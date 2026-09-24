// Internal transport for the Phase 2 classic Worker. Consumers import src/index.js.
import { CompilerError } from './compiler-error.js';
import { validWorkerResult } from './worker-result.js';

export class WorkerClient {
  #worker;
  #pending = new Map();
  #nextId = 0;
  #closed = false;
  #onStop;

  constructor(url, onStop) {
    if (typeof Worker !== 'function') throw new CompilerError('WORKER_ERROR', 'Web Workers are unavailable.');
    this.#onStop = onStop;
    try {
      this.#worker = new Worker(url);
    } catch (error) {
      throw new CompilerError('WORKER_ERROR', 'Could not start the compiler Worker.', error);
    }
    this.#worker.onmessage = event => this.#receive(event.data);
    this.#worker.onerror = event => {
      this.stop(new CompilerError('WORKER_ERROR', event.message || 'Compiler Worker failed.'));
    };
    this.#worker.onmessageerror = () => this.stop(new CompilerError('WORKER_ERROR', 'Could not decode a compiler Worker response.'));
  }

  get pendingCount() { return this.#pending.size; }

  request(type, payload = {}, watchdog = {}) {
    if (this.#closed) return Promise.reject(new CompilerError('WORKER_ERROR', 'Compiler Worker has stopped.'));
    const id = String(++this.#nextId);
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, type, stage: type === 'init' ? 'initialize' : 'compile',
        timer: null, executionTimeoutMs: watchdog.executionTimeoutMs };
      this.#pending.set(id, pending);
      if (Number.isFinite(watchdog.timeoutMs) && watchdog.timeoutMs > 0) {
        pending.timer = setTimeout(() => this.#expire(id), watchdog.timeoutMs);
      }
      try {
        this.#worker.postMessage({ ...payload, type, id });
      } catch (error) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        reject(new CompilerError('WORKER_ERROR', 'Could not send request to compiler Worker.', error));
      }
    });
  }

  #expire(id) {
    const pending = this.#pending.get(id);
    if (!pending || this.#closed) return;
    const error = new CompilerError('TIMEOUT', `Compiler Worker timed out during ${pending.stage}.`);
    error.stage = pending.stage;
    // The owner handles recovery; synchronous Wasm cannot service another message.
    this.stop(error, false);
  }

  #receive(data) {
    try {
      this.#handle(data);
    } catch {
      this.stop(new CompilerError('WORKER_ERROR', 'Compiler Worker sent an unreadable response.'));
    }
  }

  #handle(data) {
    if (this.#closed) return;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      this.stop(new CompilerError('WORKER_ERROR', 'Compiler Worker sent an invalid response.'));
      return;
    }
    const pending = this.#pending.get(data.id);
    if (!pending) return; // A response from a request already settled during teardown.
    if (data.type === 'progress') {
      if (!['compile', 'link', 'execute'].includes(data.stage) ||
          !['compile', 'compileAndRun'].includes(pending.type) ||
          (data.stage === 'execute' && pending.type !== 'compileAndRun') ||
          (pending.stage === 'execute' && data.stage !== 'execute')) {
        this.stop(new CompilerError('WORKER_ERROR', 'Compiler Worker sent invalid progress.'));
        return;
      }
      if (pending.stage !== 'execute' && data.stage === 'execute') {
        clearTimeout(pending.timer);
        if (Number.isFinite(pending.executionTimeoutMs) && pending.executionTimeoutMs > 0) {
          pending.timer = setTimeout(() => this.#expire(data.id), pending.executionTimeoutMs);
        }
      }
      if (pending.stage !== 'execute') pending.stage = data.stage;
      return;
    }
    if (data.operation !== pending.type ||
        (data.type === 'result' && !validWorkerResult(data.result, pending.type)) ||
        (data.type === 'error' && (!data.error || typeof data.error !== 'object' || Array.isArray(data.error) ||
          typeof data.error.code !== 'string' || data.error.code.length > 128 ||
          typeof data.error.message !== 'string' || data.error.message.length > 8192))) {
      this.stop(new CompilerError('WORKER_ERROR', 'Compiler Worker sent a malformed response.'));
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(data.id);
    if (data.type === 'result') pending.resolve(data.result);
    else if (data.type === 'error') pending.reject(new CompilerError(data.error?.code || 'RUNTIME_ERROR', data.error?.message || 'Compiler Worker request failed.'));
    else {
      pending.reject(new CompilerError('WORKER_ERROR', 'Compiler Worker sent an unknown response type.'));
      this.stop(new CompilerError('WORKER_ERROR', 'Compiler Worker protocol failed.'));
    }
  }

  stop(reason = new CompilerError('WORKER_ERROR', 'Compiler Worker was stopped.'), notify = true) {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.onmessage = null;
    this.#worker.onerror = null;
    this.#worker.onmessageerror = null;
    try { this.#worker.terminate(); } catch { /* Settle callers even if termination itself fails. */ }
    this.#worker = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
    if (notify) this.#onStop?.(reason);
  }
}
