/* Toolchain adapter. No compiler is imported or invoked by the main thread. */
class CompilerWorkerRuntime {
  constructor() {
    this.assets = null;
    this.info = null;
  }

  async initialize(assetBase) {
    const base = new URL(assetBase ?? '../poc/vendor/wasm-clang/', self.location.href);
    if (base.origin !== self.location.origin || !base.pathname.endsWith('/') || base.search || base.hash) {
      throw new WorkerProtocol.RequestError('INVALID_REQUEST', 'assetBase must be a same-origin directory URL ending in /.');
    }
    if (this.info) {
      if (assetBase !== undefined && base.href !== this.info.assetBase) throw new WorkerProtocol.RequestError('ALREADY_INITIALIZED', 'Terminate this Worker before changing assetBase.');
      return this.info;
    }
    const started = performance.now();
    // The Phase 1 host declares a global lexical API; import it only once, including on retry.
    if (typeof API === 'undefined') importScripts(new URL('shared-patched.js', base).href);
    const entries = await Promise.all(['clang', 'lld', 'memfs', 'sysroot.tar'].map(async name => {
      const response = await fetch(new URL(name, base));
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      return [name, name === 'sysroot.tar' ? bytes : await WebAssembly.compile(bytes)];
    }));
    // Publish the cache only after every asset is loaded successfully.
    this.assets = new Map(entries);
    try {
      const api = await this.createFilesystem();
      const clang = await this.command(api, 'initialize', this.assets.get('clang'), 'clang', '--version');
      const lld = await this.command(api, 'initialize', this.assets.get('lld'), 'wasm-ld', '--version');
      if (clang.exitCode !== 0 || lld.exitCode !== 0) throw new Error('Compiler/linker version check failed.');
      this.info = {
        assetBase: base.href, clang: clang.stdout.trim(), lld: lld.stdout.trim(),
        commit: '648c4a89997a351eef75cdaec3ef5b89d4937dec',
        defaultStandard: 'c++17', abi: 'wasi_unstable',
        loadMs: performance.now() - started, worker: typeof document === 'undefined',
        crossOriginIsolated: self.crossOriginIsolated
      };
      return this.info;
    } catch (error) { this.assets = null; throw error; }
  }

  async createFilesystem() {
    const api = new API({
      clang: 'clang', lld: 'lld', memfs: 'memfs', sysroot: 'sysroot.tar',
      readBuffer: async name => {
        if (name !== 'sysroot.tar') throw new Error(`Uncached asset: ${name}`);
        return this.assets.get(name);
      },
      compileStreaming: async name => {
        const module = this.assets.get(name);
        if (!(module instanceof WebAssembly.Module)) throw new Error(`Uncached module: ${name}`);
        return module;
      },
      hostWrite() {} // Keep upstream presentation logs out of program streams.
    });
    await api.ready;
    return api;
  }

  async command(api, stage, module, ...args) {
    const started = performance.now();
    const step = { stage, args, stdout: '', stderr: '', exitCode: 0, trap: null };
    api.memfs.hostWrite = (text, fd) => {
      if (fd === 1) step.stdout += text;
      if (fd === 2) step.stderr += text;
    };
    try {
      const app = await api.run(module, ...args);
      // Upstream reserves this exit for its canvas demo; this runtime has no UI/event loop.
      if (app) { app.allowRequestAnimationFrame = false; step.exitCode = 0xC0C0A; }
    } catch (error) {
      if (Number.isInteger(error.code)) step.exitCode = error.code;
      else { step.exitCode = null; step.trap = { name: error.name, message: error.message }; }
    } finally { api.memfs.hostWrite = () => {}; }
    step.ms = performance.now() - started;
    step.linearMemoryBytes = api.memfs.hostMem_?.memory.buffer.byteLength ?? null;
    return step;
  }

  async build(job, execute, onStage = () => {}) {
    if (!this.info) throw new WorkerProtocol.RequestError('NOT_INITIALIZED', 'Send init and wait for success before compiling.');
    const start = performance.now();
    const api = await this.createFilesystem();
    const run = (stage, module, ...args) => {
      onStage(stage);
      return this.command(api, stage, module, ...args);
    };
    // API/MemFS/App state is owned only by this job and becomes collectible on return.
    // Project include/ is aliased away from the sysroot include/ directory.
    const physical = name => job.isolatedIncludes && name.startsWith('include/') ? `.cpp-project/${name}` : name;
    const directories = new Set(job.isolatedIncludes ? ['.cpp-project'] : []);
    for (const name of Object.keys(job.files)) {
      const parts = physical(name).split('/');
      for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    }
    for (const directory of [...directories].sort((a, b) => a.split('/').length - b.split('/').length)) api.memfs.addDirectory(directory);
    api.memfs.addDirectory('.cpp-worker');
    for (const [name, text] of Object.entries(job.files)) api.memfs.addFile(physical(name), new TextEncoder().encode(text));
    const steps = [];
    let artifact = null;
    const finish = () => {
      const last = steps.at(-1);
      const diagnostics = steps.filter(s => s.stage !== 'execute')
        .flatMap(s => WorkerProtocol.diagnostics(s.stage, s.stderr))
        .map(d => ({ ...d, file: job.isolatedIncludes && d.file?.startsWith('.cpp-project/include/')
          ? d.file.slice('.cpp-project/'.length) : d.file }));
      return {
        status: last.trap ? 'trap' : last.exitCode !== 0 ? (last.stage === 'execute' ? 'nonzero-exit' : `${last.stage}-error`) : 'success',
        stage: last.stage, exitCode: last.exitCode, stdout: last.stdout, stderr: last.stderr,
        trap: last.trap, steps, diagnostics,
        artifact, durationMs: performance.now() - start
      };
    };
    const objects = job.sources.map((_, i) => `.cpp-worker/${i}.o`);
    for (let i = 0; i < job.sources.length; i++) {
      const step = await run('compile', this.assets.get('clang'), 'clang', '-cc1', '-emit-obj',
        ...api.clangCommonArgs.filter(a => a !== '-fcolor-diagnostics'), `-std=${job.standard}`, ...job.compilerFlags,
        '-O0', ...(job.isolatedIncludes ? ['-I.cpp-project'] : []), '-I.', '-o', objects[i], '-x', 'c++', physical(job.sources[i]));
      steps.push(step);
      if (step.exitCode !== 0) return finish();
    }
    const output = '.cpp-worker/program.wasm';
    const link = await run('link', this.assets.get('lld'), 'wasm-ld', '--no-threads',
      '-z', 'stack-size=1048576', '-Llib/wasm32-wasi', 'lib/wasm32-wasi/crt1.o', ...objects,
      '-lc', '-lc++', '-lc++abi', '-o', output);
    steps.push(link);
    if (link.exitCode !== 0) return finish();
    const bytes = api.memfs.getFileContents(output).slice();
    artifact = { format: 'wasm', abi: 'wasi_unstable', bytes };
    if (execute) {
      try {
        const module = await WebAssembly.compile(bytes);
        api.memfs.setStdinStr(job.stdin);
        steps.push(await run('execute', module, output));
      } catch (error) {
        steps.push({ stage: 'execute', args: [output], stdout: '', stderr: '', exitCode: null, trap: { name: error.name, message: error.message } });
      }
    }
    return finish();
  }

  dispose() { this.assets = null; this.info = null; }
}
