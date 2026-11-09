// QQ 空间（说说）——纯文字发布。
//
// 为什么这么写：
// - OneBot 11 没有发说说的接口，SnowLuma 也没有，所以只能走 Qzone 网页接口。
// - 发布接口是 emotion_cgi_publish_v6，需要登录态 cookie（uin / skey / p_skey）和由 skey 算出来的 g_tk。
// - 图要两步（先 up.qzone.qq.com 上传拿 lloc/sloc，再在发布 body 里带 pic_bo），这一版故意只做纯文字。
//
// 内容由模型按人格现写：走 OpenAI 兼容的 chat/completions，密钥沿用 TTS 翻译那套解析顺序。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveApiKey } from './tts.js';

const PUBLISH_URL = 'https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6';
const UPLOAD_URL = 'https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image';
const MSG_LIST_URL = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6';
const ADD_REPLY_URL = 'https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_addreply_ugc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function str(v, d = '') {
  return typeof v === 'string' ? v : (v == null ? d : String(v));
}
function num(v, d, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
}

export function normalizeQzoneConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const w = r.writer && typeof r.writer === 'object' ? r.writer : {};
  const img = r.image && typeof r.image === 'object' ? r.image : {};
  const rep = r.reply && typeof r.reply === 'object' ? r.reply : {};
  const noti = r.notify && typeof r.notify === 'object' ? r.notify : {};
  const hours = str(r.activeHours, '09:00-23:00');
  return {
    enabled: r.enabled === true,
    cookie: str(r.cookie, ''),
    cookieFile: str(r.cookieFile, ''),
    dailyMin: Math.round(num(r.dailyMin, 1, 0, 12)),
    dailyMax: Math.round(num(r.dailyMax, 2, 0, 12)),
    activeHours: /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(hours) ? hours : '09:00-23:00',
    minGapMs: Math.round(num(r.minGapMs, 3600000, 60000, 86400000)),
    maxChars: Math.round(num(r.maxChars, 200, 20, 2000)),
    persona: str(r.persona, ''),
    writer: {
      enabled: w.enabled !== false,
      baseUrl: str(w.baseUrl, 'https://api.deepseek.com/v1'),
      model: str(w.model, 'deepseek-flash'),
      authHeader: str(w.authHeader, 'x-dsh-auth-token'),
      authPrefix: str(w.authPrefix, ''),
      apiKey: str(w.apiKey, ''),
      apiKeyEnv: str(w.apiKeyEnv, 'JSNU_API_KEY'),
      apiKeyFile: str(w.apiKeyFile, ''),
      apiKeyLine: str(w.apiKeyLine, '^\\s*token:\\s*(\\S+)'),
      reasoningEffort: str(w.reasoningEffort, 'low'),
      temperature: num(w.temperature, 0.95, 0, 2),
      maxTokens: Math.round(num(w.maxTokens, 1200, 64, 8000)),
      timeoutMs: Math.round(num(w.timeoutMs, 60000, 5000, 180000))
    },
    // 配图：从收藏表情库里按备注挑一张，转成品 JPEG 传到说说相册再带图发出。
    image: {
      enabled: img.enabled !== false,
      probability: num(img.probability, 1, 0, 1),
      maxWidth: Math.round(num(img.maxWidth, 800, 240, 2048)),
      quality: Math.round(num(img.quality, 4, 1, 31)),
      stickersFile: str(img.stickersFile, 'state/stickers.json'),
      ffmpegPath: str(img.ffmpegPath, '')
    },
    // 回复评论：定时看看自己说说下面有没有新评论，按人格回一条；轮数有上限。
    reply: {
      enabled: rep.enabled !== false,
      checkEveryMin: Math.round(num(rep.checkEveryMin, 10, 1, 180)),
      scanPosts: Math.round(num(rep.scanPosts, 5, 1, 20)),
      maxRounds: Math.round(num(rep.maxRounds, 2, 0, 20)),
      maxPerDay: Math.round(num(rep.maxPerDay, 10, 0, 200)),
      maxChars: Math.round(num(rep.maxChars, 120, 10, 1000)),
      minGapMs: Math.round(num(rep.minGapMs, 180000, 30000, 86400000)),
      replyOwn: rep.replyOwn === true
    },
    // 登录态掉线时通过 QQ 说一声（2026-11-02）：默认发到配置的第一个群，同一个状态 minGapMs 内只提醒一次。
    notify: {
      enabled: noti.enabled !== false,
      key: str(noti.key, ''),
      minGapMs: Math.round(num(noti.minGapMs, 6 * 3600 * 1000, 60000, 72 * 3600 * 1000))
    }
  };
}

/** cookie 串 → { uin, skey, p_skey, gtk }；uin 统一成数字 QQ。 */
export function parseQzoneCookie(cookie) {
  const out = { uin: '', skey: '', p_skey: '' };
  for (const part of str(cookie).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 'uin' || k === 'p_uin') out.uin = v;
    else if (k === 'skey') out.skey = v;
    else if (k === 'p_skey') out.p_skey = v;
  }
  out.uin = out.uin.replace(/^o0?/, '').replace(/[^0-9]/g, '');
  // Qzone 的 g_tk 优先用 p_skey 算（网页域），没有 p_skey 才退回 skey。
  const basis = out.p_skey || out.skey;
  out.gtk = gtkOf(basis);
  return out;
}

export function gtkOf(skey) {
  let hash = 5381;
  const s = str(skey);
  for (let i = 0; i < s.length; i += 1) {
    hash += (hash << 5) + s.charCodeAt(i);
    hash &= 0x7fffffff;
  }
  return hash & 0x7fffffff;
}

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function inHours(spec, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(str(spec));
  if (!m) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start <= end) return cur >= start && cur < end;
  return cur >= start || cur < end; // 跨零点
}

function cleanPost(text) {
  return str(text)
    .replace(/^\s*(说说|动态)[:：]\s*/, '')
    .replace(/^["'「『]|["'」』]$/g, '')
    .trim();
}

/**
 * 这串评论还要不要回：判断只看数据，不看时间。
 * 条件：最后一句不是我说的；我在这串里回过的次数 < maxRounds。
 */
/** 空间接口回的是 JSONP/HTML 包一层（frameElement.callback({...})），从最后一个 callback( 后面那个对象里抠 JSON。 */
function parseJsonp(raw) {
  const text = String(raw || '');
  const at = text.lastIndexOf('callback(');
  let start = at >= 0 ? text.indexOf('{', at) : text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export function threadNeedsReply(comment, replies, meUin, maxRounds, replyOwn = false) {
  const me = String(meUin || '');
  if (String(comment?.uin ?? '') === me && !replyOwn) return false;
  const list = Array.isArray(replies) ? replies : [];
  const mine = list.filter((r) => String(r.uin ?? '') === me);
  const times = [comment, ...list].map((x) => Number(x.create_time ?? 0)).filter((t) => t > 0);
  const lastAt = times.length ? Math.max(...times) : 0;
  const mineTimes = mine.map((r) => Number(r.create_time ?? 0)).filter((t) => t > 0);
  const lastMineAt = mineTimes.length ? Math.max(...mineTimes) : 0;
  if (lastAt && lastAt <= lastMineAt) return false;
  return mine.length < Number(maxRounds ?? 0);
}

export function createQzoneService({ root, stateDir, getConfig, log = () => {} }) {
  const historyFile = path.join(stateDir, 'qzone-posts.json');
  const runtimeFile = path.join(stateDir, 'qzone-runtime.json');

  function cfgOf() {
    return normalizeQzoneConfig(getConfig());
  }

  function readJson(file, fallback) {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return v && typeof v === 'object' ? v : fallback;
    } catch {
      return fallback;
    }
  }
  function writeJson(file, value) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
    } catch (error) {
      log('[qzone] 写文件失败 ' + file + '：' + (error?.message ?? error));
    }
  }

  function history() {
    const h = readJson(historyFile, { posts: [] });
    return Array.isArray(h.posts) ? h.posts : [];
  }

  function cookieOf(cfg) {
    const raw = cfg.cookieFile
      ? (() => { try { return fs.readFileSync(path.resolve(root, cfg.cookieFile), 'utf8'); } catch { return ''; } })()
      : '';
    const text = (cfg.cookie || raw).trim();
    if (!text) return null;
    const parsed = parseQzoneCookie(text);
    // cookie 可能整行是裸串，也可能带 "cookie:" 前缀
    return { ...parsed, header: text.replace(/^\s*cookie\s*[:：]\s*/i, '') };
  }

  function writerKey(cfg) {
    const w = cfg.writer;
    return resolveApiKey(w.apiKeyEnv, w.apiKey, { file: w.apiKeyFile, lineRe: w.apiKeyLine });
  }

  const DEFAULT_PERSONA = [
    '你在写自己 QQ 空间的说说（短动态），不是给别人看的公告。',
    '人设：晓山瑞希，25 时的 MV 制作人，神山高校 2-B；爱可爱的东西、会改衣服、在服装店打工、严重猫舌（薯条要等凉）、讨厌菌菇、爱吃咖喱饭和炸薯条。',
    '队友：奏（作曲，夜里在线，说话轻）、真冬（很安静，熟了之后会吐槽）、绘名（画家，易燃，跟我最闹）。姐姐在法国做服装设计。',
    '写什么：25 时的日常小事（一起熬夜做曲、谁又在群里发了奇怪的东西）、自己做衣服/剪片子的进度、打工的碎事、天台的天气、买到的碟、猫舌翻车现场……偶尔编一段小小的队内插曲。',
    '怎么写：中文口语，一到三句话，40~120 字，像随手发的一条；不写标题、不加话题标签、不堆 emoji（最多一个颜文字）、不自我介绍、不说「发个动态」这种元话、不总结升华。',
    '不要每次都落到「好开心」「要继续加油」上，很多条就只是记录一个瞬间。',
    '只输出说说正文本身，不要解释、不要引号。'
  ].join('\n');

  function recentHint() {
    const posts = history().filter((p) => p && p.ok !== false).slice(-6);
    if (!posts.length) return '';
    return '\n最近发过的（别重复同样的题材和句式，也别直接复述）：\n' + posts.map((p, i) => (i + 1) + '. ' + String(p.text || '').slice(0, 80)).join('\n');
  }

  /** 让模型按人格写一条说说正文（不发布）。 */
  async function generate(extraHint = '') {
    const cfg = cfgOf();
    const w = cfg.writer;
    if (w.enabled === false) throw new Error('内容生成已关闭（qzone.writer.enabled=false）');
    const key = writerKey(cfg);
    if (!key) throw new Error('缺少写作接口的密钥（' + w.apiKeyEnv + '），可在 config.json 的 qzone.writer.apiKey 直接填');
    const sys = (cfg.persona ? cfg.persona + '\n\n' : '') + DEFAULT_PERSONA + recentHint();
    const user = extraHint
      ? '这次可以围绕这个方向写：' + extraHint + '\n（不要直接提到这个提示本身。）'
      : '写一条。题材你自己挑，别跟最近发过的重复。';
    const body = {
      model: w.model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: w.temperature,
      max_tokens: w.maxTokens,
      stream: false
    };
    if (w.reasoningEffort) body.reasoning_effort = w.reasoningEffort;
    const url = w.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [w.authHeader]: (w.authPrefix + key).trim() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(w.timeoutMs)
    });
    const raw = await res.text();
    if (!res.ok) throw new Error('写作接口 ' + res.status + '：' + raw.slice(0, 200));
    let data = {};
    try { data = JSON.parse(raw); } catch { throw new Error('写作接口返回的不是 JSON：' + raw.slice(0, 120)); }
    const out = cleanPost(data.choices?.[0]?.message?.content ?? '');
    if (!out) throw new Error('写作接口返回了空文本（finish_reason=' + (data.choices?.[0]?.finish_reason ?? '?') + '）');
    return out.slice(0, cfg.maxChars);
  }

  /** 真发一条：POST emotion_cgi_publish_v6。pic 有值就是图文说说。 */
  async function publish(text, pic = null) {
    const cfg = cfgOf();
    const body = cleanPost(text).slice(0, cfg.maxChars);
    if (!body) throw new Error('说说内容是空的');
    const ck = cookieOf(cfg);
    if (!ck || !ck.uin || !(ck.p_skey || ck.skey)) {
      throw new Error('还没有配 QQ 空间的 cookie（qzone.cookie 或 qzone.cookieFile），需要至少含 uin 与 skey/p_skey');
    }
    const form = new URLSearchParams({
      syn_tweet_verson: '1',
      paramstr: '1',
      who: '1',
      conformat: '1',
      feedversion: '1',
      ver: '1',
      ugc_right: '1',
      to_sign: '0',
      hostuin: ck.uin,
      code_version: '1',
      format: 'json',
      qzreferrer: 'https://user.qzone.qq.com/' + ck.uin,
      // 内容字段名是 con，不是 content：写成 content 时接口会回 code:-10005「您未输入内容」
      // （2026-11-01 实测，query 里传 content 也一样不认）。
      con: body
    });
    if (pic && pic.richval && pic.picBo) {
      // 带图要加这几个字段（2026-11-01 实测可用）：richtype=1 + richval + pic_bo + richflag=1
      form.set('richtype', '1');
      form.set('richval', pic.richval);
      form.set('pic_bo', pic.picBo);
      form.set('richflag', '1');
      form.set('pic_template', '');
    }
    const res = await fetch(PUBLISH_URL + '?g_tk=' + ck.gtk, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        cookie: ck.header,
        referer: 'https://user.qzone.qq.com/' + ck.uin,
        origin: 'https://user.qzone.qq.com',
        'user-agent': UA
      },
      body: form.toString(),
      signal: AbortSignal.timeout(30000)
    });
    const raw = await res.text();
    const flat = raw.replace(/^[^({]*\(/, '').replace(/\)\s*;?\s*$/, '').trim();
    let data = null;
    try { data = JSON.parse(flat); } catch {}
    // 这个接口历史上返回过 {"code":0,...}、{"ret":0,...}、{"subcode":0,...} 几种形状，
    // 判断口径放宽：能解析出 JSON 且 code/ret 为 0（或 message 为空、subcode 为 0）就算成功；
    // 出现 "code":-3000 这类（未登录/风控）就按失败抛出去，把原文带出便于排查。
    const codeOk = data && (Number(data.code ?? data.ret ?? 0) === 0) && Number(data.subcode ?? 0) === 0;
    if (!res.ok || !data || !codeOk) {
      const hint = /-3000|请先登录|未登录/.test(raw) ? '（cookie 可能失效了，去浏览器重新复制一次）' : '';
      throw new Error('发说说失败 ' + res.status + '：' + raw.slice(0, 200) + hint);
    }
    return { ok: true, raw: data };
  }

  function record(entry) {
    const h = readJson(historyFile, { posts: [] });
    const posts = Array.isArray(h.posts) ? h.posts : [];
    posts.push({ at: Date.now(), ...entry });
    writeJson(historyFile, { posts: posts.slice(-300) });
  }

  /** 生成 + 发布，成功失败都落历史。text 给了就发这段，不给就现写。
   *  withImage 不传就按 qzone.image 的开关和概率决定附不附图。 */
  async function postNow({ text = '', hint = '', withImage } = {}) {
    const cfg = cfgOf();
    let content = cleanPost(text);
    let generated = false;
    let sticker = null;
    let pic = null;
    try {
      if (!content) {
        content = await generate(hint);
        generated = true;
      }
      if (content.length > cfg.maxChars) content = content.slice(0, cfg.maxChars);
      const wantImage = withImage === undefined
        ? (cfg.image.enabled && Math.random() < cfg.image.probability)
        : Boolean(withImage && cfg.image.enabled);
      if (wantImage) {
        // 配图失败不许影响发文：整块包一层 try，出错就退回纯文字。
        try {
          const ck = cookieOf(cfg);
          if (!ck) throw new Error('还没有配 cookie');
          sticker = await pickSticker(cfg, content);
          if (!sticker) log('[qzone] 这次没挑到合适的表情，只发文字');
          if (sticker) {
            const jpg = await stickerJpeg(cfg, sticker);
            const up = await uploadImage(ck, jpg);
            pic = { ...richOf(up), desc: sticker.desc, url: sticker.url };
            log('[qzone] 配图：' + sticker.desc + '（' + jpg.length + ' B → 相册 ' + up.albumid + '）');
          }
        } catch (error) {
          log('[qzone] 配图失败，这条只发文字：' + (error?.message ?? error));
          sticker = null;
          pic = null;
        }
      }
      await publish(content, pic);
      const meta = { text: content, generated, ok: true, image: Boolean(pic), sticker: sticker ? { desc: sticker.desc, url: sticker.url } : null };
      record(meta);
      log('[qzone] 已发说说（' + content.length + ' 字' + (pic ? '，带图' : '') + '）' + content.slice(0, 30));
      return meta;
    } catch (error) {
      record({ text: content, generated, ok: false, error: String(error?.message ?? error) });
      throw error;
    }
  }

  // ---- 配图：从收藏表情库里挑一张，转 JPEG 后传到说说相册 ----

  function ffmpegBin(cfg) {
    return cfg.image.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  }

  function stickerEntries(cfg) {
    const file = path.resolve(root, cfg.image.stickersFile || 'state/stickers.json');
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(raw) ? raw : Object.values(raw ?? {});
      return list
        .filter((s) => s && typeof s === 'object' && str(s.url))
        .map((s, i) => ({
          i: i + 1,
          url: str(s.url),
          desc: str(s.desc || s.localNote).slice(0, 24),
          note: str(s.localNote || s.desc).slice(0, 90),
          tags: Array.isArray(s.tags) ? s.tags.slice(0, 4).join('/') : ''
        }));
    } catch (error) {
      log('[qzone] 读表情库失败（' + file + '）：' + (error?.message ?? error));
      return [];
    }
  }

  const PICK_SYSTEM = [
    '你在翻自己 QQ 收藏的表情包，想给刚写好的一条说说配一张。',
    '只看备注挑最贴的一张；宁可不配（回 none），也不要硬凑一张不搭的。',
    '只输出一行：编号（例 S3）或 none。不要解释。'
  ].join('\n');

  /** 让模型按表情备注挑一张，挑不到返回 null。 */
  async function pickSticker(cfg, text) {
    const entries = stickerEntries(cfg);
    if (!entries.length) return null;
    const key = writerKey(cfg);
    if (!key) return null;
    const w = cfg.writer;
    const list = entries.map((e) => 'S' + e.i + ' | ' + e.desc + ' | ' + e.note + (e.tags ? ' | ' + e.tags : '')).join('\n');
    const body = {
      model: w.model,
      messages: [
        { role: 'system', content: PICK_SYSTEM },
        { role: 'user', content: '说说：' + text + '\n\n表情包库（编号 | 备注 | 说明 | 标签）：\n' + list }
      ],
      temperature: 0.5,
      max_tokens: 400,
      stream: false
    };
    if (w.reasoningEffort) body.reasoning_effort = w.reasoningEffort;
    const res = await fetch(w.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [w.authHeader]: (w.authPrefix + key).trim() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(w.timeoutMs)
    });
    const raw = await res.text();
    if (!res.ok) throw new Error('挑配图接口 ' + res.status + '：' + raw.slice(0, 160));
    let data = {};
    try { data = JSON.parse(raw); } catch {}
    const ans = String(data.choices?.[0]?.message?.content ?? '').trim();
    const hit = ans.match(/S\s*(\d+)/i);
    if (!hit) return null;
    return entries.find((e) => e.i === Number(hit[1])) ?? null;
  }

  /** 下载表情图 → ffmpeg 转成合适尺寸的 JPEG（动图取第一帧）。 */
  async function stickerJpeg(cfg, entry) {
    const res = await fetch(entry.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('下载表情图失败 ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const tmpDir = path.join(stateDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const stamp = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    const src = path.join(tmpDir, 'st-' + stamp + '.src');
    const out = path.join(tmpDir, 'st-' + stamp + '.jpg');
    fs.writeFileSync(src, buf);
    const run = spawnSync(ffmpegBin(cfg), [
      '-y', '-v', 'error', '-i', src,
      '-vf', 'scale=' + cfg.image.maxWidth + ':-2:force_original_aspect_ratio=decrease',
      '-frames:v', '1', '-q:v', String(cfg.image.quality), out
    ], { encoding: 'utf8', timeout: 30000 });
    try { fs.unlinkSync(src); } catch {}
    if (run.status !== 0 || !fs.existsSync(out)) {
      throw new Error('图片转码失败：' + String(run.stderr || '').slice(0, 140));
    }
    const jpg = fs.readFileSync(out);
    try { fs.unlinkSync(out); } catch {}
    if (jpg.length < 200) throw new Error('转码出来的图是空的');
    return jpg;
  }

  /** 传到说说相册（up.qzone.qq.com），返回 data（含 albumid/lloc/sloc/type/height/width/url）。 */
  async function uploadImage(ck, buf) {
    const form = new URLSearchParams({
      filename: 'filename',
      zzpanelkey: '',
      uploadtype: '1',
      albumtype: '7', // 7 = 说说相册
      exttype: '0',
      skey: ck.skey,
      zzpaneluin: ck.uin,
      p_uin: ck.uin,
      uin: ck.uin,
      p_skey: ck.p_skey || '',
      output_type: 'json',
      qzonetoken: '',
      refer: 'shuoshuo',
      charset: 'utf-8',
      output_charset: 'utf-8',
      upload_hd: '1',
      hd_width: '2048',
      hd_height: '10000',
      hd_quality: '96',
      backUrls: 'http://upbak.photo.qzone.qq.com/cgi-bin/upload/cgi_upload_image,http://119.147.64.75/cgi-bin/upload/cgi_upload_image',
      url: UPLOAD_URL + '?g_tk=' + ck.gtk,
      base64: '1',
      picfile: buf.toString('base64')
    });
    const res = await fetch(UPLOAD_URL + '?g_tk=' + ck.gtk, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        cookie: ck.header,
        referer: 'https://user.qzone.qq.com/' + ck.uin,
        origin: 'https://user.qzone.qq.com',
        'user-agent': UA
      },
      body: form.toString(),
      signal: AbortSignal.timeout(60000)
    });
    const raw = await res.text();
    const flat = raw.replace(/^[^({]*\(/, '').replace(/\)\s*;?\s*$/, '').trim();
    let data = null;
    try { data = JSON.parse(flat); } catch {}
    const d = data?.data;
    if (!res.ok || !d || !d.url) throw new Error('上传图片失败：' + raw.slice(0, 160));
    return d;
  }

  /** 上传结果 → 发说说要的 richval / pic_bo。 */
  function richOf(d) {
    const richval = ',{albumid},{lloc},{sloc},{type},{height},{width},,{height},{width}'
      .replace('{albumid}', d.albumid ?? '')
      .replace('{lloc}', d.lloc ?? '')
      .replace('{sloc}', d.sloc ?? '')
      .replace('{type}', d.type ?? '')
      .replace(/\{height\}/g, d.height ?? '')
      .replace(/\{width\}/g, d.width ?? '');
    const picBo = (String(d.url).match(/bo=([^&]+)/) || [])[1] || '';
    return { richval, picBo };
  }

  /** 生成一条 + 挑好的配图（不上传、不发布），给控制台预览用。 */
  async function preview(hint = '') {
    const cfg = cfgOf();
    const text = await generate(hint);
    let sticker = null;
    if (cfg.image.enabled) {
      try {
        sticker = await pickSticker(cfg, text);
      } catch (error) {
        log('[qzone] 挑配图失败：' + (error?.message ?? error));
      }
    }
    return { text, sticker: sticker ? { desc: sticker.desc, url: sticker.url } : null };
  }

  // ---------------- 回复评论 ----------------
  function replyStateFile() { return path.join(stateDir, 'qzone-reply-state.json'); }
  function replyState() {
    const s = readJson(replyStateFile(), {});
    return {
      day: str(s.day, ''),
      count: Number(s.count ?? 0),
      lastAt: Number(s.lastAt ?? 0),
      lastCheck: Number(s.lastCheck ?? 0),
      lastError: str(s.lastError, ''),
      lastReply: s.lastReply ?? null,
      handled: s.handled && typeof s.handled === 'object' ? s.handled : {}
    };
  }
  function saveReplyState(next) { writeJson(replyStateFile(), next); }

  /**
   * 只验登录态：拉一条自己的说说看 code 是不是 0。
   * cookie 过期时空间回 -3000「请先登录空间」——这时发帖、回复、拉评论全都会失败，但失败信息埋在各处，
   * 所以单独有一个廉价的探活（2026-11-02 加，配合桥接里的定时看护）。
   */
  async function checkAuth() {
    const cfg = cfgOf();
    const ck = cookieOf(cfg);
    if (!ck) return { ok: false, code: 'NO_COOKIE', message: '还没填 cookie' };
    const q = new URLSearchParams({
      uin: String(ck.uin), ftype: '0', sort: '0', pos: '0', num: '1',
      replynum: '0', code_version: '1', format: 'jsonp', g_tk: String(ck.gtk)
    });
    try {
      const res = await fetch(MSG_LIST_URL + '?' + q.toString(), {
        headers: { cookie: ck.header, referer: 'https://user.qzone.qq.com/' + ck.uin, origin: 'https://user.qzone.qq.com', 'user-agent': UA },
        signal: AbortSignal.timeout(20000)
      });
      const raw = await res.text();
      const data = parseJsonp(raw);
      if (!data) return { ok: false, code: 'BAD_RESPONSE', message: '返回不是 JSONP：' + raw.slice(0, 80) };
      const code = Number(data.code ?? 0);
      if (code !== 0) return { ok: false, code, message: str(data.message, '') };
      return { ok: true, code: 0, message: '', name: str(data.logininfo?.name, ''), uin: String(ck.uin) };
    } catch (error) {
      return { ok: false, code: 'NETWORK', message: String(error?.message ?? error) };
    }
  }

  /** 拉自己最近的说说（带评论）。msglist 返回的评论在 commentlist，楼中楼在 list_3。 */
  async function fetchFeeds(cfg, ck, num) {
    const q = new URLSearchParams({
      uin: String(ck.uin), ftype: '0', sort: '0', pos: '0', num: String(num),
      replynum: '20', code_version: '1', format: 'jsonp', need_private_comment: '1', g_tk: String(ck.gtk)
    });
    const res = await fetch(MSG_LIST_URL + '?' + q.toString(), {
      headers: { cookie: ck.header, referer: 'https://user.qzone.qq.com/' + ck.uin, origin: 'https://user.qzone.qq.com', 'user-agent': UA },
      signal: AbortSignal.timeout(25000)
    });
    const raw = await res.text();
    if (!res.ok) throw new Error('拉说说列表失败 HTTP ' + res.status);
    const data = parseJsonp(raw);
    if (!data) throw new Error('说说列表不是 JSONP：' + raw.slice(0, 120));
    if (Number(data.code ?? 0) !== 0) throw new Error('说说列表返回 code=' + data.code + (data.message ? '：' + data.message : ''));
    return Array.isArray(data.msglist) ? data.msglist : [];
  }

  /**
   * 列出「还值得回」的评论串。
   * 规则：最后一句不是我说的话（说明对方还没被回）、且我在这串里回过的次数 < reply.maxRounds。
   */
  async function listThreads(cfg, ck) {
    const me = String(ck.uin);
    const feeds = await fetchFeeds(cfg, ck, cfg.reply.scanPosts);
    const out = [];
    for (const post of feeds) {
      const tid = String(post.tid ?? '');
      if (!tid) continue;
      const comments = Array.isArray(post.commentlist) ? post.commentlist : [];
      for (const c of comments) {
        const cid = String(c.tid ?? '');
        const cuin = String(c.uin ?? '');
        if (!cid || !cuin) continue;
        const replies = Array.isArray(c.list_3) ? c.list_3 : [];
        if (!threadNeedsReply(c, replies, me, cfg.reply.maxRounds, cfg.reply.replyOwn)) continue;
        const mine = replies.filter((r) => String(r.uin ?? '') === me);
        out.push({
          tid,
          postText: cleanPost(post.content ?? ''),
          postAt: Number(post.created_time ?? post.createTime ?? 0) * 1000,
          comment: { id: cid, uin: cuin, name: str(c.name, '有人'), text: cleanPost(c.content ?? ''), at: Number(c.create_time ?? 0) * 1000 },
          replies: replies.map((r) => ({ uin: String(r.uin ?? ''), name: str(r.name, ''), text: cleanPost(r.content ?? ''), at: Number(r.create_time ?? 0) * 1000 })),
          rounds: mine.length
        });
      }
    }
    return out;
  }

  const REPLY_SYSTEM = [
    '你在回复自己 QQ 空间说说下面的评论。',
    '人设：晓山瑞希，25 时的 MV 制作人；爱可爱的东西、会改衣服、在服装店打工、严重猫舌、讨厌菌菇、爱吃咖喱饭和炸薯条。',
    '怎么写：中文口语，一到两句，最多 60 字。像朋友在评论区接话，可以打趣、可以反问，但不客套——不写「谢谢支持」「感谢关注」「祝你」。不堆 emoji。',
    '对方认真、难受、或者在说正经事，就把玩笑收起来，只回必要的那句。',
    '不重复对方的话，不解释自己在回复评论，不自我介绍。只输出回复正文本身。'
  ].join('\n');

  async function generateReply(cfg, ck, item) {
    const w = cfg.writer;
    if (w.enabled === false) throw new Error('内容生成已关闭（qzone.writer.enabled=false）');
    const key = writerKey(cfg);
    if (!key) throw new Error('缺少写作接口的密钥（' + w.apiKeyEnv + '）');
    const me = String(ck.uin);
    const lines = [];
    lines.push('说说：' + (item.postText ? item.postText.slice(0, 200) : '（只有图，没写正文）'));
    lines.push('评论区：');
    lines.push('「' + item.comment.name + '」：' + item.comment.text);
    for (const r of item.replies) {
      const who = r.uin === me ? '我' : '「' + (r.name || '有人') + '」';
      lines.push(who + '：' + r.text);
    }
    lines.push('');
    lines.push(item.rounds === 0 ? '现在要回上面这条评论。' : '对方又接着说了一句，接着回（这是第 ' + (item.rounds + 1) + ' 句）。');
    const body = {
      model: w.model,
      messages: [{ role: 'system', content: REPLY_SYSTEM + (cfg.persona ? '\n\n' + cfg.persona : '') }, { role: 'user', content: lines.join('\n') }],
      temperature: Math.min(1.1, w.temperature),
      max_tokens: 400,
      stream: false
    };
    if (w.reasoningEffort) body.reasoning_effort = w.reasoningEffort;
    const res = await fetch(w.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [w.authHeader]: (w.authPrefix + key).trim() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(w.timeoutMs)
    });
    const raw = await res.text();
    if (!res.ok) throw new Error('写作接口 ' + res.status + '：' + raw.slice(0, 200));
    let data = {};
    try { data = JSON.parse(raw); } catch { throw new Error('写作接口返回的不是 JSON：' + raw.slice(0, 120)); }
    let out = cleanPost(data.choices?.[0]?.message?.content ?? '');
    out = out.replace(/^["'「『]+|["'」』]+$/g, '').trim();
    if (!out) throw new Error('写作接口返回了空文本（finish_reason=' + (data.choices?.[0]?.finish_reason ?? '?') + '）');
    return out.slice(0, cfg.reply.maxChars);
  }

  /** 真发一条回复：POST emotion_cgi_addreply_ugc，commentId 是被回复那条评论的 tid。 */
  async function postReply(cfg, ck, item, text) {
    const content = cleanPost(text).slice(0, cfg.reply.maxChars);
    if (!content) throw new Error('回复内容为空');
    const form = new URLSearchParams({
      uin: String(ck.uin), hostUin: String(ck.uin), topicId: String(ck.uin) + '_' + item.tid,
      // commentUin 填被回复那条评论的作者（空间那边按这个渲染「回复 @某人」）
      commentId: String(item.comment.id), commentUin: String(item.comment.uin || ck.uin), content,
      private: '0', with_fwd: '0', to_tweet: '0', hostuin: String(ck.uin),
      code_version: '1', format: 'fs', qzreferrer: 'https://user.qzone.qq.com/' + ck.uin
    });
    const res = await fetch(ADD_REPLY_URL + '?g_tk=' + ck.gtk, {
      method: 'POST',
      headers: { cookie: ck.header, 'content-type': 'application/x-www-form-urlencoded', referer: 'https://user.qzone.qq.com/' + ck.uin, origin: 'https://user.qzone.qq.com', 'user-agent': UA },
      body: form.toString(),
      signal: AbortSignal.timeout(25000)
    });
    const raw = await res.text();
    const data = parseJsonp(raw) || {};
    const code = Number(data?.code ?? data?.ret ?? -1);
    if (!res.ok || code !== 0) {
      const err = new Error('回复失败 HTTP ' + res.status + ' code=' + code + (data?.message ? '：' + data.message : '') + ' ' + raw.slice(0, 120));
      err.code = code;
      throw err;
    }
    return { text: content, code };
  }

  /**
   * 跑一轮「看看有没有新评论、回一条」。
   * force=true 就跳过间隔/时段/每日上限（控制台手动点的时候用）。
   */
  async function replyTick({ force = false } = {}) {
    const cfg = cfgOf();
    const r = cfg.reply;
    if (!r.enabled && !force) return { ok: false, skipped: 'disabled', checked: 0, replied: [] };
    const ck = cookieOf(cfg);
    if (!ck || !ck.uin) return { ok: false, skipped: 'cookie', checked: 0, replied: [] };
    const now = Date.now();
    const today = dayKey();
    const st = replyState();
    let count = st.day === today ? st.count : 0;
    if (!force) {
      if (!inHours(cfg.activeHours)) return { ok: false, skipped: 'hours', checked: 0, replied: [] };
      if (now - Number(st.lastCheck || 0) < r.checkEveryMin * 60000) return { ok: false, skipped: 'interval', checked: 0, replied: [] };
      if (count >= r.maxPerDay) return { ok: false, skipped: 'daily', checked: 0, replied: [] };
      if (now - Number(st.lastAt || 0) < r.minGapMs) return { ok: false, skipped: 'gap', checked: 0, replied: [] };
    }
    saveReplyState({ ...st, day: today, count, lastCheck: now });
    let threads = [];
    try {
      threads = await listThreads(cfg, ck);
    } catch (error) {
      const msg = String(error?.message ?? error);
      saveReplyState({ ...replyState(), lastError: msg, lastCheck: now });
      log('[qzone] 拉评论失败：' + msg);
      throw error;
    }
    const replied = [];
    for (const item of threads) {
      if (count >= r.maxPerDay) break;
      const fresh = replyState();
      const hkey = item.tid + ':' + item.comment.id;
      const seen = fresh.handled[hkey];
      const lastCommentAt = Math.max(item.comment.at, ...item.replies.map((x) => x.at), 0);
      if (seen && Number(seen.at || 0) >= lastCommentAt) continue; // 这串已经处理过、对方还没再说话
      try {
        const text = await generateReply(cfg, ck, item);
        await postReply(cfg, ck, item, text);
        count += 1;
        const handled = { ...fresh.handled, [hkey]: { at: Date.now(), rounds: item.rounds + 1, text: text.slice(0, 60), name: item.comment.name } };
        const keys = Object.keys(handled);
        if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete handled[k];
        saveReplyState({
          day: today, count, lastAt: Date.now(), lastCheck: now, lastError: '',
          lastReply: { at: Date.now(), name: item.comment.name, text, tid: item.tid, commentId: item.comment.id },
          fails: 0,
          handled
        });
        replied.push({ tid: item.tid, commentId: item.comment.id, name: item.comment.name, comment: item.comment.text, reply: text, rounds: item.rounds + 1 });
        log('[qzone] 回了 ' + item.comment.name + ' 的评论：' + text.slice(0, 40));
      } catch (error) {
        const msg = String(error?.message ?? error);
        const code = Number(error?.code ?? 0);
        // -10049「使用人数过多」是空间侧的限流：越继续试越容易被一直挡，退避半小时起步，连续失败翻倍，最多 3 小时。
        const throttled = code === -10049;
        const fails = Number(replyState().fails ?? 0) + 1;
        // -10049 是空间侧限流，实测是间歇性的（同一请求多试几次会有一次过），所以退避别太狠：10/20/40/80/120 分钟。
        const backoffMin = throttled ? Math.min(120, 10 * Math.pow(2, Math.min(4, fails - 1))) : 5;
        saveReplyState({
          ...replyState(), lastError: msg, lastCheck: now + backoffMin * 60000, day: today, count, fails
        });
        log('[qzone] 回复评论失败' + (throttled ? '（空间限流，' + backoffMin + ' 分钟后再试）' : '') + '：' + msg);
        break; // 一次失败就停手，别把剩下几条也撞上去
      }
    }
    return { ok: true, checked: threads.length, replied, count, maxPerDay: r.maxPerDay };
  }

  /** 只看不回：列出现在待回复的评论（控制台「看看有没有新评论」用）。 */
  async function pending() {
    const cfg = cfgOf();
    const ck = cookieOf(cfg);
    if (!ck || !ck.uin) return { ok: false, error: 'cookie 还没配（或已失效）', items: [] };
    const threads = await listThreads(cfg, ck);
    return {
      ok: true,
      items: threads.map((t) => ({
        tid: t.tid, commentId: t.comment.id, name: t.comment.name, comment: t.comment.text,
        rounds: t.rounds, post: t.postText.slice(0, 80)
      }))
    };
  }

  function status() {
    const cfg = cfgOf();
    const rt = readJson(runtimeFile, {});
    const ck = cookieOf(cfg);
    const posts = history();
    const today = dayKey();
    return {
      cookieReady: Boolean(ck && ck.uin && (ck.p_skey || ck.skey)),
      uin: ck?.uin ?? '',
      writerKeyReady: Boolean(writerKey(cfg)),
      runtime: {
        day: str(rt.day, ''),
        target: Number(rt.target ?? 0),
        count: Number(rt.count ?? 0),
        nextAt: Number(rt.nextAt ?? 0),
        lastAt: Number(rt.lastAt ?? 0),
        lastError: str(rt.lastError, '')
      },
      todayPosted: posts.filter((p) => p && p.ok !== false && dayKey(new Date(Number(p.at) || 0)) === today).length,
      last: posts.filter((p) => p && p.ok !== false).slice(-1)[0] ?? null,
      recent: posts.slice(-10).reverse(),
      reply: (() => {
        const rs = replyState();
        return {
          enabled: Boolean(cfg.reply?.enabled),
          today: rs.day === today ? rs.count : 0,
          maxPerDay: cfg.reply?.maxPerDay ?? 0,
          maxRounds: cfg.reply?.maxRounds ?? 0,
          lastCheck: rs.lastCheck,
          lastAt: rs.lastAt,
          lastError: rs.lastError,
          lastReply: rs.lastReply
        };
      })()
    };
  }

  return {
    cfgOf,
    generate,
    preview,
    publish,
    postNow,
    listThreads,
    checkAuth,
    replyTick,
    replyState,
    pending,
    status,
    history,
    inHours,
    dayKey,
    runtimeFile,
    readJson,
    writeJson
  };
}
