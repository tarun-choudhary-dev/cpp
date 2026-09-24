# Security, limits and network model

This engine runs a pinned Clang/LLD toolchain and compiled C++ inside a browser Web Worker. The Worker uses in-memory WASI/MemFS, with fresh project files, output files, program state, stdin and stream capture for each job. The main thread sends text input and receives structured results; it does not run Clang or the generated program. Completed jobs reuse the initialized Worker and immutable compiler/sysroot cache. Cancellation, reset and timeout terminate the entire Worker and create a fresh generation. A request ID and Worker-generation check prevent late responses from changing newer work. The host validates matching Worker results, including nested diagnostics and artifact size, before exposing them.

The engine does not offer arbitrary compiler flags or host filesystem access. The pinned WASI host does not expose a browser network API to compiled C++. After successful initialization, normal jobs need no network requests. Initialization and every Worker replacement fetch the packaged, same-origin compiler assets; a cold offline start or replacement without an effective cache can fail. No service worker or persistent offline cache is included. Deploy over HTTP(S), keep all relative paths intact, and serve JavaScript with a JavaScript MIME type. `file://` is unsupported.

| Resource | Limit | Enforcement | Public outcome |
|---|---:|---|---|
| Virtual path | 240 ASCII characters | API and Worker | `INVALID_PROJECT` at API boundary |
| Files | 256 | API and Worker | `RESOURCE_LIMIT` rejection |
| One file's text | 1,048,576 UTF-16 code units | API and Worker | `RESOURCE_LIMIT` rejection |
| All file text | 4,194,304 UTF-16 code units | API and Worker | `RESOURCE_LIMIT` rejection |
| Preloaded stdin | 1,048,576 UTF-16 code units | API and Worker | `RESOURCE_LIMIT` rejection |
| Combined captured stdout/stderr across all stages | 1,048,576 UTF-16 code units | Worker callback; host result validation | Result with stream/overall truncation flags |
| Structured diagnostics | 512 per job | Worker parser; host validation | Result with `diagnosticsTruncated` |
| Diagnostic `message` and `raw` | 8,192 UTF-16 code units each | Worker parser; host validation | Clipped text and `diagnosticsTruncated` |
| Linked Wasm artifact | 33,554,432 bytes | Worker before transfer; host validation | `RESOURCE_LIMIT` rejection |
| Initialization | 45 seconds | Main-thread timer terminates Worker | `TIMEOUT` rejection |
| Build/staging | 60 seconds | Main-thread timer terminates Worker | `TIMEOUT` rejection |
| Execution after stage progress | 15 seconds | Main-thread timer terminates Worker | `TIMEOUT` rejection |
| Worker/Wasm memory | No portable hard quota | Indirect bounds and Worker termination | Browser may still exhaust memory |

The capture cap applies to both streams and all build/run stages together, not a separate megabyte for each stream. Per-stage `stdoutTruncated` and `stderrTruncated` flags identify loss. The captured strings are prefixes; compiler stderr and diagnostics may be incomplete once output is truncated. A single upstream callback can allocate its chunk before the cap is applied. The Wasm size check occurs after linking, so it does not cap peak linker memory. Source/stdin limits count JavaScript code units, not UTF-8 bytes. Timeouts depend on the main thread event loop being able to run and terminate the Worker; they are not CPU or memory quotas.

On a native Worker error, message decode error or malformed matching response, pending work rejects `WORKER_ERROR` and the instance enters `fatal`; call `reset()` for a new Worker. Timed-out builds reject `TIMEOUT` and trigger a replacement without retrying user code. Disposing removes listeners/timers and prevents resurrection. Artifacts already returned to callers remain theirs. A program can read/write its own job MemFS but cannot carry project files into another job.

This is **not** equivalent to a hardened server-side hostile-code sandbox. Browser memory exhaustion, WebAssembly/browser implementation flaws, and compiler/runtime vulnerabilities remain possible. Safari and mobile browser behavior are unverified. The pinned Clang 8 and old `wasi_unstable` host have limited language/library/OS coverage. For application deployments, review browser security headers, origin isolation and resource policy independently; the engine does not claim to solve those concerns.
