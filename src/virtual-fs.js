import { CompilerError } from './compiler-error.js';
import { ResourceLimits } from './resource-limits.js';

const reservedRoots = new Set(['lib', 'tmp', 'dev', '.cpp-worker']);
const invalid = message => { throw new CompilerError('INVALID_PROJECT', message); };
const limit = message => { throw new CompilerError('RESOURCE_LIMIT', message); };
const comparePaths = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function normalizeProjectPath(path) {
  if (typeof path !== 'string' || !path || path.length > 240) invalid('File paths must be nonempty strings of at most 240 characters.');
  if (path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) {
    invalid(`Invalid absolute, Windows or null-byte path: ${path}`);
  }
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '.') continue;
    if (!part || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part)) invalid(`Invalid virtual path: ${path}`);
    parts.push(part);
  }
  const canonical = parts.join('/');
  if (!canonical || canonical.length > 240 || !/^[A-Za-z0-9_]/.test(canonical) ||
      reservedRoots.has(parts[0]) || canonical === 'include') {
    invalid(`Invalid or reserved virtual path: ${path}`);
  }
  return canonical;
}

// A compiler-input file collection, not an OS filesystem or the Worker's MemFS.
export class VirtualFileSystem {
  #files;

  constructor(entries) {
    if (!entries || typeof entries[Symbol.iterator] !== 'function') invalid('Files must be iterable path/content pairs.');
    const files = new Map();
    const originals = new Map();
    let totalChars = 0;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) invalid('Each virtual file must be a path/content pair.');
      const [original, content] = entry;
      const path = normalizeProjectPath(original);
      if (typeof content !== 'string') invalid(`File ${path} must contain text.`);
      if (content.length > ResourceLimits.fileChars) limit(`File ${path} exceeds ${ResourceLimits.fileChars} characters.`);
      totalChars += content.length;
      if (totalChars > ResourceLimits.totalFileChars) limit(`Project exceeds ${ResourceLimits.totalFileChars} file characters.`);
      if (files.has(path)) invalid(`Conflicting paths ${JSON.stringify(originals.get(path))} and ${JSON.stringify(original)} normalize to ${JSON.stringify(path)}.`);
      if (files.size >= ResourceLimits.files) limit(`Project exceeds ${ResourceLimits.files} files.`);
      files.set(path, content);
      originals.set(path, original);
    }
    for (const path of files.keys()) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/');
        if (files.has(parent)) invalid(`File/directory conflict: ${parent} and ${path}.`);
      }
    }
    this.#files = new Map([...files].sort(([a], [b]) => comparePaths(a, b)));
  }

  get size() { return this.#files.size; }
  has(path) { return this.#files.has(normalizeProjectPath(path)); }
  read(path) { return this.#files.get(normalizeProjectPath(path)); }
  list() { return [...this.#files.keys()]; }
  entries() { return [...this.#files].map(([path, content]) => ({ path, content })); }

  toWorkerFiles() {
    const files = Object.create(null);
    for (const [path, content] of this.#files) files[path] = content;
    return files;
  }
}
