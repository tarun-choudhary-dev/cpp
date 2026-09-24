import { chromium } from 'playwright';
import { serve } from './static-server.mjs';
import { writeFile } from 'node:fs/promises';
const { server, url } = await serve({ isolated: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const requests = [];
  const downloads = [];
  const pendingDownloads = [];
  page.on('request', r => requests.push({ url: r.url(), method: r.method() }));
  page.on('response', r => {
    if (!r.url().startsWith(url) && r.request().method() === 'GET') {
      pendingDownloads.push((async () => {
        try { const body = await r.body(); downloads.push({ url: r.url(), bytes: body.length, status: r.status() }); }
        catch (e) { downloads.push({ url: r.url(), error: String(e) }); }
      })());
    }
  });
  page.on('console', m => console.log(m.type(), m.text().slice(0, 400)));
  await page.goto(url + '/poc/blank.html');
  const result = await page.evaluate(() => new Promise((resolve, reject) => {
    const w = new Worker('./wasmer-probe.mjs', { type: 'module' });
    const messages = [];
    const timer = setTimeout(() => { w.terminate(); resolve([...messages, { timeout: true, limitMs: 120000 }]); }, 120000);
    w.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); };
    w.onmessage = e => { messages.push(e.data); console.log(JSON.stringify(e.data)); if (e.data.done) { clearTimeout(timer); w.terminate(); resolve(messages); } };
    w.postMessage({});
  }));
  await Promise.allSettled(pendingDownloads);
  await writeFile('evidence/wasmer-probe.json', JSON.stringify({ recordedAt: new Date().toISOString(), sdk: '0.16.0', browser: browser.version(), result, requests, downloads }, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); server.close(); }
