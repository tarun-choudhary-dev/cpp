import { chromium, firefox } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { serve } from './static-server.mjs';
import { cases } from '../poc/cases.mjs';

const { server, url } = await serve();
try {
  for (const name of (process.env.BROWSERS || 'chromium,firefox').split(',')) {
    const browser = await ({ chromium, firefox })[name].launch();
    const report = { browser: name, version: browser.version(), recordedAt: new Date().toISOString(), results: [], lifecycle: [], failures: [] };
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const requests = [];
      const blocked = new Set();
      await context.route('**/*', route => {
        const r = route.request();
        requests.push({ path: new URL(r.url()).pathname, method: r.method(), external: !r.url().startsWith(url + '/') });
        if (!r.url().startsWith(url + '/') || r.method() !== 'GET') return route.abort();
        if (blocked.has(new URL(r.url()).pathname)) return route.fulfill({ status: 404, body: 'Test missing asset' });
        return route.continue();
      });
      const page = await context.newPage();
      await page.goto(url + '/poc/blank.html');
      await page.evaluate(() => {
        // Test-only transport. Production code is entirely worker-side.
        window.startWorker = () => {
          window.worker?.terminate();
          window.worker = new Worker('/worker/compiler-worker.js');
          window.pending = new Map();
          window.arrival = [];
          worker.onmessage = ({ data }) => {
            if (data.type === 'progress') return;
            arrival.push(data.id);
            const p = pending.get(data.id);
            if (p) { clearTimeout(p.timer); pending.delete(data.id); p.resolve(data); }
          };
          worker.onerror = e => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(e.message)); } pending.clear(); };
        };
        window.send = request => new Promise((resolve, reject) => {
          const timer = setTimeout(() => { worker.terminate(); reject(new Error(`Worker timeout: ${request?.id}`)); }, 60000);
          pending.set(typeof request?.id === 'string' ? request.id : null, { resolve, reject, timer });
          worker.postMessage(request);
        });
        startWorker();
      });
      const send = request => page.evaluate(data => send(data), request);
      const job = (id, source = 'int main(){return 0;}') => ({ type: 'compileAndRun', id, files: { 'main.cpp': source }, sources: ['main.cpp'] });
      const checkError = async (request, code) => {
        const r = await send(request); assert.equal(r.type, 'error'); assert.equal(r.error.code, code); report.lifecycle.push(r); return r;
      };
      await checkError(null, 'INVALID_REQUEST');
      await checkError({ type: 'unknown', id: 'unknown' }, 'INVALID_REQUEST');
      await context.setOffline(true);
      await checkError(job('before-init'), 'NOT_INITIALIZED');
      await context.setOffline(false);
      await checkError({ type: 'init', id: 'bad-base', assetBase: 'https://example.org/compiler/' }, 'INVALID_REQUEST');
      blocked.add('/poc/vendor/wasm-clang/clang');
      await checkError({ type: 'init', id: 'missing-asset' }, 'INITIALIZATION_FAILED');
      blocked.clear();
      const initializations = await page.evaluate(() => Promise.all([send({ type: 'init', id: 'init1' }), send({ type: 'init', id: 'init2' })]));
      assert.ok(initializations.every(r => r.ok), JSON.stringify(initializations));
      assert.deepEqual(initializations[0].result, initializations[1].result);
      assert.ok(initializations[0].result.clang.includes('8.0.1'));
      assert.equal(initializations[0].result.worker, true);
      assert.equal(initializations[0].result.crossOriginIsolated, false);
      report.initialization = initializations;
      await context.setOffline(true);
      const afterInit = requests.length;
      await checkError({ type: 'init', id: 'switch-base', assetBase: '/another/' }, 'ALREADY_INITIALIZED');
      const again = await send({ type: 'init', id: 'offline-init' }); assert.ok(again.ok);
      for (const [id, patch] of [
        ['traversal', { files: { '../oops.cpp': '' }, sources: ['../oops.cpp'] }],
        ['reserved', { files: { 'include/iostream': '' }, sources: ['include/iostream'] }],
        ['missing-source', { sources: ['absent.cpp'] }],
        ['directory-conflict', { files: { a: '', 'a/main.cpp': '' }, sources: ['a/main.cpp'] }],
        ['bad-stdin', { stdin: 7 }],
        ['flags', { compilerFlags: ['-O3'] }]
      ]) await checkError({ ...job(id), ...patch }, 'INVALID_REQUEST');

      const phase1 = JSON.parse(await readFile(`evidence/${name}.json`, 'utf8'));
      const normalizeArgs = step => step.args.map(a => a.endsWith('.o') && !a.includes('crt1.o') ? '<object>' : a.endsWith('.wasm') ? '<output>' : a);
      for (const test of cases) {
        const { expect, ...input } = test;
        const response = await send({ ...input, type: 'compileAndRun' });
        const result = response.result;
        // Persist artifact metadata rather than hundreds of KB of JSON-encoded binary per test.
        report.results.push({ ...response, result: result && { ...result, artifact: result.artifact && { ...result.artifact, bytes: undefined, byteLength: Object.keys(result.artifact.bytes).length } } });
        assert.equal(response.type, 'result', JSON.stringify(response));
        const baseline = phase1.results.find(r => r.id === test.id);
        assert.deepEqual(result.steps.map(s => s.stage), baseline.steps.map(s => s.stage), test.id);
        for (let i = 0; i < result.steps.length; i++) {
          assert.deepEqual(normalizeArgs(result.steps[i]), normalizeArgs(baseline.steps[i]), `${test.id}: command parity`);
          assert.equal(result.steps[i].exitCode, baseline.steps[i].exitCode, `${test.id}: exit parity`);
          assert.equal(result.steps[i].stdout, baseline.steps[i].stdout, `${test.id}: stdout parity`);
        }
        const last = result.steps.at(-1);
        if (expect.failure) {
          assert.equal(result.status, `${expect.failure}-error`);
          assert.ok(last.stderr.includes(expect.diagnostic));
          assert.ok(result.diagnostics.length > 0);
          assert.equal(result.artifact, null);
          if (test.id === 'syntax-error') {
            const diagnostic = result.diagnostics.find(d => d.severity === 'error');
            assert.equal(diagnostic.file, 'syntax-error.cpp');
            assert.equal(diagnostic.line, 1);
            assert.ok(diagnostic.column > 0);
          }
        } else if (!expect.observation) {
          assert.equal(result.exitCode, expect.exitCode);
          assert.equal(result.stdout, expect.stdout);
          assert.equal(result.stderr, expect.stderr || '');
          assert.equal(response.ok, expect.exitCode === 0);
          assert.ok(result.artifact);
        }
        console.log(`${name} ${test.id}: Phase 1 parity PASS`);
      }

      const compileOnly = await send({ ...job('compile-only', 'int main(){for(;;){} }'), type: 'compile' });
      assert.ok(compileOnly.ok);
      assert.deepEqual(compileOnly.result.steps.map(s => s.stage), ['compile', 'link']);
      assert.deepEqual(Object.values(compileOnly.result.artifact.bytes).slice(0, 4), [0, 97, 115, 109]);
      report.lifecycle.push({ check: 'compile-only', ok: true });

      const nested = await send({ ...job('nested'), files: {
        'src/main.cpp': '#include "headers/answer.h"\nint main(){return answer()!=42;}',
        'headers/answer.h': 'inline int answer(){return 42;}'
      }, sources: ['src/main.cpp'] });
      assert.ok(nested.ok, JSON.stringify(nested)); report.lifecycle.push({ check: 'nested-headers', ok: true });

      const written = await send(job('write-leak', '#include <fstream>\nint main(){std::ofstream f("leaked.h"); f<<"#define LEAK 1";}'));
      assert.ok(written.ok);
      const missing = await send(job('read-leak', '#include "leaked.h"\nint main(){}'));
      assert.equal(missing.result.status, 'compile-error');
      assert.ok(missing.result.stderr.includes('file not found')); report.lifecycle.push({ check: 'filesystem-isolation', ok: true });

      const trapped = await send(job('trap', 'int main(){__builtin_trap();}'));
      assert.equal(trapped.result.status, 'trap'); assert.equal(trapped.result.exitCode, null);
      assert.equal(trapped.result.trap.name, 'RuntimeError'); report.lifecycle.push(trapped.result.trap);
      const reservedExit = await send(job('reserved-exit', 'int main(){return 0xC0C0A;}'));
      assert.equal(reservedExit.result.status, 'nonzero-exit');
      assert.equal(reservedExit.result.exitCode, 0xC0C0A);
      report.lifecycle.push({ check: 'preserve-demo-reserved-exit', ok: true });
      const queueJobs = [job('queue-a', '#include <iostream>\nint main(){std::cout<<"A";}'), job('queue-b', '#include <iostream>\nint main(){std::cerr<<"B";return 9;}'), job('queue-c')];
      const queued = await page.evaluate(inputs => Promise.all(inputs.map(x => send(x))), queueJobs);
      assert.equal(queued[0].result.stdout, 'A'); assert.equal(queued[0].result.stderr, '');
      assert.equal(queued[1].result.stderr, 'B'); assert.equal(queued[1].result.stdout, '');
      assert.equal(queued[1].result.exitCode, 9); assert.ok(queued[2].ok);
      assert.deepEqual(await page.evaluate(() => arrival.slice(-3)), ['queue-a', 'queue-b', 'queue-c']);
      report.lifecycle.push({ check: 'fifo-streams-and-recovery', ok: true });
      const disposal = await send({ type: 'dispose', id: 'dispose' });
      assert.equal(disposal.result.disposed, true);
      report.lifecycle.push(disposal);
      assert.equal(requests.length, afterInit, 'Unexpected request after initialization');
      assert.ok(requests.every(r => !r.external && r.method === 'GET'));
      report.requestsDuringJobs = requests.length - afterInit;
      report.offlineBeforeSourceSubmission = true;
      // A new Worker needs acquisition again; no state survives dispose/terminate.
      await context.setOffline(false);
      await page.evaluate(() => startWorker());
      const restarted = await send({ type: 'init', id: 'restart-init' });
      assert.ok(restarted.ok); report.lifecycle.push({ check: 'restart-after-dispose', ok: true });
      await context.setOffline(true);
      const beforeCancellation = requests.length;
      const cancellation = await page.evaluate(input => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('Infinite-loop test did not enter execution')); }, 30000);
        worker.onmessage = ({ data }) => {
          if (data.type === 'progress' && data.stage === 'execute') {
            // Runs on the main thread while Wasm occupies the Worker.
            setTimeout(() => { worker.terminate(); clearTimeout(timer); resolve({ check: 'terminate-infinite-loop', ok: true, enteredExecution: true }); }, 50);
          } else if (data.type !== 'progress') { clearTimeout(timer); reject(new Error('Infinite loop returned unexpectedly')); }
        };
        worker.postMessage(input);
      }), job('infinite', 'int main(){volatile int n=0;for(;;){n=1;}}'));
      report.lifecycle.push(cancellation);
      assert.equal(requests.length, beforeCancellation);
      report.requestsDuringCancellation = requests.length - beforeCancellation;
      report.requests = requests;
    } catch (error) {
      report.failures.push(String(error.stack)); process.exitCode = 1; console.error(error);
    } finally {
      await writeFile(`evidence/phase2-${name}.json`, JSON.stringify(report, null, 2) + '\n');
      await browser.close();
    }
  }
} finally { server.close(); }
