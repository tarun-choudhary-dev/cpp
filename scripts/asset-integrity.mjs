import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const names = ['clang', 'lld', 'memfs', 'sysroot.tar', 'shared.js', 'LICENSE', 'LICENSE.llvm'];
const vendor = path.resolve('poc/vendor/wasm-clang');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyAssets() {
  const manifest = JSON.parse(await readFile('research/assets.json', 'utf8'));
  if (manifest.commit !== '648c4a89997a351eef75cdaec3ef5b89d4937dec' ||
      !Array.isArray(manifest.files) ||
      JSON.stringify(manifest.files.map(file => file.name)) !== JSON.stringify(names)) {
    throw new Error('Pinned toolchain manifest has an unexpected commit or file list.');
  }
  const actual = (await readdir(vendor)).sort();
  const expected = [...names, 'shared-patched.js'].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected or missing toolchain asset: expected ${expected.join(', ')}; found ${actual.join(', ')}`);
  }
  const verified = [];
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(vendor, file.name));
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) {
      throw new Error(`Pinned toolchain asset differs: ${file.name}`);
    }
    verified.push({ path: `poc/vendor/wasm-clang/${file.name}`, bytes: bytes.length, sha256: file.sha256 });
  }
  const original = await readFile(path.join(vendor, 'shared.js'), 'utf8');
  const needle = 'this.hostWrite(str);';
  if (original.split(needle).length !== 2) throw new Error('Unexpected upstream shared.js patch target.');
  const derived = '// Phase 1 modification: forward fd to the output callback.\n' + original.replace(needle, 'this.hostWrite(str, fd);');
  const patched = await readFile(path.join(vendor, 'shared-patched.js'));
  if (!patched.equals(Buffer.from(derived))) throw new Error('Patched toolchain host differs from the deterministic descriptor patch.');
  verified.push({ path: 'poc/vendor/wasm-clang/shared-patched.js', bytes: patched.length, sha256: hash(patched) });
  return { manifest, verified };
}
