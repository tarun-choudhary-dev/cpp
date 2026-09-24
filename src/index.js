import { CompilerError } from './compiler-error.js';
import { ProjectSnapshot } from './project.js';
import { WorkerClient } from './worker-client.js';

const watchdogMs = Object.freeze({ initialize: 45_000, build: 60_000, execute: 15_000 });

function publicResult(result) {
  // Keep the proven values and transferable artifact; omit internal command args.
  return {
    status: result.status,
    stage: result.stage,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated ?? false,
    stderrTruncated: result.stderrTruncated ?? false,
    outputTruncated: result.outputTruncated ?? false,
    diagnosticsTruncated: result.diagnosticsTruncated ?? false,
    trap: result.trap && { ...result.trap },
    diagnostics: result.diagnostics.map(d => ({ ...d })),
    steps: result.steps.map(({ stage, stdout, stderr, stdoutTruncated, stderrTruncated, exitCode, trap, ms }) => ({
      stage, stdout, stderr, stdoutTruncated: stdoutTruncated ?? false,
      stderrTruncated: stderrTruncated ?? false, exitCode, trap: trap && { ...trap }, ms
    })),
    artifact: result.artifact && { ...result.artifact },
    durationMs: result.durationMs
  };
}

function publicInfo(info) {
  return { clang: info.clang, lld: info.lld, commit: info.commit, defaultStandard: info.defaultStandard, abi: info.abi };
}

export class CppCompiler {
  #state = 'created';
  #workerUrl;
  #assetBase;
  #client = null;
  #info = null;
  #initializePromise = null;
  #restartPromise = null;
  #generation = 0;

  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new CompilerError('INVALID_OPTIONS', 'Options must be an object.');
    }
    try {
      this.#workerUrl = new URL(options.workerUrl ?? '../worker/compiler-worker.js', import.meta.url);
    } catch (error) {
      throw new CompilerError('INVALID_OPTIONS', 'workerUrl must be a valid URL.', error);
    }
    if (options.assetBase !== undefined && typeof options.assetBase !== 'string' && !(options.assetBase instanceof URL)) {
      throw new CompilerError('INVALID_OPTIONS', 'assetBase must be a URL or string.');
    }
    this.#assetBase = options.assetBase?.toString();
  }

  getState() { return this.#state; }
  isReady() { return this.#state === 'ready'; }
  isBusy() { return this.#state === 'busy'; }
  getCompilerInfo() { return this.#info && { ...this.#info }; }

  #assertAlive() {
    if (this.#state === 'disposed') throw new CompilerError('COMPILER_DISPOSED', 'Compiler has been disposed.');
  }

  #workerStopped(generation) {
    if (generation !== this.#generation || this.#state === 'disposed') return;
    this.#client = null;
    this.#info = null;
    this.#state = 'fatal';
  }

  #initializeWorker(failureCode = 'INITIALIZATION_ERROR') {
    this.#state = 'initializing';
    const generation = this.#generation;
    const task = (async () => {
      try {
        if (!this.#client) this.#client = new WorkerClient(this.#workerUrl, () => this.#workerStopped(generation));
        const metadata = await this.#client.request('init', this.#assetBase === undefined ? {} : { assetBase: this.#assetBase },
          { timeoutMs: watchdogMs.initialize });
        if (generation !== this.#generation || this.#state === 'disposed') {
          throw new CompilerError('CANCELLATION', 'Initialization was interrupted.');
        }
        this.#info = publicInfo(metadata);
        this.#state = 'ready';
        return this.getCompilerInfo();
      } catch (error) {
        if (generation === this.#generation && this.#state !== 'disposed') {
          if (failureCode === 'RESET_ERROR') {
            this.#client?.stop(new CompilerError('RESET_ERROR', 'Reset failed.'), false);
            this.#client = null;
            this.#state = 'fatal';
          } else if (error?.code === 'WORKER_ERROR') {
            this.#state = 'fatal';
          } else if (this.#state !== 'fatal') {
            // Phase 2 permits retrying initialization after a missing asset.
            if (error?.code === 'TIMEOUT') this.#client = null; // Watchdog already terminated it.
            this.#state = 'created';
          }
        }
        if (error instanceof CompilerError && ['WORKER_ERROR', 'TIMEOUT', 'CANCELLATION', 'COMPILER_DISPOSED'].includes(error.code)) throw error;
        throw new CompilerError(failureCode, error.message || 'Compiler initialization failed.', error);
      }
    })();
    this.#initializePromise = task;
    task.then(
      () => { if (this.#initializePromise === task) this.#initializePromise = null; },
      () => { if (this.#initializePromise === task) this.#initializePromise = null; }
    );
    return task;
  }

  async initialize() {
    this.#assertAlive();
    if (this.#restartPromise) return this.#restartPromise;
    if (this.#state === 'ready' || this.#state === 'busy') return this.getCompilerInfo();
    if (this.#initializePromise) return this.#initializePromise;
    if (this.#state === 'fatal') throw new CompilerError('INVALID_STATE', 'Compiler failed; call reset() to create a fresh Worker.');
    return this.#initializeWorker();
  }

  async #build(type, project) {
    this.#assertAlive();
    if (this.#state === 'busy') throw new CompilerError('COMPILER_BUSY', 'A compile or run operation is already active.');
    if (this.#state !== 'ready') throw new CompilerError('COMPILER_NOT_READY', 'Call initialize() and wait for ready state.');
    let input;
    try { input = new ProjectSnapshot(project).toWorkerInput(); } // Copy before yielding to caller or Worker.
    catch (error) {
      if (error instanceof CompilerError) throw error;
      throw new CompilerError('INVALID_PROJECT', 'Could not read project files.', error);
    }
    const generation = this.#generation;
    this.#state = 'busy';
    try {
      return publicResult(await this.#client.request(type, input,
        { timeoutMs: watchdogMs.build, executionTimeoutMs: type === 'compileAndRun' ? watchdogMs.execute : undefined }));
    } catch (error) {
      if (error?.code === 'TIMEOUT' && generation === this.#generation && this.#state !== 'disposed') {
        // Reject this job now; recovery happens on a replacement Worker.
        this.#restart(error).catch(() => {});
      }
      if (error?.code === 'INVALID_REQUEST') throw new CompilerError('INVALID_PROJECT', error.message, error);
      if (error?.code === 'NOT_INITIALIZED') throw new CompilerError('COMPILER_NOT_READY', error.message, error);
      if (error?.code === 'DISPOSED') throw new CompilerError('COMPILER_DISPOSED', error.message, error);
      if (error instanceof CompilerError) throw error;
      throw new CompilerError('RUNTIME_ERROR', error.message || 'Compiler request failed.', error);
    } finally {
      if (generation === this.#generation && this.#state === 'busy') this.#state = 'ready';
    }
  }

  async compile(project) { return this.#build('compile', project); }
  async run(project) { return this.#build('compileAndRun', project); }

  #restart(reason) {
    this.#assertAlive();
    if (this.#restartPromise) return this.#restartPromise;
    this.#generation++;
    this.#client?.stop(reason, false);
    this.#client = null;
    this.#info = null;
    const task = this.#initializeWorker('RESET_ERROR');
    this.#restartPromise = task;
    task.then(
      () => { if (this.#restartPromise === task) this.#restartPromise = null; },
      () => { if (this.#restartPromise === task) this.#restartPromise = null; }
    );
    return task;
  }

  cancel() {
    this.#assertAlive();
    if (this.#restartPromise) return this.#restartPromise;
    if (this.#state !== 'busy' && this.#state !== 'initializing') return Promise.resolve(this.getCompilerInfo());
    return this.#restart(new CompilerError('CANCELLATION', 'Compiler operation was cancelled.'));
  }

  async reset() {
    return this.#restart(new CompilerError('RESET_ERROR', 'Compiler operation was interrupted by reset.'));
  }

  async dispose() {
    if (this.#state === 'disposed') return;
    this.#generation++;
    this.#state = 'disposed';
    this.#info = null;
    this.#client?.stop(new CompilerError('COMPILER_DISPOSED', 'Compiler has been disposed.'), false);
    this.#client = null;
    this.#initializePromise = null;
    this.#restartPromise = null;
  }
}
