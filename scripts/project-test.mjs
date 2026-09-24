import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { serve } from './static-server.mjs';
import { ProjectSnapshot } from '../src/project.js';
import { normalizeProjectPath, VirtualFileSystem } from '../src/virtual-fs.js';

const invalid = action => assert.throws(action, error => error.code === 'INVALID_PROJECT');
assert.equal(normalizeProjectPath('./src/./main.cpp'), 'src/main.cpp');
assert.equal(normalizeProjectPath('main.cpp'), 'main.cpp');
for (const path of ['', '.', './', '../main.cpp', 'src/../main.cpp', '/absolute/main.cpp',
  'C:/project/main.cpp', 'C:\\project\\main.cpp', 'src\\main.cpp', 'foo\0bar', 'a//b.cpp', 'a/']) {
  invalid(() => normalizeProjectPath(path));
}
invalid(() => normalizeProjectPath('include'));
invalid(() => normalizeProjectPath('a'.repeat(241)));

const fs = new VirtualFileSystem([
  ['./src/./main.cpp', 'original'], ['include/z.hpp', 'z'], ['include/a.hpp', 'a']
]);
assert.equal(fs.size, 3);
assert.equal(fs.read('src/main.cpp'), 'original');
assert.equal(fs.read('./src/main.cpp'), 'original');
assert.equal(fs.read('missing.cpp'), undefined);
assert.equal(fs.has('./src/main.cpp'), true);
assert.equal(fs.has('missing.cpp'), false);
assert.deepEqual(fs.list(), ['include/a.hpp', 'include/z.hpp', 'src/main.cpp']);
assert.deepEqual(fs.entries(), [
  { path: 'include/a.hpp', content: 'a' },
  { path: 'include/z.hpp', content: 'z' },
  { path: 'src/main.cpp', content: 'original' }
]);
const returnedEntry = fs.entries()[2];
returnedEntry.content = 'changed';
fs.toWorkerFiles()['src/main.cpp'] = 'changed';
fs.list().push('another.cpp');
assert.equal(fs.read('src/main.cpp'), 'original');
assert.throws(() => new VirtualFileSystem([['main.cpp', 'A'], ['./main.cpp', 'B']]),
  error => error.code === 'INVALID_PROJECT' && error.message.includes('main.cpp') && error.message.includes('./main.cpp'));
invalid(() => new VirtualFileSystem([['src', 'A'], ['src/main.cpp', 'B']]));

const filesA = { 'z.cpp': 'int z(){return 2;}', 'main.cpp': 'int main(){return 0;}',
  'a.cpp': 'int a(){return 1;}', 'config.hpp': '#define X 1' };
const filesB = { 'config.hpp': '#define X 1', 'a.cpp': 'int a(){return 1;}',
  'main.cpp': 'int main(){return 0;}', 'z.cpp': 'int z(){return 2;}' };
const snapshotA = new ProjectSnapshot({ files: filesA, entry: './main.cpp', stdin: 'input' });
const snapshotB = new ProjectSnapshot({ files: filesB, entry: 'main.cpp', stdin: 'input' });
assert.equal(snapshotA.entry, 'main.cpp');
assert.equal(snapshotA.stdin, 'input');
assert.deepEqual(snapshotA.filesystem.list(), ['a.cpp', 'config.hpp', 'main.cpp', 'z.cpp']);
assert.deepEqual(snapshotA.sources, ['main.cpp', 'a.cpp', 'z.cpp']);
assert.equal(JSON.stringify(snapshotA.toWorkerInput()), JSON.stringify(snapshotB.toWorkerInput()));
const includeSnapshot = new ProjectSnapshot({ files: {
  'src/main.cpp': '#include "include/math.hpp"', 'include/math.hpp': 'int add();'
}, entry: 'src/main.cpp' });
assert.equal(includeSnapshot.toWorkerInput().isolatedIncludes, true);
assert.deepEqual(includeSnapshot.filesystem.list(), ['include/math.hpp', 'src/main.cpp']);
filesA['main.cpp'] = 'modified';
delete filesA['a.cpp'];
const workerInput = snapshotA.toWorkerInput();
assert.equal(workerInput.files['main.cpp'], 'int main(){return 0;}');
assert.equal(workerInput.files['a.cpp'], 'int a(){return 1;}');
workerInput.files['main.cpp'] = 'changed again';
workerInput.sources.pop();
assert.equal(snapshotA.filesystem.read('main.cpp'), 'int main(){return 0;}');
assert.deepEqual(snapshotA.sources, ['main.cpp', 'a.cpp', 'z.cpp']);
invalid(() => new ProjectSnapshot({ files: { 'main.cpp': 'A', './main.cpp': 'B' }, entry: 'main.cpp' }));
invalid(() => new ProjectSnapshot({ files: { 'main.cpp': '' }, entry: 'absent.cpp' }));
console.log('project/VFS model: direct tests PASS');

const { server, url } = await serve();
try {
  for (const name of (process.env.BROWSERS || 'chromium,firefox').split(',')) {
    const browser = await ({ chromium, firefox })[name].launch();
    const report = { browser: name, version: browser.version(), recordedAt: new Date().toISOString(), checks: [], failures: [] };
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const requests = [];
      await context.route('**/*', route => {
        requests.push(route.request().url());
        return route.request().url().startsWith(url + '/') && route.request().method() === 'GET'
          ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      await page.goto(url + '/poc/blank.html');
      await page.evaluate(async () => {
        const { CppCompiler } = await import('/src/index.js');
        window.compiler = new CppCompiler();
        window.errorCode = async promise => { try { await promise; return null; } catch (error) { return error.code; } };
        await compiler.initialize();
      });
      await context.setOffline(true);
      const afterInit = requests.length;
      const run = project => page.evaluate(async input => {
        const result = await compiler.run(input);
        return { status: result.status, stdout: result.stdout, stderr: result.stderr,
          exitCode: result.exitCode, steps: result.steps.map(step => step.stage),
          wasmBytes: result.artifact?.bytes.byteLength ?? 0 };
      }, project);

      const basic = await run({ files: {
        'main.cpp': '#include <iostream>\nint add(int,int);int main(){std::cout<<add(2,3);}',
        'math.cpp': 'int add(int a,int b){return a+b;}'
      }, entry: 'main.cpp' });
      assert.equal(basic.status, 'success');
      assert.equal(basic.stdout, '5');
      assert.deepEqual(basic.steps, ['compile', 'compile', 'link', 'execute']);
      assert.ok(basic.wasmBytes > 8);
      report.checks.push('two-translation-units');

      const header = await run({ files: {
        'main.cpp': '#include <iostream>\n#include "math.hpp"\nint main(){std::cout<<add(2,3);}',
        'math.cpp': '#include "math.hpp"\nint add(int a,int b){return a+b;}',
        'math.hpp': 'int add(int,int);'
      }, entry: 'main.cpp' });
      assert.equal(header.stdout, '5');
      report.checks.push('root-header');

      const nested = await run({ files: {
        'src/main.cpp': '#include <iostream>\n#include "include/math.hpp"\nint main(){std::cout<<add(2,3);}',
        'src/math.cpp': '#include "include/math.hpp"\nint add(int a,int b){return a+b;}',
        'include/math.hpp': 'int add(int,int);'
      }, entry: 'src/main.cpp' });
      assert.equal(nested.stdout, '5');
      report.checks.push('nested-directories-and-header');

      const nestedHeaders = await run({ files: {
        'src/application.cpp': '#include <iostream>\n#include "include/math.hpp"\nint main(){std::cout<<sum();}',
        'include/math.hpp': '#include "config.hpp"\ninline int sum(){return BASE+2;}',
        'include/config.hpp': '#define BASE 3'
      }, entry: 'src/application.cpp' });
      assert.equal(nestedHeaders.stdout, '5');
      assert.deepEqual(nestedHeaders.steps, ['compile', 'link', 'execute']);
      report.checks.push('nested-headers-and-non-main-entry');

      const normalized = await run({ files: {
        './src/./application.cpp': '#include <iostream>\nint main(){std::cout<<"normalized";}'
      }, entry: 'src/application.cpp' });
      assert.equal(normalized.stdout, 'normalized');
      report.checks.push('benign-dot-normalization');

      const headerFailure = await page.evaluate(async () => {
        const result = await compiler.compile({ files: {
          'src/application.cpp': '#include "include/bad.hpp"\nint main(){}',
          'include/bad.hpp': 'this is invalid C++;'
        }, entry: 'src/application.cpp' });
        return { status: result.status, diagnostics: result.diagnostics };
      });
      assert.equal(headerFailure.status, 'compile-error');
      assert.ok(headerFailure.diagnostics.some(d => d.file === 'include/bad.hpp' && d.severity === 'error'));
      report.checks.push('logical-header-diagnostic-path');

      const orderingA = await run({ files: {
        'z.cpp': 'int z(){return 2;}', 'main.cpp': '#include <iostream>\nint a();int z();int main(){std::cout<<a()+z();}',
        'a.cpp': 'int a(){return 3;}'
      }, entry: 'main.cpp' });
      const orderingB = await run({ files: {
        'a.cpp': 'int a(){return 3;}', 'main.cpp': '#include <iostream>\nint a();int z();int main(){std::cout<<a()+z();}',
        'z.cpp': 'int z(){return 2;}'
      }, entry: 'main.cpp' });
      assert.equal(orderingA.stdout, '5');
      assert.equal(orderingB.stdout, '5');
      assert.deepEqual(orderingA.steps, orderingB.steps);
      report.checks.push('insertion-independent-source-order');

      const mutation = await page.evaluate(async () => {
        const project = { files: { 'src/application.cpp': 'int main(){return 4;}' }, entry: 'src/application.cpp' };
        const operation = compiler.run(project);
        project.files['src/application.cpp'] = 'int main(){return 9;}';
        delete project.files['src/application.cpp'];
        project.entry = 'missing.cpp';
        const result = await operation;
        return { status: result.status, exitCode: result.exitCode };
      });
      assert.deepEqual(mutation, { status: 'nonzero-exit', exitCode: 4 });
      report.checks.push('caller-mutation-and-deletion-isolation');

      const rejected = await page.evaluate(async () => {
        const candidates = [
          { files: { 'main.cpp': 'A', './main.cpp': 'B' }, entry: 'main.cpp' },
          { files: { '../main.cpp': '' }, entry: '../main.cpp' },
          { files: { '/secret/main.cpp': '' }, entry: '/secret/main.cpp' },
          { files: { 'C:\\project\\main.cpp': '' }, entry: 'C:\\project\\main.cpp' },
          { files: { 'C:/project/main.cpp': '' }, entry: 'C:/project/main.cpp' },
          { files: { 'src\\main.cpp': '' }, entry: 'src\\main.cpp' },
          { files: { 'foo\0bar': '' }, entry: 'foo\0bar' },
          { files: { 'src/main.cpp': '' }, entry: '../src/main.cpp' },
          { files: { 'src': '', 'src/main.cpp': '' }, entry: 'src/main.cpp' }
        ];
        const codes = [];
        for (const candidate of candidates) codes.push(await errorCode(compiler.compile(candidate)));
        return { codes, state: compiler.getState() };
      });
      assert.ok(rejected.codes.every(code => code === 'INVALID_PROJECT'), JSON.stringify(rejected.codes));
      assert.equal(rejected.state, 'ready');
      report.checks.push('duplicates-traversal-absolute-windows-null-and-conflicts');

      assert.equal(requests.length, afterInit, 'Project jobs must not fetch after initialization');
      assert.ok(requests.every(request => request.startsWith(url + '/')));
      report.checks.push('offline-and-self-hosted');
      report.requestsDuringJobs = requests.length - afterInit;
      console.log(`${name}: ${report.checks.length} Phase 4 project groups PASS`);
    } catch (error) {
      report.failures.push(String(error.stack || error));
      process.exitCode = 1;
      console.error(`${name}:`, error);
    } finally {
      await writeFile(`evidence/phase4-${name}.json`, JSON.stringify(report, null, 2) + '\n');
      await browser.close();
    }
  }
} finally { server.close(); }
