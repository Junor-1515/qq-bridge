// 媒体缓存：B 站 MP4 与音乐 MP3 共用一套「按天 + 按体积」的清理策略。
// 目录结构：<root>/bili/*.mp4、<root>/music/*.mp3；文件 mtime 即最后使用时间。
import fs from 'node:fs';
import path from 'node:path';

const MB = 1024 * 1024;

export function ensureCacheDir(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** 清理：先按天数删过期，再按总体积删最旧的。返回 {removed, freedBytes, keptBytes, keptFiles}。 */
export function cleanupCache(root, { days = 7, maxMb = 500 } = {}) {
  const maxBytes = Math.max(0, Number(maxMb) || 0) * MB;
  const maxAgeMs = Math.max(1, Number(days) || 7) * 24 * 3600 * 1000;
  const now = Date.now();
  const files = walk(root).map((file) => {
    let st = null;
    try { st = fs.statSync(file); } catch {}
    return st ? { file, size: st.size, mtime: st.mtimeMs } : null;
  }).filter(Boolean);
  const removed = [];
  let freed = 0;
  const keep = [];
  for (const f of files) {
    if (now - f.mtime > maxAgeMs) {
      try { fs.unlinkSync(f.file); removed.push(f.file); freed += f.size; } catch {}
    } else keep.push(f);
  }
  keep.sort((a, b) => a.mtime - b.mtime);
  let total = keep.reduce((s, f) => s + f.size, 0);
  while (total > maxBytes && keep.length > 0) {
    const f = keep.shift();
    try { fs.unlinkSync(f.file); removed.push(f.file); freed += f.size; total -= f.size; } catch {}
  }
  return { removed: removed.length, freedBytes: freed, keptBytes: total, keptFiles: keep.length };
}

export function cacheStats(root) {
  const files = walk(root);
  let bytes = 0;
  for (const f of files) { try { bytes += fs.statSync(f).size; } catch {} }
  return { files: files.length, bytes };
}
