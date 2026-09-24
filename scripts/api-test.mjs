import { chromium, firefox } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { serve } from './static-server.mjs';

const { server, url } = await serve();
const hello = '#include <iostream>\nint main(){std::cout<<"Hello World\\n";}';

try {
  for (const name of (process.env.BROWSERS || 'chromium,firefox').split(',')) {
    const browser = await ({ chromium, firefox })[name].launch();
    const report = { browser: name, version: browser.version(), recordedAt: new Date().toISOString(), checks: [], failures: [] };
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const requests = [];
      await context.route('**/*', route => {
        requests.push(route.request().url());
        return route.request().url().startsWith(url + '/') && route.request().method() === 'GET' ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      await page.goto(url + '/poc/blank.html');
      const initial = await page.evaluate(async () => {
        const { CppCompiler } = await import('/src/index.js');
        window.CppCompiler = CppCompiler;
        window.compiler = new CppCompiler();
        window.errorCode = async promise => { try { await promise; return null; } catch (error) { return error.code; } };
        window.summarize = result => ({ ...result, artifact: result.artifact && {
          format: result.artifact.format, abi: result.artifact.abi,
          byteLength: result.artifact.bytes.byteLength, magic: [...result.artifact.bytes.slice(0, 4)]
        } });
        return { state: compiler.getState(), ready: compiler.isReady(), busy: compiler.isBusy(), info: compiler.getCompilerInfo() };
      });
      assert.deepEqual(initial, { state: 'created', ready: false, busy: false, info: null });
      report.checks.push('constructor-and-created');

      const beforeInitCode = await page.evaluate(() => errorCode(compiler.run({ files: { 'main.cpp': 'int main(){}' }, entry: 'main.cpp' })));
      assert.equal(beforeInitCode, 'COMPILER_NOT_READY');
      const infos = await page.evaluate(() => Promise.all([compiler.initialize(), compiler.initialize()]));
      assert.deepEqual(infos[0], infos[1]);
      assert.match(infos[0].clang, /8\.0\.1/);
      assert.equal(await page.evaluate(() => compiler.getState()), 'ready');
      report.checks.push('initialize-and-idempotency');

      await context.setOffline(true);
      const requestsBeforeJobs = requests.length;
      const project = (source, stdin = '') => ({ files: { 'main.cpp': source }, entry: 'main.cpp', stdin });
      const compiled = await page.evaluate(input => compiler.compile(input).then(summarize), project(hello));
      assert.equal(compiled.status, 'success');
      assert.equal(compiled.stage, 'link');
      assert.deepEqual(compiled.steps.map(s => s.stage), ['compile', 'link']);
      assert.equal(compiled.stdout, '');
      assert.deepEqual(compiled.artifact.magic, [0, 97, 115, 109]);
      assert.ok(compiled.artifact.byteLength > 8);
      assert.ok(compiled.steps.every(s => !Object.hasOwn(s, 'args')));
      report.checks.push('compile-only-and-owned-artifact');

      const ran = await page.evaluate(input => compiler.run(input).then(summarize), project(hello));
      assert.equal(ran.status, 'success');
      assert.equal(ran.stdout, 'Hello World\n');
      assert.equal(ran.stderr, '');
      assert.equal(ran.exitCode, 0);
      report.checks.push('hello-world');

      const multi = await page.evaluate(() => compiler.run({ files: {
        'main.cpp': '#include <iostream>\n#include "answer.h"\nint main(){std::cout<<answer()<<"\\n";}',
        'answer.cpp': '#include "answer.h"\nint answer(){return 42;}',
        'answer.h': '#pragma once\nint answer();'
      }, entry: 'main.cpp' }).then(summarize));
      assert.equal(multi.stdout, '42\n');
      assert.deepEqual(multi.steps.map(s => s.stage), ['compile', 'compile', 'link', 'execute']);
      report.checks.push('multiple-sources-and-header');

      const stl = await page.evaluate(() => compiler.run({ files: { 'main.cpp': '#include <iostream>\n#include <vector>\nint main(){std::vector<int> v{4,5};std::cout<<v[0]+v[1];}' }, entry: 'main.cpp' }).then(summarize));
      assert.equal(stl.stdout, '9');
      const streams = await page.evaluate(input => compiler.run(input).then(summarize), project('#include <iostream>\nint main(){std::cout<<"out\\n";return 7;}'));
      assert.equal(streams.stdout, 'out\n');
      assert.equal(streams.exitCode, 7);
      assert.equal(streams.status, 'nonzero-exit');
      const stderr = await page.evaluate(input => compiler.run(input).then(summarize), project('#include <iostream>\nint main(){std::cerr<<"err\\n";}'));
      assert.equal(stderr.stderr, 'err\n');
      const stdin = await page.evaluate(input => compiler.run(input).then(summarize), project('#include <iostream>\nint main(){int n;std::cin>>n;std::cout<<n*2;}', '21\n'));
      assert.equal(stdin.stdout, '42');
      report.checks.push('stl-streams-exit-and-stdin');

      const syntax = await page.evaluate(input => compiler.compile(input).then(summarize), project('int main(){ invalid cpp; }'));
      assert.equal(syntax.status, 'compile-error');
      assert.equal(syntax.artifact, null);
      assert.ok(syntax.diagnostics.some(d => d.severity === 'error' && d.file === 'main.cpp' && d.line === 1 && d.column > 0 && d.raw));
      const link = await page.evaluate(input => compiler.run(input).then(summarize), project('extern int missing();int main(){return missing();}'));
      assert.equal(link.status, 'link-error');
      assert.ok(link.diagnostics.length > 0);
      const trap = await page.evaluate(input => compiler.run(input).then(summarize), project('int main(){__builtin_trap();}'));
      assert.equal(trap.status, 'trap');
      assert.equal(trap.exitCode, null);
      assert.equal(trap.trap.name, 'RuntimeError');
      report.checks.push('compiler-link-and-runtime-failures');

      const snapshot = await page.evaluate(async () => {
        const input = { files: { 'main.cpp': 'int main(){return 3;}' }, entry: 'main.cpp' };
        const operation = compiler.run(input);
        input.files['main.cpp'] = 'int main(){return 8;}';
        input.entry = 'other.cpp';
        return summarize(await operation);
      });
      assert.equal(snapshot.exitCode, 3);
      const busy = await page.evaluate(async input => {
        const first = compiler.run(input);
        const state = compiler.getState();
        const secondCode = await errorCode(compiler.compile(input));
        const firstResult = summarize(await first);
        return { state, secondCode, firstResult, finalState: compiler.getState() };
      }, project(hello));
      assert.equal(busy.state, 'busy');
      assert.equal(busy.secondCode, 'COMPILER_BUSY');
      assert.equal(busy.firstResult.status, 'success');
      assert.equal(busy.finalState, 'ready');
      report.checks.push('input-snapshot-busy-and-sequential-recovery');

      const invalid = await page.evaluate(async () => {
        const candidates = [
          undefined, null, [], {}, { files: {} }, { files: 'bad', entry: 'main.cpp' },
          { files: { 'main.cpp': '' } },
          { files: { 'main.cpp': '' }, entry: 'absent.cpp' },
          { files: { '../main.cpp': '' }, entry: '../main.cpp' },
          { files: { '/main.cpp': '' }, entry: '/main.cpp' },
          { files: { 'main\0.cpp': '' }, entry: 'main\0.cpp' },
          { files: { 'main.cpp': 42 }, entry: 'main.cpp' },
          { files: { 'main.cpp': '' }, entry: 'main.cpp', stdin: 42 },
          { files: { a: '', 'a/main.cpp': '' }, entry: 'a/main.cpp' },
          { files: { '.cpp-worker/0.o': '' }, entry: '.cpp-worker/0.o' }
        ];
        const codes = [];
        for (const candidate of candidates) codes.push(await errorCode(compiler.compile(candidate)));
        return { codes, state: compiler.getState() };
      });
      assert.ok(invalid.codes.every(code => code === 'INVALID_PROJECT'), JSON.stringify(invalid.codes));
      assert.equal(invalid.state, 'ready');
      assert.equal(requests.length, requestsBeforeJobs, 'Compilation must not fetch assets after initialization');
      report.checks.push('project-validation-and-offline-jobs');

      await context.setOffline(false);
      const reset = await page.evaluate(async () => {
        const infos = await Promise.all([compiler.reset(), compiler.reset()]);
        return { infos, state: compiler.getState(), ready: compiler.isReady() };
      });
      assert.deepEqual(reset.infos[0], reset.infos[1]);
      assert.equal(reset.state, 'ready');
      assert.equal(reset.ready, true);
      report.checks.push('reset-and-coalesced-reset');

      const cancelled = await page.evaluate(async input => {
        const running = compiler.run(input);
        const recovery = compiler.cancel();
        const code = await errorCode(running);
        await recovery;
        return { code, state: compiler.getState(), result: summarize(await compiler.run(input)) };
      }, project(hello));
      assert.equal(cancelled.code, 'CANCELLATION');
      assert.equal(cancelled.state, 'ready');
      assert.equal(cancelled.result.stdout, 'Hello World\n');
      report.checks.push('cancel-normal-and-worker-recreation');

      const cancelledInfinite = await page.evaluate(async () => {
        const running = compiler.run({ files: { 'main.cpp': 'int main(){volatile int n=0;for(;;){n=1;}}' }, entry: 'main.cpp' });
        await new Promise(resolve => setTimeout(resolve, 2000));
        const before = compiler.getState();
        const recovery = compiler.cancel();
        const code = await errorCode(running);
        await recovery;
        return { before, code, after: compiler.getState() };
      });
      assert.equal(cancelledInfinite.before, 'busy');
      assert.equal(cancelledInfinite.code, 'CANCELLATION');
      assert.equal(cancelledInfinite.after, 'ready');
      report.checks.push('cancel-infinite-loop-and-recover');

      const cancelledLong = await page.evaluate(async () => {
        const running = compiler.run({ files: { 'main.cpp': 'int main(){volatile unsigned n=0;for(unsigned i=0;i<1000000000u;++i){n+=i;}return n;}' }, entry: 'main.cpp' });
        await new Promise(resolve => setTimeout(resolve, 500));
        const before = compiler.getState();
        const recovery = compiler.cancel();
        const code = await errorCode(running);
        await recovery;
        return { before, code, after: compiler.getState() };
      });
      assert.deepEqual(cancelledLong, { before: 'busy', code: 'CANCELLATION', after: 'ready' });
      report.checks.push('cancel-long-running-work');

      const resetDuring = await page.evaluate(async () => {
        const running = compiler.run({ files: { 'main.cpp': 'int main(){volatile int n=0;for(;;){n=1;}}' }, entry: 'main.cpp' });
        await new Promise(resolve => setTimeout(resolve, 500));
        const recovery = compiler.reset();
        const code = await errorCode(running);
        await recovery;
        return { code, state: compiler.getState() };
      });
      assert.deepEqual(resetDuring, { code: 'RESET_ERROR', state: 'ready' });
      report.checks.push('reset-during-execution');

      const disposed = await page.evaluate(async () => {
        const running = compiler.run({ files: { 'main.cpp': 'int main(){volatile int n=0;for(;;){n=1;}}' }, entry: 'main.cpp' });
        await new Promise(resolve => setTimeout(resolve, 500));
        await compiler.dispose();
        const code = await errorCode(running);
        await compiler.dispose();
        return { code, state: compiler.getState(), info: compiler.getCompilerInfo(), later: await errorCode(compiler.initialize()) };
      });
      assert.equal(disposed.code, 'COMPILER_DISPOSED');
      assert.equal(disposed.state, 'disposed');
      assert.equal(disposed.info, null);
      assert.equal(disposed.later, 'COMPILER_DISPOSED');
      report.checks.push('dispose-during-work-idempotency');

      const protocol = await page.evaluate(async () => {
        const ActualWorker = window.Worker;
        const spawned = [];
        class FakeWorker {
          constructor() { this.sent = []; this.terminated = false; spawned.push(this); }
          postMessage(data) { this.sent.push(data); }
          terminate() { this.terminated = true; }
          emit(data) { this.onmessage?.({ data }); }
        }
        const emitResult = (worker, id, result) => worker.emit({
          type: 'result', id, operation: worker.sent.find(request => request.id === id)?.type, result
        });
        const metadata = { clang: 'clang test', lld: 'lld test', commit: 'test', defaultStandard: 'c++17', abi: 'wasi_unstable' };
        const result = { status: 'success', stage: 'link', exitCode: 0, stdout: '', stderr: '', trap: null, diagnostics: [], steps: [], artifact: null, durationMs: 1 };
        window.Worker = FakeWorker;
        try {
          const c = new CppCompiler();
          const init = c.initialize();
          const firstWorker = spawned[0];
          const initId = firstWorker.sent[0].id;
          firstWorker.emit({ type: 'result', id: 'unknown', result: metadata });
          emitResult(firstWorker, initId, metadata);
          await init;
          const input = { files: { 'main.cpp': 'int main(){}' }, entry: 'main.cpp' };
          const one = c.compile(input);
          const firstId = firstWorker.sent.at(-1).id;
          firstWorker.emit({ type: 'progress', id: firstId, stage: 'compile' });
          emitResult(firstWorker, firstId, result);
          await one;
          const two = c.compile(input);
          const secondId = firstWorker.sent.at(-1).id;
          emitResult(firstWorker, firstId, { ...result, status: 'compile-error' });
          const stillBusy = c.isBusy();
          emitResult(firstWorker, secondId, result);
          await two;
          const three = c.compile(input);
          firstWorker.onerror?.({ message: 'simulated crash' });
          const failure = await errorCode(three);
          const fatal = c.getState();
          const reset = c.reset();
          const secondWorker = spawned[1];
          emitResult(firstWorker, firstId, metadata);
          emitResult(secondWorker, secondWorker.sent[0].id, metadata);
          await reset;
          const ready = c.getState();
          await c.dispose();
          const retry = new CppCompiler();
          const badInit = retry.initialize();
          const retryWorker = spawned[2];
          retryWorker.emit({ type: 'error', id: retryWorker.sent[0].id, operation: 'init', error: { code: 'INITIALIZATION_FAILED', message: 'missing asset' } });
          const initFailure = await errorCode(badInit);
          const retryState = retry.getState();
          const goodInit = retry.initialize();
          emitResult(retryWorker, retryWorker.sent[1].id, metadata);
          await goodInit;
          const malformed = retry.compile(input);
          retryWorker.emit({ type: 'result', id: retryWorker.sent[2].id, operation: 'run', result });
          const malformedCode = await errorCode(malformed);
          const malformedState = retry.getState();
          await retry.dispose();
          return { ids: [initId, firstId, secondId], stillBusy, failure, fatal, ready,
            firstTerminated: firstWorker.terminated, listenersCleared: firstWorker.onmessage === null,
            secondTerminated: secondWorker.terminated, initFailure, retryState, malformedCode, malformedState };
        } finally { window.Worker = ActualWorker; }
      });
      assert.deepEqual(protocol.ids, ['1', '2', '3']);
      assert.equal(protocol.stillBusy, true);
      assert.equal(protocol.failure, 'WORKER_ERROR');
      assert.equal(protocol.fatal, 'fatal');
      assert.equal(protocol.ready, 'ready');
      assert.ok(protocol.firstTerminated && protocol.listenersCleared && protocol.secondTerminated);
      assert.equal(protocol.initFailure, 'INITIALIZATION_ERROR');
      assert.equal(protocol.retryState, 'created');
      assert.equal(protocol.malformedCode, 'WORKER_ERROR');
      assert.equal(protocol.malformedState, 'fatal');
      report.checks.push('request-ids-matching-stale-unknown-worker-failure');

      console.log(`${name}: ${report.checks.length} public API groups PASS`);
      report.requests = requests.map(request => new URL(request).pathname);
    } catch (error) {
      report.failures.push(String(error.stack || error));
      process.exitCode = 1;
      console.error(`${name}:`, error);
    } finally {
      await writeFile(`evidence/phase3-${name}.json`, JSON.stringify(report, null, 2) + '\n');
      await browser.close();
    }
  }
} finally { server.close(); }
