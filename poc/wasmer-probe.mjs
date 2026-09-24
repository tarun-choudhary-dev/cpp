import { Wasmer } from '../node_modules/@wasmer/sdk/dist/index.js';

self.onmessage = async () => {
  const wasmer = new Wasmer({ cache: 'memory' });
  try {
    const pkg = await wasmer.packages.load('clang/clang@=0.160000.1');
    postMessage({ stage: 'package', commands: pkg.commands });
    const sandbox = await wasmer.sandboxes.create({ packages: [pkg], network: { mode: 'disabled' }, files: {
      'hello.cpp': '#include <iostream>\nint main() { std::cout << "Hello World\\n"; return 0; }\n'
    }});
    for (const args of [['--version'], ['-###', 'hello.cpp', '-o', 'hello.wasm', '-lc++'], ['-fsyntax-only', 'hello.cpp'], ['hello.cpp', '-o', 'hello.wasm', '-lc++']]) {
      postMessage({ stage: 'starting', args });
      const result = await sandbox.command(pkg, args).run({ check: false, timeoutMs: 30000 });
      postMessage({ stage: 'command', args, exitCode: result.exitCode, stdout: result.stdout.text(), stderr: result.stderr.text() });
      if (result.exitCode) { await sandbox.close(); return; }
    }
    const bytes = await sandbox.fs.readFile('/workspace/hello.wasm');
    const app = await wasmer.packages.load(bytes);
    const result = await sandbox.command(app).run({ check: false });
    postMessage({ stage: 'execution', exitCode: result.exitCode, stdout: result.stdout.text(), stderr: result.stderr.text() });
    await sandbox.close();
  } catch (e) { postMessage({ error: String(e), stack: e.stack }); }
  finally { await wasmer.close(); postMessage({ done: true }); }
};
