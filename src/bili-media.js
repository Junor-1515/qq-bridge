// B 站视频 → MP4（分享视频时自动下载并留在缓存里）。
// dash 视频流 + 音频流用 ffmpeg 直接 -c copy 合流，不重编码；只有 durl 的老视频直接存 mp4。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BiliClient } from './bili-client.js';
import { readCredential } from './bili-login.js';
import { resolveBiliRef } from './music-voice.js';
import { ensureCacheDir } from './media-cache.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BYTES = 300 * 1024 * 1024;

function bundledFfmpeg() {
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
  try { if (fs.statSync(p).isFile()) return p; } catch {}
  return null;
}

function run(bin, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('ffmpeg 超时')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg 退出码 ' + code)); });
  });
}

async function download(url, headers, maxBytes = MAX_BYTES) {
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
  const len = Number(res.headers.get('content-length')) || 0;
  if (len > maxBytes) throw new Error('文件太大（' + Math.round(len / 1024 / 1024) + 'MB）');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('下载到的文件是空的');
  if (buf.length > maxBytes) throw new Error('文件太大（' + Math.round(buf.length / 1024 / 1024) + 'MB）');
  return buf;
}

function pickVideo(dash) {
  const list = Array.isArray(dash?.video) ? dash.video.filter((v) => v && (v.baseUrl || v.base_url)) : [];
  if (!list.length) return null;
  // 优先 720P（id 64），其次 480P/360P；不取 1080P，免得文件太大、上传太慢。
  const rank = (v) => {
    const id = Number(v.id) || 0;
    if (id === 64) return 0;
    if (id === 32) return 1;
    if (id === 16) return 2;
    return 3;
  };
  const best = list.sort((a, b) => rank(a) - rank(b) || (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
  return { url: best.baseUrl || best.base_url, backup: (best.backupUrl || best.backup_url || [])[0] || null };
}

function pickAudio(dash) {
  const list = Array.isArray(dash?.audio) ? dash.audio.filter((a) => a && (a.baseUrl || a.base_url)) : [];
  if (!list.length) return null;
  const best = list.sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
  return { url: best.baseUrl || best.base_url, backup: (best.backupUrl || best.backup_url || [])[0] || null };
}

/**
 * 取（或复用）一条 B 站视频的 mp4。
 * @returns {{file:string,title:string,owner:string,duration:number,cached:boolean}}
 */
export async function fetchBiliMp4(input, { stateDir, cacheDir, ffmpegPath = null, maxDuration = 600 } = {}) {
  const ref = await resolveBiliRef(input);
  const dir = cacheDir ? ensureCacheDir(cacheDir, 'bili') : ensureCacheDir(path.join(stateDir, 'media-cache'), 'bili');
  const client = new BiliClient({});
  const cred = readCredential(stateDir);
  if (cred) client.setCredential(cred);
  const q = ref.bvid ? 'bvid=' + encodeURIComponent(ref.bvid) : 'aid=' + Number(ref.aid);
  const view = await client.requestJson('https://api.bilibili.com/x/web-interface/view?' + q, { cacheTtlMs: 300000 });
  const bvid = String(view.bvid || ref.bvid || '');
  if (!bvid) throw new Error('读不出视频号');
  const duration = Number(view.duration) || 0;
  const limit = Math.max(10, Number(maxDuration) || 600);
  if (duration > limit) throw new Error('视频时长 ' + Math.round(duration / 60) + ' 分钟，超过上限 ' + Math.round(limit / 60) + ' 分钟，不解析');
  const out = path.join(dir, bvid + '.mp4');
  if (fs.existsSync(out) && fs.statSync(out).size > 10 * 1024) {
    try { fs.utimesSync(out, new Date(), new Date()); } catch {}
    return { file: out, title: String(view.title ?? ''), owner: String(view?.owner?.name ?? ''), duration, cached: true };
  }

  const cid = Number(view?.pages?.[0]?.cid ?? view?.cid) || 0;
  if (!cid) throw new Error('这个视频没有可用的分 P');
  let play = null;
  try {
    play = await client.requestWbi('/x/player/wbi/playurl', { bvid, cid: String(cid), fnval: '16', fnver: '0', fourk: '0' }, { useCredential: true });
  } catch (error) {
    play = await client.requestJson('https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) + '&cid=' + cid + '&fnval=16&fnver=0&fourk=0', { useCredential: true }).catch(() => { throw error; });
  }
  const cookie = [await client.anonymousCookie().catch(() => ''), client.credentialCookie()].filter(Boolean).join('; ');
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...(cookie ? { Cookie: cookie } : {}) };
  const ffmpeg = ffmpegPath || bundledFfmpeg() || 'ffmpeg';
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const tmp = path.join(dir, '.tmp-' + stamp + '.mp4');
  try {
    const video = pickVideo(play?.dash);
    if (video) {
      const audio = pickAudio(play?.dash);
      const vbuf = await download(video.url, headers);
      const vfile = path.join(dir, '.v-' + stamp + '.m4s');
      fs.writeFileSync(vfile, vbuf);
      let afile = null;
      if (audio) {
        const abuf = await download(audio.url, headers);
        afile = path.join(dir, '.a-' + stamp + '.m4s');
        fs.writeFileSync(afile, abuf);
      }
      try {
        if (afile) await run(ffmpeg, ['-y', '-i', vfile, '-i', afile, '-c', 'copy', '-movflags', '+faststart', tmp]);
        else await run(ffmpeg, ['-y', '-i', vfile, '-c', 'copy', '-movflags', '+faststart', tmp]);
      } finally {
        try { fs.unlinkSync(vfile); } catch {}
        if (afile) { try { fs.unlinkSync(afile); } catch {} }
      }
    } else {
      const durl = Array.isArray(play?.durl) ? play.durl.find((d) => d && d.url) : null;
      if (!durl) throw new Error('这个视频没有可下载的视频流');
      const buf = await download(durl.url, headers);
      fs.writeFileSync(tmp, buf);
    }
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 10 * 1024) throw new Error('合并后的 mp4 不可用');
    fs.renameSync(tmp, out);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return { file: out, title: String(view.title ?? ''), owner: String(view?.owner?.name ?? ''), duration, cached: false };
}
