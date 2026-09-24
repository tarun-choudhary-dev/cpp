import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { chromium, firefox } from 'playwright';
import { serve } from './static-server.mjs';
import { ProjectSnapshot } from '../src/project.js';

const protocolSource = await readFile(new URL('../worker/protocol.js', import.meta.url), 'utf8');
const protocol = runInNewContext(`${protocolSource}\nWorkerProtocol`, {});
const lines = [
  'src/main.cpp:2:4: error: first',
  'include/header.hpp:7: warning: no column',
  'C:\\internal\\unit.cpp:9:2: note: Windows-style path',
  'src/main.cpp:2:4: error: first',
  'noise unrelated to diagnostics',
  'wasm-ld: error: undefined symbol: missing'
];
const parsed = JSON.parse(JSON.stringify(protocol.diagnostics('compile', lines.join('\n'))));
assert.equal(parsed.length, 5);
assert.deepEqual(parsed.map(d => d.severity), ['error', 'warning', 'note', 'error', 'error']);
assert.deepEqual([parsed[0].file, parsed[0].line, parsed[0].column], ['src/main.cpp', 2, 4]);
assert.deepEqual([parsed[1].file, parsed[1].line, parsed[1].column], ['include/header.hpp', 7, null]);
assert.deepEqual([parsed[2].file, parsed[2].line, parsed[2].column], ['C:\\internal\\unit.cpp', 9, 2]);
assert.equal(parsed[3].raw, parsed[0].raw); // Duplicate output retains order.
assert.deepEqual([parsed[4].file, parsed[4].line, parsed[4].column], [null, null, null]);
assert.equal(parsed[4].stage, 'compile');

const basic = { files: { 'main.cpp': 'int main(){return 0;}' }, entry: 'main.cpp' };
const optionsInput = { ...basic, options: { standard: 'c++14', warnings: { all: true } } };
const snapshot = new ProjectSnapshot(optionsInput);
optionsInput.options.standard = 'c++11';
optionsInput.options.warnings.all = false;
assert.deepEqual(snapshot.toWorkerInput().options, {
  standard: 'c++14', optimization: 'O0', warnings: { all: true, extra: false }
});
const detached = snapshot.toWorkerInput();
detached.options.warnings.all = false;
assert.equal(snapshot.toWorkerInput().options.warnings.all, true);
assert.equal(Object.hasOwn(new ProjectSnapshot(basic).toWorkerInput(), 'options'), false);
Object.prototype.standard = 'c++11';
try { assert.equal(new ProjectSnapshot({ ...basic, options: {} }).toWorkerInput().options.standard, 'c++17'); }
finally { delete Object.prototype.standard; }
const inheritedProject = Object.assign(Object.create({ options: { standard: 'c++11' } }), basic);
assert.equal(Object.hasOwn(new ProjectSnapshot(inheritedProject).toWorkerInput(), 'options'), false);
const throwingProject = { ...basic };
Object.defineProperty(throwingProject, 'options', { get() { throw new Error('getter failed'); } });
assert.throws(() => new ProjectSnapshot(throwingProject), error => error.code === 'INVALID_OPTIONS');
for (const options of [null, [], { flags: ['-I/'] }, { standard: 'c++20' },
  { standard: null }, { optimization: 'O3' }, { warnings: { all: 'yes' } },
  { warnings: [] }, { warnings: { bogus: true } }, JSON.parse('{"__proto__":{"polluted":true}}')]) {
  assert.throws(() => new ProjectSnapshot({ ...basic, options }), error => error.code === 'INVALID_OPTIONS');
}
console.log('diagnostic parser and option snapshots: direct tests PASS');

const { server, url } = await serve();
const input = (source, options, extra = {}) => ({ files: { 'main.cpp': source }, entry: 'main.cpp',
  ...(options === undefined ? {} : { options }), ...extra });
try {
  for (const name of (process.env.BROWSERS || 'chromium,firefox').split(',')) {
    const browser = await ({ chromium, firefox })[name].launch();
    const report = { browser: name, version: browser.version(), recordedAt: new Date().toISOString(), checks: [], failures: [] };
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const requests = [];
      await context.route('**/*', route => {
        const request = route.request();
        requests.push({ url: request.url(), method: request.method() });
        return request.url().startsWith(url + '/') && request.method() === 'GET' ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      await page.goto(url + '/poc/blank.html');
      await page.evaluate(async () => {
        const { CppCompiler } = await import('/src/index.js');
        window.compiler = new CppCompiler();
        window.errorCode = async p => { try { await p; return null; } catch (error) { return error.code; } };
        window.rawWorker = new Worker('/worker/compiler-worker.js');
        window.rawPending = new Map();
        window.rawNextId = 0;
        rawWorker.onmessage = ({ data }) => {
          if (data.type === 'progress') return;
          const pending = rawPending.get(data.id);
          if (pending) { rawPending.delete(data.id); pending(data); }
        };
        window.raw = data => new Promise(resolve => {
          const id = String(++rawNextId);
          rawPending.set(id, resolve);
          rawWorker.postMessage({ ...data, id });
        });
        await Promise.all([compiler.initialize(), raw({ type: 'init' })]);
      });
      await context.setOffline(true);
      const offlineStart = requests.length;
      const call = (method, project) => page.evaluate(({ method, project }) => compiler[method](project).then(result => ({
        status: result.status, stage: result.stage, exitCode: result.exitCode, stdout: result.stdout,
        stderr: result.stderr, diagnostics: result.diagnostics, steps: result.steps.map(({ stage, stderr, exitCode }) => ({ stage, stderr, exitCode })),
        artifactBytes: result.artifact?.bytes.byteLength ?? 0
      })), { method, project });
      const rawCall = project => page.evaluate(project => raw({ type: 'compile', files: project.files,
        sources: [project.entry], ...(project.options === undefined ? {} : { options: project.options })
      }).then(response => ({ type: response.type, error: response.error,
        status: response.result?.status, args: response.result?.steps[0]?.args })), project);

      const baseline = await call('compile', basic);
      const defaults = await call('compile', { ...basic, options: {} });
      assert.equal(baseline.status, 'success');
      assert.equal(defaults.status, 'success');
      assert.deepEqual({ ...defaults, artifactBytes: 0 }, { ...baseline, artifactBytes: 0 });
      const directDefault = await rawCall(basic);
      const directExplicit = await rawCall({ ...basic, options: {} });
      assert.deepEqual(directDefault.args, directExplicit.args);
      assert.ok(directDefault.args.includes('-std=c++17') && directDefault.args.includes('-O0'));
      report.checks.push('omitted-options-preserve-default-command-and-result');

      const syntax = await call('compile', input('int main(){ invalid cpp; }'));
      assert.equal(syntax.status, 'compile-error');
      assert.ok(syntax.diagnostics.some(d => d.stage === 'compile' && d.severity === 'error' && d.file === 'main.cpp' && d.line === 1 && d.column > 0));
      assert.ok(syntax.steps[0].stderr.includes(syntax.diagnostics[0].raw));
      const runSyntax = await call('run', input('int main(){ invalid cpp; }'));
      assert.equal(runSyntax.status, 'compile-error');
      assert.deepEqual(runSyntax.steps.map(s => s.stage), ['compile']);
      report.checks.push('compile-and-run-errors-retain-raw-stderr');

      const typeError = await call('compile', input('int main(){int value = "text";return value;}'));
      const missingInclude = await call('compile', input('#include "missing.hpp"\nint main(){return 0;}'));
      assert.equal(typeError.status, 'compile-error');
      assert.equal(missingInclude.status, 'compile-error');
      assert.ok(typeError.diagnostics.some(d => d.stage === 'compile' && d.severity === 'error'));
      assert.ok(missingInclude.diagnostics.some(d => d.stage === 'compile' && d.severity === 'fatal error'));
      assert.ok(missingInclude.steps[0].stderr.includes('missing.hpp'));
      report.checks.push('type-error-and-missing-include');

      const multiple = await call('compile', input('int main(){ unknown_one; unknown_two; }'));
      assert.equal(multiple.status, 'compile-error');
      assert.ok(multiple.diagnostics.filter(d => d.severity === 'error').length >= 2);
      assert.ok(multiple.diagnostics.findIndex(d => d.message.includes('unknown_one')) <
        multiple.diagnostics.findIndex(d => d.message.includes('unknown_two')));
      report.checks.push('multiple-errors-preserve-emission-order');

      const helper = await call('compile', { files: {
        'src/main.cpp': 'int helper();int main(){return helper();}',
        'src/helper.cpp': 'int helper(){return nonexistent;}',
        'include/header.hpp': 'int helper();'
      }, entry: 'src/main.cpp' });
      assert.equal(helper.status, 'compile-error');
      assert.ok(helper.diagnostics.some(d => d.file === 'src/helper.cpp' && d.stage === 'compile'));
      const header = await call('compile', { files: {
        'src/main.cpp': '#include "include/header.hpp"\nint main(){return 0;}',
        'include/header.hpp': 'int broken = ;'
      }, entry: 'src/main.cpp' });
      assert.equal(header.status, 'compile-error');
      assert.ok(header.diagnostics.some(d => d.file === 'include/header.hpp' && d.stage === 'compile'));
      assert.ok(header.steps[0].stderr.includes('.cpp-project/include/header.hpp'));
      report.checks.push('multi-file-and-logical-header-error-paths');

      const link = await call('compile', input('extern int missing();int main(){return missing();}'));
      assert.equal(link.status, 'link-error');
      assert.ok(link.diagnostics.some(d => d.stage === 'link' && d.severity === 'error'));
      assert.ok(link.steps.at(-1).stderr.length > 0);
      report.checks.push('link-diagnostic-stage-and-raw-stderr');

      const unusedLocal = 'int main(){int unused=1;return 0;}';
      const noWarnings = await call('compile', input(unusedLocal));
      const allWarnings = await call('compile', input(unusedLocal, { warnings: { all: true } }));
      assert.equal(noWarnings.status, 'success');
      assert.equal(allWarnings.status, 'success');
      assert.ok(allWarnings.artifactBytes > 8);
      assert.ok(!noWarnings.diagnostics.some(d => d.severity === 'warning'));
      assert.ok(allWarnings.diagnostics.some(d => d.severity === 'warning' && d.message.includes('unused')));
      assert.ok(allWarnings.steps[0].stderr.includes('warning:'));
      const allCommand = await rawCall(input(unusedLocal, { warnings: { all: true } }));
      assert.ok(allCommand.args.includes('-Wall'));
      report.checks.push('Wall-enables-warning-with-successful-artifact');

      const extraSource = 'int f(int unused){return 2;}int main(){return f(1);}';
      const extraWarnings = await call('compile', input(extraSource, { warnings: { extra: true } }));
      assert.equal(extraWarnings.status, 'success');
      assert.ok(extraWarnings.diagnostics.some(d => d.severity === 'warning' && d.message.includes('unused parameter')));
      const extraCommand = await rawCall(input(extraSource, { warnings: { extra: true } }));
      assert.ok(extraCommand.args.includes('-Wextra'));
      report.checks.push('Wextra-enables-unused-parameter-warning');

      const headerWarning = await call('compile', { files: {
        'src/main.cpp': '#include "include/header.hpp"\nint main(){return 0;}',
        'include/header.hpp': '#warning header-warning'
      }, entry: 'src/main.cpp' });
      assert.equal(headerWarning.status, 'success');
      assert.ok(headerWarning.diagnostics.some(d => d.severity === 'warning' && d.file === 'include/header.hpp'));
      report.checks.push('warning-in-staged-header');

      const standardSource = '#if __cplusplus < 201402L\n#error requires-cxx14\n#endif\nint main(){auto f=[](auto x){return x+1;};return f(1)-2;}';
      const elevenValid = await call('run', input('int main(){return 0;}', { standard: 'c++11' }));
      assert.equal(elevenValid.status, 'success');
      assert.equal(elevenValid.exitCode, 0);
      const eleven = await call('compile', input(standardSource, { standard: 'c++11' }));
      assert.equal(eleven.status, 'compile-error');
      for (const standard of ['c++14', 'c++17']) {
        const compiled = await call('run', input(standardSource, { standard }));
        assert.equal(compiled.status, 'success');
        assert.equal(compiled.exitCode, 0);
        const command = await rawCall(input(standardSource, { standard }));
        assert.ok(command.args.includes(`-std=${standard}`));
        report.checks.push(`${standard}-enables-generic-lambda`);
      }
      assert.ok((await rawCall(input(standardSource, { standard: 'c++11' }))).args.includes('-std=c++11'));
      report.checks.push('c++11-rejects-c++14-feature');

      const optimizationSource = 'int square(int x){return x*x;}int main(){return square(3)-9;}';
      for (const optimization of ['O0', 'O1', 'O2']) {
        const outcome = await call('run', input(optimizationSource, { optimization }));
        assert.equal(outcome.status, 'success');
        assert.equal(outcome.exitCode, 0);
        const command = await rawCall(input(optimizationSource, { optimization }));
        assert.ok(command.args.includes(`-${optimization}`));
        report.checks.push(`${optimization}-applied-and-executes`);
      }

      const mutated = await page.evaluate(async () => {
        const project = { files: { 'main.cpp': '#if __cplusplus < 201703L\n#error old-standard\n#endif\nint main(){return 0;}' },
          entry: 'main.cpp', options: { standard: 'c++17', warnings: { all: false } } };
        const pending = compiler.compile(project);
        project.options.standard = 'c++11';
        project.options.warnings.all = true;
        return (await pending).status;
      });
      assert.equal(mutated, 'success');
      report.checks.push('option-snapshot-is-detached');

      for (const options of [null, [], { flags: ['-I/'] }, { standard: 'c++20' },
        { standard: [] }, { optimization: 'O3' }, { optimization: [] },
        { warnings: [] }, { warnings: { all: 1 } }, { warnings: { extra: 'no' } },
        { warnings: { unknown: true } }]) {
        assert.equal(await page.evaluate(project => errorCode(compiler.compile(project)), { ...basic, options }), 'INVALID_OPTIONS', JSON.stringify(options));
        const worker = await rawCall({ ...basic, options });
        assert.equal(worker.type, 'error');
        assert.equal(worker.error.code, 'INVALID_OPTIONS');
      }
      const pollution = await page.evaluate(async () => {
        const options = JSON.parse('{"__proto__":{"polluted":true}}');
        const project = { files: { 'main.cpp': 'int main(){return 0;}' }, entry: 'main.cpp', options };
        const api = await errorCode(compiler.compile(project));
        const worker = await raw({ type: 'compile', files: project.files, sources: ['main.cpp'], options });
        return { api, worker: worker.error?.code, polluted: Object.hasOwn(Object.prototype, 'polluted') };
      });
      assert.deepEqual(pollution, { api: 'INVALID_OPTIONS', worker: 'INVALID_OPTIONS', polluted: false });
      report.checks.push('api-and-worker-reject-invalid-options');
      assert.equal(requests.length, offlineStart);
      assert.ok(requests.every(r => r.url.startsWith(url + '/') && r.method === 'GET'));
      report.offlineRequests = requests.length - offlineStart;
      report.checks.push('offline-and-same-origin');
      await page.evaluate(async () => { await compiler.dispose(); rawWorker.terminate(); });
      console.log(`${name}: ${report.checks.length} Phase 6 diagnostics/options groups PASS`);
    } catch (error) {
      report.failures.push(String(error.stack || error));
      process.exitCode = 1;
      console.error(`${name}:`, error);
    } finally {
      await writeFile(`evidence/phase6-${name}.json`, JSON.stringify(report, null, 2) + '\n');
      await browser.close();
    }
  }
} finally { server.close(); }
