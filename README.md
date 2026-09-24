# Browser C++ compiler — Phase 2 Worker runtime

Real C++ compilation and execution have been verified in browser Web Workers with **no compiler backend**. The supplied `iostream` Hello World passes in Chromium and Firefox with all networking disabled before source submission.

The [pinned asset manifest](research/assets.json) records the toolchain inputs and hashes. The full research report and raw browser results are local-only files.

Phase 2 adds a reusable **Worker runtime** around the unchanged Phase 1 toolchain. The implementation lives in [worker/](worker/); internal protocol and architecture notes are local-only. It has no editor, UI, framework components, or final public `CppCompiler` API. `poc/blank.html` remains an empty automation fixture.

## Reproduce

Requires Node.js 20+ with built-in `fetch` (tested with 24.19.0) and npm. From this directory:

```sh
npm ci
npx playwright install chromium firefox
npm run assets
npm test
npm run test:worker
```

Setup downloads packages, browser binaries and approximately 60.4 MB of compiler assets. `npm run assets` verifies each upstream file against a pinned SHA-256 and retains license files. Subsequent runs reuse verified local assets. Large downloaded assets are excluded from Git.

`npm test` starts a temporary loopback **static GET-only** server, opens an empty page, loads Clang, LLD, an in-memory filesystem and the C++ sysroot into a Worker, disables browser networking, then submits C++ sources. All compilation, linking and program execution happen inside the browser. The script closes browsers and the server when finished.

It writes `evidence/chromium.json` and `evidence/firefox.json`: exact commands, stdout, stderr, exit codes, timings, Wasm sizes/imports, browser versions and network checks. The suite includes expected failures for unsupported features; a passing negative test does **not** mean the feature is supported. Two exception probes record observations without asserting support.

`npm run test:worker` runs the Phase 2 message-boundary and lifecycle tests and writes `evidence/phase2-chromium.json` and `evidence/phase2-firefox.json`. The original Phase 1 proof, commands, asset files and download instructions remain available unchanged.

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
- `docs/`: local-only Phase 2 architecture, internal messages, lifecycle and limits.
- `scripts/`: asset verification, static test transport and browser automation.
- `research/`: local-only comparison plus shareable asset URLs/hashes and upstream observations.
- `evidence/`: local-only measured results, including the unavailable WebKit environment.
- `decisions.md`, `progress/STATUS.md`, `logs/`: local-only project decision and activity record.

The only upstream runtime modification forwards the file descriptor to its output callback so stdout and stderr can be distinguished. The deterministic patch is in `scripts/fetch-assets.mjs`; original upstream files remain intact.
