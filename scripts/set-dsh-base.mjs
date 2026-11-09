// 把 DSH 的 baseUrl 写进 qq-bridge/config.json，其余字段原样保留。
// 为什么单独一个脚本：PowerShell 5.1 的 ConvertTo-Json 会把中文转成 \uXXXX、
// Set-Content -Encoding utf8 又会加 BOM，两个都恶心。用 node 写最干净。
//
// 用法：node scripts/set-dsh-base.mjs http://127.0.0.1:58762
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.join(here, '..', 'config.json');

const next = String(process.argv[2] ?? '').trim();
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(next)) {
  console.error(`[set-dsh-base] 拒绝写入非法 baseUrl: ${next || '(空)'}`);
  process.exit(2);
}

let text = fs.readFileSync(cfgPath, 'utf8');
const hadBom = text.charCodeAt(0) === 0xFEFF;
if (hadBom) text = text.slice(1);
const cfg = JSON.parse(text);
const prev = String(cfg?.dsh?.baseUrl ?? '');
if (prev === next) {
  console.log(`[set-dsh-base] 已是最新：${next}`);
  process.exit(0);
}
cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl: next };
fs.writeFileSync(cfgPath, (hadBom ? '\uFEFF' : '') + JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log(`[set-dsh-base] ${prev || '(空)'} → ${next}`);
