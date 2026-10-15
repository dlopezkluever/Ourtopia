import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:sk_live_|rk_live_)[A-Za-z0-9]{12,}/,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/,
  /\bsbp_[a-f0-9]{30,}/,
];
let failed = false;
for (const file of files) {
  if (file === 'package-lock.json') continue;
  const body = readFileSync(file, 'utf8');
  if (forbidden.some(expression => expression.test(body))) { process.stderr.write(`Potential secret in ${file}.\n`); failed = true; }
}
if (failed) process.exitCode = 1;
else process.stdout.write(`Secret patterns checked in ${files.length} tracked or unignored files.\n`);
