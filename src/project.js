import { CompilerError } from './compiler-error.js';
import { normalizeCompilerOptions } from './compiler-options.js';
import { normalizeProjectPath, VirtualFileSystem } from './virtual-fs.js';

const sourceExtension = /\.(?:cpp|cc|cxx|C)$/;
const invalid = message => { throw new CompilerError('INVALID_PROJECT', message); };

// Detached project snapshot. Only plain data produced by toWorkerInput crosses the Worker boundary.
export class ProjectSnapshot {
  #filesystem;
  #entry;
  #stdin;
  #sources;
  #isolatedIncludes;
  #options;

  constructor(project) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) invalid('Project must be an object.');
    const inputFiles = project.files;
    if (!inputFiles || typeof inputFiles !== 'object' || Array.isArray(inputFiles)) {
      invalid('Project files must be a nonempty map of paths to source text.');
    }
    this.#filesystem = new VirtualFileSystem(Object.entries(inputFiles));
    if (!this.#filesystem.size) invalid('Project files must be a nonempty map of paths to source text.');
    this.#entry = normalizeProjectPath(project.entry);
    if (!this.#filesystem.has(this.#entry)) invalid('Project entry must name a file in files.');
    this.#stdin = project.stdin ?? '';
    if (typeof this.#stdin !== 'string') invalid('Project stdin must be a string.');
    const paths = this.#filesystem.list();
    this.#sources = Object.freeze([
      this.#entry,
      ...paths.filter(path => path !== this.#entry && sourceExtension.test(path))
    ]);
    this.#isolatedIncludes = paths.some(path => path.startsWith('include/'));
    let options;
    try { options = Object.hasOwn(project, 'options') ? project.options : undefined; }
    catch { throw new CompilerError('INVALID_OPTIONS', 'Could not read project options.'); }
    this.#options = options === undefined ? null : normalizeCompilerOptions(options);
  }

  get filesystem() { return this.#filesystem; }
  get entry() { return this.#entry; }
  get stdin() { return this.#stdin; }
  get sources() { return [...this.#sources]; }

  toWorkerInput() {
    return {
      files: this.#filesystem.toWorkerFiles(), sources: [...this.#sources], stdin: this.#stdin,
      ...(this.#isolatedIncludes ? { isolatedIncludes: true } : {}),
      ...(this.#options ? { options: { ...this.#options, warnings: { ...this.#options.warnings } } } : {})
    };
  }
}
