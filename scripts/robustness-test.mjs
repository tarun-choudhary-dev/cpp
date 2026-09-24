import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import { chromium, firefox } from 'playwright';
import { serve } from './static-server.mjs';
import { ProjectSnapshot } from '../src/project.js';
import { VirtualFileSystem } from '../src/virtual-fs.js';
import { ResourceLimits } from '../src/resource-limits.js';
import { validWorkerResult } from '../src/worker-result.js';

const protocolText = await readFile(new URL('../worker/protocol.js', import.meta.url), 'utf8');
const runtimeText = await readFile(new URL('../worker/runtime.js', import.meta.url), 'utf8');
const internals = runInNewContext(`${protocolText}\n${runtimeText}\n({ protocol: WorkerProtocol, limits: WorkerLimits, Runtime: CompilerWorkerRuntime })`, { performance });
assert.deepEqual(JSON.parse(JSON.stringify(internals.limits)), ResourceLimits);
const atLimit = (action, code = 'RESOURCE_LIMIT') => assert.throws(action, error => error.code === code);
const entries = count => Array.from({ length: count }, (_, i) => [`f${i}.hpp`, '']);
new VirtualFileSystem(entries(ResourceLimits.files - 1));
new VirtualFileSystem(entries(ResourceLimits.files));
atLimit(() => new VirtualFileSystem(entries(ResourceLimits.files + 1)));
const exactFile = 'x'.repeat(ResourceLimits.fileChars);
new ProjectSnapshot({ files: { 'main.cpp': exactFile }, entry: 'main.cpp' });
atLimit(() => new ProjectSnapshot({ files: { 'main.cpp': exactFile + 'x' }, entry: 'main.cpp' }));
const totalFiles = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`f${i}.cpp`, exactFile]));
new ProjectSnapshot({ files: totalFiles, entry: 'f0.cpp' });
atLimit(() => new ProjectSnapshot({ files: { ...totalFiles, 'extra.hpp': 'x' }, entry: 'f0.cpp' }));
new ProjectSnapshot({ files: { 'main.cpp': '' }, entry: 'main.cpp', stdin: 'x'.repeat(ResourceLimits.stdinChars) });
atLimit(() => new ProjectSnapshot({ files: { 'main.cpp': '' }, entry: 'main.cpp', stdin: 'x'.repeat(ResourceLimits.stdinChars + 1) }));
const rawJob = (files, stdin = '') => ({ files, sources: [Object.keys(files)[0]], stdin });
internals.protocol.job(rawJob(Object.fromEntries(entries(ResourceLimits.files))));
atLimit(() => internals.protocol.job(rawJob(Object.fromEntries(entries(ResourceLimits.files + 1)))));
internals.protocol.job(rawJob({ 'main.cpp': exactFile }));
atLimit(() => internals.protocol.job(rawJob({ 'main.cpp': exactFile + 'x' })));
internals.protocol.job(rawJob(totalFiles));
atLimit(() => internals.protocol.job(rawJob({ ...totalFiles, 'extra.hpp': 'x' })));
internals.protocol.job(rawJob({ 'main.cpp': '' }, 'x'.repeat(ResourceLimits.stdinChars)));
atLimit(() => internals.protocol.job(rawJob({ 'main.cpp': '' }, 'x'.repeat(ResourceLimits.stdinChars + 1))));
internals.protocol.artifact({ byteLength: ResourceLimits.artifactBytes });
atLimit(() => internals.protocol.artifact({ byteLength: ResourceLimits.artifactBytes + 1 }));
const warnings = count => Array.from({ length: count }, (_, i) => `main.cpp:${i + 1}:1: warning: w`).join('\n');
assert.equal(internals.protocol.diagnostics('compile', warnings(ResourceLimits.diagnostics)).truncated, false);
const excessDiagnostics = internals.protocol.diagnostics('compile', warnings(ResourceLimits.diagnostics + 1));
assert.equal(excessDiagnostics.length, ResourceLimits.diagnostics);
assert.equal(excessDiagnostics.truncated, true);
const longDiagnostic = internals.protocol.diagnostics('compile', `warning: ${'x'.repeat(ResourceLimits.diagnosticChars + 1)}`);
assert.equal(longDiagnostic.truncated, true);
assert.ok(longDiagnostic[0].raw.length <= ResourceLimits.diagnosticChars);
const sampleResult = { status: 'success', stage: 'link', exitCode: 0, stdout: '', stderr: '', trap: null,
  diagnostics: [], steps: [], artifact: null, durationMs: 1 };
assert.ok(validWorkerResult(sampleResult, 'compile'));
assert.equal(validWorkerResult({ ...sampleResult, status: 'surprise' }, 'compile'), false);
assert.equal(validWorkerResult({ ...sampleResult, stdout: 'x'.repeat(ResourceLimits.outputChars + 1) }, 'compile'), false);
assert.equal(validWorkerResult({ ...sampleResult, diagnostics: [{ bad: true }] }, 'compile'), false);
const oversizedBytes = new Uint8Array(ResourceLimits.artifactBytes + 1);
assert.equal(validWorkerResult({ ...sampleResult, artifact: { format: 'wasm', abi: 'wasi_unstable', bytes: oversizedBytes.subarray(0, ResourceLimits.artifactBytes) } }, 'compile'), true);
assert.equal(validWorkerResult({ ...sampleResult, artifact: { format: 'wasm', abi: 'wasi_unstable', bytes: oversizedBytes } }, 'compile'), false);
async function captured(text, stream = 1) {
  const api = { memfs: { hostWrite() {} } };
  api.run = async () => { api.memfs.hostWrite(text, stream); return null; };
  return new internals.Runtime().command(api, 'execute', {}, ['program'], { remaining: ResourceLimits.outputChars });
}
assert.equal((await captured('x'.repeat(ResourceLimits.outputChars - 1))).stdoutTruncated, false);
assert.equal((await captured('x'.repeat(ResourceLimits.outputChars))).stdoutTruncated, false);
const clipped = await captured('x'.repeat(ResourceLimits.outputChars + 1));
assert.equal(clipped.stdout.length, ResourceLimits.outputChars);
assert.equal(clipped.stdoutTruncated, true);
const stderrClipped = await captured('x'.repeat(ResourceLimits.outputChars + 1), 2);
assert.equal(stderrClipped.stderr.length, ResourceLimits.outputChars);
assert.equal(stderrClipped.stderrTruncated, true);
const surrogateClipped = await captured('x'.repeat(ResourceLimits.outputChars - 1) + '😀');
assert.equal(surrogateClipped.stdout.length, ResourceLimits.outputChars - 1);
assert.equal(surrogateClipped.stdoutTruncated, true);
assert.equal(surrogateClipped.stdout.includes('\ud83d'), false);
console.log('resource, diagnostic, artifact and capture boundaries: direct tests PASS');

const { server, url } = await serve();
const hello = { files: { 'main.cpp': '#include <iostream>\nint main(){std::cout<<"recovered";}' }, entry: 'main.cpp' };
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
        const { WorkerClient } = await import('/src/worker-client.js');
        window.CppCompiler = CppCompiler;
        window.WorkerClient = WorkerClient;
        window.compiler = new CppCompiler();
        window.errorCode = async promise => { try { await promise; return null; } catch (error) { return error.code; } };
        await compiler.initialize();
      });
      await context.setOffline(true);
      const offlineStart = requests.length;
      const normal = await page.evaluate(async input => {
        const compiled = await compiler.compile(input);
        const ran = await compiler.run(input);
        window.retainedArtifact = compiled.artifact.bytes;
        return { compile: compiled.status, run: ran.status, stdout: ran.stdout, artifact: WebAssembly.validate(retainedArtifact) };
      }, hello);
      assert.deepEqual(normal, { compile: 'success', run: 'success', stdout: 'recovered', artifact: true });
      report.checks.push('normal-compile-run-and-artifact');

      const isolated = await page.evaluate(async () => {
        const write = await compiler.run({ files: { 'main.cpp': '#include <fstream>\nint main(){std::ofstream f("job-marker.txt");f<<"secret";}' }, entry: 'main.cpp' });
        const read = await compiler.run({ files: { 'main.cpp': '#include <fstream>\n#include <iostream>\nint main(){std::ifstream f("job-marker.txt");std::cout<<(f.good()?"leak":"isolated");}' }, entry: 'main.cpp' });
        return { write: write.status, read: read.status, stdout: read.stdout, retained: WebAssembly.validate(retainedArtifact) };
      });
      assert.deepEqual(isolated, { write: 'success', read: 'success', stdout: 'isolated', retained: true });
      report.checks.push('fresh-job-filesystem-and-artifact-ownership');

      const bounded = await page.evaluate(async () => {
        const result = await compiler.run({ files: { 'main.cpp': '#include <iostream>\n#include <string>\nint main(){std::cout<<std::string(1048577, \'x\');}' }, entry: 'main.cpp' });
        return { status: result.status, length: result.stdout.length, stdoutTruncated: result.stdoutTruncated,
          outputTruncated: result.outputTruncated, stepTruncated: result.steps.at(-1).stdoutTruncated };
      });
      assert.deepEqual(bounded, { status: 'success', length: ResourceLimits.outputChars,
        stdoutTruncated: true, outputTruncated: true, stepTruncated: true });
      report.checks.push('real-program-output-capped-with-truncation-metadata');
      const diagnosticBound = await page.evaluate(async () => {
        const source = Array.from({ length: 513 }, (_, i) => `#warning marker-${i}`).join('\n') + '\nint main(){return 0;}';
        const result = await compiler.compile({ files: { 'main.cpp': source }, entry: 'main.cpp' });
        return { status: result.status, count: result.diagnostics.length,
          diagnosticsTruncated: result.diagnosticsTruncated, rawWarnings: (result.steps[0].stderr.match(/warning:/g) || []).length };
      });
      assert.equal(diagnosticBound.status, 'success');
      assert.equal(diagnosticBound.count, ResourceLimits.diagnostics);
      assert.equal(diagnosticBound.diagnosticsTruncated, true);
      assert.ok(diagnosticBound.rawWarnings > diagnosticBound.count);
      report.checks.push('real-compiler-diagnostics-capped-with-raw-stderr-retained');
      assert.equal(await page.evaluate(() => errorCode(compiler.compile({ files: { 'main.cpp': 'x'.repeat(1048577) }, entry: 'main.cpp' }))), 'RESOURCE_LIMIT');
      assert.equal(await page.evaluate(() => errorCode(compiler.run({ files: { 'main.cpp': '' }, entry: 'main.cpp', stdin: 'x'.repeat(1048577) }))), 'RESOURCE_LIMIT');
      report.checks.push('public-source-and-stdin-limits-before-worker');
      assert.equal(requests.length, offlineStart);
      report.offlineRequests = requests.length - offlineStart;
      await context.setOffline(false); // Replacement Workers must reload assets.

      const timed = await page.evaluate(async input => {
        const started = performance.now();
        const operation = compiler.run({ files: { 'main.cpp': 'int main(){volatile int x=0;for(;;){x++;}}' }, entry: 'main.cpp' });
        let code, stage;
        try { await operation; } catch (error) { code = error.code; stage = error.stage; }
        const elapsedMs = performance.now() - started;
        await compiler.initialize(); // Wait for automatic replacement.
        const next = await compiler.run(input);
        return { code, stage, elapsedMs, state: compiler.getState(), stdout: next.stdout,
          artifactValid: WebAssembly.validate(retainedArtifact) };
      }, hello);
      assert.equal(timed.code, 'TIMEOUT');
      assert.equal(timed.stage, 'execute');
      assert.ok(timed.elapsedMs >= 14000 && timed.elapsedMs < 30000, JSON.stringify(timed));
      assert.equal(timed.state, 'ready');
      assert.equal(timed.stdout, 'recovered');
      assert.equal(timed.artifactValid, true);
      report.checks.push('infinite-execution-timeout-and-fresh-worker-recovery');
      await page.evaluate(() => compiler.dispose());

      const synthetic = await page.evaluate(async input => {
        const NativeWorker = window.Worker;
        const instances = [];
        const metadata = { clang: 'test', lld: 'test', commit: 'test', defaultStandard: 'c++17', abi: 'wasi_unstable' };
        const result = { status: 'success', stage: 'link', exitCode: 0, stdout: '', stderr: '', trap: null,
          diagnostics: [], steps: [], artifact: null, durationMs: 1 };
        class FakeWorker {
          constructor() { this.sent = []; this.terminated = false; instances.push(this); }
          postMessage(data) { this.sent.push(data); }
          terminate() { this.terminated = true; }
          emit(data) { this.onmessage?.({ data }); }
          answerInit() { this.emit({ type: 'result', id: this.sent[0].id, operation: 'init', result: metadata }); }
          answerLast(override = result) { const request = this.sent.at(-1); this.emit({ type: 'result', id: request.id, operation: request.type, result: override }); }
        }
        window.Worker = FakeWorker;
        const checks = [];
        const ready = async () => {
          const c = new CppCompiler();
          const init = c.initialize();
          instances.at(-1).answerInit();
          await init;
          return c;
        };
        try {
          const initial = new CppCompiler();
          const init = initial.initialize();
          const first = instances.at(-1);
          const late = first.onmessage;
          const replacement = initial.cancel();
          const initCode = await errorCode(init);
          instances.at(-1).answerInit();
          await replacement;
          late({ data: { type: 'result', id: first.sent[0].id, operation: 'init', result: metadata } });
          if (initCode !== 'CANCELLATION' || initial.getState() !== 'ready' || !first.terminated || first.onmessage !== null) throw Error('cancel init');
          checks.push('cancel-initialization');
          await initial.dispose();

          for (const stage of ['compile', 'link', 'execute']) {
            const c = await ready();
            const old = instances.at(-1);
            const pending = c.run(input);
            const request = old.sent.at(-1);
            old.emit({ type: 'progress', id: request.id, stage });
            const stale = old.onmessage;
            const recovery = c.cancel();
            const again = c.cancel();
            const code = await errorCode(pending);
            const blocked = await errorCode(c.compile(input));
            const fresh = instances.at(-1);
            fresh.answerInit();
            await Promise.all([recovery, again]);
            const next = c.compile(input);
            stale({ data: { type: 'result', id: request.id, operation: 'compileAndRun', result } });
            fresh.answerLast();
            await next;
            if (code !== 'CANCELLATION' || blocked !== 'COMPILER_NOT_READY' || !c.isReady() || !old.terminated || old.onmessage !== null) throw Error(`cancel ${stage}`);
            checks.push(`cancel-${stage}-double-and-stale`);
            await c.dispose();
          }

          const overlap = await ready();
          const overlapping = overlap.run(input);
          const cancelled = overlap.cancel();
          const concurrentReset = overlap.reset();
          const cancelledCode = await errorCode(overlapping);
          instances.at(-1).answerInit();
          await Promise.all([cancelled, concurrentReset]);
          const secondJob = overlap.run(input);
          const interruptedRecovery = overlap.cancel();
          const secondCode = await errorCode(secondJob);
          await overlap.dispose();
          const recoveryCode = await errorCode(interruptedRecovery);
          if (cancelledCode !== 'CANCELLATION' || secondCode !== 'CANCELLATION' ||
              recoveryCode !== 'COMPILER_DISPOSED' || overlap.getState() !== 'disposed') throw Error('cancel/reset/dispose overlap');
          checks.push('cancel-reset-and-dispose-overlap');

          const c = await ready();
          const worker = instances.at(-1);
          const complete = c.compile(input);
          worker.answerLast();
          await complete;
          await c.cancel(); // A completed job is a no-op.
          if (instances.at(-1) !== worker) throw Error('cancel completed');
          const firstRun = c.run(input);
          const busyA = await errorCode(c.run(input));
          const busyB = await errorCode(c.compile(input));
          const stale = worker.onmessage;
          const reset = c.reset();
          const resetCode = await errorCode(firstRun);
          const fresh = instances.at(-1);
          fresh.answerInit();
          await reset;
          stale({ data: { type: 'error', id: worker.sent.at(-1).id, operation: 'compileAndRun', error: { code: 'WORKER_ERROR', message: 'late' } } });
          if (busyA !== 'COMPILER_BUSY' || busyB !== 'COMPILER_BUSY' || resetCode !== 'RESET_ERROR' || !c.isReady()) throw Error('busy/reset');
          checks.push('complete-cancel-busy-reset-stale-error');
          const active = c.compile(input);
          fresh.onerror({ message: 'simulated crash' });
          if (await errorCode(active) !== 'WORKER_ERROR' || c.getState() !== 'fatal') throw Error('worker crash');
          const recover = c.reset();
          instances.at(-1).answerInit();
          await recover;
          if (!c.isReady()) throw Error('crash recovery');
          checks.push('worker-crash-and-reset-recovery');
          const messageFailure = c.compile(input);
          instances.at(-1).onmessageerror();
          if (await errorCode(messageFailure) !== 'WORKER_ERROR' || c.getState() !== 'fatal') throw Error('messageerror');
          const messageRecovery = c.reset();
          instances.at(-1).answerInit();
          await messageRecovery;
          checks.push('messageerror-and-reset-recovery');
          const disposedJob = c.compile(input);
          const disposeWorker = instances.at(-1);
          const lateDispose = disposeWorker.onmessage;
          await c.dispose();
          const disposeCode = await errorCode(disposedJob);
          lateDispose({ data: { type: 'result', id: disposeWorker.sent.at(-1).id, operation: 'compile', result } });
          await c.dispose();
          if (disposeCode !== 'COMPILER_DISPOSED' || c.getState() !== 'disposed' || await errorCode(c.compile(input)) !== 'COMPILER_DISPOSED') throw Error('dispose');
          checks.push('dispose-pending-listeners-and-stale');

          for (const malformed of [null, [], { type: 'result', status: 'bad' },
            { type: 'result', result: { ...result, status: 'invalid' } },
            { type: 'result', result: Object.defineProperty({ ...result }, 'status', { get() { throw Error('unreadable'); } }) },
            { type: 'result', result: { ...result, diagnostics: [{ bogus: true }] } },
            { type: 'result', result: { ...result, artifact: { format: 'wasm', abi: 'wasi_unstable', bytes: 'invalid' } } },
            { type: 'error', error: { code: 7, message: 'invalid' } },
            { type: 'result', result: { ...result, stdout: 'x'.repeat(1048577) } }]) {
            const broken = await ready();
            const target = instances.at(-1);
            const pending = broken.compile(input);
            const request = target.sent.at(-1);
            target.emit(malformed && { ...malformed, id: request.id, operation: request.type });
            if (await errorCode(pending) !== 'WORKER_ERROR' || broken.getState() !== 'fatal' || !target.terminated) throw Error('malformed');
            const resetBroken = broken.reset();
            instances.at(-1).answerInit();
            await resetBroken;
            if (!broken.isReady()) throw Error('malformed recovery');
            await broken.dispose();
          }
          const badProgress = await ready();
          const progressWorker = instances.at(-1);
          const progressJob = badProgress.compile(input);
          progressWorker.emit({ type: 'progress', id: progressWorker.sent.at(-1).id, stage: 'execute' });
          if (await errorCode(progressJob) !== 'WORKER_ERROR' || badProgress.getState() !== 'fatal') throw Error('invalid progress');
          await badProgress.dispose();
          checks.push('malformed-worker-results-and-recovery');

          const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
          let stops = 0;
          const client = new WorkerClient('/fake.js', () => { stops++; });
          const transport = instances.at(-1);
          const done = client.request('init', {}, { timeoutMs: 25 });
          transport.answerInit();
          await done;
          await wait(40);
          if (client.pendingCount !== 0 || transport.terminated || stops) throw Error('settled init timer');
          const completedCompile = client.request('compile', {}, { timeoutMs: 25 });
          transport.answerLast();
          await completedCompile;
          await wait(40);
          if (client.pendingCount !== 0 || transport.terminated || stops) throw Error('settled compile timer');
          const timedCompile = client.request('compile', {}, { timeoutMs: 25 });
          transport.emit({ type: 'progress', id: transport.sent.at(-1).id, stage: 'compile' });
          const compileCode = await errorCode(timedCompile);
          if (compileCode !== 'TIMEOUT' || client.pendingCount !== 0 || !transport.terminated || stops) throw Error('compile watchdog');
          const executionClient = new WorkerClient('/fake.js', () => { stops++; });
          const executionWorker = instances.at(-1);
          const timedRun = executionClient.request('compileAndRun', {}, { timeoutMs: 1000, executionTimeoutMs: 25 });
          executionWorker.emit({ type: 'progress', id: executionWorker.sent.at(-1).id, stage: 'execute' });
          const runCode = await errorCode(timedRun);
          if (runCode !== 'TIMEOUT' || executionClient.pendingCount !== 0 || !executionWorker.terminated || stops) throw Error('execute watchdog');
          checks.push('compile-execute-watchdogs-and-timer-cleanup');
          const initClient = new WorkerClient('/fake.js', () => { stops++; });
          const initWorker = instances.at(-1);
          const initTimeout = await errorCode(initClient.request('init', {}, { timeoutMs: 25 }));
          if (initTimeout !== 'TIMEOUT' || !initWorker.terminated || initClient.pendingCount !== 0) throw Error('init watchdog');
          checks.push('initialization-watchdog');
          const nativeTimer = window.setTimeout;
          window.setTimeout = (callback, delay, ...args) => nativeTimer(callback, delay === 45000 ? 25 : delay, ...args);
          try {
            const startup = new CppCompiler();
            const pendingStart = startup.initialize();
            const originalWorker = instances.at(-1);
            const startupCode = await errorCode(pendingStart);
            if (startupCode !== 'TIMEOUT' || startup.getState() !== 'created' || !originalWorker.terminated) throw Error('public init timeout');
            const retry = startup.initialize();
            instances.at(-1).answerInit();
            await retry;
            if (!startup.isReady()) throw Error('public init recovery');
            await startup.dispose();
          } finally { window.setTimeout = nativeTimer; }
          checks.push('public-initialization-timeout-and-retry');
          window.setTimeout = (callback, delay, ...args) => nativeTimer(callback, delay === 60000 ? 25 : delay, ...args);
          try {
            const buildCompiler = await ready();
            const hangingWorker = instances.at(-1);
            const hanging = buildCompiler.compile(input);
            const buildCode = await errorCode(hanging);
            if (buildCode !== 'TIMEOUT' || !hangingWorker.terminated) throw Error('public compile timeout');
            instances.at(-1).answerInit();
            await buildCompiler.initialize();
            const recoveredBuild = buildCompiler.compile(input);
            instances.at(-1).answerLast();
            await recoveredBuild;
            if (!buildCompiler.isReady()) throw Error('public compile recovery');
            await buildCompiler.dispose();
          } finally { window.setTimeout = nativeTimer; }
          checks.push('public-compilation-timeout-and-replacement');
          return { checks, workers: instances.length, stoppedWorkers: instances.filter(w => w.terminated).length };
        } finally { window.Worker = NativeWorker; }
      }, hello);
      assert.equal(synthetic.checks.length, 14);
      report.checks.push(...synthetic.checks);
      console.log(`${name}: ${report.checks.length} Phase 7 robustness groups PASS`);
    } catch (error) {
      report.failures.push(String(error.stack || error));
      process.exitCode = 1;
      console.error(`${name}:`, error);
    } finally {
      await writeFile(`evidence/phase7-${name}.json`, JSON.stringify(report, null, 2) + '\n');
      await browser.close();
    }
  }
} finally { server.close(); }
