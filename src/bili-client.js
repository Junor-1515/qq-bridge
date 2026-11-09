// B 站取数层：匿名通道 + WBI 签名 + 限流 + TTL 缓存 + 结构化失败。
//
// 设计取自开源插件 2332239652/dsh-bilibili-retrieval 的 lib/protocol.js（MIT），
// 只保留「匿名通道」——分享视频不需要登录态；账号级风控会跟着真人走，不碰。
// 三条实测结论（原插件注释记录，2026-10）：
//   1. wbi/search/type 第 7 次请求起返回 v_voucher 挑战，未签名的 search/type 第 2 次就 412；
//   2. all/v2 能抗突发；
//   3. WBI 签名目前不是真门槛，buvid cookie + 请求速率才是。
import { createHmac } from 'node:crypto';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;
const AID_PATTERN = /^av(\d+)$/i;

export class BiliError extends Error {
  constructor(code, message) {
    super(code + ': ' + message);
    this.name = 'BiliError';
    this.code = code;
  }
}

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export function mixinKey(imgUrl, subUrl) {
  const pick = (u) => String(u ?? '').split('/').pop().replace(/\.\w+$/, '');
  const raw = pick(imgUrl) + pick(subUrl);
  let out = '';
  for (const index of MIXIN_KEY_ENC_TAB) out += raw[index] ?? '';
  return out.slice(0, 32);
}

export function wbiSign(params, key, nowSeconds = Math.floor(Date.now() / 1000)) {
  const entries = Object.entries(params)
    .map(([k, v]) => [k, String(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  entries.push(['wts', String(nowSeconds)]);
  const query = entries
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('&');
  const rid = createHmac('sha256', key).update(query).digest('hex');
  return query + '&w_rid=' + rid;
}

class TokenBucket {
  constructor(minIntervalMs, burst) {
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
    this.queue = Promise.resolve();
  }
  refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    if (this.minIntervalMs === 0) {
      this.tokens = this.capacity;
      return;
    }
    this.tokens = Math.min(this.capacity, this.tokens + elapsed / this.minIntervalMs);
  }
  take() {
    const run = this.queue.then(async () => {
      for (;;) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const need = (1 - this.tokens) * this.minIntervalMs;
        await new Promise((r) => setTimeout(r, Math.max(25, Math.ceil(need))));
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

class TtlCache {
  constructor(maxEntries = 300) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key, value, ttlMs) {
    if (ttlMs <= 0) return;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

function unwrap(body, status) {
  if (body === null || typeof body !== 'object' || !Object.hasOwn(body, 'code')) {
    throw new BiliError('BILIBILI_BAD_RESPONSE', 'response was not a bilibili envelope (HTTP ' + status + ')');
  }
  const code = Number(body.code);
  const message = String(body.message ?? '');
  if (code === 0) return body.data;
  switch (code) {
    case -101:
      throw new BiliError('BILIBILI_LOGIN_REQUIRED', 'this endpoint needs a logged-in account (' + message + ')');
    case -352:
    case -412:
      throw new BiliError('BILIBILI_RISK_CONTROL', 'request blocked by risk control; wait before retrying (' + message + ')');
    case -403:
      throw new BiliError('BILIBILI_FORBIDDEN', 'bilibili refused access (' + message + ')');
    case -404:
      throw new BiliError('BILIBILI_NOT_FOUND', 'the video does not exist or was removed (' + message + ')');
    default:
      throw new BiliError('BILIBILI_API_ERROR', 'bilibili error ' + code + ': ' + message);
  }
}

/**
 * 规范视频引用：BV 号 / av 号 / 完整链接 / 纯数字 av。
 * b23.tv 短链需要跟一次 HTTP 重定向，由 resolveShortLink 处理。
 */
export function parseVideoRef(input) {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) throw new BiliError('BILIBILI_BAD_ARGUMENT', '需要视频号或链接');
  if (BVID_PATTERN.test(raw)) return { bvid: raw };
  const aid = AID_PATTERN.exec(raw);
  if (aid !== null) return { aid: Number(aid[1]) };
  const bvInUrl = /(BV[0-9A-Za-z]{10})/.exec(raw);
  if (bvInUrl !== null) return { bvid: bvInUrl[1] };
  const avInUrl = /\/av(\d+)/i.exec(raw);
  if (avInUrl !== null) return { aid: Number(avInUrl[1]) };
  if (/^\d{6,}$/.test(raw)) return { aid: Number(raw) };
  return null;
}

/** 跟随 b23.tv / bili2233.cn 短链重定向，从最终地址里抠视频号。 */
export async function resolveShortLink(input, { timeoutMs = 15000 } = {}) {
  const raw = String(input ?? '').trim();
  const m = raw.match(/^https?:\/\/(b23\.tv|bili2233\.cn)\/(\S+)/i);
  if (!m) return null;
  const res = await fetch(`https://${m[1]}/${m[2].split(/[?#]/)[0]}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const landed = res.url || '';
  const bv = landed.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return { bvid: bv[0] };
  const av = landed.match(/av(\d+)/i);
  if (av) return { aid: Number(av[1]) };
  const html = await res.text().catch(() => '');
  const bv2 = html.match(/BV[0-9A-Za-z]{10}/);
  if (bv2) return { bvid: bv2[0] };
  return null;
}

export class BiliClient {
  constructor(config = {}) {
    this.config = {
      anonMinIntervalMs: Number(config.anonMinIntervalMs) || 400,
      anonBurst: Number(config.anonBurst) || 4,
      requestTimeoutMs: Number(config.requestTimeoutMs) || 20000,
    };
    this.bucket = new TokenBucket(this.config.anonMinIntervalMs, this.config.anonBurst);
    // 搜索比热门/详情更容易触发风控，单独放慢一档：1.2s/次、突发 2 次。
    this.searchBucket = new TokenBucket(1200, 2);
    this.cache = new TtlCache(300);
    this.anonCookies = null;
    this.wbiKeys = null;
    this.inflight = new Map();
    this.credential = null;
  }

  /** 丢弃当前匿名指纹与签名密钥缓存，下一次请求会重新领 buvid 与 wbi key。 */
  resetSession() {
    this.anonCookies = null;
    this.wbiKeys = null;
    this.cache.clear?.();
  }

  /** 挂上登录态（null 表示退出登录）。登录态只用于本地刷推荐流，不改匿名通道。 */
  setCredential(credential) {
    this.credential = credential && credential.sessdata ? credential : null;
    this.wbiKeys = null;
    this.cache.clear?.();
  }

  credentialCookie() {
    const c = this.credential;
    if (!c?.sessdata) return '';
    const parts = ['SESSDATA=' + c.sessdata];
    if (c.biliJct) parts.push('bili_jct=' + c.biliJct);
    if (c.dedeUserId) parts.push('DedeUserID=' + c.dedeUserId);
    if (c.buvid3) parts.push('buvid3=' + c.buvid3);
    return parts.join('; ');
  }

  async anonymousCookie() {
    if (this.anonCookies !== null) return this.anonCookies;
    const fallback = 'b_nut=' + Math.floor(Date.now() / 1000);
    try {
      const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
        headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      const body = await res.json();
      const data = body?.data;
      const parts = [];
      if (typeof data?.b_3 === 'string') parts.push('buvid3=' + data.b_3);
      if (typeof data?.b_4 === 'string') parts.push('buvid4=' + data.b_4);
      parts.push(fallback);
      this.anonCookies = parts.join('; ');
    } catch {
      this.anonCookies = fallback;
    }
    return this.anonCookies;
  }

  async wbiMixin() {
    if (this.wbiKeys !== null) return this.wbiKeys;
    const cookie = await this.anonymousCookie();
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: 'https://www.bilibili.com/',
        Cookie: cookie,
      },
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    const body = await res.json();
    // 匿名调用 code=-101，但 wbi_img 仍然有效——直接读 payload，不走错误映射。
    const img = body?.data?.wbi_img?.img_url;
    const sub = body?.data?.wbi_img?.sub_url;
    if (typeof img !== 'string' || typeof sub !== 'string') {
      throw new BiliError('BILIBILI_WBI_KEYS_UNAVAILABLE', '读不到 wbi 签名密钥');
    }
    this.wbiKeys = mixinKey(img, sub);
    return this.wbiKeys;
  }

  async requestJson(url, { cacheTtlMs = 0, skipBucket = false, signal, useCredential = false } = {}) {
    const key = useCredential ? url + '#auth' : url;
    if (cacheTtlMs > 0) {
      const hit = this.cache.get(key);
      if (hit !== undefined) return hit;
    }
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;

    const run = (async () => {
      if (!skipBucket) await this.bucket.take();
      const anon = await this.anonymousCookie();
      const cred = useCredential ? this.credentialCookie() : '';
      const cookie = cred.length > 0 ? (anon.length > 0 ? anon + '; ' + cred : cred) : anon;
      const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Referer: 'https://www.bilibili.com/',
          ...(cookie.length > 0 ? { Cookie: cookie } : {}),
        },
        redirect: 'follow',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('json')) {
        if (response.status === 412) throw new BiliError('BILIBILI_RISK_CONTROL', 'HTTP 412 风控拦截，稍后重试');
        throw new BiliError('BILIBILI_BAD_RESPONSE', 'non-JSON response (HTTP ' + response.status + ')');
      }
      const body = await response.json();
      const data = unwrap(body, response.status);
      if (cacheTtlMs > 0) this.cache.set(key, data, cacheTtlMs);
      return data;
    })();

    this.inflight.set(key, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(key);
    }
  }

  async requestWbi(pathname, params, options = {}) {
    const key = await this.wbiMixin();
    const query = wbiSign(params, key);
    return this.requestJson('https://api.bilibili.com' + pathname + '?' + query, options);
  }

  /** 综合热门（抗突发，适合当推荐流）。 */
  async hot(limit = 20, pn = 1) {
    const ps = Math.min(50, Math.max(1, Number(limit) || 20));
    const data = await this.requestJson(
      `https://api.bilibili.com/x/web-interface/popular?ps=${ps}&pn=${Math.max(1, Number(pn) || 1)}`,
      { cacheTtlMs: 120000 }
    );
    return (data?.list ?? []).map(normalizeVideo);
  }

  /** 排行榜。rid=0 全站，其它为分区 id。 */
  async ranking(limit = 20, rid = 0) {
    const data = await this.requestJson(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${Number(rid) || 0}&type=all`, {
      cacheTtlMs: 300000,
    });
    return (data?.list ?? []).slice(0, Math.max(1, Number(limit) || 20)).map(normalizeVideo);
  }

  /** 关键词搜索。走 wbi/search/type（search_type=video）：返回的是扁平的视频条目数组。
   *  实测：未签名的 search/type 第 2 次就 412，wbi 签名后连续刷也会触发 v_voucher 挑战，
   *  所以这里单独放慢（1.2s/次）+ 结果缓存 120s；撞到风控就换一次匿名指纹退避重试一次。 */
  async search(keyword, limit = 10, page = 1) {
    const kw = String(keyword ?? '').trim();
    if (!kw) throw new BiliError('BILIBILI_BAD_ARGUMENT', '搜索关键词不能为空');
    const ps = Math.min(30, Math.max(1, Number(limit) || 10));
    const run = async () => {
      await this.searchBucket.take();
      const data = await this.requestWbi('/x/web-interface/wbi/search/type', {
        keyword: kw,
        search_type: 'video',
        page: String(Math.max(1, Number(page) || 1)),
      }, { cacheTtlMs: 120000, skipBucket: true });
      if (data?.v_voucher) {
        throw new BiliError('BILIBILI_RISK_CONTROL', '搜索触发了风控挑战（v_voucher），等一会儿再试，或者改用热门/排行榜');
      }
      const list = Array.isArray(data?.result) ? data.result : [];
      return list.slice(0, ps).map(normalizeSearchItem).filter(Boolean);
    };
    try {
      return await run();
    } catch (err) {
      if (err?.code !== 'BILIBILI_RISK_CONTROL') throw err;
      // 风控多半是临时的：换一个新的 buvid 指纹，隔一两秒再试一次。
      this.resetSession();
      await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 1500));
      try {
        return await run();
      } catch (retryErr) {
        if (retryErr?.code !== 'BILIBILI_RISK_CONTROL') throw retryErr;
        // 还不行就退到老的、不带 wbi 签名的 search/type（风控画像不同，往往还能用）。
        return this.searchLegacy(kw, ps, page);
      }
    }
  }

  /** 老版搜索接口（无 wbi 签名）。WBI 搜索被 v_voucher 挡住时的兜底，返回结构相同。 */
  async searchLegacy(keyword, limit = 10, page = 1) {
    const ps = Math.min(30, Math.max(1, Number(limit) || 10));
    const q =
      'search_type=video&keyword=' +
      encodeURIComponent(keyword) +
      '&page=' +
      String(Math.max(1, Number(page) || 1));
    const data = await this.requestJson('https://api.bilibili.com/x/web-interface/search/type?' + q, {
      cacheTtlMs: 120000,
    });
    const list = Array.isArray(data?.result) ? data.result : [];
    return list.slice(0, ps).map(normalizeSearchItem).filter(Boolean);
  }

  /** 单视频详情。 */
  async video(input) {
    const ref = parseVideoRef(input) ?? (await resolveShortLink(input));
    if (!ref) throw new BiliError('BILIBILI_BAD_ARGUMENT', '读不出视频号：' + String(input).slice(0, 80));
    const q = ref.bvid ? 'bvid=' + ref.bvid : 'aid=' + ref.aid;
    const data = await this.requestJson('https://api.bilibili.com/x/web-interface/view?' + q, { cacheTtlMs: 300000 });
    return normalizeVideo(data);
  }

  /** 视频标签（公开接口，匿名可取；用来做「标签命中」的二次相关性打分）。 */
  async tags(bvid) {
    const id = String(bvid || '').trim();
    if (!id) return [];
    const data = await this.requestJson(
      'https://api.bilibili.com/x/tag/archive/tags?bvid=' + encodeURIComponent(id),
      { cacheTtlMs: 12 * 3600 * 1000 },
    );
    const rows = Array.isArray(data) ? data : [];
    return rows.map((t) => String(t?.tag_name ?? '').trim()).filter(Boolean);
  }

  /** 评论区（公开接口，未登录也能取前若干条热评）。返回 [{ user, like, text, replies:[{user,text}] }]。 */
  async comments(input, { limit = 8, sort = 2 } = {}) {
    const ref = typeof input === 'object' && input ? input : parseVideoRef(input);
    let aid = Number(ref?.aid) || 0;
    if (!aid && ref?.bvid) {
      const info = await this.video(ref.bvid);
      aid = Number(info?.aid) || 0;
    }
    if (!aid) return [];
    const size = Math.max(1, Math.min(20, Number(limit) || 8));
    const data = await this.requestJson(
      'https://api.bilibili.com/x/v2/reply?type=1&oid=' + aid + '&sort=' + (sort === 0 ? 0 : 2) + '&ps=' + size + '&pn=1',
      { cacheTtlMs: 600000 },
    );
    const rows = Array.isArray(data?.replies) ? data.replies : [];
    return rows.map((r) => ({
      user: String(r?.member?.uname ?? '').trim(),
      like: Number(r?.like) || 0,
      text: stripEm(r?.content?.message),
      replies: (Array.isArray(r?.replies) ? r.replies : []).slice(0, 2).map((x) => ({
        user: String(x?.member?.uname ?? '').trim(),
        text: stripEm(x?.content?.message),
      })),
    }));
  }

  /** 把一次「观看」写进登录账号的 B 站历史记录（web 播放器心跳）。
   *  走 x/click-interface/web/heartbeat：只要 aid，官方 web 端就是这么上报的。
   *  未登录直接跳过；失败只抛错，调用方自行决定是否静默。 */
  async reportWatch(input, { progress = 30 } = {}) {
    if (!this.credential) return { skipped: true, reason: 'not-logged-in' };
    const video = typeof input === 'object' && input ? input : await this.video(input);
    const aid = Number(video?.aid) || 0;
    if (!aid) return { skipped: true, reason: 'no-aid' };
    const secs = Math.max(1, Math.min(Number(video?.duration) || 3600, Number(progress) || 30));
    const now = Math.floor(Date.now() / 1000);
    const csrf = String(this.credential.biliJct ?? '');
    const body = new URLSearchParams({
      aid: String(aid),
      progress: String(secs),
      csrf,
      type: '3',
      dt: '2',
      play_type: '0',
      realtime: String(secs),
      played_time: String(secs),
      start_ts: String(now),
      mid: String(this.credential.dedeUserId ?? ''),
      platform: 'web',
    });
    const res = await fetch('https://api.bilibili.com/x/click-interface/web/heartbeat', {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Referer: video?.url || 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: this.credentialCookie(),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await res.json().catch(() => null);
    if (payload?.code !== 0) {
      throw new BiliError('BILIBILI_API_ERROR', `写观看记录失败（code ${payload?.code ?? res.status}）：${payload?.message ?? ''}`);
    }
    return { ok: true, aid, progress: secs };
  }

  /** 登录后的推荐流（首页「推荐」）。未登录会返回空数组。 */
  async recommend(limit = 20, { freshIdx = 1 } = {}) {
    if (!this.credential) return [];
    const ps = Math.min(30, Math.max(1, Number(limit) || 20));
    const data = await this.requestWbi('/x/web-interface/wbi/index/top/feed/rcmd', {
      ps: String(ps),
      fresh_type: '3',
      feed_version: 'V8',
      fresh_idx: String(Math.max(1, Number(freshIdx) || 1)),
      fresh_idx_1h: '1',
      brush: String(Math.floor(Math.random() * 3)),
      homepage_ver: '1',
      y_num: '4',
    }, { cacheTtlMs: 60000, useCredential: true });
    const items = Array.isArray(data?.item) ? data.item : [];
    return items
      .filter((it) => it && (it.bvid || it.id) && String(it.goto ?? 'av').startsWith('av'))
      .map((it) => {
        const bvid = it.bvid || '';
        if (!bvid) return null;
        return {
          bvid,
          aid: Number(it.id) || 0,
          title: String(it.title ?? '').trim(),
          desc: '',
          pic: normalizeCover(it.pic),
          duration: Number(it.duration) || 0,
          pubdate: Number(it.pubdate) || 0,
          owner: String(it.owner?.name ?? '').trim(),
          ownerMid: it.owner?.mid ?? 0,
          view: Number(it.stat?.view) || 0,
          like: Number(it.stat?.like) || 0,
          danmaku: Number(it.stat?.danmaku) || 0,
          url: 'https://www.bilibili.com/video/' + bvid,
        };
      })
      .filter(Boolean);
  }
}

function normalizeCover(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  return raw.startsWith('//') ? 'https:' + raw : raw.replace(/^http:\/\//, 'https://');
}

function stripEm(html) {
  return String(html ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
}

function parseDurationText(text) {
  const parts = String(text ?? '').split(':').map((n) => Number(n));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] || 0;
}

/** 搜索结果条目 → 统一的视频对象（字段名与 popular/view 接口不同）。 */
function normalizeSearchItem(item) {
  if (!item || !item.bvid) return null;
  return {
    bvid: item.bvid,
    aid: Number(item.aid) || 0,
    title: stripEm(item.title),
    desc: stripEm(item.description),
    pic: normalizeCover(item.pic),
    duration: parseDurationText(item.duration),
    pubdate: Number(item.pubdate) || 0,
    owner: String(item.author ?? '').trim(),
    ownerMid: item.mid ?? 0,
    view: Number(item.play) || 0,
    like: Number(item.like) || 0,
    danmaku: Number(item.video_review) || 0,
    url: 'https://www.bilibili.com/video/' + item.bvid,
  };
}

function normalizeVideo(v) {
  if (!v) return null;
  const stat = v.stat ?? {};
  const owner = v.owner ?? {};
  return {
    bvid: v.bvid ?? '',
    aid: v.aid ?? 0,
    title: String(v.title ?? '').trim(),
    desc: String(v.desc ?? '').replace(/\s+/g, ' ').trim(),
    pic: normalizeCover(v.pic),
    duration: Number(v.duration) || 0,
    pubdate: Number(v.pubdate ?? v.ctime) || 0,
    owner: String(owner.name ?? '').trim(),
    ownerMid: owner.mid ?? 0,
    view: Number(stat.view) || 0,
    like: Number(stat.like) || 0,
    danmaku: Number(stat.danmaku) || 0,
    url: v.bvid ? 'https://www.bilibili.com/video/' + v.bvid : '',
  };
}

export function formatDuration(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `0:${String(r).padStart(2, '0')}`;
}

export function formatCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + '万';
  return String(v);
}

/** 给模型/文本看的单条摘要。 */
export function describeVideo(v, index = null) {
  const head = index === null ? '' : `${index + 1}. `;
  return (
    `${head}${v.title}\n` +
    `   UP：${v.owner || '未知'} ｜ ${formatDuration(v.duration)} ｜ 播放 ${formatCount(v.view)}\n` +
    `   ${v.url}`
  );
}
