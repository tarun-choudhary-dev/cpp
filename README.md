# Browser C++ compiler engine — 0.1.0-rc.1

Real C++ compilation and execution have been verified in browser Web Workers with **no compiler backend**. The supplied `iostream` Hello World passes in Chromium and Firefox with all networking disabled before source submission.

The [pinned asset manifest](research/assets.json) records the toolchain inputs and hashes. The full research report and raw browser results are local-only files.

Phase 2 added a reusable **Worker runtime** around the unchanged Phase 1 toolchain. Phase 3 added the public [CppCompiler](src/index.js) JavaScript API over that Worker. Phase 4 formalized its internal project and in-memory file model. Phase 5 verified the compile/run contract. Phase 6 added structured compiler diagnostics and a small, validated options interface. Phase 7 added host-side timeouts, bounded inputs/output and stronger Worker-result checks. Phase 8 packages these unchanged modules as a static release candidate. It has no editor, UI, framework components or backend. `poc/blank.html` remains an empty automation fixture. Local engineering notes remain ignored under `docs/`; the shareable consumer [API guide](guide/api/README.md), [security and limits](guide/security/README.md), [toolchain inventory](guide/toolchain/README.md) and [test matrix](guide/testing/README.md) are README-named files under `guide/`.

```js
import { CppCompiler } from './src/index.js';

const compiler = new CppCompiler();
await compiler.initialize();
const result = await compiler.run({
  files: { 'main.cpp': '#include <iostream>\nint main(){std::cout << "Hello World\\n";}' },
  entry: 'main.cpp'
});
console.log(result.status, result.stdout, result.exitCode);
await compiler.dispose();
```

`compile(project)` builds without executing user code; `run(project)` builds again and executes. A project supplies text `files`, an existing `entry` path, optional preloaded `stdin`, and optional `options`. Supported options are `standard: 'c++11' | 'c++14' | 'c++17'`, `optimization: 'O0' | 'O1' | 'O2'`, and `warnings: { all?: boolean, extra?: boolean }`. Omitted options preserve the original C++17/O0 command; arbitrary flags reject. Paths are relative to an in-memory virtual project root, use `/`, and never access the user's actual filesystem. Harmless `.` segments normalize; traversal, absolute/drive paths, backslashes and duplicate normalized paths reject. The entry compiles first, then other `.cpp`, `.cc`, `.cxx` and `.C` files in canonical path order. Headers, including nested `include/` headers, stay available for Clang includes. Both methods resolve with structured statuses (`success`, `compile-error`, `link-error`, `nonzero-exit`, `trap`), ordered compile/link diagnostics, per-stage captured output and a caller-owned `Uint8Array` Wasm artifact when linking succeeds. Syntax/link failures and nonzero exits are results; API/Worker failures reject with an error `code`. `cancel()` and `reset()` replace the Worker and reload assets; `dispose()` permanently releases it. Timed-out builds reject with `TIMEOUT` and trigger Worker replacement. Previously returned artifacts remain valid after lifecycle changes. Inputs and output capture are bounded, with truncation flags on results; browser Worker memory itself has no portable hard quota. The legacy stdin path does not round-trip all Unicode text, and there is no interactive input.

## Reproduce

Requires Node.js 20+ with built-in `fetch` (tested with 24.19.0) and npm. From this directory:

```sh
npm ci
npx playwright install chromium firefox
npm run assets
npm test
npm run test:worker
npm run test:api
npm run test:project
npm run test:compile-run
npm run test:diagnostics-options
npm run test:robustness
npm run verify:assets
npm run build
npm run verify:release
npm run test:release
npm run check:privacy
```

Setup downloads packages, browser binaries and approximately 60.4 MB of compiler assets. `npm run assets` verifies each upstream file against a pinned SHA-256 and retains license files. Subsequent runs reuse verified local assets. Large downloaded assets are excluded from Git.

`npm test` starts a temporary loopback **static GET-only** server, opens an empty page, loads Clang, LLD, an in-memory filesystem and the C++ sysroot into a Worker, disables browser networking, then submits C++ sources. All compilation, linking and program execution happen inside the browser. The script closes browsers and the server when finished.

It writes `evidence/chromium.json` and `evidence/firefox.json`: exact commands, stdout, stderr, exit codes, timings, Wasm sizes/imports, browser versions and network checks. The suite includes expected failures for unsupported features; a passing negative test does **not** mean the feature is supported. Two exception probes record observations without asserting support.

`npm run test:worker` runs the Phase 2 message-boundary and lifecycle tests and writes `evidence/phase2-chromium.json` and `evidence/phase2-firefox.json`. The original Phase 1 proof, commands, asset files and download instructions remain available unchanged.

`npm run test:api` checks the public API's lifecycle, validation, results, hard cancellation, reset, disposal and Worker failure handling in Chromium and Firefox. It writes local-only `evidence/phase3-chromium.json` and `evidence/phase3-firefox.json`.

`npm run test:project` checks canonical paths, duplicate detection, ordering, detached snapshots and real multi-file/header compilation in Chromium and Firefox. Browser jobs run with networking disabled after initialization. Results are local-only under `evidence/phase4-*.json`.

`npm run test:compile-run` checks the Phase 5 compile/run contract, streams, input, exit codes, failures, repeatability, artifact ownership and lifecycle in Chromium and Firefox. Initialized jobs run offline. Results, including a wider-Unicode stdin observation, stay local under `evidence/phase5-*.json`.

`npm run test:diagnostics-options` checks diagnostic parsing, source/header/link locations, warning-only builds, the actual selected Clang flags, option behavior and API/Worker rejection of invalid options in Chromium and Firefox. Raw reports stay local under `evidence/phase6-*.json`.

`npm run test:robustness` checks Phase 7 limits, cancellation and timeout races, malformed Worker responses, stale-message handling, resource cleanup and recovery in Chromium and Firefox. Normal initialized jobs run offline; replacement Workers reload same-origin assets. Raw reports stay local under `evidence/phase7-*.json`.

`npm run verify:assets` checks the already-downloaded pinned files without fetching or repairing them, including the deterministic host patch. `npm run build` creates one ignored `dist/` directory with an allowlisted package, `release-manifest.json`, notices, and a minimal consumer example. `npm run verify:release` checks the exact package file list, hashes, paths and entry. `npm run test:release` serves **only the built package** over loopback HTTP at `/` and `/cpp-engine/`, then tests its public API, options, diagnostics, cancellation, real infinite-loop timeout/recovery, reset, disposal and example in Chromium and Firefox. Timings are recorded in ignored `evidence/phase8-release.json`.

The release package entry is `dist/src/index.js` (package export `browser-cpp-engine`). Deploy the complete directory with its relative Worker and asset paths intact; `file://` is unsupported. The package is marked private and has not been published. See [its README](release/README.md) for intended deployment behavior and [the build script](scripts/build-release.mjs) for the exact allowlist. The pinned Clang and engine versions are separate.

The engine license is being finalized as AGPL 3.0; upstream Clang/LLD notices are separate. The pinned sysroot archive has no bundled notice inventory, so third-party redistribution review is **incomplete**. The package preserves the two upstream notice files and calls out this gap; it must not be described as fully cleared for publication yet.

To limit the test to one installed browser in PowerShell:

```powershell
$env:BROWSERS = 'chromium'
npm test
Remove-Item Env:BROWSERS
```

The separate, online Wasmer candidate probe is reproducible with `node scripts/probe-wasmer.mjs`. It downloads `clang/clang@0.160000.1` from the Wasmer registry and records its outcome in `evidence/wasmer-probe.json`. It is not used by the selected baseline. Its current compiler-dispatch failure is documented in the report.

## Privacy before sharing

Only files named `README.md` are eligible for Git among Markdown files. Project notes, research prose, generated browser evidence, downloaded toolchains, local data, credentials and common editor files are ignored. Raw test output can include submitted source and program output; see [evidence/README.md](evidence/README.md). Run `npm run check:privacy` before staging. The local pre-commit check is installed in this working copy; on a new clone, enable it with `git config core.hooksPath .githooks`. On macOS/Linux, also run `chmod +x .githooks/pre-commit`.

Review `git status --short --untracked-files=all` and `git diff --cached` before pushing. Ignore rules do not remove files already committed elsewhere, and the checker cannot recognize every kind of private data.

## Files

- `poc/worker.js`, `poc/cases.mjs`: private experiment and C++ fixtures.
- `worker/compiler-worker.js`, `worker/runtime.js`, `worker/protocol.js`: dedicated runtime, toolchain adapter, input validation and diagnostics.
- `src/index.js`, `src/project.js`, `src/virtual-fs.js`, `src/worker-client.js`: public API, internal project/VFS model and private Worker transport.
- `docs/`: local-only Phase 2–8 architecture, protocol, API, project, compile/run, diagnostics/options, robustness and lifecycle notes.
- `guide/`: shareable consumer documentation; `release/`: shareable release input; `dist/`: ignored generated package.
- `scripts/`: asset verification, static test transport and browser automation.
- `research/`: local-only comparison plus shareable asset URLs/hashes and upstream observations.
- `evidence/`: local-only measured results, including the unavailable WebKit environment.
- `decisions.md`, `progress/STATUS.md`, `logs/`: local-only project decision and activity record.

The only upstream runtime modification forwards the file descriptor to its output callback so stdout and stderr can be distinguished. The deterministic patch is in `scripts/fetch-assets.mjs`; original upstream files remain intact.
