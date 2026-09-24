# CppCompiler API — 0.1.0-rc.1

Import the sole public export from the release package root (`browser-cpp-engine` when installed as a package) or from `src/index.js` when the complete release directory is hosted as static files. Deploy the entire directory without moving its `src/`, `worker/` or `poc/vendor/wasm-clang/` subdirectories. The browser needs ordinary same-origin HTTP(S); `file://` is unsupported. No DOM API or backend is required by the engine.

```js
import { CppCompiler } from '../src/index.js'; // Adjust to the hosted release directory.

const compiler = new CppCompiler();
try {
  await compiler.initialize();
  const result = await compiler.run({
    files: { 'main.cpp': '#include <iostream>\nint main(){std::cout << "hello\\n";}' },
    entry: 'main.cpp'
  });
  console.log(result.status, result.stdout, result.stderr, result.diagnostics);
} finally {
  await compiler.dispose();
}
```

`new CppCompiler(options = {})` creates no Worker. `options.workerUrl`, if supplied, is a URL or relative path resolved against `src/index.js`; `options.assetBase` is a URL or string that must resolve in the Worker to a same-origin directory URL ending in `/`. Defaults use the included relative layout. Invalid constructor option types/URLs throw `INVALID_OPTIONS` synchronously; an invalid asset directory rejects initialization. `getCompilerInfo()` returns `null` before readiness and after fatal failure/disposal, otherwise a copy of `{ clang, lld, commit, defaultStandard, abi }`. Engine version is in `package.json` and `release-manifest.json`, separate from the Clang version.

| Method | Arguments and return | State and failure behavior |
|---|---|---|
| `initialize()` | No arguments; Promise of compiler info | Creates/initializes Worker; repeated calls share or return ready info. `INITIALIZATION_ERROR` may be retried; `WORKER_ERROR` or fatal state requires `reset()`. The 45-second watchdog can reject `TIMEOUT`; explicit `initialize()` can retry. |
| `compile(project)` | Project object; Promise of result | Requires `ready`; builds without executing. Invalid input rejects before Worker submission. Compiler/link failures resolve as results. Another active build rejects `COMPILER_BUSY`. |
| `run(project)` | Project object; Promise of result | Requires `ready`; compiles, links, then executes. It recompiles even after `compile()` on the same project. Nonzero exit and traps resolve as results. |
| `cancel()` | No arguments; Promise of replacement compiler info | During initialization/build, terminates the Worker; active Promise rejects `CANCELLATION`. Recreates and initializes a Worker. With no active work, resolves without changing it. Repeated calls during recovery share the replacement. |
| `reset()` | No arguments; Promise of replacement compiler info | Terminates current Worker and initializes a clean generation. Active work rejects `RESET_ERROR`; failed replacement rejects `RESET_ERROR` and leaves `fatal`. |
| `dispose()` | No arguments; Promise of `undefined` | Terminates Worker, settles pending work with `COMPILER_DISPOSED`, clears references/listeners/timers. Repeated disposal resolves. Other operations cannot resurrect it. |
| `isReady()` / `isBusy()` | No arguments; synchronous booleans | Reflect `ready` or `busy` state respectively. Initialization and recovery are neither `ready` nor `busy`. |
| `getState()` | No arguments; synchronous state string | `created`, `initializing`, `ready`, `busy`, `fatal` or `disposed`. |
| `getCompilerInfo()` | No arguments; synchronous object or `null` | Returns a copy, not Worker internals. |

For example, `await compiler.initialize()` readies the Worker; `await compiler.compile(project)` builds an artifact; `await compiler.run(project)` also executes. Call `compiler.getState()`, `compiler.isReady()`, `compiler.isBusy()` and `compiler.getCompilerInfo()` without awaiting them. To stop an active `run()`, attach a rejection handler to its Promise and then `await compiler.cancel()`; to discard all Worker state use `await compiler.reset()`. Finish with `await compiler.dispose()` even after a compile or runtime result reports failure. The runnable [consumer example](../../example/example.js) exercises initialization, execution, diagnostics, failure handling and disposal.

`compile()` and `run()` are `async` methods: validation and state failures appear as rejected Promises even though the project is snapshotted before yielding to the caller. `cancel()`, `reset()` and `dispose()` have the lifecycle behavior above. A native Worker crash, message decoding failure or malformed matching result rejects `WORKER_ERROR` and leaves `fatal`; use `reset()`. A timed-out build rejects `TIMEOUT`, terminates its Worker, and starts replacement without automatically rerunning that job; await `initialize()` before the next job. `TIMEOUT` carries the last known `error.stage` (`initialize`, `compile`, `link` or `execute`).

## Project input and internal model

```js
{
  files: { 'main.cpp': '...', 'math.cpp': '...', 'include/math.hpp': '...' },
  entry: 'main.cpp',
  stdin: 'optional preloaded input',
  options: { standard: 'c++17', optimization: 'O1', warnings: { all: true, extra: false } }
}
```

`files` is a nonempty map from virtual paths to source/data strings; `entry` must name one file. `stdin` defaults to `''` and is used only by `run()`. Optional options default to `standard: 'c++17'`, `optimization: 'O0'`, `warnings.all: false`, `warnings.extra: false`. Only `c++11`, `c++14`, `c++17`; `O0`, `O1`, `O2`; and boolean warning flags are accepted. Arbitrary compiler/linker flags, C++20/23, O3, debug controls and exception options are not exposed.

Paths are relative ASCII strings up to 240 characters, with `/` separators and letters, digits, `_`, `-` or `.` segments. Harmless `.` segments normalize. Absolute paths, `..`, backslashes, null bytes, empty segments, reserved toolchain roots, normalized duplicates and file/directory conflicts reject. The entry compiles first, followed by other `.cpp`, `.cc`, `.cxx`, `.C` files in canonical ASCII path order. Headers are available to includes but are not compiled separately. `include/` project headers are isolated from sysroot headers; their structured diagnostic paths map back to logical project paths. The internal `ProjectSnapshot` validates and copies inputs before a request; the internal `VirtualFileSystem` stores canonical text files. Neither is exported as a public class or host-disk filesystem. The Worker validates again and creates a fresh MemFS for every job.

## Result and diagnostic contract

Both methods resolve with this shape. `artifact` is `null` until linking succeeds; all named fields are present on real Worker results.

```js
{
  status: 'success', // compile-error | link-error | nonzero-exit | trap
  stage: 'execute', // last attempted: compile | link | execute
  exitCode: 0, // integer, or null on a trap
  stdout: '', stderr: '', // last attempted stage only
  stdoutTruncated: false, stderrTruncated: false,
  outputTruncated: false, diagnosticsTruncated: false,
  trap: null, // or { name: string, message: string }
  diagnostics: [{ stage: 'compile', severity: 'error', file: 'main.cpp',
    line: 1, column: 8, message: '...', raw: '...' }],
  steps: [{ stage: 'compile', stdout: '', stderr: '',
    stdoutTruncated: false, stderrTruncated: false,
    exitCode: 0, trap: null, ms: 12 }],
  artifact: { format: 'wasm', abi: 'wasi_unstable', bytes: Uint8Array },
  durationMs: 123
}
```

`success` means linked for `compile()` and exited zero for `run()`. `compile-error`/`link-error` stop before execution. `nonzero-exit` reports a program exit code; `trap` reports an unexpected stage exception with null exit code. These are normal results, not rejected API operations. `steps` keeps ordered compiler/linker/execution streams; top-level streams are only the last step. `durationMs` and `steps[].ms` are measured milliseconds, not performance guarantees. The artifact is a transferred `Uint8Array` owned by the caller and remains valid after another job, cancellation, reset or disposal. It uses the pinned `wasi_unstable` ABI; generic modern WASI hosts may not execute it directly.

Diagnostics are best-effort parsing of pinned Clang/LLD stderr, ordered as emitted and not deduplicated. `severity` is `fatal error`, `error`, `warning` or `note`; `stage` is `compile` or `link`. `file`, `line` and `column` may be `null`; locations are never invented. `raw` is the original diagnostic line up to its cap. `steps[].stderr` contains captured raw compiler output, including messages the parser did not recognize. Runtime stderr is not parsed as a compiler diagnostic. `outputTruncated` means combined stage capture was clipped; per-step and top-level stream flags identify which stream. `diagnosticsTruncated` also covers clipped diagnostic text or incomplete compiler stderr. See [security and limits](../security/README.md).

| Error code | Trigger and recovery |
|---|---|
| `INVALID_OPTIONS` | Bad constructor/project options; fix input, compiler remains usable. Constructor throws; project call rejects. |
| `INVALID_PROJECT` | Bad project shape/path/value/entry; fix input, compiler remains usable. |
| `RESOURCE_LIMIT` | Source/file/stdin or linked Wasm exceeds a bound; reduce input/artifact, compiler remains usable unless Worker separately fails. |
| `COMPILER_BUSY` | Overlapping build; wait for active operation. |
| `COMPILER_NOT_READY` | Build before ready or during recovery; initialize/wait. |
| `COMPILER_DISPOSED` | Call after disposal or active work interrupted by disposal; create a new instance. |
| `INVALID_STATE` | Initialize called in fatal state; `reset()` required. |
| `INITIALIZATION_ERROR` | Asset/runtime initialization failed; fix assets and retry `initialize()` where state is `created`. |
| `WORKER_ERROR` | Worker startup/crash/protocol failure; `reset()` required from `fatal`. |
| `RUNTIME_ERROR` | Unexpected engine request failure; inspect error; reset if the Worker becomes unusable. |
| `CANCELLATION` | Active work interrupted by `cancel()`; await cancellation/reinitialization, then retry explicitly. |
| `RESET_ERROR` | Active work interrupted by reset, or replacement failed; await reset or call it again from `fatal`. |
| `TIMEOUT` | Host watchdog terminated Worker; initial init may retry; builds recover through replacement, then retry explicitly. |

The implementation intentionally has no public Worker protocol, command-line flags, linker controls or result-scheme conversion. For a runnable example, see [the consumer example](../../example/example.js).
