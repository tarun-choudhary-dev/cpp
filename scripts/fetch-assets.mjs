import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(await readFile('research/assets.json', 'utf8'));
await mkdir('poc/vendor/wasm-clang', { recursive: true });
for (const asset of manifest.files) {
  const dest = `poc/vendor/wasm-clang/${asset.name}`;
  let bytes;
  try { bytes = await readFile(dest); } catch {}
  const hash = data => createHash('sha256').update(data).digest('hex');
  if (!bytes || hash(bytes) !== asset.sha256) {
    const response = await fetch(asset.url);
    if (!response.ok) throw new Error(`${response.status}: ${asset.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== asset.sha256) throw new Error(`Hash mismatch: ${asset.name}`);
    await writeFile(dest, bytes);
  }
  console.log(`${asset.name}: ${bytes.length} bytes, SHA-256 verified`);
}
// The upstream callback discards the descriptor. Preserve it for separate streams.
const original = await readFile('poc/vendor/wasm-clang/shared.js', 'utf8');
const needle = 'this.hostWrite(str);';
if (original.split(needle).length !== 2) throw new Error('Unexpected upstream shared.js');
await writeFile('poc/vendor/wasm-clang/shared-patched.js',
  '// Phase 1 modification: forward fd to the output callback.\n' + original.replace(needle, 'this.hostWrite(str, fd);'));
