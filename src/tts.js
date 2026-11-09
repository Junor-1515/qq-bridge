import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

/**
 * TTS 引擎层（文字 → 音频）。
 *
 * 设计要点：
 * - 一个「音色」(voice) 就是一条记录：引擎 + 语言 + 参数。多模型 = 多条记录，
 *   因为 GPT-SoVITS 的模型是在服务启动时加载的，客户端切不了，只能一模型一端口。
 * - 合成结果落在语音库目录下的 tts/ 子目录（sendVoiceForV2 只允许发语音库内的文件），
 *   文件名用内容哈希，天然去重：同一句话同一个音色只合成一次。
 * - 目标语言是日语而原文是中文时，先过一层翻译（走 OpenAI 兼容接口），
 *   翻译结果也按哈希缓存，避免同一句反复烧 token。
 */

export const MOODS = ['calm', 'happy', 'sad', 'angry', 'shy', 'surprised'];
export const MOOD_LABELS = { calm: '平静', happy: '开心', sad: '难过', angry: '生气', shy: '撒娇', surprised: '惊讶' };

const MOOD_RULES = [
  ['angry', /气死|生气|烦死|讨厌|闭嘴|滚|无语|离谱|什么鬼|啧|不行|别闹|受不了/],
  ['sad', /难过|想哭|哭了|委屈|失落|难受|心疼|孤单|寂寞|唉|算了|抱抱|对不起|抱歉/],
  ['shy', /害羞|不好意思|脸红|撒娇|嘛|呀|啦|嘿嘿|诶嘿|哼|才不|才没/],
  ['happy', /开心|高兴|太好了|笑死|哈哈|啊哈|诶嘿|喜欢|好耶|棒|快乐|可爱|不错|赞/],
  ['surprised', /惊讶|真的假的|不会吧|天哪|居然|竟然|什么|欸|啊？|怎么会|吓/]
];

/** 假名判日语；没有假名就按中文。 */
export function detectLang(text) {
  const t = String(text ?? '');
  if (/[\u3040-\u30ff]/.test(t)) return 'ja';
  return 'zh';
}

export function classifyMood(text) {
  const t = String(text ?? '');
  for (const [mood, re] of MOOD_RULES) if (re.test(t)) return mood;
  return 'calm';
}

export function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function num(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max ?? n, Math.max(min ?? n, n));
}

function str(v, fallback = '') {
  return typeof v === 'string' ? v.trim() : (v == null ? fallback : String(v));
}

export function normalizeTtsConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ex = r.explicit && typeof r.explicit === 'object' ? r.explicit : {};
  const au = r.auto && typeof r.auto === 'object' ? r.auto : {};
  const voices = Array.isArray(r.voices) ? r.voices : [];
  const refAudios = Array.isArray(r.refAudios) ? r.refAudios : [];
  const cfg = {
    enabled: r.enabled !== false,
    engine: ['sovits', 'edge', 'sapi'].includes(r.engine) ? r.engine : (voices[0]?.engine ?? 'sapi'),
    translate: {
      enabled: r.translate?.enabled !== false,
      baseUrl: str(r.translate?.baseUrl, 'https://model.jsnu.edu.cn/v1'),
      model: str(r.translate?.model, 'deepseek-v4-flash'),
      apiKeyEnv: str(r.translate?.apiKeyEnv, 'JSNU_API_KEY'),
      apiKey: str(r.translate?.apiKey, ''),
      temperature: num(r.translate?.temperature, 0.8, 0, 2),
      maxTokens: num(r.translate?.maxTokens, 1500, 32, 4000),
      // jsnu 这类网关默认按 high 思考，翻一句日常口语要 5~6 秒；降到 low 实测 3 秒上下。
      // 置空字符串表示不发送这个字段（给不认它的 OpenAI 兼容端点用）。
      reasoningEffort: r.translate?.reasoningEffort === undefined ? 'low' : str(r.translate.reasoningEffort, ''),
      // 有的端点不认 Authorization: Bearer，要用自定义头（deepseek 官方就是这个 x-dsh-auth-token）。
      authHeader: str(r.translate?.authHeader, 'authorization'),
      authPrefix: r.translate?.authPrefix === undefined ? 'Bearer ' : str(r.translate.authPrefix, ''),
      // 密钥也可以直接从凭据文件里按正则抠一行，省得把 token 抄进 config。
      apiKeyFile: str(r.translate?.apiKeyFile, ''),
      apiKeyLine: str(r.translate?.apiKeyLine, '^\\s*token:\\s*(\\S+)'),
      timeoutMs: num(r.translate?.timeoutMs, 20000, 2000, 120000)
    },
    explicit: {
      enabled: ex.enabled !== false,
      maxChars: num(ex.maxChars, 300, 8, 2000),
      // 点名朗读要求「先说一句再念」（2026-11-01 用户要求，跟 bili 分享同一条规矩）：
      // 这个毫秒窗口内这个会话没发过普通文字消息，qq_speak 就直接打回。0 = 不检查。
      leadInMs: num(ex.leadInMs, 90000, 0, 600000)
    },
    auto: {
      enabled: au.enabled !== false,
      minSegments: num(au.minSegments, 8, 1, 200),
      maxSegments: num(au.maxSegments, 12, 1, 200),
      probability: num(au.probability, 0.6, 0, 1),
      minChars: num(au.minChars, 4, 1, 200),
      maxChars: num(au.maxChars, 200, 10, 2000),
      maxPerDay: num(au.maxPerDay, 40, 0, 500),
      minGapMs: num(au.minGapMs, 60000, 0, 3600000),
      // 自动语音默认读哪种语言：'' = 跟当前音色自己的语言（默认，行为不变）；
      // 'zh' / 'ja' = 固定这种，跟音色语言不一样时先把文字翻过去再念。
      // 只影响功能二；功能一的 qq_speak 仍按 lang 参数临时指定。
      lang: ['zh', 'ja'].includes(au.lang) ? au.lang : ''
    },
    // 点名朗读时用户可以临时指定读哪种语言（「用日语读」/「用中文读」）：
    // 这里配「这种语言用哪个音色」，不配就按音色自己的 lang 找第一个匹配的。
    langVoices: {
      ja: str(r.langVoices?.ja, ''),
      zh: str(r.langVoices?.zh, '')
    },
    voices: voices.map((v, i) => ({
      id: str(v.id, 'voice' + (i + 1)),
      label: str(v.label, v.id || ('音色' + (i + 1))),
      engine: ['sovits', 'edge', 'sapi'].includes(v.engine) ? v.engine : 'sovits',
      lang: ['zh', 'ja', 'auto'].includes(v.lang) ? v.lang : 'zh',
      baseUrl: str(v.baseUrl, 'http://127.0.0.1:9880'),
      apiFlavor: v.apiFlavor === 'v1' ? 'v1' : 'v2',
      promptText: str(v.promptText, ''),
      promptLang: ['zh', 'ja', 'en'].includes(v.promptLang) ? v.promptLang : 'zh',
      topK: num(v.topK, 5, 1, 100),
      topP: num(v.topP, 1, 0.05, 1),
      temperature: num(v.temperature, 1, 0.05, 2),
      speed: num(v.speed, 1, 0.5, 2),
      refAudio: str(v.refAudio, ''),
      edgeVoice: str(v.edgeVoice, 'zh-CN-XiaoxiaoNeural'),
      sapiVoice: str(v.sapiVoice, ''),
      sapiRate: num(v.sapiRate, 0, -10, 10)
    })),
    refAudios: refAudios.map((a, i) => ({
      id: str(a.id, 'ref' + (i + 1)),
      file: str(a.file, ''),
      note: str(a.note, ''),
      promptText: str(a.promptText, ''),
      lang: ['zh', 'ja'].includes(a.lang) ? a.lang : 'zh',
      moods: Array.isArray(a.moods) ? a.moods.filter((m) => MOODS.includes(m)) : [],
      // 可空：填了就只给这几个音色用，免得不同模型（音色）串着用参考音频跑调
      voices: Array.isArray(a.voices) ? a.voices.map((x) => str(x, '')).filter(Boolean) : []
    })),
    // 清理与自动拉起这两块以前不在归一化里，被设置页保存一次就从 config.json 里消失了
    // （用户 2026-10-31 发现：autostart 保存后静默失效）。这里显式保留。
    cleanup: {
      enabled: r.cleanup?.enabled !== false,
      maxAgeDays: num(r.cleanup?.maxAgeDays, 7, 0, 3650),
      maxBytesMb: num(r.cleanup?.maxBytesMb, 500, 0, 1048576),
      cacheMaxAgeDays: num(r.cleanup?.cacheMaxAgeDays, 7, 0, 3650),
      intervalMs: num(r.cleanup?.intervalMs, 3600000, 60000, 86400000)
    },
    autostart: {
      enabled: r.autostart?.enabled !== false,
      scripts: r.autostart?.scripts && typeof r.autostart.scripts === 'object' ? { ...r.autostart.scripts } : {},
      intervalMs: num(r.autostart?.intervalMs, 300000, 30000, 3600000),
      cooldownMs: num(r.autostart?.cooldownMs, 600000, 60000, 86400000)
    },
    activeVoice: str(r.activeVoice, ''),
    overrides: r.overrides && typeof r.overrides === 'object' ? r.overrides : {}
  };
  // 音色 id 必须唯一：重复 id 会让 voiceById 只认第一个，另一个永远调不到；
  // 也会让看护把两份 baseUrl 都算成「在用」（用户 2026-11-01 遇到过 9880 被莫名拉起）。
  const seenIds = new Set();
  for (const v of cfg.voices) {
    const base = v.id;
    let n = 2;
    while (seenIds.has(v.id)) v.id = base + '-' + n++;
    seenIds.add(v.id);
  }
  if (!cfg.activeVoice && cfg.voices[0]) cfg.activeVoice = cfg.voices[0].id;
  if (cfg.activeVoice && !cfg.voices.some((v) => v.id === cfg.activeVoice) && cfg.voices[0]) {
    cfg.activeVoice = cfg.voices[0].id;
  }
  return cfg;
}

/** 会话覆盖：group:/private: 的键优先，其次是 '*' 通配。 */
export function resolveTtsFor(key, cfg) {
  const base = normalizeTtsConfig(cfg);
  const o = base.overrides?.[key] ?? base.overrides?.['*'] ?? null;
  if (!o || typeof o !== 'object') return base;
  const merged = JSON.parse(JSON.stringify(base));
  if (o.enabled === false) merged.enabled = false;
  if (o.enabled === true) merged.enabled = true;
  if (typeof o.activeVoice === 'string' && o.activeVoice) merged.activeVoice = o.activeVoice;
  if (o.langVoices && typeof o.langVoices === 'object') {
    for (const l of ['ja', 'zh']) if (l in o.langVoices) merged.langVoices[l] = str(o.langVoices[l], '');
  }
  if (o.explicit && typeof o.explicit === 'object') {
    if ('enabled' in o.explicit) merged.explicit.enabled = o.explicit.enabled === true;
    if ('maxChars' in o.explicit) merged.explicit.maxChars = num(o.explicit.maxChars, merged.explicit.maxChars, 8, 2000);
    if ('leadInMs' in o.explicit) merged.explicit.leadInMs = num(o.explicit.leadInMs, merged.explicit.leadInMs, 0, 600000);
  }
  if (o.auto && typeof o.auto === 'object') {
    for (const k of ['minSegments', 'maxSegments', 'minChars', 'maxChars', 'maxPerDay', 'minGapMs']) {
      if (k in o.auto) merged.auto[k] = num(o.auto[k], merged.auto[k], 0, 3600000);
    }
    if ('probability' in o.auto) merged.auto.probability = num(o.auto.probability, merged.auto.probability, 0, 1);
    if ('enabled' in o.auto) merged.auto.enabled = o.auto.enabled === true;
    if ('lang' in o.auto) merged.auto.lang = ['zh', 'ja'].includes(o.auto.lang) ? o.auto.lang : '';
  }
  return merged;
}

function readFileKey(file, envName) {
  if (!file) return '';
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      if (t.slice(0, eq).trim() === envName) return t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  return '';
}

function readYamlKey(yamlPath, envName) {
  try {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const out = {};
    let inRefs = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*refs:\s*$/.test(line)) { inRefs = true; continue; }
      if (inRefs && /^\S/.test(line)) inRefs = false;
      if (!inRefs) continue;
      const kv = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(.+?)\s*$/);
      if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
    return out[envName] || '';
  } catch {}
  return '';
}

export function resolveApiKey(apiKeyEnv, inlineKey, extra = {}) {
  if (inlineKey) return inlineKey;
  if (extra.file) {
    try {
      const m = new RegExp(extra.lineRe || '^\\s*token:\\s*(\\S+)', 'm').exec(fs.readFileSync(extra.file, 'utf8'));
      if (m && m[1]) return m[1];
    } catch {}
  }
  if (process.env[apiKeyEnv]) return process.env[apiKeyEnv];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  for (const c of [path.join(home, '.dsh', '.credentials.yaml'), path.join(home, '.dsh', 'credentials.yaml')]) {
    const k = readYamlKey(c, apiKeyEnv);
    if (k) return k;
  }
  return readFileKey(path.join(home, '.dsh', '.env'), apiKeyEnv) || '';
}

function run(cmd, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** 挑参考音频：先按「适用的音色」（refAudios[].voices，空=通用），再在同语言里按情绪，最后退回音色自带的。 */
export function selectRefAudio(cfg, voice, mood) {
  if (!voice) return null;
  const pool = (cfg.refAudios || []).filter((a) => a.file && (!a.voices || !a.voices.length || a.voices.includes(voice.id)));
  const lang = voice.lang === 'auto' ? 'zh' : voice.lang;
  const sameLang = pool.filter((a) => a.lang === lang);
  return sameLang.find((a) => a.moods.includes(mood)) || sameLang.find((a) => a.moods.length === 0) || sameLang[0] || null;
}

export function createTtsService({ root, stateDir, audioDir, getTtsConfig, log = () => {} }) {
  const cacheDir = path.join(stateDir, 'tts-cache');
  const outDir = path.join(audioDir, 'tts');
  const refDir = path.join(outDir, 'refs');
  for (const d of [cacheDir, outDir, refDir]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }

  function cfgOf() {
    return normalizeTtsConfig(getTtsConfig());
  }

  function voiceById(cfg, id) {
    const want = id || cfg.activeVoice;
    return cfg.voices.find((v) => v.id === want) || cfg.voices[0] || null;
  }

  // 把一句中文/日语翻成另一种语言再读。target 是「要读出来的语言」。
  async function translateTo(text, target, cfg) {
    const tr = cfg.translate;
    const toJa = target !== 'zh';
    if (tr.enabled === false) throw new Error('翻译功能已关闭（tts.translate.enabled=false），无法把' + (toJa ? '中文转成日语' : '日语转成中文'));
    const key = resolveApiKey(tr.apiKeyEnv, tr.apiKey, { file: tr.apiKeyFile, lineRe: tr.apiKeyLine });
    if (!key) throw new Error('缺少翻译接口的密钥（' + tr.apiKeyEnv + '），可在 config.json 的 tts.translate.apiKey 直接填，或设置同名环境变量');
    const cacheFile = path.join(cacheDir, 'tr-' + sha1('tr3|' + tr.model + '|' + target + '|' + text) + '.json');
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached && cached.text) return cached.text;
    } catch {}
    const sys = (toJa ? [
      '你是把中文口语翻成自然日语口语的翻译。要求：',
      '1. 只输出译文本身，不要解释、不要引号、不要罗马音。',
      '2. 用朋友之间聊天的タメ口，绝对不要敬语（です・ます・ございます）。',
      '3. 保留说话人的语气：撒娇、吐槽、玩笑、犹豫都要在日语里体现出来（ね・よ・じゃん・かな・って 这类语气词该用就用）。',
      '4. 保留表情与颜文字的位置，但不要翻译它们。',
      '5. 不要补充原文没有的信息。',
      '6. 人名读音：「晓山瑞希」「暁山瑞希」读作 あきやま みずき，必须写成「暁山みずき」（平假名写死，避免被读错），不要写成 みつき；网名 Amia 保留原文不译；其他人名拿不准就用平假名注音。'
    ] : [
      '你是把日语口语翻成自然中文口语的翻译。要求：',
      '1. 只输出译文本身，不要解释、不要引号。',
      '2. 用朋友之间聊天的口气，不要书面语、不要敬语腔。',
      '3. 保留说话人的语气：撒娇、吐槽、玩笑、犹豫都要在中文里体现出来（啊、嘛、诶、啦、啧 这类该用就用）。',
      '4. 保留表情与颜文字的位置，但不要翻译它们。',
      '5. 不要补充原文没有的信息。',
      '6. 人名：「暁山みずき」「暁山瑞希」译成「晓山瑞希」。'
    ]).join('\n');
    // 模型开了推理档时，reasoning token 也算进 max_tokens：400 够翻译，但长句会被推理吃掉
    // 一整份预算，最后 finish_reason=length、content 为空。所以第一次不够就加预算再试一次。
    let askTokens = tr.maxTokens;
    const body = {
      model: tr.model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
      temperature: tr.temperature,
      max_tokens: askTokens,
      stream: false
    };
    if (tr.reasoningEffort) body.reasoning_effort = tr.reasoningEffort;
    const res = await fetch(tr.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [tr.authHeader]: (tr.authPrefix + key).trim() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(tr.timeoutMs)
    });
    const raw = await res.text();
    if (!res.ok) throw new Error('翻译接口 ' + res.status + '：' + raw.slice(0, 200));
    let data = {};
    try { data = JSON.parse(raw); } catch { throw new Error('翻译接口返回的不是 JSON：' + raw.slice(0, 120)); }
    let out = String(data.choices?.[0]?.message?.content ?? '').trim().replace(/^["'「『]|["'」』]$/g, '').trim();
    if (!out) {
      // 多半是推理吃掉预算（finish_reason=length）：加预算重试一次，别让整条语音就这么失败。
      askTokens = Math.max(askTokens * 3, 1600);
      log('[tts] 翻译返回空（finish_reason=' + (data.choices?.[0]?.finish_reason ?? '?') + '），把 max_tokens 提到 ' + askTokens + ' 重试');
      const res2 = await fetch(tr.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [tr.authHeader]: (tr.authPrefix + key).trim() },
        body: JSON.stringify({ ...body, max_tokens: askTokens }),
        signal: AbortSignal.timeout(tr.timeoutMs)
      });
      const raw2 = await res2.text();
      if (!res2.ok) throw new Error('翻译接口 ' + res2.status + '：' + raw2.slice(0, 200));
      try { data = JSON.parse(raw2); } catch { throw new Error('翻译接口返回的不是 JSON：' + raw2.slice(0, 120)); }
      out = String(data.choices?.[0]?.message?.content ?? '').trim().replace(/^["'「『]|["'」』]$/g, '').trim();
      if (!out) throw new Error('翻译接口返回了空文本（finish_reason=' + (data.choices?.[0]?.finish_reason ?? '?') + '）');
    }
    try { fs.writeFileSync(cacheFile, JSON.stringify({ text: out, at: Date.now(), src: text }), 'utf8'); } catch {}
    log('[tts] 翻译 ' + text.slice(0, 20) + ' → ' + out.slice(0, 20));
    return out;
  }

  async function sovitsSynth(text, voice, outPath, cfg, mood = '', textLang = '') {
    const base = (voice.baseUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '');
    // mood 由调用方给（自动语音按原文判过），没给才按要读的文字现判；
    // 注意文字可能已被翻成日语，中文情绪词会判不出来，所以优先用原文的 mood。
    const ref = selectRefAudio(cfg, voice, mood || classifyMood(text));
    const refPath = ref?.file ? path.resolve(root, ref.file) : (voice.refAudio ? path.resolve(root, voice.refAudio) : '');
    if (!refPath) throw new Error('SoVITS 需要参考音频：给这个音色配一条参考音频，或在参考音频库里加一条');
    const params = {
      text,
      // 念什么语言看的是这段文字本身（可能被翻译过），不是音色记录的默认语言；
      // 参考音频那边仍按音色自己的 promptLang —— 音色模型不变。
      text_lang: textLang || (voice.lang === 'auto' ? detectLang(text) : voice.lang),
      ref_audio_path: refPath,
      prompt_text: ref?.promptText || voice.promptText || '',
      prompt_lang: voice.promptLang,
      top_k: voice.topK,
      top_p: voice.topP,
      temperature: voice.temperature,
      speed_factor: voice.speed,
      text_split_method: 'cut5',
      batch_size: 1,
      media_type: 'wav',
      streaming_mode: false
    };
    let res;
    if (voice.apiFlavor === 'v1') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
      res = await fetch(base + '/tts?' + qs.toString(), { signal: AbortSignal.timeout(120000) });
    } else {
      res = await fetch(base + '/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(120000)
      });
      if (res.status === 404 || res.status === 405) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
        res = await fetch(base + '/tts?' + qs.toString(), { signal: AbortSignal.timeout(120000) });
      }
    }
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error('SoVITS ' + res.status + '：' + (msg.slice(0, 200) || '（无内容，服务是不是没开？' + base + '）'));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error('SoVITS 返回的音频太小（' + buf.length + ' 字节），多半是服务报错了');
    fs.writeFileSync(outPath, buf);
    return { engine: 'sovits', refAudio: refPath };
  }

  async function sapiSynth(text, voice, outPath) {
    const inFile = path.join(cacheDir, 'sapi-' + sha1(text) + '.txt');
    const ps1 = path.join(cacheDir, 'sapi-say.ps1');
    fs.writeFileSync(inFile, text, 'utf8');
    const script = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Speech',
      '$t = Get-Content -Raw -Encoding UTF8 -LiteralPath $args[0]',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      'if ($args[2]) { try { $s.SelectVoice($args[2]) } catch { } }',
      '$rate = 0',
      'try { $rate = [int]$args[3] } catch { }',
      '$s.Rate = $rate',
      '$s.SetOutputToWaveFile($args[1])',
      '$s.Speak($t)',
      '$s.Dispose()',
      'Write-Output "OK"'
    ].join('\r\n');
    if (!fs.existsSync(ps1)) fs.writeFileSync(ps1, script, 'utf8');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, inFile, outPath, voice.sapiVoice || '', String(voice.sapiRate)];
    const r = await run('powershell', args, { timeoutMs: 120000 });
    if (r.code !== 0 || !fs.existsSync(outPath)) {
      throw new Error('Windows 语音合成失败（没装对应语言的语音包？）：' + (r.stderr || r.stdout || 'exit ' + r.code).slice(0, 200));
    }
    return { engine: 'sapi' };
  }

  async function edgeSynth(text, voice, outPath) {
    const args = ['--voice', voice.edgeVoice, '--text', text, '--write-media', outPath];
    let r = await run('edge-tts', args, { timeoutMs: 120000 });
    if (r.code !== 0) {
      const py = await run('python', ['-m', 'edge_tts', ...args], { timeoutMs: 120000 });
      if (py.code !== 0) {
        throw new Error('edge-tts 不可用（没装或没联网）：' + (py.stderr || r.stderr || '').slice(0, 200) + '；安装：pip install edge-tts');
      }
      r = py;
    }
    if (!fs.existsSync(outPath)) throw new Error('edge-tts 没有产出音频文件');
    return { engine: 'edge' };
  }

  /** 合成一句话，返回可发送的音频（rel 相对语音库目录）。 */
  async function synthesize(text, { key = '', voiceId = '', mood = '', lang: wantLangOverride = '', force = false } = {}) {
    const cfg = key ? resolveTtsFor(key, getTtsConfig()) : cfgOf();
    if (!cfg.enabled) throw new Error('TTS 已关闭（tts.enabled=false）');
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('要读的文字是空的');
    const override = ['zh', 'ja'].includes(String(wantLangOverride)) ? String(wantLangOverride) : '';
    let voice = voiceById(cfg, voiceId);
    if (!voice) throw new Error('没有可用音色：先在控制台「语音」页加一个（SoVITS 或 Windows 语音）');
    // 用户说「用日语读」/「用中文读」：不换音色、不换模型，只把文字换成那种语言再念
    // （2026-11-01 用户要求）。音色只管音色，语言只管文本。
    const wantLang = override || (voice.lang === 'auto' ? detectLang(clean) : voice.lang);
    const srcLang = detectLang(clean);
    let spoken = clean;
    let translated = false;
    if (wantLang !== srcLang) {
      spoken = await translateTo(clean, wantLang, cfg);
      translated = true;
    }
    const moodPick = mood || classifyMood(clean);
    const ext = voice.engine === 'edge' ? 'mp3' : 'wav';
    const hash = sha1([voice.engine, voice.id, wantLang, moodPick, spoken].join('|')).slice(0, 24);
    const outPath = path.join(outDir, hash + '.' + ext);
    const rel = 'tts/' + hash + '.' + ext;
    if (!force && fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
      return { file: outPath, rel, engine: voice.engine, voiceId: voice.id, lang: wantLang, text: clean, spoken, translated, cached: true };
    }
    const tmp = outPath + '.part';
    let info;
    if (voice.engine === 'sovits') info = await sovitsSynth(spoken, voice, tmp, cfg, moodPick, wantLang);
    else if (voice.engine === 'edge') info = await edgeSynth(spoken, voice, tmp);
    else info = await sapiSynth(spoken, voice, tmp);
    fs.renameSync(tmp, outPath);
    log('[tts] 合成完成 ' + voice.id + '/' + voice.engine + ' ' + clean.length + ' 字 → ' + path.basename(outPath));
    return { file: outPath, rel, engine: voice.engine, voiceId: voice.id, lang: wantLang, text: clean, spoken, translated, cached: false, ...info };
  }

  async function testVoice(voiceId) {
    const cfg = cfgOf();
    const voice = voiceById(cfg, voiceId);
    if (!voice) throw new Error('音色不存在：' + (voiceId || '(空)'));
    const sample = voice.lang === 'ja' ? 'こんにちは、テストです。' : '你好，这是一条测试语音。';
    const r = await synthesize(sample, { voiceId: voice.id, force: true });
    return { ...r, sample };
  }

  return { cfgOf, resolveTtsFor, synthesize, translateTo, testVoice, voiceById, cacheDir, outDir, refDir };
}
