import { ResourceLimits } from './resource-limits.js';

const text = (value, max = ResourceLimits.outputChars) => typeof value === 'string' && value.length <= max;
const exit = value => value === null || Number.isSafeInteger(value);
const duration = value => value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
const flag = value => value === undefined || typeof value === 'boolean';
const trap = value => value === null || (value && typeof value === 'object' && !Array.isArray(value) &&
  text(value.name, 256) && text(value.message, ResourceLimits.diagnosticChars));

export function validWorkerResult(result, operation) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (operation === 'init') {
    return ['clang', 'lld', 'commit', 'defaultStandard', 'abi'].every(key => text(result[key], 4096));
  }
  if (operation === 'dispose') return result.disposed === true;
  if (!['success', 'compile-error', 'link-error', 'nonzero-exit', 'trap'].includes(result.status) ||
      !['compile', 'link', 'execute'].includes(result.stage) ||
      (operation === 'compile' && result.stage === 'execute') ||
      !exit(result.exitCode) || !text(result.stdout) || !text(result.stderr) ||
      !trap(result.trap) || !duration(result.durationMs) ||
      !flag(result.stdoutTruncated) || !flag(result.stderrTruncated) ||
      !flag(result.outputTruncated) || !flag(result.diagnosticsTruncated) ||
      !Array.isArray(result.steps) || result.steps.length > ResourceLimits.files + 2 ||
      !Array.isArray(result.diagnostics) || result.diagnostics.length > ResourceLimits.diagnostics) return false;

  let captured = 0;
  for (const step of result.steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step) ||
        !['compile', 'link', 'execute'].includes(step.stage) ||
        !text(step.stdout) || !text(step.stderr) || !exit(step.exitCode) ||
        !trap(step.trap) || !duration(step.ms) ||
        !flag(step.stdoutTruncated) || !flag(step.stderrTruncated)) return false;
    captured += step.stdout.length + step.stderr.length;
    if (captured > ResourceLimits.outputChars) return false;
  }
  for (const diagnostic of result.diagnostics) {
    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic) ||
        !['compile', 'link'].includes(diagnostic.stage) ||
        !['error', 'warning', 'note', 'fatal error'].includes(diagnostic.severity) ||
        !(diagnostic.file === null || text(diagnostic.file, 1024)) ||
        !(diagnostic.line === null || Number.isSafeInteger(diagnostic.line) && diagnostic.line >= 0) ||
        !(diagnostic.column === null || Number.isSafeInteger(diagnostic.column) && diagnostic.column >= 0) ||
        !text(diagnostic.message, ResourceLimits.diagnosticChars) ||
        !text(diagnostic.raw, ResourceLimits.diagnosticChars)) return false;
  }
  if (result.artifact !== null) {
    if (!result.artifact || typeof result.artifact !== 'object' ||
        result.artifact.format !== 'wasm' || result.artifact.abi !== 'wasi_unstable' ||
        !(result.artifact.bytes instanceof Uint8Array) ||
        result.artifact.bytes.byteLength > ResourceLimits.artifactBytes) return false;
  }
  return true;
}
