#!/usr/bin/env node
/**
 * switch-model.mjs —— QQ 桥接模型快速切换（2026-10-31 用户要求）
 *
 * 用法：
 *   node scripts/switch-model.mjs            # 查看当前
 *   node scripts/switch-model.mjs jsnu       # 切到 JSNU · DeepSeek-V4-Flash
 *   node scripts/switch-model.mjs account    # 切到 DeepSeek 官方 · V4.1-Flash
 *
 * 两档的思考强度都固定 low。切换走桥接控制台的 POST /api/dsh/model：
 * 它改 config.json、更新内存配置、递增 modelSelectionEpoch，
 * 已有会话在下一条消息自动重新 selectModel，不用重启桥接或 DSH。
 * 控制台不可达时回退到直接改 config.json，并提示需要重启桥接。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const TOKEN_FILE = path.join(ROOT, 'state', 'console-token');

const PRESETS = {
  jsnu: { key: 'jsnu', provider: 'jsnu', model: 'deepseek-v4-flash', reasoningEffort: 'low', label: 'JSNU · DeepSeek-V4-Flash' },
  account: { key: 'account', provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low', label: 'DeepSeek 官方 · V4.1-Flash' },
  qwen: { key: 'qwen', provider: 'jsnu', model: 'qwen3.8-27b', reasoningEffort: 'low', label: 'JSNU · Qwen3.8-27B（能看图）' },
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function currentDsh() {
  const cfg = readJson(CONFIG_FILE);
  return {
    provider: String(cfg.dsh?.provider ?? ''),
    model: String(cfg.dsh?.model ?? ''),
    reasoningEffort: String(cfg.dsh?.reasoningEffort ?? ''),
    baseUrl: String(cfg.dsh?.baseUrl ?? ''),
    port: Number(cfg.consolePort) || 3100,
  };
}

function currentKey(dsh) {
  const hit = Object.values(PRESETS).find((p) => p.provider === dsh.provider && p.model === dsh.model);
  return hit ? hit.key : null;
}

function printState(dsh) {
  const key = currentKey(dsh);
  const label = key ? PRESETS[key].label : `${dsh.provider}/${dsh.model}（不在预设里）`;
  console.log('当前模型：' + label);
  console.log(`  provider=${dsh.provider}  model=${dsh.model}  effort=${dsh.reasoningEffort || '默认'}`);
  console.log('  可切换：' + Object.values(PRESETS).map((p) => p.key).join(' / '));
}

async function viaConsole(preset, dsh) {
  const token = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';
  if (!token) throw new Error('没有 state/console-token，无法走控制台接口');
  const url = `http://127.0.0.1:${dsh.port}/api/dsh/model`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify({ preset: preset.key }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** 控制台不可达时的兜底：只改 config.json，桥接下次启动才生效。 */
function writeConfigOnly(preset) {
  const cfg = readJson(CONFIG_FILE);
  const backup = CONFIG_FILE + '.bak-switch';
  fs.copyFileSync(CONFIG_FILE, backup);
  cfg.dsh = { ...(cfg.dsh ?? {}), provider: preset.provider, model: preset.model, reasoningEffort: preset.reasoningEffort };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return backup;
}

const arg = String(process.argv[2] ?? '').trim().toLowerCase();
const dsh = currentDsh();

if (arg === '' || arg === 'status' || arg === 'current') {
  printState(dsh);
  process.exit(0);
}

const preset = PRESETS[arg];
if (!preset) {
  console.error(`未知参数「${arg}」，可用：${Object.keys(PRESETS).join(' / ')} / status`);
  process.exit(1);
}
if (currentKey(dsh) === preset.key) {
  console.log('已经是 ' + preset.label + '，没动。');
  process.exit(0);
}

try {
  await viaConsole(preset, dsh);
  console.log('✅ 已切到 ' + preset.label + '（强度 ' + preset.reasoningEffort + '）');
  console.log('   下一条消息生效，不用重启桥接。');
} catch (error) {
  const backup = writeConfigOnly(preset);
  console.log('⚠️  控制台接口不可用（' + (error?.message ?? error) + '），已只改 config.json。');
  console.log('   备份：' + path.basename(backup));
  console.log('   需要重启桥接才生效：restart.bat，或等守护循环自己拉起。');
}
