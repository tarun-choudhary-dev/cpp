/* Internal Phase 2 protocol helpers. Loaded only by compiler-worker.js. */
const WorkerProtocol = (() => {
  class RequestError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const invalid = message => { throw new RequestError('INVALID_REQUEST', message); };
  const invalidOptions = message => { throw new RequestError('INVALID_OPTIONS', message); };
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const plainRecord = value => record(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  function options(input) {
    if (!plainRecord(input)) invalidOptions('Project options must be a plain object.');
    for (const key of Reflect.ownKeys(input)) {
      if (!['standard', 'optimization', 'warnings'].includes(key)) invalidOptions(`Unknown compiler option: ${String(key)}`);
    }
    const standard = Object.hasOwn(input, 'standard') ? input.standard : 'c++17';
    const optimization = Object.hasOwn(input, 'optimization') ? input.optimization : 'O0';
    if (!['c++11', 'c++14', 'c++17'].includes(standard)) invalidOptions('Unsupported C++ standard.');
    if (!['O0', 'O1', 'O2'].includes(optimization)) invalidOptions('Unsupported optimization level.');
    const warnings = Object.hasOwn(input, 'warnings') ? input.warnings : {};
    if (!plainRecord(warnings)) invalidOptions('Warnings must be a plain object.');
    for (const key of Reflect.ownKeys(warnings)) {
      if (!['all', 'extra'].includes(key)) invalidOptions(`Unknown warning option: ${String(key)}`);
    }
    const all = Object.hasOwn(warnings, 'all') ? warnings.all : false;
    const extra = Object.hasOwn(warnings, 'extra') ? warnings.extra : false;
    if (typeof all !== 'boolean' || typeof extra !== 'boolean') invalidOptions('Warning options must be booleans.');
    return { standard, optimization, warnings: { all, extra } };
  }
  function envelope(data) {
    if (!record(data)) invalid('Request must be an object.');
    if (typeof data.id !== 'string' || !data.id || data.id.length > 128) invalid('id must be a nonempty string of at most 128 characters.');
    if (!['init', 'compile', 'compileAndRun', 'dispose'].includes(data.type)) invalid('Unknown request type.');
    return data;
  }
  function path(name, isolatedIncludes = false) {
    if (typeof name !== 'string' || name.length > 240 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(name)) invalid('File paths must be relative ASCII paths (letters, digits, _, -, . and /).');
    const parts = name.split('/');
    if (parts.some(p => !p || p === '.' || p === '..')) invalid(`Noncanonical path: ${name}`);
    if (['lib', 'tmp', 'dev'].includes(parts[0]) ||
        (parts[0] === 'include' && (!isolatedIncludes || parts.length === 1))) invalid(`Reserved sysroot path: ${name}`);
    return name;
  }
  function job(data) {
    if (data.isolatedIncludes !== undefined && data.isolatedIncludes !== true) invalid('isolatedIncludes must be true when supplied.');
    const isolatedIncludes = data.isolatedIncludes === true;
    if (!record(data.files) || !Object.keys(data.files).length) invalid('files must be a nonempty map of paths to source text.');
    const names = Object.keys(data.files);
    for (const name of names) {
      path(name, isolatedIncludes);
      if (typeof data.files[name] !== 'string') invalid(`File ${name} must contain text.`);
      const pieces = name.split('/');
      for (let i = 1; i < pieces.length; i++) {
        if (Object.hasOwn(data.files, pieces.slice(0, i).join('/'))) invalid(`File/directory conflict: ${name}`);
      }
    }
    if (!Array.isArray(data.sources) || !data.sources.length) invalid('sources must be a nonempty ordered array.');
    for (const source of data.sources) {
      path(source, isolatedIncludes);
      if (!Object.hasOwn(data.files, source)) invalid(`Source is missing from files: ${source}`);
    }
    if (new Set(data.sources).size !== data.sources.length) invalid('Duplicate source paths.');
    const standard = data.standard ?? 'c++17';
    if (!['c++98', 'c++03', 'c++11', 'c++14', 'c++17', 'c++2a', 'c++20', 'c++23'].includes(standard)) invalid('Unsupported standard selection.');
    const stdin = data.stdin ?? '';
    if (typeof stdin !== 'string') invalid('stdin must be a preloaded string.');
    const compilerFlags = data.compilerFlags ?? [];
    if (!Array.isArray(compilerFlags) || compilerFlags.some(f => !['-fcxx-exceptions', '-fexceptions'].includes(f))) invalid('Only the Phase 1 exception probe flags are accepted as compilerFlags.');
    if (data.options !== undefined && (data.standard !== undefined || data.compilerFlags !== undefined)) {
      invalidOptions('Structured options cannot be combined with legacy Worker compiler settings.');
    }
    return { files: data.files, sources: data.sources, standard, stdin, compilerFlags, isolatedIncludes,
      options: data.options === undefined ? null : options(data.options) };
  }
  function diagnostics(stage, stderr) {
    const found = [];
    for (const raw of stderr.split('\n')) {
      const location = raw.match(/^(.+?):(\d+)(?::(\d+))?: (fatal error|error|warning|note): (.*)$/);
      const general = raw.match(/^(?:(.*?): )?(fatal error|error|warning|note): (.*)$/);
      if (location) found.push({ stage, severity: location[4], file: location[1], line: Number(location[2]), column: location[3] === undefined ? null : Number(location[3]), message: location[5], raw });
      else if (general) found.push({ stage, severity: general[2], file: null, line: null, column: null, message: general[3], raw });
    }
    return found; // Full multiline text is always retained separately in steps[].stderr.
  }
  return { RequestError, envelope, job, diagnostics };
})();
