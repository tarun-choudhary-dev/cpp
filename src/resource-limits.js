// Keep the duplicated classic-Worker limits in worker/protocol.js in sync.
export const ResourceLimits = Object.freeze({
  files: 256,
  fileChars: 1_048_576,
  totalFileChars: 4_194_304,
  stdinChars: 1_048_576,
  outputChars: 1_048_576,
  diagnostics: 512,
  diagnosticChars: 8_192,
  artifactBytes: 33_554_432
});
