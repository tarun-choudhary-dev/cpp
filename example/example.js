// Minimal browser consumer of the released public entry. Open through HTTP(S).
import { CppCompiler } from '../src/index.js';

const compiler = new CppCompiler();
try {
  const info = await compiler.initialize();
  const result = await compiler.run({
    files: { 'main.cpp': '#include <iostream>\nint main(){std::cout << "example\\n";}' },
    entry: 'main.cpp'
  });
  console.log('Compiler:', info.clang);
  console.log('Status:', result.status, 'exit:', result.exitCode);
  console.log('stdout:', result.stdout, 'stderr:', result.stderr);
  console.log('diagnostics:', result.diagnostics);
  try {
    await compiler.compile({ files: {}, entry: 'missing.cpp' });
  } catch (error) {
    console.log('Invalid project:', error.code, error.message);
  }
  globalThis.exampleResult = { status: result.status, stdout: result.stdout };
} catch (error) {
  console.error('Compiler failed:', error.code, error.message);
  globalThis.exampleResult = { error: error.code ?? 'UNKNOWN' };
} finally {
  await compiler.dispose();
}
