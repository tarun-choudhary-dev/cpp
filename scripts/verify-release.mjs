import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('dist');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function list(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await list(path.join(directory, entry.name), name));
    else if (entry.isFile()) found.push(name);
    else throw new Error(`Unexpected release filesystem entry: ${name}`);
  }
  return found.sort();
}

const manifest = JSON.parse(await readFile(path.join(root, 'release-manifest.json'), 'utf8'));
const files = await list(root);
assert.equal(manifest.schema, 1);
assert.deepEqual(files, [...manifest.packageFiles.map(item => item.path), 'release-manifest.json'].sort(),
  'Release has missing or undeclared files');
assert.deepEqual(manifest.publicStandards, ['c++11', 'c++14', 'c++17']);
assert.equal(manifest.safari, 'unverified');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.deepEqual(pkg.exports, { '.': './src/index.js' });
assert.equal(pkg.name, manifest.engine.name);
assert.equal(pkg.version, manifest.engine.version);
assert.equal(pkg.license, manifest.engine.license);
assert.equal(pkg.private, true);
for (const item of manifest.packageFiles) {
  assert.ok(!path.isAbsolute(item.path) && !item.path.split('/').includes('..'));
  const bytes = await readFile(path.join(root, ...item.path.split('/')));
  assert.equal(bytes.length, item.bytes, `${item.path} byte length`);
  assert.equal(sha256(bytes), item.sha256, `${item.path} SHA-256`);
  if (/\.(?:js|json|html|md|txt)$/.test(item.path)) {
    const source = bytes.toString('utf8');
    assert.ok(!/[A-Z]:[\\/]Github[\\/]cpp|[A-Z]:[\\/]Users[\\/]/i.test(source), `${item.path} contains a local path`);
  }
}
const assetPaths = manifest.assets.map(item => item.path).sort();
assert.deepEqual(assetPaths, manifest.packageFiles.filter(item => item.path.startsWith('poc/vendor/wasm-clang/')).map(item => item.path).sort());
for (const asset of manifest.assets) {
  const packaged = manifest.packageFiles.find(file => file.path === asset.path);
  assert.equal(packaged.sha256, asset.sha256);
}
for (const required of ['src/index.js', 'worker/compiler-worker.js', 'LICENSE', 'THIRD_PARTY_NOTICES.txt',
  'README.md', 'CHANGELOG.md', 'guide/api/README.md', 'guide/security/README.md',
  'guide/toolchain/README.md', 'guide/testing/README.md', 'example/index.html', 'example/example.js']) {
  assert.ok(files.includes(required), `Missing release file: ${required}`);
}
assert.ok(files.every(file => !file.startsWith('scripts/') && !file.startsWith('research/') &&
  !file.startsWith('evidence/') && !file.startsWith('node_modules/') && !file.startsWith('docs/')));
console.log(`Release audit passed: ${files.length} declared files, ${manifest.assets.length} pinned/derived assets, ${pkg.version}.`);
