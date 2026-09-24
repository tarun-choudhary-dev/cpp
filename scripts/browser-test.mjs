import { chromium, firefox, webkit } from 'playwright';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { serve } from './static-server.mjs';
import { cases } from '../poc/cases.mjs';

const { server, url } = await serve();
const reports = [];
try {
  for (const name of (process.env.BROWSERS || 'chromium,firefox').split(',')) {
    const browser = await ({ chromium, firefox, webkit })[name].launch();
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const requests = [];
      await context.route('**/*', route => {
        const req = route.request();
        requests.push({ url: new URL(req.url()).pathname, method: req.method(), external: !req.url().startsWith(url + '/') });
        return req.url().startsWith(url + '/') && req.method() === 'GET' ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      await page.goto(url + '/poc/blank.html');
      const init = await page.evaluate(() => {
        const worker = new Worker('./worker.js');
        window.phase1Worker = worker;
        window.sendTest = data => new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Worker timeout')); }, 60000);
          worker.onerror = e => { clearTimeout(timeout); reject(new Error(e.message)); };
          worker.onmessage = e => { clearTimeout(timeout); resolve(e.data); };
          worker.postMessage(data);
        });
        return window.sendTest({ type: 'init' });
      });
      assert.equal(init.ready, true, JSON.stringify(init));
      assert.equal(init.worker, true);
      assert.equal(init.crossOriginIsolated, false, 'This baseline should work without COOP/COEP');
      // Disable ALL transport before sending any C++ source, not just external requests.
      await context.setOffline(true);
      const requestsAfterInit = requests.length;
      const results = [];
      const failures = [];
      for (const test of cases) {
        const { expect, ...input } = test;
        const result = await page.evaluate(data => window.sendTest(data), input);
        results.push(result);
        try {
          assert.ok(!result.error, result.error);
          const last = result.steps.at(-1);
          if (expect.observation) { /* Record, without claiming expected support. */ }
          else if (expect.failure) {
            assert.equal(last.stage, expect.failure);
            assert.ok(Number.isInteger(last.exitCode) && last.exitCode !== 0);
            assert.ok(last.stderr.includes(expect.diagnostic), last.stderr);
          } else {
            assert.equal(last.stage, 'execute');
            assert.equal(last.exitCode, expect.exitCode);
            assert.equal(last.stdout, expect.stdout);
            assert.equal(last.stderr, expect.stderr || '');
            assert.ok(result.wasmBytes > 8);
          }
          console.log(`${name} ${test.id}: ${expect.observation ? 'recorded' : 'PASS'}`);
        } catch (error) { failures.push({ id: test.id, error: String(error) }); console.error(`${name} ${test.id}: FAIL`, error.message); }
      }
      assert.equal(requests.length, requestsAfterInit, 'Network request during offline compilation');
      assert.ok(requests.every(r => !r.external && r.method === 'GET'));
      const report = { recordedAt: new Date().toISOString(), browser: name, version: browser.version(), init,
        offlineBeforeSourceSubmission: true, requestsDuringTests: requests.length - requestsAfterInit, requests, results, failures };
      reports.push(report);
      await writeFile(`evidence/${name}.json`, JSON.stringify(report, null, 2) + '\n');
      if (failures.length) process.exitCode = 1;
    } finally { await browser.close(); }
  }
} finally { server.close(); }
console.log(`${reports.length} browser(s) tested; raw evidence in evidence/.`);
