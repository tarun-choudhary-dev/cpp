/* Dedicated classic Worker entry. This is an internal transport, not CppCompiler. */
if (typeof document !== 'undefined') throw new Error('Load compiler-worker.js using new Worker().');
importScripts('protocol.js', 'runtime.js');
const runtime = new CompilerWorkerRuntime();
let queue = Promise.resolve();
let closing = false;

function failure(data, error) {
  self.postMessage({
    type: 'error', id: typeof data?.id === 'string' ? data.id : null,
    operation: typeof data?.type === 'string' ? data.type : null, ok: false,
    error: { code: typeof error.code === 'string' ? error.code : (data?.type === 'init' ? 'INITIALIZATION_FAILED' : 'RUNTIME_ERROR'), message: error.message || String(error) }
  });
}

self.onmessage = ({ data }) => {
  try { WorkerProtocol.envelope(data); } catch (error) { failure(data, error); return; }
  // Valid commands run in arrival order, including concurrent init requests.
  if (closing) { failure(data, new WorkerProtocol.RequestError('DISPOSED', 'Worker is closing.')); return; }
  if (data.type === 'dispose') closing = true;
  queue = queue.then(async () => {
    try {
      const request = WorkerProtocol.envelope(data);
      let result;
      switch (request.type) {
        case 'init':
          if (request.assetBase !== undefined && typeof request.assetBase !== 'string') throw new WorkerProtocol.RequestError('INVALID_REQUEST', 'assetBase must be a string.');
          result = await runtime.initialize(request.assetBase);
          break;
        case 'compile':
        case 'compileAndRun':
          result = await runtime.build(WorkerProtocol.job(request), request.type === 'compileAndRun',
            stage => self.postMessage({ type: 'progress', id: request.id, stage }));
          break;
        case 'dispose': runtime.dispose(); result = { disposed: true }; break;
      }
      const transfer = result.artifact ? [result.artifact.bytes.buffer] : [];
      self.postMessage({ type: 'result', id: request.id, operation: request.type, ok: !result.status || result.status === 'success', result }, transfer);
      if (request.type === 'dispose') self.close();
    } catch (error) { failure(data, error); }
  });
};
