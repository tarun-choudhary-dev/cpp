import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, firefox } from 'playwright';

const root = path.resolve('dist');
const manifest = JSON.parse(await readFile(path.join(root, 'release-manifest.json'), 'utf8'));
const declared = new Set([...manifest.packageFiles.map(file => file.path), 'release-manifest.json']);
const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    let name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (name.startsWith('/cpp-engine/')) name = name.slice('/cpp-engine'.length);
    if (name === '/') { response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end('<!doctype html><meta charset="utf-8">'); return; }
    const relative = name.slice(1);
    if (!declared.has(relative)) { response.writeHead(404).end(); return; }
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const bytes = await readFile(file);
    const extension = path.extname(file);
    const mime = ({ '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.tar': 'application/octet-stream' })[extension] || 'application/wasm';
    response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Length': bytes.length }).end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const hello = { files: { 'main.cpp': '#include <iostream>\nint main(){std::cout << "release\\n";}' }, entry: 'main.cpp' };
const infinite = { files: { 'main.cpp': 'int main(){for(;;){} }' }, entry: 'main.cpp' };
const results = [];

async function smoke(browser, prefix, full) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const requests = [];
  try {
    await context.route('**/*', route => {
      const request = route.request();
      requests.push({ url: request.url(), method: request.method() });
      return request.url().startsWith(origin + '/') && request.method() === 'GET' ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    await page.goto(origin + prefix);
    const boot = await page.evaluate(async () => {
      const { CppCompiler } = await import(new URL('./src/index.js', location.href).href);
      window.compiler = new CppCompiler();
      const start = performance.now();
      const info = await compiler.initialize();
      return { ms: performance.now() - start, info };
    });
    assert.match(boot.info.clang, /clang version 8\.0\.1/i);
    assert.match(boot.info.lld, /LLD 8\.0\.1/i);
    const networkStart = requests.length;
    await context.setOffline(true);
    const basic = await page.evaluate(async ({ hello, full }) => {
      const startCompile = performance.now();
      const built = await compiler.compile(hello);
      const compileMs = performance.now() - startCompile;
      const startRun = performance.now();
      const ran = await compiler.run(hello);
      const runMs = performance.now() - startRun;
      const bad = await compiler.compile({ files: { 'main.cpp': 'int main( {' }, entry: 'main.cpp' });
      const selected = await compiler.compile({ files: { 'main.cpp': '#if __cplusplus != 201402L\n#error wrong standard\n#endif\nint main(){return 0;}' },
        entry: 'main.cpp', options: { standard: 'c++14', optimization: 'O1', warnings: { all: true } } });
      window.releaseArtifact = built.artifact?.bytes;
      return { built: built.status, ran: ran.status, output: ran.stdout,
        bytes: built.artifact?.bytes.byteLength, valid: WebAssembly.validate(releaseArtifact),
        bad: bad.status, diagnostic: bad.diagnostics.some(d => d.severity === 'error'),
        options: selected.status, compileMs, runMs, full };
    }, { hello, full });
    assert.equal(basic.built, 'success');
    assert.equal(basic.ran, 'success');
    assert.equal(basic.output, 'release\n');
    assert.ok(basic.bytes > 0 && basic.valid);
    assert.equal(basic.bad, 'compile-error');
    assert.equal(basic.diagnostic, true);
    assert.equal(basic.options, 'success');
    assert.equal(requests.length, networkStart, 'Initialized jobs made network requests');
    await context.setOffline(false);
    let recovery = null;
    if (full) {
      recovery = await page.evaluate(async ({ hello, infinite }) => {
        const startedCancel = performance.now();
        const pending = compiler.run(infinite).then(() => 'resolved', error => error.code);
        await new Promise(resolve => setTimeout(resolve, 100));
        await compiler.cancel();
        const cancelled = await pending;
        const cancelReplacementMs = performance.now() - startedCancel;
        const afterCancel = await compiler.run(hello);

        const startedTimeout = performance.now();
        let timeoutCode, timeoutStage;
        try { await compiler.run(infinite); }
        catch (error) { timeoutCode = error.code; timeoutStage = error.stage; }
        const timeoutMs = performance.now() - startedTimeout;
        const startedReplacement = performance.now();
        await compiler.initialize();
        const timeoutReplacementMs = performance.now() - startedReplacement;
        const afterTimeout = await compiler.run(hello);
        await compiler.reset();
        const afterReset = await compiler.run(hello);
        const artifactStillValid = WebAssembly.validate(releaseArtifact);
        await compiler.dispose();
        let disposed;
        try { await compiler.compile(hello); } catch (error) { disposed = error.code; }
        return { cancelled, cancelReplacementMs, afterCancel: afterCancel.stdout,
          timeoutCode, timeoutStage, timeoutMs, timeoutReplacementMs,
          afterTimeout: afterTimeout.stdout, afterReset: afterReset.stdout,
          artifactStillValid, disposed, state: compiler.getState() };
      }, { hello, infinite });
      assert.equal(recovery.cancelled, 'CANCELLATION');
      assert.equal(recovery.afterCancel, 'release\n');
      assert.equal(recovery.timeoutCode, 'TIMEOUT');
      assert.equal(recovery.timeoutStage, 'execute');
      assert.equal(recovery.afterTimeout, 'release\n');
      assert.equal(recovery.afterReset, 'release\n');
      assert.equal(recovery.artifactStillValid, true);
      assert.equal(recovery.disposed, 'COMPILER_DISPOSED');
      assert.equal(recovery.state, 'disposed');
    } else {
      await page.evaluate(() => compiler.dispose());
    }
    const unexpected = requests.filter(({ url, method }) => method !== 'GET' || !url.startsWith(origin + prefix));
    assert.deepEqual(unexpected, [], 'Requests escaped the package/static origin');
    return { path: prefix, initializeMs: boot.ms, compileMs: basic.compileMs, runMs: basic.runMs,
      recovery, requests: requests.length, offlineJobRequests: 0 };
  } finally { await context.close(); }
}

try {
  for (const name of (process.env.BROWSERS || 'chromium,firefox').split(',')) {
    const launcher = ({ chromium, firefox })[name];
    if (!launcher) throw new Error(`Unknown browser: ${name}`);
    const browser = await launcher.launch();
    try {
      const report = { browser: name, version: browser.version(), engineVersion: manifest.engine.version,
        checks: [await smoke(browser, '/', true), await smoke(browser, '/cpp-engine/', false)] };
      const exampleContext = await browser.newContext({ serviceWorkers: 'block' });
      try {
        const example = await exampleContext.newPage();
        await example.goto(origin + '/example/index.html');
        await example.waitForFunction(() => !!window.exampleResult, null, { timeout: 90_000 });
        assert.deepEqual(await example.evaluate(() => window.exampleResult), { status: 'success', stdout: 'example\n' });
        report.example = 'PASS';
      } finally { await exampleContext.close(); }
      results.push(report);
      console.log(`${name} ${report.version}: packaged root, /cpp-engine/, lifecycle, timeout and example PASS`);
    } finally { await browser.close(); }
  }
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/phase8-release.json', JSON.stringify(results, null, 2) + '\n');
} finally {
  await new Promise(resolve => server.close(resolve));
}
