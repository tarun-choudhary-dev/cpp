/* Private Phase 1 experiment, intentionally not an engine/public API. */
importScripts('vendor/wasm-clang/shared-patched.js');
let api;
let capture;
const assets = 'vendor/wasm-clang/';
const read = async name => {
  const response = await fetch(name);
  if (!response.ok) throw new Error(`Asset ${name}: HTTP ${response.status}`);
  return response.arrayBuffer();
};
async function command(module, ...args) {
  capture = { stdout: '', stderr: '' };
  const start = performance.now();
  let exitCode = 0;
  let trap;
  try { await api.run(module, ...args); }
  catch (error) {
    if (Number.isInteger(error.code)) exitCode = error.code;
    else { exitCode = null; trap = String(error); }
  }
  return { args, ...capture, exitCode, ...(trap ? { trap } : {}), ms: performance.now() - start,
    linearMemoryBytes: api.memfs.hostMem_.memory.buffer.byteLength };
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const start = performance.now();
      api = new API({
        clang: assets + 'clang', lld: assets + 'lld', memfs: assets + 'memfs', sysroot: assets + 'sysroot.tar',
        readBuffer: read, compileStreaming: async name => WebAssembly.compile(await read(name)),
        hostWrite() {} // Suppress upstream presentation/log output.
      });
      await api.ready;
      api.memfs.hostWrite = (text, fd) => {
        if (capture && fd === 1) capture.stdout += text;
        if (capture && fd === 2) capture.stderr += text;
      };
      await api.getModule(api.clangFilename);
      await api.getModule(api.lldFilename);
      const version = await command(api.moduleCache[api.clangFilename], 'clang', '--version');
      postMessage({ ready: true, version, loadMs: performance.now() - start, worker: typeof document === 'undefined', crossOriginIsolated });
      return;
    }
    const { id, files, sources, standard = 'c++17', stdin = '', compilerFlags = [] } = data;
    const steps = [];
    for (const [name, contents] of Object.entries(files)) api.memfs.addFile(name, new TextEncoder().encode(contents));
    for (let i = 0; i < sources.length; i++) {
      const step = await command(api.moduleCache[api.clangFilename], 'clang', '-cc1', '-emit-obj',
        ...api.clangCommonArgs.filter(a => a !== '-fcolor-diagnostics'), `-std=${standard}`, ...compilerFlags, '-O0', '-I.',
        '-o', `${id}-${i}.o`, '-x', 'c++', sources[i]);
      steps.push({ stage: 'compile', ...step });
      if (step.exitCode !== 0) { postMessage({ id, steps }); return; }
    }
    const objects = sources.map((_, i) => `${id}-${i}.o`);
    const link = await command(api.moduleCache[api.lldFilename], 'wasm-ld', '--no-threads',
      '-z', 'stack-size=1048576', '-Llib/wasm32-wasi', 'lib/wasm32-wasi/crt1.o', ...objects,
      '-lc', '-lc++', '-lc++abi', '-o', `${id}.wasm`);
    steps.push({ stage: 'link', ...link });
    if (link.exitCode !== 0) { postMessage({ id, steps }); return; }
    const bytes = api.memfs.getFileContents(`${id}.wasm`).slice();
    const module = await WebAssembly.compile(bytes);
    api.memfs.setStdinStr(stdin);
    const run = await command(module, `${id}.wasm`);
    steps.push({ stage: 'execute', ...run });
    postMessage({ id, steps, wasmBytes: bytes.length, imports: WebAssembly.Module.imports(module),
      memoryBytes: api.memfs.hostMem_.memory.buffer.byteLength, fsMemoryBytes: api.memfs.mem.memory.buffer.byteLength });
  } catch (e) { postMessage({ id: data.id, error: String(e), stack: e.stack }); }
};
