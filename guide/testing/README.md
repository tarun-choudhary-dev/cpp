# Release verification matrix

The source repository has separate browser commands for each phase. Run from the repository root after `npm ci`, `npx playwright install chromium firefox` and `npm run assets`:

| Scope | Command | Chromium | Firefox |
|---|---|---|---|
| Phase 1 proof | `npm test` | Verified | Verified |
| Phase 2 Worker | `npm run test:worker` | Verified | Verified |
| Phase 3 API | `npm run test:api` | Verified | Verified |
| Phase 4 project/VFS | `npm run test:project` | Verified | Verified |
| Phase 5 compile/run | `npm run test:compile-run` | Verified | Verified |
| Phase 6 diagnostics/options | `npm run test:diagnostics-options` | Verified | Verified |
| Phase 7 robustness | `npm run test:robustness` | Verified | Verified |
| Phase 8 package | `npm run test:release` | Verified at `/` and `/cpp-engine/` | Verified at `/` and `/cpp-engine/` |

`npm run verify:assets` fails on missing, altered or unexpected local toolchain files; it does not fetch replacements. `npm run build` creates `dist/`, and `npm run verify:release` checks its exact file list and digests against the generated manifest. `npm run check:privacy` reviews files eligible for Git. `npm run test:release` serves only `dist/` on a temporary GET-only loopback server, both at the root and under `/cpp-engine/`, then tests the actual packaged API in Chromium and Firefox. It records timings as observations, not promises. Raw browser reports are written under ignored `evidence/`.

All compiler execution is client-side; the loopback server is static file transport, not a compiler backend. A successful initialization fetches the packaged assets. Normal initialized jobs make no network requests; replacement Workers fetch trusted assets again. Safari: unverified. A `file://` deployment is not supported.

The packaged-output smoke test used Chromium 153.0.8010.12 and Firefox 155.0 on 2026-09-24. At the HTTP root, observed Chromium timings were approximately 580 ms initialization, 1,816 ms simple compile, 922 ms simple run and 547 ms cancellation plus replacement; Firefox observed 1,192 ms, 1,221 ms, 1,009 ms and 910 ms respectively. Execution of an infinite C++ loop ended with engine `TIMEOUT` after about 15.0 s in Chromium and 16.3 s in Firefox, followed by a successful run on the replacement Worker. These are local observations, not startup or performance guarantees.
