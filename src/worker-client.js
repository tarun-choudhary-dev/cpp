// Internal transport for the Phase 2 classic Worker. Consumers import src/index.js.
import { CompilerError } from './compiler-error.js';

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

  request(type, payload = {}) {
    if (this.#closed) return Promise.reject(new CompilerError('WORKER_ERROR', 'Compiler Worker has stopped.'));
    const id = String(++this.#nextId);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, type });
      try {
        this.#worker.postMessage({ ...payload, type, id });
      } catch (error) {
        this.#pending.delete(id);
        reject(new CompilerError('WORKER_ERROR', 'Could not send request to compiler Worker.', error));
      }
    });
  }

  #receive(data) {
    if (this.#closed) return;
    if (!data || typeof data !== 'object') {
      this.stop(new CompilerError('WORKER_ERROR', 'Compiler Worker sent an invalid response.'));
      return;
    }
    const pending = this.#pending.get(data.id);
    if (!pending) return; // A response from a request already settled during teardown.
    if (data.type === 'progress') return;
    if (data.operation !== pending.type ||
        (data.type === 'result' && (!data.result || typeof data.result !== 'object' ||
          (pending.type === 'init' && typeof data.result.clang !== 'string') ||
          (pending.type !== 'init' && (typeof data.result.status !== 'string' ||
            !Array.isArray(data.result.steps) || !Array.isArray(data.result.diagnostics))))) ||
        (data.type === 'error' && (!data.error || typeof data.error !== 'object'))) {
      this.stop(new CompilerError('WORKER_ERROR', 'Compiler Worker sent a malformed response.'));
      return;
    }
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
      pending.reject(reason);
    }
    this.#pending.clear();
    if (notify) this.#onStop?.(reason);
  }
}
