// 「把音乐链接变成一条 QQ 语音」。
//
// 流程：解析链接（B 站：BV/av/短链）→ 取 view 拿 cid → playurl 取 dash 音频流
//      → 下载 → ffmpeg 裁剪到 maxSeconds → 交给语音发送链路。
// 只支持 B 站；网易云/QQ 音乐需要登录态与另外的接口，后面再补。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BiliClient, parseVideoRef, resolveShortLink } from './bili-client.js';
import { inspectAudio, resolveFfmpeg } from './voice-core.js';
import { readCredential } from './bili-login.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;

export function isBiliLink(input) {
  const s = String(input ?? '');
  return /(?:^|\/\/)(?:[a-z0-9-]+\.)?bilibili\.com\//i.test(s) ||
    /(?:^|\/\/)(?:b23\.tv|bili2233\.cn)\//i.test(s) ||
    /^BV[0-9A-Za-z]{10}$/.test(s.trim()) || /^av\d+$/i.test(s.trim());
}

function ffmpegRun(bin, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('ffmpeg 超时')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error('ffmpeg 退出码 ' + code));
    });
  });
}

function pickAudioUrl(dash) {
  const audios = Array.isArray(dash?.audio) ? dash.audio : [];
  if (!audios.length) return null;
  const best = audios
    .filter((a) => a && (a.baseUrl || a.base_url))
    .sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
  if (!best) return null;
  const url = best.baseUrl || best.base_url;
  const backup = Array.isArray(best.backupUrl) ? best.backupUrl[0] : (Array.isArray(best.backup_url) ? best.backup_url[0] : null);
  return { url, backup, bandwidth: Number(best.bandwidth) || 0, mime: best.mimeType || best.mime_type || '' };
}

/** 解析 B 站链接/号码 → { bvid, aid }。短链会跟一次重定向。 */
export async function resolveBiliRef(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('缺少链接或 BV 号');
  let ref = null;
  try { ref = parseVideoRef(raw); } catch { ref = null; }
  if (!ref) {
    ref = await resolveShortLink(raw).catch(() => null);
  }
  if (!ref) throw new Error('读不出 B 站视频号：目前只支持 B 站链接（bilibili.com / b23.tv）或 BV 号');
  return ref;
}

/**
 * 下载并裁剪一段可当语音发的音频。
 * @returns {{ file: string, title: string, owner: string, sourceDuration: number, seconds: number, bandwidth: number }}
 */
export async function fetchBiliAudio(input, { stateDir, ffmpegPath = null, maxSeconds = 300, startSeconds = 0, outDir } = {}) {
  const ref = await resolveBiliRef(input);
  const client = new BiliClient({});
  const cred = readCredential(stateDir);
  if (cred) client.setCredential(cred);

  const q = ref.bvid ? 'bvid=' + encodeURIComponent(ref.bvid) : 'aid=' + Number(ref.aid);
  const view = await client.requestJson('https://api.bilibili.com/x/web-interface/view?' + q, { cacheTtlMs: 300000 });
  const cid = Number(view?.pages?.[0]?.cid ?? view?.cid) || 0;
  if (!cid) throw new Error('这个视频没有可用的分 P（拿不到 cid）');

  let play = null;
  try {
    play = await client.requestWbi('/x/player/wbi/playurl', {
      bvid: view.bvid, cid: String(cid), fnval: '16', fnver: '0', fourk: '0'
    }, { useCredential: true });
  } catch (error) {
    // 未登录时 wbi playurl 偶尔被风控，退回老接口再试一次。
    play = await client.requestJson(
      'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(view.bvid) +
      '&cid=' + cid + '&fnval=16&fnver=0&fourk=0',
      { useCredential: true }
    ).catch(() => { throw error; });
  }

  let picked = pickAudioUrl(play?.dash);
  if (!picked) {
    // 少数老视频只有 durl（整段 mp4），退化成下载 mp4 再抽音轨。
    const durl = Array.isArray(play?.durl) ? play.durl.find((d) => d && d.url) : null;
    if (!durl) throw new Error('这个视频没有音频流（可能是纯音乐投稿的版权限制）');
    picked = { url: durl.url, backup: null, bandwidth: 0, mime: 'video/mp4' };
  }

  const cookie = [await client.anonymousCookie().catch(() => ''), client.credentialCookie()].filter(Boolean).join('; ');
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...(cookie ? { Cookie: cookie } : {}) };
  let res = await fetch(picked.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!res.ok && picked.backup) res = await fetch(picked.backup, { headers, redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('下载音频失败（HTTP ' + res.status + '）');

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('音频文件太大（超过 30MB）');
  if (buf.length < 1024) throw new Error('下载到的音频是空的');

  const dir = outDir ? path.resolve(outDir) : path.join(stateDir, 'tmp-music-voice');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const srcExt = /mpeg|mp3/i.test(picked.mime) ? '.mp3' : (/mp4|m4a/i.test(picked.mime) ? '.m4a' : '.bin');
  const src = path.join(dir, 'src-' + stamp + srcExt);
  const out = path.join(dir, 'voice-' + stamp + '.mp3');
  fs.writeFileSync(src, buf);

  let ffmpeg = ffmpegPath || null;
  if (!ffmpeg) {
    // 先找项目自带的静态 ffmpeg（npm 安装时下载），再退回 PATH。
    const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
    try { if (fs.statSync(bundled).isFile()) ffmpeg = bundled; } catch {}
  }
  ffmpeg = ffmpeg || resolveFfmpeg({});
  const start = Math.max(0, Number(startSeconds) || 0);
  try {
    await ffmpegRun(ffmpeg, [
      '-y', '-ss', String(start), '-i', src,
      '-t', String(Math.max(1, Number(maxSeconds) || 300)),
      '-vn', '-ac', '1', '-ar', '44100', '-b:a', '96k', out
    ]);
  } finally {
    try { fs.unlinkSync(src); } catch {}
  }

  const probe = await inspectAudio(out, { maxBytes: 20 * 1024 * 1024, maxSeconds: Math.max(1, Number(maxSeconds) || 300) });
  if (!probe.ok) {
    try { fs.unlinkSync(out); } catch {}
    throw new Error('处理后的音频不可用：' + (probe.error || '未知'));
  }

  return {
    file: out,
    title: String(view.title ?? '').trim(),
    owner: String(view?.owner?.name ?? '').trim(),
    sourceDuration: Number(view.duration) || 0,
    seconds: probe.duration ?? Math.round((probe.size / 12000) * 10) / 10,
    bandwidth: picked.bandwidth
  };
}
