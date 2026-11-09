// B 站「刷视频 + 分享」业务层。
//
// 职责边界：
//   - 取数：交给 bili-client.js（匿名通道；登录后额外有推荐流）
//   - 登录：交给 bili-login.js（扫码，落 state/bili-credential.json）
//   - 发送：交给 bridge.js 的 sendChain（图片 + 文本共用一条发送链，保证顺序）
// 本文件只负责「选哪个视频、说哪句话、分享过哪些别重复、你喜欢什么」。
import fs from 'node:fs';
import path from 'node:path';
import { BiliClient, describeVideo, BiliError } from './bili-client.js';
import { createLoginQr, pollLogin, readCredential, saveCredential, clearCredential, verifyCredential } from './bili-login.js';

const SHARED_FILE = 'bili-shared.json';
const INTEREST_FILE = 'bili-interest.json';
const TAGS_FILE = 'bili-tags.json';
const MAX_HISTORY = 400;
const MAX_KEYWORDS = 40;
const TAG_TTL_MS = 7 * 24 * 3600 * 1000;
const TAG_CACHE_MAX = 800;

// 上下文推送用的词法工具（纯函数，放在这里方便单测）。
export const TOPIC_STOP = new Set([
  '什么', '怎么', '为什么', '如何', '有没有', '这个', '那个', '我们', '他们', '你们', '现在', '今天',
  '感觉', '觉得', '知道', '可以', '应该', '需要', '问题', '东西', '时候', '视频', '推荐', '一个', '一下',
]);
export const TOPIC_SIGNAL_RE = /[？?]|吗|怎么|为什么|如何|有没有|哪个|是不是|能不能|推荐|求|想找|帮我|请问|想知道|有没有人/;

/** 从一句聊天里抠出「他在问/找什么」的关键词，返回 0~3 个，长的优先。 */
export function extractTopicKeywords(text) {
  const s = String(text ?? '').replace(/\[[^\]]*\]/g, ' ').trim();
  if (!s) return [];
  const spans = s
    .split(/[，。！？,.!?;；:：、\s（）()【】\[\]"'“”‘’~～…—\-\/]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const out = [];
  const NOISE_HEAD = /^(那|这个|那个|就是|我想问|请问|话说|对了|所以|但是|而且|然后|还是|有人|有没有人|有没有什么|有没有讲|有没有|帮我看看|帮我找找?|帮我|问一下?|求个|求|我想学|我想知道)/;
  const NOISE_TAIL = /(推荐一下|推荐点|推荐|教程|视频|合集|介绍|科普|一下|看看|讲过|说过|过|吗|呢|吧|啊|呀)$/;
  for (const span of spans) {
    // 一句话里常把问题揉在一起（“这个游戏怎么快速刷材料”），先按疑问词切开再清理。
    for (const part of span.split(/(?:怎么|如何|为什么|什么是|有没有|求推荐)/)) {
      let w = part.replace(NOISE_HEAD, '');
      for (let i = 0; i < 3; i += 1) {
        const next = w.replace(NOISE_TAIL, '').trim();
        if (next === w) break;
        w = next;
      }
      // “适合新手的滑雪”→取最后的中心词；“讲摄影构图的”已经去掉尾巴的“的”。
      if (w.endsWith('的')) w = w.slice(0, -1).trim();
      if (w.includes('的')) {
        const tail = w.split('的').pop().trim();
        if (tail.length >= 2) w = tail;
      }
      w = w.replace(/^[讲说聊看]+/, '').trim();
      if (w.length < 2 || w.length > 10) continue;
      if (TOPIC_STOP.has(w)) continue;
      if (!/[\u4e00-\u9fffA-Za-z]/.test(w)) continue;
      out.push(w);
    }
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length).slice(0, 3);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function createBiliService({ cfg, log = () => {}, stateDir }) {
  const biliCfg = () => cfg.bili ?? {};
  const sharedPath = path.join(stateDir, SHARED_FILE);
  const interestPath = path.join(stateDir, INTEREST_FILE);
  const tagsPath = path.join(stateDir, TAGS_FILE);
  const state = readJson(sharedPath, { shared: [] });
  if (!Array.isArray(state.shared)) state.shared = [];
  const interest = readJson(interestPath, { keywords: [] });
  if (!Array.isArray(interest.keywords)) interest.keywords = [];
  const tagState = readJson(tagsPath, { tags: {} });
  if (!tagState.tags || typeof tagState.tags !== 'object' || Array.isArray(tagState.tags)) tagState.tags = {};

  let client = null;
  function getClient() {
    if (client === null) {
      const c = biliCfg();
      client = new BiliClient({
        anonMinIntervalMs: c.requestIntervalMs,
        anonBurst: c.burst,
        requestTimeoutMs: c.timeoutMs,
      });
      const cred = readCredential(stateDir);
      if (cred) client.setCredential(cred);
    }
    return client;
  }

  // ---- 去重 ----

  function remember(bvid, extra = {}) {
    if (!bvid) return;
    state.shared.unshift({
      bvid,
      at: Date.now(),
      ...(extra.title ? { title: String(extra.title).slice(0, 80) } : {}),
      ...(extra.key ? { key: String(extra.key) } : {}),
    });
    if (state.shared.length > MAX_HISTORY) state.shared = state.shared.slice(0, MAX_HISTORY);
    try {
      writeJson(sharedPath, state);
    } catch (error) {
      log(`[bili] 记录分享历史失败：${error?.message ?? error}`);
    }
  }

  /** 最近分享过的视频（新的在前），给设置面板和活动日志用。 */
  function recentShares(limit = 10) {
    return state.shared.slice(0, Math.max(1, Number(limit) || 10));
  }

  function sharedRecently(bvid, withinMs = 12 * 3600 * 1000) {
    const now = Date.now();
    return state.shared.some((s) => s.bvid === bvid && now - Number(s.at || 0) < withinMs);
  }

  /** 今天已经分享过多少条（用于 autoShare.maxPerDay 的每日上限）。 */
  function sharedTodayCount() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const since = start.getTime();
    return state.shared.filter((s) => Number(s.at || 0) >= since).length;
  }

  /**
   * 标题指纹：去标点/空白、转小写、截前 40 字。
   * 同一段内容被换号搬运会换 bvid 但标题几乎一样，只按 bvid 去重挡不住这种重复。
   */
  function titleFingerprint(title) {
    return String(title ?? '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '')
      .slice(0, 40);
  }

  /**
   * 只挡「标题完全相同」的同一条视频（换号搬运也会撞标题）。
   * 刻意不做包含/相似判断：同一系列、同一个 UP 的上下集、同题材的别的视频都是「同类」不是「同一条」，
   * 该照常推（2026-10-31 用户要求）。
   */
  function titleSame(a, b) {
    const fa = titleFingerprint(a);
    const fb = titleFingerprint(b);
    if (fa.length === 0 || fb.length === 0) return false;
    return fa === fb;
  }

  /** 最近分享过的记录里有没有标题撞车的（同窗口，避免同一个视频的搬运版连推）。 */
  function sharedTitleRecently(title, withinMs = 12 * 3600 * 1000) {
    if (titleFingerprint(title).length === 0) return false;
    const now = Date.now();
    return state.shared.some(
      (s) => s.title && now - Number(s.at || 0) < withinMs && titleSame(s.title, title)
    );
  }

  /** 新鲜度配置归一化：缺省按「一年内、三个月半衰、老的也有 5% 机会」处理。 */
  function normalizeFreshness(f) {
    const src = f && typeof f === 'object' ? f : {};
    const maxAgeDays = Number(src.maxAgeDays);
    const halfLifeDays = Number(src.halfLifeDays);
    const floor = Number(src.floor);
    return {
      enabled: src.enabled !== false,
      // 0 显式表示不限年代；没填则按一年。
      maxAgeDays:
        Number.isFinite(maxAgeDays) && maxAgeDays >= 0
          ? maxAgeDays === 0
            ? Number.POSITIVE_INFINITY
            : maxAgeDays
          : 365,
      halfLifeDays: Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : 90,
      floor: Number.isFinite(floor) ? Math.min(1, Math.max(0.001, floor)) : 0.05,
    };
  }

  /**
   * 从候选里挑一条没分享过的。
   * - 去重：bvid 命中或标题完全一致才算重复（同类、同系列不算）；全部重复就返回 null（绝不回退成「随便给一条」，
   *   那是之前重复推送的根因——24 小时窗口一过、或候选全在窗口内，就会把老视频又发一遍）。
   * - 新鲜度：超出 maxAgeDays 的直接剔除；剩下的按「半衰期」加权随机，
   *   新视频权重高、老视频按 0.5^(age/halfLife) 衰减到 floor 为止。
   *   pubdate 缺失的条目给 floor 权重（不知道多老，就当冷门备选）。
   */
  function pickUnshared(list, withinMs = 12 * 3600 * 1000, freshness) {
    const items = (Array.isArray(list) ? list : []).filter((v) => v && v.bvid);
    const deduped = items.filter(
      (v) => !sharedRecently(v.bvid, withinMs) && !sharedTitleRecently(v.title, withinMs)
    );
    if (deduped.length === 0) return null;
    const f = normalizeFreshness(freshness);
    if (!f.enabled) return deduped[Math.floor(Math.random() * deduped.length)];
    const now = Date.now();
    const pool = [];
    for (const v of deduped) {
      const raw = Number(v.pubdate) || 0;
      if (!raw) {
        pool.push({ v, w: f.floor });
        continue;
      }
      const tsMs = raw > 1e12 ? raw : raw * 1000;
      const ageDays = Math.max(0, (now - tsMs) / 86400000);
      if (ageDays > f.maxAgeDays) continue;
      pool.push({ v, w: Math.max(f.floor, Math.pow(0.5, ageDays / f.halfLifeDays)) });
    }
    if (pool.length === 0) return null;
    const total = pool.reduce((sum, p) => sum + p.w, 0);
    let r = Math.random() * total;
    for (const p of pool) {
      r -= p.w;
      if (r <= 0) return p.v;
    }
    return pool[pool.length - 1].v;
  }

  // ---- 兴趣：把「你让我搜的词」记下来，之后推荐优先用 ----

  /** 喜好上限：设置面板的 bili.interest.maxKeywords 生效，兜底 40（常量仍然是硬上限）。 */
  function interestMax() {
    const n = Number(biliCfg().interest?.maxKeywords);
    return Number.isFinite(n) && n > 0 ? Math.min(MAX_KEYWORDS, Math.floor(n)) : MAX_KEYWORDS;
  }

  /** 词条长度上限（默认 10，像 B 站标签）与一次搜索最多拆几条。2026-11-02 用户要求：词条要短，不要整句塞进去。 */
  function interestMaxLen() {
    const n = Number(biliCfg().interest?.maxLen);
    return Number.isFinite(n) && n >= 2 ? Math.min(20, Math.floor(n)) : 10;
  }
  function interestMaxPerQuery() {
    const n = Number(biliCfg().interest?.maxPerQuery);
    return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 3;
  }

  const TAG_SPLIT_RE = /[\s\u3000,，、;；:：|/\\·•\-—_+~～!！?？。.…()（）\[\]【】《》"'“”‘’「」『』]+/;
  const TAG_ASCII_RE = /^[A-Za-z0-9][A-Za-z0-9.&'!\-]*$/;
  const TAG_STOP = new Set([
    '视频', '推荐', '看看', '有没有', '什么', '怎么', '求', '帮我', '请问', '想知道', '一下', '这个', '那个',
    '的', '了', '啊', '吧', '吗', '呢', '和', '与', '相关', '合集', '搬运', '最新', '热门', '高清', '完整版',
    '实测', '盘点', '教程', 'up主', '直播'
  ]);

  function cleanTagText(text) {
    return String(text ?? '')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D]/gu, ' ')
      .replace(/[#＃]/g, ' ')
      .replace(/[\s\u3000]+/g, ' ')
      .trim();
  }

  /**
   * 把一段搜索词拆成「像标签一样」的短词条。
   * 例：「BanG Dream 少女乐团派对 难度29 手元 全连」→ BanG Dream / 少女乐团派对 / 难度29
   * 规则：按空格和标点切 → 相邻英文词合并 → 去停用词/纯数字/单字 → 超长截断 → 去重 → 最多 maxCount 条。
   */
  function interestTags(text, maxCount = 3) {
    const maxLen = interestMaxLen();
    const parts = cleanTagText(text).split(TAG_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
    const merged = [];
    for (const part of parts) {
      const prev = merged[merged.length - 1];
      // 相邻英文词合并成一个标签（BanG Dream / Hololive EN），最多比长度上限多 4 个字符。
      if (prev && TAG_ASCII_RE.test(prev) && TAG_ASCII_RE.test(part) && (prev + ' ' + part).length <= maxLen + 4) {
        merged[merged.length - 1] = prev + ' ' + part;
        continue;
      }
      merged.push(part);
    }
    const out = [];
    const seen = new Set();
    for (const raw of merged) {
      let tag = raw.replace(/^[._\-—+~～]+|[._\-—+~～]+$/g, '').trim();
      if (!tag) continue;
      // 太长的一律不当标签：截断只会截出半句话（「帮我找一下有没有明日」），不如不记。
      const chars = Array.from(tag);
      const asciiOnly = TAG_ASCII_RE.test(tag) || /^[A-Za-z0-9 .&'!-]+$/.test(tag);
      if (asciiOnly ? chars.length > maxLen + 4 : chars.length > maxLen) continue;
      if (chars.length < 2) continue;
      if (/^\d+$/.test(tag)) continue;
      if (TAG_STOP.has(tag)) continue;
      const low = tag.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      out.push(tag);
      if (out.length >= Math.max(1, maxCount)) break;
    }
    return out;
  }
  /** 词条满了只淘汰最久没用的，不按次数淘汰。 */
  function trimOldestTags(list, cap) {
    if (!Array.isArray(list) || list.length <= cap) return list;
    const drop = new Set(
      [...list]
        .sort((a, b) => Number(a.lastAt || 0) - Number(b.lastAt || 0))
        .slice(0, list.length - cap)
    );
    return list.filter((k) => !drop.has(k));
  }

  function recordInterest(text) {
    if (biliCfg().interest?.enabled === false) return;
    // 一次搜索词可能是一整句，拆成几个短标签再存（2026-11-02 用户要求）。
    const tags = interestTags(text, interestMaxPerQuery());
    if (tags.length === 0) return;
    const now = Date.now();
    for (const kw of tags) {
      const low = kw.toLowerCase();
      const idx = interest.keywords.findIndex((k) => String(k.kw ?? '').toLowerCase() === low);
      if (idx >= 0) {
        // 命中旧词条：累加次数并拉到最前（最近用过）。
        const [hit] = interest.keywords.splice(idx, 1);
        hit.count = Number(hit.count || 0) + 1;
        hit.lastAt = now;
        interest.keywords.unshift(hit);
      } else {
        interest.keywords.unshift({ kw, count: 1, lastAt: now });
      }
    }
    interest.keywords = trimOldestTags(interest.keywords, interestMax());
    try {
      writeJson(interestPath, interest);
    } catch (error) {
      log(`[bili] 记录兴趣失败：${error?.message ?? error}`);
    }
  }

  function interestKeywords(limit = 5) {
    return interest.keywords.slice(0, Math.max(1, Number(limit) || 5)).map((k) => k.kw);
  }

  /** 随机挑 n 个喜好词条（按 count 加权，不重复）。推荐时一次用几个，可配。 */
  function interestSample(n = 3) {
    const list = interest.keywords.map((k) => ({ kw: String(k.kw || ''), weight: Math.max(1, Number(k.count) || 1) })).filter((k) => k.kw);
    const picked = [];
    const pool = [...list];
    const want = Math.min(Math.max(1, Number(n) || 3), pool.length);
    for (let i = 0; i < want; i += 1) {
      const total = pool.reduce((s, k) => s + k.weight, 0);
      let x = Math.random() * total;
      let idx = 0;
      for (; idx < pool.length; idx += 1) { x -= pool[idx].weight; if (x <= 0) break; }
      const hit = pool.splice(Math.min(idx, pool.length - 1), 1)[0];
      if (hit) picked.push(hit.kw);
    }
    return picked;
  }

  /** 完整列表（带次数与时间），给面板显示用。 */
  function interestItems() {
    return interest.keywords.map((k) => ({ kw: k.kw, count: Number(k.count || 0), lastAt: Number(k.lastAt || 0) }));
  }

  /**
   * 面板手动编辑喜好（2026-10-31 用户要求词条可编辑）：整体替换列表。
   * 同名词保留原来的 count/lastAt，手动新加的给 count 1；按 interestMax() 截断，避免存进去又被自动记录挤掉。
   * 不排序——用户自己排的顺序不该被一次保存打乱。
   */
  function setInterestKeywords(list) {
    if (!Array.isArray(list)) return interestItems();
    const prev = new Map(interest.keywords.map((k) => [k.kw, k]));
    const now = Date.now();
    const cap = interestMax();
    const seen = new Set();
    const next = [];
    for (const raw of list) {
      if (next.length >= cap) break;
      const kw = interestTags(raw, 1)[0] ?? '';
      if (kw.length === 0 || seen.has(kw)) continue;
      seen.add(kw);
      const old = prev.get(kw);
      next.push(old ? { kw, count: Number(old.count || 1), lastAt: Number(old.lastAt || now) } : { kw, count: 1, lastAt: now });
    }
    interest.keywords = next;
    try {
      writeJson(interestPath, interest);
    } catch (error) {
      log(`[bili] 保存喜好失败：${error?.message ?? error}`);
    }
    return interestItems();
  }

  // ---- 相关性：关键词命中标题 + 命中标签，标签权重更高 ----
  // B 站搜索本身按它自己的相关性排序（标题为主），冷门但标签对得上的视频常被压到后面。
  // 这里对候选再打一次分：标签命中比标题命中更值钱，且不按播放量过滤，冷门照样能上来。

  function relevanceScore(video, keyword, { tagWeight = 2, titleWeight = 1 } = {}) {
    const kw = String(keyword ?? '').trim().toLowerCase();
    if (!kw) return 0;
    const tokens = kw.split(/\s+/).filter(Boolean);
    const title = String(video?.title ?? '').toLowerCase();
    const tags = (Array.isArray(video?.tags) ? video.tags : []).map((t) => String(t).toLowerCase());
    let score = 0;
    for (const t of tokens) {
      if (title.includes(t)) score += titleWeight;
      if (tags.some((tag) => tag === t)) score += tagWeight * 1.5;
      else if (tags.some((tag) => tag.includes(t) || t.includes(tag))) score += tagWeight;
    }
    return score;
  }

  function tagsFor(bvid) {
    const hit = tagState.tags[bvid];
    if (hit && Array.isArray(hit.tags) && Date.now() - Number(hit.at || 0) < TAG_TTL_MS) return hit.tags;
    return null;
  }

  async function loadTags(video) {
    const cached = tagsFor(video.bvid);
    if (cached) return cached;
    const tags = await getClient().tags(video.bvid);
    tagState.tags[video.bvid] = { tags, at: Date.now() };
    const keys = Object.keys(tagState.tags);
    if (keys.length > TAG_CACHE_MAX) {
      keys
        .sort((a, b) => Number(tagState.tags[a].at || 0) - Number(tagState.tags[b].at || 0))
        .slice(0, keys.length - TAG_CACHE_MAX)
        .forEach((k) => delete tagState.tags[k]);
    }
    try {
      writeJson(tagsPath, tagState);
    } catch (error) {
      log(`[bili] 缓存标签失败：${error?.message ?? error}`);
    }
    return tags;
  }

  /** 给候选补标签，只补前 limit 个（每个视频一个请求，靠 token bucket 自动排队）。 */
  async function attachTags(videos, limit = 8) {
    const out = videos.map((v) => ({ ...v }));
    const n = Math.min(out.length, Math.max(0, Number(limit) || 0));
    await Promise.all(
      out.slice(0, n).map(async (v, i) => {
        try {
          out[i].tags = await loadTags(v);
        } catch {
          out[i].tags = tagsFor(v.bvid) || [];
        }
      }),
    );
    return out;
  }

  /** 搜索结果按「标题 + 标签」重排；tagWeight 设 0 就退回 B 站原顺序。 */
  async function rankByRelevance(videos, keyword, { limit } = {}) {
    if (!Array.isArray(videos) || videos.length === 0) return videos ?? [];
    const rel = biliCfg().relevance ?? {};
    const tagWeight = Number(rel.tagWeight ?? 2);
    const titleWeight = Number(rel.titleWeight ?? 1);
    if (!(tagWeight > 0) || !String(keyword ?? '').trim()) return videos;
    const enriched = await attachTags(videos, limit ?? rel.tagFetchLimit ?? 8);
    const scored = enriched.map((v, i) => ({ v, i, s: relevanceScore(v, keyword, { tagWeight, titleWeight }) }));
    scored.sort((a, b) => b.s - a.s || a.i - b.i);
    const top = scored[0]?.s ?? 0;
    if (top > 0) {
      log(`[bili] 相关性重排「${String(keyword).slice(0, 20)}」：${scored.map((x) => x.s).join('/')}`);
    }
    return scored.map((x) => x.v);
  }

  // ---- 取数 ----

  async function feed({ mode = 'hot', limit = 20, keyword = '', rid = 0 } = {}) {
    const c = getClient();
    if (mode === 'search') return rankByRelevance(await c.search(keyword, limit), keyword);
    if (mode === 'ranking') return c.ranking(limit, rid);
    if (mode === 'recommend') {
      const rows = await c.recommend(limit, { freshIdx: 1 + Math.floor(Math.random() * 5) });
      if (rows.length > 0) return rows;
      // 没登录 / 推荐流为空时退回热门，别让自动分享停摆。
      return c.hot(limit);
    }
    if (mode === 'interest') {
      const kws = interestSample(Math.max(1, Number(biliCfg().interest?.pickCount) || 3));
      if (kws.length === 0) return c.hot(limit);
      // 一次随机挑几个词条分别检索，合并去重后打乱（2026-11-05 用户要求）。
      const settled = await Promise.allSettled(kws.map(async (kw) => {
        // 同一个词随机翻到第 1~3 页：只看第一页的话，前十条推完这一路就空了。
        const page = 1 + Math.floor(Math.random() * 3);
        try {
          return await rankByRelevance(await c.search(kw, limit, page), kw);
        } catch (err) {
          if (err?.code === 'BILIBILI_RISK_CONTROL') return [];
          throw err;
        }
      }));
      const merged = [];
      const seen = new Set();
      for (const item of settled) {
        if (item.status !== 'fulfilled') continue;
        for (const v of item.value) {
          const id = v?.bvid || v?.aid;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          merged.push(v);
        }
      }
      return merged.length > 0 ? shuffle(merged).slice(0, limit) : c.hot(limit);
    }
    if (mode === 'mixed') return mixedFeed({ limit, weights: biliCfg().mixWeights });
    return c.hot(limit);
  }

  /** 并行混合流：热门 / 推荐 / 喜好 / 排行榜 各取一部分，按权重配比后再打乱。 */
  async function mixedFeed({ limit = 20, weights } = {}) {
    const c = getClient();
    const want = Math.max(1, Number(limit) || 20);
    const raw = weights && typeof weights === 'object' ? weights : {};
    const pick = (name, fallback) => {
      const n = Number(raw[name]);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const w = {
      recommend: pick('recommend', 35),
      interest: pick('interest', 35),
      hot: pick('hot', 20),
      ranking: pick('ranking', 10),
    };
    const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
    const kws = interestKeywords(3);
    const tasks = [
      ['hot', () => c.hot(want)],
      ['recommend', async () => c.recommend(want, { freshIdx: 1 + Math.floor(Math.random() * 5) })],
      ['interest', async () => {
        if (kws.length === 0) return [];
        const kw = kws[Math.floor(Math.random() * kws.length)];
        const page = 1 + Math.floor(Math.random() * 3);
        try {
          return await rankByRelevance(await c.search(kw, want, page), kw);
        } catch (error) {
          if (error?.code === 'BILIBILI_RISK_CONTROL') return [];
          throw error;
        }
      }],
      ['ranking', () => c.ranking(want)],
    ];
    const settled = await Promise.allSettled(tasks.map(async ([name, fn]) => [name, await fn()]));
    const seen = new Set();
    const picked = [];
    let weightTotal = Object.entries(w).reduce((a, [, v]) => a + v, 0);
    for (const [name] of tasks) {
      const hit = settled.find((s) => s.status === 'fulfilled' && s.value?.[0] === name);
      const list = hit?.status === 'fulfilled' ? hit.value[1] : [];
      const share = weightTotal > 0 ? w[name] / total : 1 / tasks.length;
      const quota = Math.max(1, Math.round(want * share));
      let taken = 0;
      for (const v of shuffle(list)) {
        if (taken >= quota) break;
        const id = v?.bvid || v?.aid;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        picked.push(v);
        taken += 1;
      }
    }
    // 配额没凑够就用剩下的补
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      for (const v of shuffle(s.value?.[1] ?? [])) {
        if (picked.length >= want) break;
        const id = v?.bvid || v?.aid;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        picked.push(v);
      }
    }
    return shuffle(picked).slice(0, want);
  }

  function shuffle(list) {
    const arr = [...(Array.isArray(list) ? list : [])];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async function find(query, { limit = 8, bvid = '', recordInterest: rememberQuery = true } = {}) {
    const c = getClient();
    const idRef = String(bvid || '').trim();
    if (idRef) {
      const v = await c.video(idRef);
      return { videos: [v], mode: 'video' };
    }
    const kw = String(query || '').trim();
    if (!kw) throw new BiliError('BILIBILI_BAD_ARGUMENT', '要么给关键词，要么给视频号/链接');
    if (rememberQuery) recordInterest(kw);
    const videos = await rankByRelevance(await c.search(kw, limit), kw);
    return { videos, mode: 'search' };
  }

  // ---- 分享文本 ----

  function coverUrl(video) {
    return String(video?.pic || '').trim();
  }

  function titleText(video) {
    const t = String(video?.title || '').trim();
    return t.length > 60 ? t.slice(0, 59) + '…' : t;
  }

  /** 信息块：只有标题 / 链接 / BV 号（封面单独作为图片发出去）。 */
  function infoText(video) {
    const lines = [];
    const title = titleText(video);
    if (title) lines.push(title);
    const url = String(video?.url || (video?.bvid ? `https://www.bilibili.com/video/${video.bvid}` : '')).trim();
    if (url) lines.push(url);
    if (video?.bvid) lines.push(String(video.bvid));
    return lines.join('\n');
  }

  // 自动分享前那句引入：一句，角色口吻，但必须沾一点这条视频的内容。
  // 场景不同的引入不一样：
  //   · 定时/随机推荐 → 用这里的模板，并把视频的话题填进去（面板可配固定引入语覆盖）
  //   · 用户点名让你找 → agent 先正常回一句，再发视频，不走这里
  //   · 上下文顺手推 → 同上，agent 自己接那句话
  const INTRO_TEMPLATES = [
    '刚刷到一条讲「{topic}」的，看着挺对味。',
    '诶，「{topic}」相关的，我顺手捞到一条。',
    '这个「{topic}」的视频我觉得你会喜欢。',
    '啊，「{topic}」这种我也会点进去，正好碰上了。',
    '刷着刷着撞见个「{topic}」，给你看看。',
    '「{topic}」——我刷到这个就想给你了。',
  ];
  const INTROS = [
    '看我刷到了什么视频~',
    '诶，刚好刷到这个。',
    '这个我觉得你会喜欢。',
    '啊，这个得给你看看。',
    '刚刷到个挺有意思的。',
    '顺手捞到个好东西。',
    '嗯……这个你可能会想看。',
    '刷着刷着撞见这个。',
  ];

  /** 从标题/标签里挑一个能当话题的短词，用来把引入句和视频缝在一起。 */
  function topicOf(video) {
    const clean = String(video?.title ?? '')
      .replace(/[【\[（(][^】\]）)]*[】\]）)]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // 歌名/MV 常把正题放在《》里，那个就是最好的话题。
    const book = clean.match(/《([^》]{2,20})》/);
    if (book) return book[1].trim();
    // 有些梗视频把标题写成「不 看 尾 巴 挑 战 💃」，空格是节奏不是分隔，直接摘掉。
    const dense = clean.replace(/\s/g, '').replace(/[《》]/g, '');
    const strip = (s) =>
      String(s)
        .replace(/^[「『【\[(（\s·•\-—~～⚡🎵♪!！]+/, '')
        .replace(/[」』】\])）\s·•\-—~～⚡🎵♪]+$/, '')
        .trim();
    const chunks = dense
      .split(/[，,。！？!?|｜/／:：·•—~～\-]+/)
      .map(strip)
      .filter((s) => s.length >= 2);
    // 标题通常把主话题放最前面，优先用第一个够长的片段。
    const heading = chunks.find((s) => s.length >= 2 && s.length <= 20) ?? chunks.sort((a, b) => b.length - a.length)[0] ?? '';
    const tags = Array.isArray(video?.tags)
      ? video.tags.map((t) => strip(t)).filter((t) => t.length >= 2 && t.length <= 10 && !/^\d+$/.test(t))
      : [];
    const pick = heading.length <= 20 ? heading : heading.slice(0, 16) + '…';
    return pick || tags[0] || '';
  }

  function autoIntro(video) {
    const topic = topicOf(video);
    if (topic) {
      const tpl = INTRO_TEMPLATES[Math.floor(Math.random() * INTRO_TEMPLATES.length)];
      return tpl.replace('{topic}', topic);
    }
    return INTROS[Math.floor(Math.random() * INTROS.length)];
  }

  function shareText(video, intro = '') {
    const head = String(intro ?? '').trim();
    const info = infoText(video);
    return head.length > 0 ? `${head}\n${info}` : info;
  }

  // ---- 登录 ----

  async function loginStart() {
    const qr = await createLoginQr({ timeoutMs: Number(biliCfg().timeoutMs) || 20000 });
    return qr;
  }

  async function loginPoll(qrcodeKey) {
    const result = await pollLogin(qrcodeKey, { timeoutMs: Number(biliCfg().timeoutMs) || 20000 });
    if (result.state === 'success' && result.credential) {
      saveCredential(stateDir, result.credential);
      getClient().setCredential(result.credential);
      log('[bili] B 站账号已登录，推荐流可用');
    }
    return result;
  }

  function logout() {
    const ok = clearCredential(stateDir);
    getClient().setCredential(null);
    return ok;
  }

  async function loginStatus() {
    const cred = readCredential(stateDir);
    if (!cred) return { loggedIn: false };
    const check = await verifyCredential(cred, { timeoutMs: Number(biliCfg().timeoutMs) || 20000 });
    if (!check.ok) return { loggedIn: false, stale: true, reason: check.reason };
    return { loggedIn: true, mid: check.mid, name: check.name, savedAt: cred.savedAt };
  }

  /** 把这次「看过」写进登录账号的 B 站历史记录；没登录或开关关掉就静默跳过。 */
  async function markWatched(video) {
    if (!video) return { skipped: true, reason: 'no-video' };
    if (biliCfg().recordHistory === false) return { skipped: true, reason: 'disabled' };
    const cred = readCredential(stateDir);
    if (!cred) return { skipped: true, reason: 'not-logged-in' };
    // 进度随便给个几十秒，像真的点开看了一会儿；不超过视频本身长度。
    const duration = Number(video.duration) || 3600;
    const progress = Math.max(5, Math.min(duration, 25 + Math.floor(Math.random() * 70)));
    try {
      const res = await getClient().reportWatch(video, { progress });
      if (res?.ok) log(`[bili] 已写入观看历史：${video.bvid || video.aid}（${progress}s）`);
      return res;
    } catch (error) {
      log(`[bili] 写观看历史失败：${error?.message ?? error}`);
      return { skipped: true, error: String(error?.message ?? error) };
    }
  }

  return {
    getClient,
    feed,
    find,
    coverUrl,
    infoText,
    autoIntro,
    shareText,
    titleText,
    describeVideo,
    remember,
    markWatched,
    sharedRecently,
    sharedTitleRecently,
    sharedTodayCount,
    recentShares,
    pickUnshared,
    normalizeFreshness,
    recordInterest,
    interestTags,
    interestMaxLen,
    interestKeywords,
    interestItems,
    setInterestKeywords,
    relevanceScore,
    rankByRelevance,
    tagsFor,
    loginStart,
    loginPoll,
    loginStatus,
    logout,
    statePath: sharedPath,
    interestPath,
  };
}
