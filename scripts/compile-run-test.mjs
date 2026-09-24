import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';
import { serve } from './static-server.mjs';

const { server, url } = await serve();
const project = (source, stdin = '') => ({ files: { 'main.cpp': source }, entry: 'main.cpp', stdin });
const hello = project('#include <iostream>\nint main(){std::cout<<"THIS MUST NOT APPEAR";}');
const inputEcho = project('#include <iostream>\n#include <string>\nint main(){std::string s;while(std::getline(std::cin,s))std::cout<<"["<<s<<"]\\n";}');

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
        window.CppCompiler = CppCompiler;
        window.compiler = new CppCompiler();
        window.errorCode = async promise => { try { await promise; return null; } catch (error) { return error.code; } };
        window.summarize = result => ({
          status: result.status, stage: result.stage, exitCode: result.exitCode,
          stdout: result.stdout, stderr: result.stderr, trap: result.trap,
          diagnostics: result.diagnostics,
          steps: result.steps.map(({ stage, stdout, stderr, exitCode, trap }) => ({ stage, stdout, stderr, exitCode, trap })),
          artifact: result.artifact && { format: result.artifact.format, abi: result.artifact.abi,
            byteLength: result.artifact.bytes.byteLength, magic: [...result.artifact.bytes.slice(0, 4)] }
        });
      });
      assert.equal(await page.evaluate(input => errorCode(compiler.compile(input)), hello), 'COMPILER_NOT_READY');
      await page.evaluate(() => compiler.initialize());
      await context.setOffline(true);
      let offlineStart = requests.length;
      const call = (method, input) => page.evaluate(({ method, input }) => compiler[method](input).then(summarize), { method, input });
      const checkOffline = () => {
        assert.equal(requests.length, offlineStart, 'A loaded Worker must not fetch during compilation/execution');
        report.offlineJobRequests = requests.length - offlineStart;
      };

      const compiled = await call('compile', hello);
      assert.equal(compiled.status, 'success');
      assert.equal(compiled.stage, 'link');
      assert.deepEqual(compiled.steps.map(s => s.stage), ['compile', 'link']);
      assert.equal(compiled.stdout, '');
      assert.equal(compiled.stderr, '');
      assert.equal(compiled.exitCode, 0);
      assert.deepEqual(compiled.artifact.magic, [0, 97, 115, 109]);
      assert.ok(compiled.artifact.byteLength > 8);
      report.checks.push('compile-only-never-executes-and-transfers-wasm');

      const ran = await call('run', hello);
      assert.equal(ran.status, 'success');
      assert.deepEqual(ran.steps.map(s => s.stage), ['compile', 'link', 'execute']);
      assert.equal(ran.stdout, 'THIS MUST NOT APPEAR');
      assert.equal(ran.stderr, '');
      assert.equal(ran.exitCode, 0);
      assert.deepEqual(ran.artifact.magic, [0, 97, 115, 109]);
      report.checks.push('run-compiles-and-executes');

      const streams = await call('run', project('#include <iostream>\n#include <cstdio>\nint main(){std::cout<<"cout\\n";std::printf("printf\\n");std::cerr<<"cerr\\n";std::fprintf(stderr,"fprintf\\n");}'));
      assert.equal(streams.status, 'success');
      assert.equal(streams.stdout, 'cout\nprintf\n');
      assert.equal(streams.stderr, 'cerr\nfprintf\n');
      assert.equal(streams.diagnostics.length, 0);
      report.checks.push('cout-printf-and-separate-stderr');

      for (const [label, input, expected] of [
        ['empty', '', ''], ['one-line', 'hello', '[hello]\n'],
        ['multi-line', 'first\nsecond\n', '[first]\n[second]\n'],
        ['whitespace', '  padded  \n\n', '[  padded  ]\n[]\n'],
        ['latin1-unicode', 'café\n', '[café]\n']
      ]) {
        const outcome = await call('run', { ...inputEcho, stdin: input });
        assert.equal(outcome.status, 'success', `${label}: ${outcome.status}`);
        assert.equal(outcome.stdout, expected, label);
        assert.equal(outcome.stderr, '', label);
        report.checks.push(`stdin-${label}`);
      }
      const wideUnicode = await call('run', { ...inputEcho, stdin: '世界\n' });
      assert.equal(wideUnicode.status, 'success');
      report.unicodeStdinObservation = { input: '世界\n', stdout: wideUnicode.stdout,
        roundTrips: wideUnicode.stdout === '[世界]\n' };
      report.checks.push('wider-unicode-stdin-observed');

      for (const exitCode of [0, 1, 42]) {
        const outcome = await call('run', project(`int main(){return ${exitCode};}`));
        assert.equal(outcome.status, exitCode ? 'nonzero-exit' : 'success');
        assert.equal(outcome.stage, 'execute');
        assert.equal(outcome.exitCode, exitCode);
        report.checks.push(`exit-${exitCode}-resolves`);
      }

      const invalidCpp = project('int main(){ this is invalid; }');
      const compileFailure = await call('compile', invalidCpp);
      const runFailure = await call('run', invalidCpp);
      for (const outcome of [compileFailure, runFailure]) {
        assert.equal(outcome.status, 'compile-error');
        assert.equal(outcome.stage, 'compile');
        assert.equal(outcome.artifact, null);
        assert.deepEqual(outcome.steps.map(s => s.stage), ['compile']);
        assert.equal(outcome.stdout, '');
        assert.ok(outcome.diagnostics.some(d => d.severity === 'error' && d.file === 'main.cpp' && d.raw));
      }
      const linkFailure = await call('run', project('extern int missing();int main(){return missing();}'));
      assert.equal(linkFailure.status, 'link-error');
      assert.equal(linkFailure.stage, 'link');
      assert.equal(linkFailure.artifact, null);
      assert.deepEqual(linkFailure.steps.map(s => s.stage), ['compile', 'link']);
      report.checks.push('compile-and-link-failures-resolve-before-execution');

      const trap = await call('run', project('int main(){__builtin_trap();}'));
      assert.equal(trap.status, 'trap');
      assert.equal(trap.stage, 'execute');
      assert.equal(trap.exitCode, null);
      assert.equal(trap.trap.name, 'RuntimeError');
      assert.ok(trap.artifact.byteLength > 8);
      assert.deepEqual(trap.steps.map(s => s.stage), ['compile', 'link', 'execute']);
      report.checks.push('runtime-trap-resolves-distinct-from-compile-failure');

      const multi = { files: {
        'src/z.cpp': 'int z(){return 2;}',
        'src/application.cpp': '#include <iostream>\n#include "include/math.hpp"\nint z();int main(){std::cout<<add(3,4)+z();}',
        'include/math.hpp': 'int add(int,int);',
        'src/a.cpp': '#include "include/math.hpp"\nint add(int a,int b){return a+b;}'
      }, entry: 'src/application.cpp' };
      const multiCompiled = await call('compile', multi);
      assert.equal(multiCompiled.status, 'success');
      assert.deepEqual(multiCompiled.steps.map(s => s.stage), ['compile', 'compile', 'compile', 'link']);
      const multiRan = await call('run', multi);
      assert.equal(multiRan.stdout, '9');
      const reordered = { files: Object.fromEntries(Object.entries(multi.files).reverse()), entry: multi.entry };
      assert.deepEqual(await call('compile', reordered), multiCompiled);
      report.checks.push('multi-file-headers-explicit-entry-and-insertion-order');

      const mutated = await page.evaluate(async () => {
        const input = { files: { 'src/entry.cpp': 'int main(){return 42;}' }, entry: 'src/entry.cpp', stdin: 'original' };
        const pending = compiler.run(input);
        input.files['src/entry.cpp'] = 'int main(){return 1;}';
        input.entry = 'missing.cpp';
        input.stdin = 'changed';
        return summarize(await pending);
      });
      assert.equal(mutated.exitCode, 42);
      assert.equal(mutated.status, 'nonzero-exit');
      report.checks.push('one-snapshot-despite-caller-mutation');

      const freshSource = '#include <iostream>\n#include <fstream>\nint main(){static int n=0;std::ifstream f("marker.txt");std::cout<<(f.good()?"stale":"fresh")<<":"<<++n;std::ofstream o("marker.txt");o<<"x";}';
      const repeat = [];
      for (let i = 0; i < 3; i++) repeat.push(await call('run', project(freshSource)));
      assert.ok(repeat.every(x => x.status === 'success' && x.stdout === 'fresh:1'));
      assert.deepEqual(repeat, [repeat[0], repeat[0], repeat[0]]);
      report.checks.push('repeated-run-fresh-memfs-and-static-state');
      const repeatedInput = [];
      for (let i = 0; i < 2; i++) repeatedInput.push(await call('run', { ...inputEcho, stdin: 'again\n' }));
      assert.deepEqual(repeatedInput.map(x => x.stdout), ['[again]\n', '[again]\n']);
      report.checks.push('repeated-run-fresh-stdin');

      const artifact = await page.evaluate(async input => {
        window.retained = (await compiler.compile(input)).artifact.bytes;
        const before = { length: retained.byteLength, valid: WebAssembly.validate(retained) };
        await compiler.run(input);
        const after = { length: retained.byteLength, valid: WebAssembly.validate(retained) };
        return { before, after };
      }, hello);
      assert.ok(artifact.before.length > 8 && artifact.before.valid);
      assert.deepEqual(artifact.after, artifact.before);
      report.checks.push('artifact-survives-next-job');

      assert.equal(await page.evaluate(input => errorCode(compiler.compile(input)), { files: {}, entry: 'main.cpp' }), 'INVALID_PROJECT');
      const busy = await page.evaluate(async input => {
        const first = compiler.run(input);
        const state = compiler.getState();
        const second = await errorCode(compiler.compile(input));
        const outcome = summarize(await first);
        return { state, second, outcome, after: compiler.getState() };
      }, hello);
      assert.equal(busy.state, 'busy');
      assert.equal(busy.second, 'COMPILER_BUSY');
      assert.equal(busy.outcome.status, 'success');
      assert.equal(busy.after, 'ready');
      report.checks.push('invalid-project-and-busy-reject');
      checkOffline();

      await context.setOffline(false); // Worker replacement must reload assets.
      const reset = await page.evaluate(async input => {
        await compiler.reset();
        const outcome = summarize(await compiler.run(input));
        return { state: compiler.getState(), outcome, retainedValid: WebAssembly.validate(retained) };
      }, hello);
      assert.equal(reset.state, 'ready');
      assert.equal(reset.outcome.stdout, 'THIS MUST NOT APPEAR');
      assert.equal(reset.retainedValid, true);
      report.checks.push('reset-and-retained-artifact');

      const cancel = await page.evaluate(async input => {
        const pending = compiler.run({ files: { 'main.cpp': 'int main(){volatile int n=0;for(;;){n=1;}}' }, entry: 'main.cpp' });
        await new Promise(resolve => setTimeout(resolve, 1200));
        const before = compiler.getState();
        const recovery = compiler.cancel();
        const code = await errorCode(pending);
        await recovery;
        return { before, code, after: compiler.getState(), outcome: summarize(await compiler.run(input)) };
      }, hello);
      assert.equal(cancel.before, 'busy');
      assert.equal(cancel.code, 'CANCELLATION');
      assert.equal(cancel.after, 'ready');
      assert.equal(cancel.outcome.stdout, 'THIS MUST NOT APPEAR');
      report.checks.push('cancel-infinite-execution-and-recover');

      const disposal = await page.evaluate(async input => {
        const pending = compiler.run(input);
        await compiler.dispose();
        return { code: await errorCode(pending), after: await errorCode(compiler.compile(input)),
          state: compiler.getState(), retainedValid: WebAssembly.validate(retained) };
      }, hello);
      assert.equal(disposal.code, 'COMPILER_DISPOSED');
      assert.equal(disposal.after, 'COMPILER_DISPOSED');
      assert.equal(disposal.state, 'disposed');
      assert.equal(disposal.retainedValid, true);
      report.checks.push('dispose-during-work-and-retained-artifact');

      const fake = await page.evaluate(async () => {
        const NativeWorker = window.Worker;
        let instance;
        class FakeWorker {
          constructor() { instance = this; this.sent = []; }
          postMessage(data) { this.sent.push(data); }
          terminate() { this.terminated = true; }
          emit(data) { this.onmessage?.({ data }); }
        }
        const metadata = { clang: 'test', lld: 'test', commit: 'test', defaultStandard: 'c++17', abi: 'wasi_unstable' };
        window.Worker = FakeWorker;
        try {
          const c = new CppCompiler();
          const init = c.initialize();
          instance.emit({ type: 'result', id: instance.sent[0].id, operation: 'init', result: metadata });
          await init;
          const rawBytes = new Uint8Array([0, 97, 115, 109]);
          const raw = { status: 'success', stage: 'link', exitCode: 0, stdout: '', stderr: '', trap: null,
            diagnostics: [{ stage: 'compile', severity: 'warning', file: 'main.cpp', line: 1, column: 1, message: 'x', raw: 'x' }],
            steps: [{ stage: 'link', stdout: '', stderr: '', exitCode: 0, trap: { name: 'x', message: 'y' }, ms: 1 }],
            artifact: { format: 'wasm', abi: 'wasi_unstable', bytes: rawBytes }, durationMs: 1 };
          const pending = c.compile({ files: { 'main.cpp': 'int main(){}' }, entry: 'main.cpp' });
          instance.emit({ type: 'result', id: instance.sent.at(-1).id, operation: 'compile', result: raw });
          const result = await pending;
          const sameBytes = result.artifact.bytes === rawBytes;
          raw.diagnostics[0].message = 'changed'; raw.steps[0].trap.name = 'changed'; raw.artifact.format = 'changed';
          const detached = result.diagnostics[0].message === 'x' && result.steps[0].trap.name === 'x' && result.artifact.format === 'wasm';
          const run = c.run({ files: { 'main.cpp': 'int main(){}' }, entry: 'main.cpp' });
          instance.onerror({ message: 'simulated Worker failure' });
          const failure = await errorCode(run);
          const state = c.getState();
          await c.dispose();
          return { sameBytes, detached, failure, state, terminated: instance.terminated, listenersCleared: instance.onmessage === null };
        } finally { window.Worker = NativeWorker; }
      });
      assert.deepEqual(fake, { sameBytes: true, detached: true, failure: 'WORKER_ERROR', state: 'fatal', terminated: true, listenersCleared: true });
      report.checks.push('zero-additional-artifact-copy-detached-metadata-and-worker-failure');

      assert.ok(requests.every(request => request.url.startsWith(url + '/') && request.method === 'GET'));
      report.checks.push('same-origin-static-assets-and-offline-jobs');
      report.requests = requests.map(request => new URL(request.url).pathname);
      console.log(`${name}: ${report.checks.length} Phase 5 compile/run groups PASS`);
    } catch (error) {
      report.failures.push(String(error.stack || error));
      process.exitCode = 1;
      console.error(`${name}:`, error);
    } finally {
      await writeFile(`evidence/phase5-${name}.json`, JSON.stringify(report, null, 2) + '\n');
      await browser.close();
    }
  }
} finally { server.close(); }
