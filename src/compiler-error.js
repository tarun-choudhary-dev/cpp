// Shared internal error category; the public API exposes Error.code, not this module.
export class CompilerError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CppCompilerError';
    this.code = code;
  }
}
