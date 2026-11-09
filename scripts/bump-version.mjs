import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve('package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const old = String(pkg.version || '0.0.0');
let next;

const r = old.match(/^(.*-r)(\d+)$/);
if (r) {
  next = r[1] + (Number(r[2]) + 1);
} else {
  const m = old.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) {
    console.error('Unsupported version: ' + old);
    process.exit(1);
  }
  next = m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1) + (m[4] || '');
}

pkg.version = next;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');

const lockFile = path.resolve('package-lock.json');
if (fs.existsSync(lockFile)) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
}

console.log(old + ' -> ' + next);
