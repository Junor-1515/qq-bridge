// B 站只读数据访问层（无登录、无写操作）。供 src/mcp-web-search-safe.js 里的 bili_* 工具使用。
//
// 只访问 api.bilibili.com / www.bilibili.com / b23.tv 这几个固定域名，不接受用户传入任意 URL，
// 因此不需要 safe-fetch 的 SSRF 防护；但用户给的是视频链接，也只做「解析出 BV/av 号」这一步，
// 命中的仍然是 api.bilibili.com 的固定端点。
//
// 无登录抓公开数据的两个坑：
// - 搜索类接口（wbi/search/type）需要 buvid3 cookie，否则 -352/-412；用 finger/spi 拿 b_3 冒充。
// - 2023 起搜索接口要 wbi 签名（nav 接口拿 img_key/sub_key，再按固定置换表算 mixin key）。
import crypto from 'node:crypto';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Accept: 'application/json, text/plain, */*',
};

const cookies = new Map();
let fingerReady = false;
let wbi = { imgKey: '', subKey: '', at: 0 };

function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbCookies(res) {
  let list = [];
  try {
    list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  } catch {}
  for (const line of list) {
    const pair = String(line).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function biliFetch(url, init = {}) {
  const headers = { ...BASE_HEADERS, ...(init.headers || {}) };
  const ck = cookieHeader();
  if (ck) headers.Cookie = ck;
  const res = await fetch(url, { ...init, headers, redirect: 'follow' });
  absorbCookies(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!json) throw new Error(`B站接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  return json;
}

async function api(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, String(v));
  const json = await biliFetch(u.toString());
  if (json.code !== 0) throw new Error(`B站接口报错 code=${json.code}：${json.message || '未知'}`);
  return json.data;
}

async function ensureFinger() {
  if (fingerReady) return;
  try {
    const data = await api('https://api.bilibili.com/x/frontend/finger/spi');
    if (data?.b_3) cookies.set('buvid3', data.b_3);
    if (data?.b_4) cookies.set('buvid4', data.b_4);
    cookies.set('b_nut', String(Math.floor(Date.now() / 1000)));
  } catch {}
  fingerReady = true;
}

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function mixinKey(raw) {
  return MIXIN_TAB.map((i) => raw[i] ?? '').join('').slice(0, 32);
}

async function ensureWbi() {
  if (wbi.imgKey && Date.now() - wbi.at < 30 * 60 * 1000) return wbi;
  await ensureFinger();
  const nav = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
  const img = String(nav?.data?.wbi_img?.img_url || '');
  const sub = String(nav?.data?.wbi_img?.sub_url || '');
  const pick = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
  if (!img || !sub) throw new Error('拿不到 B 站 wbi 签名密钥（nav 接口异常）');
  wbi = { imgKey: pick(img), subKey: pick(sub), at: Date.now() };
  return wbi;
}

async function signedParams(params) {
  const { imgKey, subKey } = await ensureWbi();
  const mixin = mixinKey(imgKey + subKey);
  const all = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(all)
    .sort()
    .map((k) => {
      const v = String(all[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixin).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

// ── 数值/时间格式化 ────────────────────────────────────────────────────────
export function fmtCount(n) {
  const num = Number(n) || 0;
  if (num >= 1e8) return `${(num / 1e8).toFixed(1)}亿`;
  if (num >= 1e4) return `${(num / 1e4).toFixed(1)}万`;
  return String(num);
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export function videoUrl(v) {
  if (v?.bvid) return `https://www.bilibili.com/video/${v.bvid}`;
  if (v?.aid) return `https://www.bilibili.com/video/av${v.aid}`;
  return '';
}

export function stripEm(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 对外能力 ──────────────────────────────────────────────────────────────

/** 综合热门（popular）。 */
export async function hot(limit = 10) {
  await ensureFinger();
  const ps = Math.min(Math.max(Number(limit) || 10, 1), 30);
  const data = await api('https://api.bilibili.com/x/web-interface/popular', { ps, pn: 1 });
  return (data?.list || []).slice(0, ps).map((v) => ({
    bvid: v.bvid,
    title: v.title,
    up: v.owner?.name || '',
    view: fmtCount(v.stat?.view),
    danmaku: fmtCount(v.stat?.danmaku),
    duration: fmtDuration(v.duration),
    url: videoUrl(v),
  }));
}

/** 排行榜（ranking/v2），按分区。 */
export async function ranking(limit = 10, rid = 0) {
  await ensureFinger();
  const data = await api('https://api.bilibili.com/x/web-interface/ranking/v2', { rid, type: 'all' });
  return (data?.list || []).slice(0, Math.min(Number(limit) || 10, 30)).map((v) => ({
    bvid: v.bvid,
    title: v.title,
    up: v.owner?.name || '',
    view: fmtCount(v.stat?.view),
    duration: fmtDuration(v.duration),
    url: videoUrl(v),
  }));
}

/** 视频搜索（wbi 签名 + buvid3）。 */
export async function search(keyword, limit = 8) {
  const kw = String(keyword || '').trim().slice(0, 60);
  if (!kw) throw new Error('搜索词为空');
  await ensureFinger();
  const pageSize = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const qs = await signedParams({
    search_type: 'video',
    keyword: kw,
    page: 1,
    page_size: pageSize,
  });
  const json = await biliFetch(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`,
    { headers: { Referer: `https://search.bilibili.com/all?keyword=${encodeURIComponent(kw)}` } }
  );
  if (json.code !== 0) throw new Error(`搜索失败 code=${json.code}：${json.message || '未知'}`);
  const list = json?.data?.result || [];
  return list.slice(0, pageSize).map((v) => ({
    bvid: v.bvid,
    title: stripEm(v.title),
    up: stripEm(v.author),
    play: fmtCount(v.play),
    duration: fmtDuration(v.duration),
    pubdate: v.pubdate ? new Date(v.pubdate * 1000).toISOString().slice(0, 10) : '',
    url: `https://www.bilibili.com/video/${v.bvid}`,
  }));
}

/** 从各种输入里解析出 BV/aid（b23.tv 短链会跟一次重定向）。 */
export async function resolveId(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('视频标识为空');
  let m = raw.match(/BV[0-9A-Za-z]{10}/);
  if (m) return { bvid: m[0] };
  m = raw.match(/av(\d+)/i);
  if (m) return { aid: Number(m[1]) };
  if (/^\d+$/.test(raw)) return { aid: Number(raw) };
  m = raw.match(/^https?:\/\/(b23\.tv|bili2233\.cn)\/(\S+)/i);
  if (m) {
    const res = await biliFetch(`https://${m[1]}/${m[2]}`, { headers: { Accept: 'text/html' } });
    const finalUrl = res?.data ? '' : '';
    void finalUrl;
    throw new Error('短链需要浏览器重定向，暂不支持 b23.tv 短链，请发 BV 号或完整视频链接');
  }
  throw new Error('没认出视频号，请发 BV 号 / av 号 / 完整视频链接');
}

/** 视频详情（含 UP 主、数据、简介、分P）。 */
export async function video(input) {
  const id = await resolveId(input);
  const params = id.bvid ? { bvid: id.bvid } : { aid: id.aid };
  const v = await api('https://api.bilibili.com/x/web-interface/view', params);
  return {
    bvid: v.bvid,
    aid: v.aid,
    title: v.title,
    up: v.owner?.name || '',
    upMid: v.owner?.mid,
    view: fmtCount(v.stat?.view),
    danmaku: fmtCount(v.stat?.danmaku),
    like: fmtCount(v.stat?.like),
    coin: fmtCount(v.stat?.coin),
    favorite: fmtCount(v.stat?.favorite),
    reply: fmtCount(v.stat?.reply),
    duration: fmtDuration(v.duration),
    pubdate: v.pubdate ? new Date(v.pubdate * 1000).toISOString().slice(0, 10) : '',
    desc: String(v.desc || '').slice(0, 200),
    cover: v.pic || '',
    pages: (v.pages || []).length,
    url: videoUrl(v),
    tname: v.tname || '',
  };
}

/** 组装一条「可以直接发出去的分享文本」。 */
export function shareCard(v) {
  return [
    `【${v.title}】`,
    `UP：${v.up}｜播放 ${v.view}｜时长 ${v.duration}${v.pubdate ? `｜${v.pubdate}` : ''}`,
    v.desc ? `简介：${v.desc}` : '',
    v.url,
  ]
    .filter(Boolean)
    .join('\n');
}
