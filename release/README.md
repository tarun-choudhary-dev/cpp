# Browser C++ compiler engine — 0.1.0-rc.1

This is a reusable JavaScript engine that compiles and runs C++ locally in browser Workers using pinned Clang 8.0.1, LLD and an older WASI/MemFS host. It requires no compiler backend, editor or UI framework. Chromium and Firefox are tested; Safari is unverified. The package is a release candidate, not a published npm package.

Host the **entire release directory** on one HTTP(S) origin, preserving `src/`, `worker/` and `poc/vendor/wasm-clang/` relative paths. JavaScript files need a JavaScript MIME type. `file://` is unsupported. If using package tooling, import `browser-cpp-engine` through its `exports` entry and copy the complete static asset/Worker tree to the deployed output with the same relative structure. A bundler that moves `src/index.js` independently of its Worker/assets needs explicit deployment testing; no bundler integration is supplied.

```js
import { CppCompiler } from './src/index.js';

const compiler = new CppCompiler();
try {
  await compiler.initialize();
  const result = await compiler.run({
    files: { 'main.cpp': '#include <iostream>\nint main(){std::cout << "Hello World\\n";}' },
    entry: 'main.cpp'
  });
  console.log(result.status, result.stdout, result.stderr, result.diagnostics);
} finally {
  await compiler.dispose();
}
```

The sole public class is `CppCompiler`. Its methods are `initialize`, `compile`, `run`, `cancel`, `reset`, `dispose`, `isReady`, `isBusy`, `getState` and `getCompilerInfo`. Projects provide a `files` text map, an existing `entry`, and optional preloaded `stdin` and validated `options`. `compile()` does not execute; `run()` compiles, links and executes. C++ compile/link failures, nonzero exits and traps resolve as structured results. Engine/Worker failures reject with stable `error.code` values. Returned Wasm bytes are caller-owned. See the [full API and schema](guide/api/README.md) and [runnable example](example/example.js).

Options are limited to C++11/14/17, O0/O1/O2, and boolean `warnings.all`/`warnings.extra`; defaults are C++17/O0 with both warnings false. Diagnostics include stage, severity, nullable source location, message and raw line. Captured output and diagnostics can be truncated at documented limits. `cancel()` and `reset()` terminate and replace the Worker; builds and execution also have host-side watchdogs. See [security and resource limits](guide/security/README.md).

The package contains browser-native ES modules under `src/`, a classic internal Worker under `worker/`, pinned compiler/runtime assets under the legacy relative path `poc/vendor/wasm-clang/`, a minimal example and public guides. It contains no test harness, development script, research note or backend. Initialization fetches same-origin assets; normal initialized jobs make no network requests. Worker replacement reloads assets, so cold offline startup/recovery is not promised.

The engine's own code is licensed under the license in `LICENSE`; bundled toolchain components retain their separate upstream notices in `poc/vendor/wasm-clang/LICENSE`, `LICENSE.llvm` and `THIRD_PARTY_NOTICES.txt`. **The exact sysroot component/notice inventory is still under review. Do not publish this candidate as a cleared third-party distribution until that review is complete.** See the [toolchain inventory](guide/toolchain/README.md), [test matrix](guide/testing/README.md) and `release-manifest.json` for versions, hashes and package contents.

Known limitations: pinned Clang 8, no exposed C++20/23, O3, debug or exception options, no interactive stdin, an observed `世界` stdin round-trip issue, incomplete WASI/OS coverage, no portable hard Worker memory quota, and no claim of a hardened hostile-code sandbox. Safari remains unverified.
