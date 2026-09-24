import { CompilerError } from './compiler-error.js';

const invalid = message => { throw new CompilerError('INVALID_OPTIONS', message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// Public input allowlist. Keep in step with independent Worker validation.
export function normalizeCompilerOptions(input) {
  try {
    if (!record(input)) invalid('Project options must be a plain object.');
    for (const key of Reflect.ownKeys(input)) {
      if (!['standard', 'optimization', 'warnings'].includes(key)) invalid(`Unknown compiler option: ${String(key)}`);
    }
    const standard = Object.hasOwn(input, 'standard') ? input.standard : 'c++17';
    const optimization = Object.hasOwn(input, 'optimization') ? input.optimization : 'O0';
    if (!['c++11', 'c++14', 'c++17'].includes(standard)) invalid('Unsupported C++ standard.');
    if (!['O0', 'O1', 'O2'].includes(optimization)) invalid('Unsupported optimization level.');
    const warnings = Object.hasOwn(input, 'warnings') ? input.warnings : {};
    if (!record(warnings)) invalid('Warnings must be a plain object.');
    for (const key of Reflect.ownKeys(warnings)) {
      if (!['all', 'extra'].includes(key)) invalid(`Unknown warning option: ${String(key)}`);
    }
    const all = Object.hasOwn(warnings, 'all') ? warnings.all : false;
    const extra = Object.hasOwn(warnings, 'extra') ? warnings.extra : false;
    if (typeof all !== 'boolean' || typeof extra !== 'boolean') invalid('Warning options must be booleans.');
    return { standard, optimization, warnings: { all, extra } };
  } catch (error) {
    if (error instanceof CompilerError) throw error;
    invalid('Could not read compiler options.');
  }
}
