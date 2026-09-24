import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyAssets } from './asset-integrity.mjs';

const root = process.cwd();
const output = path.resolve(root, 'dist');
if (output !== path.join(root, 'dist') || !output.startsWith(root + path.sep)) {
  throw new Error('Release output is outside the project.');
}

const sourceFiles = [
  'src/compiler-error.js', 'src/compiler-options.js', 'src/index.js', 'src/project.js',
  'src/resource-limits.js', 'src/virtual-fs.js', 'src/worker-client.js', 'src/worker-result.js',
  'worker/compiler-worker.js', 'worker/protocol.js', 'worker/runtime.js',
  'example/index.html', 'example/example.js',
  'guide/api/README.md', 'guide/security/README.md', 'guide/toolchain/README.md',
  'guide/testing/README.md'
];
const mappedFiles = [
  ['release/README.md', 'README.md'],
  ['release/THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt'],
  ['LICENSE', 'LICENSE']
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const { manifest: assets, verified } = await verifyAssets(); // Read-only, fails on missing/changed/unexpected assets.
const project = JSON.parse(await readFile('package.json', 'utf8'));
const changelog = JSON.parse(await readFile('release/changelog.json', 'utf8'));
if (project.name !== 'browser-cpp-engine' || project.version !== '0.1.0-rc.1' ||
    !['AGPL-3.0-only', 'AGPL-3.0-or-later', 'SEE LICENSE IN LICENSE'].includes(project.license) ||
    changelog.version !== project.version) {
  throw new Error('Release name, version, license or changelog does not match the pinned candidate.');
}

// Only this literal, verified directory is recursively replaced. Never copy the repository wholesale.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
async function copy(from, to = from) {
  const destination = path.join(output, ...to.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(root, ...from.split('/')), destination);
}
for (const name of sourceFiles) await copy(name);
for (const [from, to] of mappedFiles) await copy(from, to);
for (const asset of verified) await copy(asset.path);

const packageJson = {
  name: project.name, version: project.version, private: true, type: 'module',
  license: project.license, exports: { '.': './src/index.js' }
};
await writeFile(path.join(output, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
const sections = changelog.phases.map(({ phase, changes }) =>
  `## ${phase}\n\n${changes.map(change => `- ${change}`).join('\n')}`);
const changelogText = `# Changelog\n\nVersion ${changelog.version} is a release candidate; no package has been published.\n\n${sections.join('\n\n')}\n`;
await writeFile(path.join(output, 'CHANGELOG.md'), changelogText);
await writeFile(path.join(root, 'CHANGELOG.md'), changelogText); // Ignored locally under the user's Markdown policy.

async function listFiles(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await listFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) found.push(relative);
    else throw new Error(`Unsupported release entry: ${relative}`);
  }
  return found;
}
const packageFiles = [];
for (const file of (await listFiles(output)).sort()) {
  const bytes = await readFile(path.join(output, ...file.split('/')));
  packageFiles.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
}
const releaseManifest = {
  schema: 1,
  engine: { name: project.name, version: project.version, license: project.license },
  toolchain: { compiler: 'Clang 8.0.1', linker: 'LLD 8.0.1', abi: 'wasi_unstable',
    runtime: 'binji/wasm-clang host and MemFS at the pinned upstream commit',
    upstreamCommit: assets.commit,
    notices: ['poc/vendor/wasm-clang/LICENSE', 'poc/vendor/wasm-clang/LICENSE.llvm', 'THIRD_PARTY_NOTICES.txt'] },
  browsersVerifiedBySuite: ['Chromium', 'Firefox'], safari: 'unverified',
  publicStandards: ['c++11', 'c++14', 'c++17'],
  assets: verified,
  packageFiles
};
await writeFile(path.join(output, 'release-manifest.json'), JSON.stringify(releaseManifest, null, 2) + '\n');
console.log(`Built ${output} (${packageFiles.length + 1} allowlisted files, ${verified.length} verified toolchain files).`);
