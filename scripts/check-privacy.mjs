import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const staged = process.argv.includes('--staged');

function git(args) {
  return execFileSync('git', args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
}

function paths(args) {
  return git(args).toString('utf8').split('\0').filter(Boolean);
}

function isIgnored(path) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path], {
    stdio: 'ignore',
  });
  if (result.error || ![0, 1].includes(result.status)) {
    throw result.error ?? new Error(`git check-ignore failed for ${path}`);
  }
  return result.status === 0;
}

const signatures = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}\b/],
  ['OpenAI key', /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{35}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['Stripe secret key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/],
];

function findings(path, bytes) {
  const problems = [];
  if (isIgnored(path)) problems.push('path is covered by .gitignore');
  if (bytes.length > 5 * 1024 * 1024) {
    problems.push('file exceeds 5 MiB review limit');
    return problems;
  }
  if (bytes.includes(0)) {
    problems.push('binary file requires manual review');
    return problems;
  }

  const content = bytes.toString('utf8');
  for (const [name, pattern] of signatures) {
    if (pattern.test(content)) problems.push(name);
  }

  const assignment = /(?:^|[^\w])(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|client[_-]?secret|private[_-]?key)\s*["']?\s*[:=]\s*["']?([^\s"',;#]{8,})/gim;
  for (const match of content.matchAll(assignment)) {
    const value = match[1];
    if (/^(?:example|sample|dummy|changeme|placeholder|replace|process\.env|import\.meta|\$\{|<|your[_-])/i.test(value)) continue;
    problems.push('possible credential assignment');
    break;
  }
  return problems;
}

try {
  const selected = staged
    ? paths(['ls-files', '--cached', '-z'])
    : [...new Set([
        ...paths(['ls-files', '--cached', '-z']),
        ...paths(['ls-files', '--others', '--exclude-standard', '-z']),
      ])];

  const rejected = [];
  for (const path of selected) {
    const bytes = staged ? git(['show', `:${path}`]) : existsSync(path) && statSync(path).isFile() ? readFileSync(path) : null;
    if (bytes === null) continue;
    const reasons = findings(path, bytes);
    if (reasons.length) rejected.push(`${path}: ${[...new Set(reasons)].join(', ')}`);
  }

  if (rejected.length) {
    console.error(`Privacy check failed (${staged ? 'Git index' : 'working tree'}):`);
    for (const issue of rejected) console.error(`- ${issue}`);
    console.error('Remove private files from the index, or remove the sensitive content before committing.');
    process.exitCode = 1;
  } else {
    console.log(`Privacy check passed: ${selected.length} ${staged ? 'indexed' : 'shareable'} files reviewed.`);
  }
} catch (error) {
  console.error(`Privacy check could not complete: ${error.message}`);
  process.exitCode = 1;
}
