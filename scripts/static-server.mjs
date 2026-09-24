import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Test asset transport only. No compiler, uploads or execution endpoints.
export async function serve({ isolated = false } = {}) {
  const root = process.cwd();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = path.resolve(root, '.' + name);
      if (!file.startsWith(root + path.sep) || !['poc', 'worker', 'node_modules'].some(p => file.startsWith(path.join(root, p) + path.sep))) {
        res.writeHead(403).end(); return;
      }
      const body = await readFile(file);
      const ext = path.extname(file);
      res.writeHead(200, {
        'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' })[ext] || 'application/octet-stream',
        ...(isolated ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } : {}),
        'Cache-Control': 'no-store',
        'Content-Length': body.length
      }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
