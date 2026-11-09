// 音乐解析：QQ 音乐 / 网易云 的链接与卡片 → mp3；搜索 / 推荐。
// 不依赖官方 SDK：网易云走公开接口 + Meting 兜底；QQ 音乐搜索/详情走公开接口，
// 播放受版权限制，优先用配置的转发接口，失败时用「歌名 + 歌手」到网易云找同一首。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureCacheDir } from './media-cache.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BYTES = 40 * 1024 * 1024;
const MB = 1024 * 1024;

/** 词条满了只淘汰最久没用的，不按次数淘汰（次数高的老词条也该留着）。 */
function trimOldestTags(list, cap) {
  if (!Array.isArray(list) || list.length <= cap) return list;
  const drop = new Set(
    [...list]
      .sort((a, b) => (Number(a.lastAt) || 0) - (Number(b.lastAt) || 0))
      .slice(0, list.length - cap)
  );
  return list.filter((t) => !drop.has(t));
}

function bundledFfmpeg() {
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
  try { if (fs.statSync(p).isFile()) return p; } catch {}
  return null;
}

function run(bin, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('ffmpeg 超时')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg 退出码 ' + code)); });
  });
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', ...headers },
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

async function fetchAudio(url, headers = {}, maxBytes = MAX_BYTES) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(60000)
  });
  const type = String(res.headers.get('content-type') || '');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4096) throw new Error('返回的不是音频（' + type + '，' + buf.length + ' 字节）');
  if (buf.length > maxBytes) throw new Error('音频太大（' + Math.round(buf.length / MB) + 'MB）');
  if (!/audio|octet-stream|mpeg|mp4/i.test(type)) {
    const head = buf.slice(0, 4).toString('hex');
    if (!/^(494433|fff|000000|664c6143)/i.test(head)) throw new Error('返回的不是音频（' + type + '）');
  }
  return buf;
}

// ---- 链接 / 卡片解析 ----

/** 从一段文字里找出 QQ 音乐 / 网易云音乐的歌曲链接。 */
export function parseMusicUrls(text) {
  const s = String(text ?? '');
  const out = [];
  const seen = new Set();
  const add = (source, id) => {
    const key = source + ':' + id;
    if (!id || seen.has(key)) return;
    seen.add(key);
    out.push({ source, id: String(id) });
  };
  for (const m of s.matchAll(/y\.qq\.com\/[^\s<>"']*?(?:songDetail|songmid=)(?:\/|=)?([0-9A-Za-z]{10,16})/gi)) add('qq', m[1]);
  for (const m of s.matchAll(/i\.y\.qq\.com\/[^\s<>"']*?songmid=([0-9A-Za-z]{10,16})/gi)) add('qq', m[1]);
  for (const m of s.matchAll(/music\.163\.com\/(?:#\/)?(?:song|songDetail\/)(?:\?id=|\/)?(\d{4,20})/gi)) add('netease', m[1]);
  for (const m of s.matchAll(/y\.music\.163\.com\/m\/song\?id=(\d{4,20})/gi)) add('netease', m[1]);
  return out;
}

/** 解析 QQ 结构化卡片（json 段）：音乐卡片里通常有 jumpUrl/title，迷你应用卡也可能带链接。 */
export function extractJsonCardInfo(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const metas = obj.meta && typeof obj.meta === 'object' ? Object.values(obj.meta) : [];
  for (const m of metas) {
    if (!m || typeof m !== 'object') continue;
    const url = String(m.jumpUrl ?? m.musicUrl ?? m.qqmusicUrl ?? m.url ?? '').trim();
    const title = String(m.title ?? m.songName ?? m.name ?? obj.prompt ?? '').trim();
    const desc = String(m.desc ?? m.songArtist ?? '').trim();
    if (url) return { url, title, desc };
  }
  const direct = String(obj.jumpUrl ?? obj.url ?? '').trim();
  if (direct) return { url: direct, title: String(obj.title ?? obj.prompt ?? ''), desc: '' };
  return null;
}

/** OneBot music 段或 QQ 音乐卡片 → {source,id,title,url}；不是音乐就返回 null。 */
export function parseMusicSegment(seg, textFallback = '') {
  if (!seg) return null;
  if (seg.type === 'json') {
    const info = extractJsonCardInfo(seg.data?.data ?? seg.data?.content ?? seg.data);
    if (!info) return null;
    const fromCard = parseMusicUrls(info.url);
    if (!fromCard.length) return null;
    return { ...fromCard[0], title: info.title || '', rawUrl: info.url };
  }
  if (seg.type !== 'music') return null;
  const d = seg.data ?? {};
  const type = String(d.type ?? '').toLowerCase();
  const id = String(d.id ?? '').trim();
  const url = String(d.url ?? d.audio ?? '');
  const fromUrl = parseMusicUrls(url);
  if (fromUrl.length) return { ...fromUrl[0], title: String(d.title ?? ''), rawUrl: url };
  if (/^\d{4,20}$/.test(id)) return { source: 'netease', id, title: String(d.title ?? ''), rawUrl: url };
  if (id && /^[0-9A-Za-z]{10,16}$/.test(id)) return { source: 'qq', id, title: String(d.title ?? ''), rawUrl: url };
  if (type === 'qq' && id) return { source: 'qq', id, title: String(d.title ?? ''), rawUrl: url };
  if (fromUrl.length === 0 && /^\d+$/.test(id)) return { source: 'netease', id, title: String(d.title ?? ''), rawUrl: url };
  return null;
}

/** 合并一条消息里的音乐段和文字链接。 */
export function collectMusicRefs(segments, text = '') {
  const refs = [];
  for (const seg of segments ?? []) {
    const ref = parseMusicSegment(seg, text);
    if (ref) refs.push(ref);
  }
  for (const ref of parseMusicUrls(text)) refs.push(ref);
  const seen = new Set();
  return refs.filter((r) => {
    const k = r.source + ':' + (r.id || r.rawUrl);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---- 服务 ----

export function createMusicService({ stateDir, cacheRoot, getConfig, log = () => {} }) {
  const prefsPath = path.join(stateDir, 'music-prefs.json');
  const musicDir = ensureCacheDir(cacheRoot, 'music');
  const readPrefs = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      return { tags: Array.isArray(raw.tags) ? raw.tags : [], songs: Array.isArray(raw.songs) ? raw.songs : [] };
    } catch { return { tags: [], songs: [] }; }
  };
  const writePrefs = (p) => {
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify(p, null, 2));
  };
  const cfg = () => getConfig()?.socialV2?.music ?? {};

  function recordSong(song) {
    if (!song) return;
    const p = readPrefs();
    const now = Date.now();
    const tags = new Set();
    const artists = Array.isArray(song.artists) ? song.artists : String(song.artists || '').split(/[\/、,&，]/);
    for (const a of artists) {
      const kw = String(a ?? '').trim();
      if (kw && kw.length <= 24) tags.add(kw);
    }
    if (song.genre) tags.add(String(song.genre).slice(0, 24));
    for (const kw of tags) {
      const low = kw.toLowerCase();
      const idx = p.tags.findIndex((t) => String(t.kw ?? '').toLowerCase() === low);
      if (idx >= 0) {
        // 命中旧词条：累加次数并把这个词条拉到最前（最近用过）。
        const [hit] = p.tags.splice(idx, 1);
        hit.count = Number(hit.count || 0) + 1;
        hit.lastAt = now;
        p.tags.unshift(hit);
      } else {
        p.tags.unshift({ kw, count: 1, lastAt: now });
      }
    }
    p.tags = trimOldestTags(p.tags, 80);
    p.songs.unshift({ title: song.title, artists: song.artists, source: song.source, id: song.id, at: now });
    p.songs = p.songs.slice(0, 200);
    writePrefs(p);
  }

  function tags() { return readPrefs().tags; }
  function setTags(list) {
    const now = Date.now();
    const p = readPrefs();
    const prev = new Map(p.tags.map((t) => [t.kw, t]));
    // 保存设置时保留已有词条的累计次数/时间，别把权重重置成 1。
    const tags = (Array.isArray(list) ? list : []).map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 80)
      .map((kw) => {
        const old = prev.get(kw);
        return old ? { kw, count: Math.max(1, Number(old.count) || 1), lastAt: Number(old.lastAt) || now } : { kw, count: 1, lastAt: now };
      });
    p.tags = tags;
    writePrefs(p);
    return tags;
  }
  function pickTags(n) {
    const list = tags().filter((t) => t.kw);
    if (!list.length) return [];
    const total = list.reduce((s, t) => s + Math.max(1, Number(t.count) || 1), 0);
    const picked = [];
    const pool = [...list];
    const want = Math.min(Math.max(1, n), pool.length);
    for (let i = 0; i < want; i += 1) {
      let r = Math.random() * total;
      let idx = 0;
      for (; idx < pool.length; idx += 1) {
        r -= Math.max(1, Number(pool[idx].count) || 1);
        if (r <= 0) break;
      }
      const hit = pool.splice(Math.min(idx, pool.length - 1), 1)[0];
      if (hit) picked.push(hit.kw);
    }
    return picked;
  }

  async function neteaseMeta(id) {
    const data = await fetchJson('https://music.163.com/api/song/detail/?id=' + id + '&ids=%5B' + id + '%5D', { Referer: 'https://music.163.com/' });
    const s = data?.songs?.[0];
    if (!s) throw new Error('网易云查不到这首歌（id=' + id + '）');
    return {
      source: 'netease', id: String(s.id), title: String(s.name ?? ''),
      artists: (s.artists ?? []).map((a) => a.name), album: s.album?.name ?? '',
      duration: Math.round((Number(s.duration) || 0) / 1000)
    };
  }

  async function neteaseSearch(keyword, limit = 8) {
    const url = 'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(keyword) + '&type=1&limit=' + limit + '&offset=0';
    const data = await fetchJson(url, { Referer: 'https://music.163.com/' });
    const songs = data?.result?.songs ?? [];
    return songs.map((s) => ({
      source: 'netease', id: String(s.id), title: String(s.name ?? ''),
      artists: (s.artists ?? []).map((a) => a.name), album: s.album?.name ?? '',
      duration: Math.round((Number(s.duration) || 0) / 1000)
    }));
  }

  async function neteaseStream(id) {
    const headers = { Referer: 'https://music.163.com/' };
    try {
      return await fetchAudio('https://music.163.com/song/media/outer/url?id=' + id + '.mp3', headers);
    } catch (error) {
      const base = String(cfg().metingBase || 'https://api.injahow.cn/meting/').trim();
      if (!base) throw error;
      const u = base + (base.includes('?') ? '&' : '?') + 'server=netease&type=url&id=' + encodeURIComponent(id);
      return await fetchAudio(u, headers);
    }
  }

  async function qqMeta(mid) {
    const data = await fetchJson('https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=' + encodeURIComponent(mid) + '&format=json&platform=yqq');
    const s = data?.data?.[0];
    if (!s) throw new Error('QQ 音乐查不到这首歌（mid=' + mid + '）');
    return {
      source: 'qq', id: String(mid), title: String(s.name ?? s.title ?? ''),
      artists: (s.singer ?? []).map((x) => x.name), album: s.album?.name ?? '',
      duration: Math.round(Number(s.interval) || 0)
    };
  }

  async function qqSearch(keyword, limit = 8) {
    const data = await fetchJson('https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=' + limit + '&w=' + encodeURIComponent(keyword), { Referer: 'https://y.qq.com/' });
    const list = data?.data?.song?.list ?? [];
    return list.map((s) => ({
      source: 'qq', id: String(s.songmid), title: String(s.songname ?? ''),
      artists: (s.singer ?? []).map((x) => x.name), album: s.albumname ?? '',
      duration: Math.round(Number(s.interval) || 0)
    }));
  }

  async function qqStream(mid) {
    const tpl = String(cfg().tencentUrlTemplate || '').trim();
    if (tpl) {
      const url = tpl.replace(/\{mid\}/g, encodeURIComponent(mid));
      return await fetchAudio(url, { Referer: 'https://y.qq.com/' });
    }
    const base = String(cfg().metingBase || 'https://api.injahow.cn/meting/').trim();
    if (base) {
      const u = base + (base.includes('?') ? '&' : '?') + 'server=tencent&type=url&id=' + encodeURIComponent(mid);
      try { return await fetchAudio(u, { Referer: 'https://y.qq.com/' }); } catch (e) { log('[music] QQ 音乐直链失败，改走网易云同曲：' + e.message); }
    }
    return null;
  }

  // 用「字节 / 时长」折算码率判断试听片段：30/45 秒的试听按整首时长一摊，
  // 码率会低得离谱（十几 kbps），比单看文件大小可靠。
  function looksPreview(bufOrSize, seconds) {
    const size = typeof bufOrSize === 'number' ? bufOrSize : (bufOrSize?.length || 0);
    const sec = Number(seconds);
    if (!(size > 0) || !(sec > 90)) return false;
    return (size * 8) / sec < 32000;
  }
  // 网易云对部分版权/会员曲目只返回 30 秒试听：搜同曲的其它版本兜底。
  async function neteaseFullFallback(meta) {
    const q = (String(meta.title || '') + ' ' + String(meta.artists?.[0] || '')).trim();
    if (!q) return null;
    const list = await neteaseSearch(q, 6).catch(() => []);
    for (const s of list) {
      if (String(s.id) === String(meta.id)) continue;
      try {
        const m = await neteaseMeta(s.id);
        const b = await neteaseStream(s.id);
        if (!looksPreview(b, m.duration)) return { meta: m, buf: b };
      } catch {}
    }
    return null;
  }

  async function resolveToMp3(ref, { maxSeconds = 300, force = false, record = true } = {}) {
    const c = cfg();
    const source = ref.source === 'qq' ? 'qq' : 'netease';
    let meta;
    let buf;
    let actual = { source, id: ref.id };
    if (source === 'qq') {
      meta = await qqMeta(ref.id);
      try { buf = await qqStream(ref.id); } catch (e) { buf = null; log('[music] QQ 播放失败：' + e.message); }
      if (!buf) {
        const list = await neteaseSearch((meta.title + ' ' + (meta.artists?.[0] || '')).trim(), 5).catch(() => []);
        const hit = list[0];
        if (!hit) throw new Error('QQ 音乐这首取不到音频（可能需要 Cookie 或会员）');
        meta = { ...meta, title: meta.title || hit.title };
        actual = { source: 'netease', id: hit.id };
        buf = await neteaseStream(hit.id);
      }
    } else {
      meta = await neteaseMeta(ref.id);
      buf = await neteaseStream(ref.id);
    }
    if (actual.source === 'netease' && looksPreview(buf, meta.duration)) {
      log('[music] 只拿到 30 秒试听，改找完整版本：' + meta.title);
      const alt = await neteaseFullFallback(meta);
      if (alt) {
        meta = alt.meta;
        buf = alt.buf;
        actual = { source: 'netease', id: meta.id };
      } else {
        throw new Error('「' + meta.title + '」只能拿到 30 秒试听（版权/会员限制），换一首试试');
      }
    }
    const safeTitle = String(meta.title || 'music').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    const baseName = actual.source + '-' + actual.id + '-' + safeTitle;
    const out = path.join(musicDir, baseName + '.mp3');
    if (!force && fs.existsSync(out) && fs.statSync(out).size > 4096) {
      if (!looksPreview(fs.statSync(out).size, meta.duration)) {
        try { fs.utimesSync(out, new Date(), new Date()); } catch {}
        if (record) recordSong(meta);
        return { file: out, meta, cached: true };
      }
      // 之前缓存的是试听片段：删掉重下。
      try { fs.unlinkSync(out); } catch {}
    }
    const ffmpeg = bundledFfmpeg() || 'ffmpeg';
    const limit = Math.max(5, Number(maxSeconds) || 300);
    const transcode = async (data, target) => {
      const src = path.join(musicDir, '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.bin');
      fs.writeFileSync(src, data);
      try {
        await run(ffmpeg, ['-y', '-i', src, '-t', String(limit), '-vn', '-ac', '1', '-ar', '44100', '-b:a', '96k', target]);
      } finally {
        try { fs.unlinkSync(src); } catch {}
      }
      if (!fs.existsSync(target) || fs.statSync(target).size < 4096) throw new Error('转 mp3 失败');
    };
    await transcode(buf, out);
    // 转码码率固定 96k：文件明显短于「时长 × 96k」就说明源音频是试听片段。
    const expected = Math.min(limit, Number(meta.duration) || 0) * 96000 / 8;
    const tooShort = () => expected > 0 && fs.statSync(out).size < expected * 0.55;
    if (tooShort()) {
      const alt = await neteaseFullFallback(meta);
      if (alt) {
        meta = alt.meta;
        buf = alt.buf;
        actual = { source: 'netease', id: meta.id };
        try { fs.unlinkSync(out); } catch {}
        await transcode(buf, out);
      }
      if (tooShort()) {
        const got = Math.max(1, Math.round((fs.statSync(out).size * 8) / 96000));
        try { fs.unlinkSync(out); } catch {}
        throw new Error('「' + meta.title + '」只能拿到约 ' + got + ' 秒试听（版权/会员限制），换一首试试');
      }
    }
    if (record) recordSong(meta);
    return { file: out, meta, cached: false };
  }

  /** 按歌名搜索并挑第一首解析。网易云和 QQ 音乐一起搜，都没有就抛 MUSIC_NOT_FOUND，交给上层去 B 站兜底。 */
  async function searchAndResolve(query, opts = {}) {
    const q = String(query ?? '').trim();
    if (!q) throw new Error('缺少歌名');
    const settled = await Promise.allSettled([neteaseSearch(q, 8), qqSearch(q, 8)]);
    const list = [];
    const seen = new Set();
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue;
      for (const s of r.value ?? []) {
        const k = s.source + ':' + s.id;
        if (!s.id || seen.has(k)) continue;
        seen.add(k);
        list.push(s);
      }
    }
    if (!list.length) {
      const failed = settled.filter((r) => r.status === 'rejected');
      if (failed.length === settled.length) throw failed[0].reason;
      const error = new Error('没搜到「' + q + '」（网易云和 QQ 音乐都没有）');
      error.code = 'MUSIC_NOT_FOUND';
      throw error;
    }
    const song = list.find((s) => s.duration > 0 && s.duration <= (Number(opts.maxSeconds) || 300) + 2) || list[0];
    const out = await resolveToMp3({ source: song.source, id: song.id }, opts);
    return { ...out, query: q, candidates: list.length };
  }

  /** 随机挑 N 个喜好词条检索，返回候选（不下载）。 */
  async function recommendCandidates({ count = 3 } = {}) {
    const picked = pickTags(Number(cfg().recommendTags) || count);
    if (!picked.length) return { tags: [], songs: [] };
    const lists = await Promise.allSettled(picked.map((kw) => neteaseSearch(kw, 8)));
    const songs = [];
    const seen = new Set();
    for (const r of lists) {
      if (r.status !== 'fulfilled') continue;
      for (const s of r.value) {
        const k = s.id;
        if (seen.has(k)) continue;
        seen.add(k);
        songs.push(s);
      }
    }
    for (let i = songs.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [songs[i], songs[j]] = [songs[j], songs[i]];
    }
    return { tags: picked, songs };
  }

  async function recommend({ maxSeconds = 300 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { tags: picked, songs } = await recommendCandidates({ count: Number(cfg().recommendTags) || 3 });
      if (!songs.length) {
        if (!picked.length) throw new Error('还没有喜好词条：先解析几首歌，或到音乐设置页手动加几个');
        lastError = new Error('按词条「' + picked.join('、') + '」没搜到歌');
        continue;
      }
      const song = songs[Math.floor(Math.random() * Math.min(songs.length, 10))];
      try {
        const out = await resolveToMp3({ source: song.source, id: song.id }, { maxSeconds });
        return { ...out, tags: picked, song };
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error('推荐失败');
  }

  return {
    parseMusicUrls, collectMusicRefs, recordSong, tags, setTags, pickTags,
    neteaseSearch, qqSearch, recommendCandidates, recommend, searchAndResolve, resolveToMp3,
    cacheDir: musicDir, prefsPath
  };
}
