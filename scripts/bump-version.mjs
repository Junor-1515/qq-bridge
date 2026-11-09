import fs from 'node:fs';
import path from 'node:path';

function bumpVersion(old) {
  const r = old.match(/^(.*-r)(\d+)$/);
  if (r) return r[1] + (Number(r[2]) + 1);
  const m = old.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) {
    console.error('Unsupported version: ' + old);
    process.exit(1);
  }
  return m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1) + (m[4] || '');
}

const rootFile = path.resolve('package.json');
const rootPkg = JSON.parse(fs.readFileSync(rootFile, 'utf8'));
const old = String(rootPkg.version || '0.0.0');
const next = bumpVersion(old);

const targets = [rootFile];
const pluginsDir = path.resolve('plugins');
if (fs.existsSync(pluginsDir)) {
  for (const name of fs.readdirSync(pluginsDir).sort()) {
    const file = path.join(pluginsDir, name, 'package.json');
    if (fs.existsSync(file)) targets.push(file);
  }
}

for (const file of targets) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = next;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}

const lockFile = path.resolve('package-lock.json');
if (fs.existsSync(lockFile)) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
}

console.log(old + ' -> ' + next + ' (' + targets.length + ' package.json)');
