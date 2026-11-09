// B 站扫码登录（二维码渲染复用 bili-qr.js，零依赖）。
//
// 流程（全程普通 HTTPS，不需要浏览器）：
//   1. passport.bilibili.com/x/passport-login/web/qrcode/generate → url + qrcode_key
//   2. 本地把 url 渲染成二维码 PNG（bili-qr.js）
//   3. .../qrcode/poll?qrcode_key=... 轮询：86101 未扫、86090 已扫待确认、0 成功、86038 过期
//   4. 成功后凭据主要在轮询响应的 Set-Cookie 里（`data.url` 那条是给别的域用的游戏票，
//      里面没有 SESSDATA —— 先读 cookie，再退回 url 参数）
import fs from 'node:fs';
import path from 'node:path';
import { BiliError, USER_AGENT } from './bili-client.js';
import { encode, toPng } from './bili-qr.js';

const PASSPORT = 'https://passport.bilibili.com';

export const QR_STATE = { SUCCESS: 0, EXPIRED: 86038, SCANNED: 86090, WAITING: 86101 };

export function credentialFile(stateDir) {
  return path.join(stateDir, 'bili-credential.json');
}

function cookieFromHeaders(setCookies, name) {
  for (const header of setCookies) {
    const [pair] = String(header).split(';');
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return '';
}

/** 拿不到 buvid3 时补一张指纹（非致命）。 */
async function ensureBuvid3(jar, timeoutMs = 15000) {
  if (jar.buvid3) return jar;
  try {
    const response = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json();
    const value = body?.data?.b_3;
    if (typeof value === 'string' && value.length > 0) jar.buvid3 = value;
  } catch {
    /* 拿不到就空着，不影响登录 */
  }
  return jar;
}

export async function credentialFromLoginUrl(loginUrl, refreshToken = '', setCookies = []) {
  let params = new URLSearchParams();
  try {
    params = new URL(loginUrl).searchParams;
  } catch {
    params = new URLSearchParams();
  }
  // Set-Cookie 优先：成功登录时的 SESSDATA 在 cookie 里，不在 data.url 里。
  const pick = (name) => {
    const fromCookie = cookieFromHeaders(setCookies, name);
    if (fromCookie.length > 0) return fromCookie;
    return params.get(name) ?? '';
  };
  const sessdata = pick('SESSDATA');
  if (sessdata.length === 0) return null;
  const credential = {
    sessdata,
    biliJct: pick('bili_jct'),
    dedeUserId: pick('DedeUserID'),
    buvid3: cookieFromHeaders(setCookies, 'buvid3'),
    refreshToken,
    savedAt: new Date().toISOString(),
  };
  if (credential.buvid3.length === 0) await ensureBuvid3(credential);
  return credential;
}

/** 生成登录二维码：返回 { qrcodeKey, url, png, width }。 */
export async function createLoginQr({ timeoutMs = 20000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(PASSPORT + '/x/passport-login/web/qrcode/generate', {
    headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.bilibili.com/' },
    signal: timeout,
  });
  const body = await response.json();
  if (Number(body?.code) !== 0) {
    throw new BiliError('BILIBILI_QR_UNAVAILABLE', '拿不到登录二维码：' + String(body?.message ?? body?.code));
  }
  const url = String(body.data?.url ?? '');
  const qrcodeKey = String(body.data?.qrcode_key ?? '');
  if (url.length === 0 || qrcodeKey.length === 0) {
    throw new BiliError('BILIBILI_QR_UNAVAILABLE', '二维码响应缺少 url 或 qrcode_key');
  }
  const matrix = encode(url);
  const png = await toPng(matrix, { scale: 8, quietZone: 4 });
  return { qrcodeKey, url, png: Buffer.from(png), width: (matrix.size + 8) * 8 };
}

/** 轮询一次扫码状态：{ state: 'waiting'|'scanned'|'expired'|'success', credential? } */
export async function pollLogin(qrcodeKey, { timeoutMs = 20000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const url =
    PASSPORT + '/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(qrcodeKey) + '&source=main-fe-header';
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.bilibili.com/' },
    signal: timeout,
  });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const body = await response.json();
  if (Number(body?.code) !== 0) {
    throw new BiliError('BILIBILI_QR_UNAVAILABLE', '扫码状态查询失败：' + String(body?.message ?? body?.code));
  }
  const state = Number(body.data?.code);
  if (state === QR_STATE.WAITING) return { state: 'waiting' };
  if (state === QR_STATE.SCANNED) return { state: 'scanned' };
  if (state === QR_STATE.EXPIRED) return { state: 'expired' };
  if (state === QR_STATE.SUCCESS) {
    const credential = credentialFromLoginUrl(String(body.data?.url ?? ''), String(body.data?.refresh_token ?? ''), setCookies);
    if (credential === null) {
      throw new BiliError('BILIBILI_QR_UNAVAILABLE', '登录成功但没拿到 SESSDATA（url 与 Set-Cookie 都是空的）');
    }
    return { state: 'success', credential };
  }
  return { state: 'waiting' };
}

export function saveCredential(stateDir, credential) {
  const target = credentialFile(stateDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(credential, null, 2));
  return target;
}

export function readCredential(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialFile(stateDir), 'utf8'));
    if (typeof parsed?.sessdata !== 'string' || parsed.sessdata.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearCredential(stateDir) {
  try {
    fs.rmSync(credentialFile(stateDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function credentialCookie(credential) {
  if (!credential?.sessdata) return '';
  const parts = ['SESSDATA=' + credential.sessdata];
  if (credential.biliJct) parts.push('bili_jct=' + credential.biliJct);
  if (credential.dedeUserId) parts.push('DedeUserID=' + credential.dedeUserId);
  // 带上登录时那张 buvid3，换设备/换 IP 时风控画像更稳定。
  if (credential.buvid3) parts.push('buvid3=' + credential.buvid3);
  return parts.join('; ');
}

/** 用 nav 接口验一下登录态还活着。 */
export async function verifyCredential(credential, { timeoutMs = 20000 } = {}) {
  const cookie = credentialCookie(credential);
  if (!cookie) return { ok: false, mid: 0, name: '', reason: '没有 SESSDATA' };
  try {
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://www.bilibili.com/',
        Cookie: cookie,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json();
    const code = Number(body?.code);
    if (code === 0 && Number(body?.data?.isLogin) === 1) {
      return { ok: true, mid: Number(body.data.mid ?? 0), name: String(body.data.uname ?? '') };
    }
    return { ok: false, mid: 0, name: '', reason: code === -101 ? '登录态已失效' : 'code ' + code };
  } catch (error) {
    return { ok: false, mid: 0, name: '', reason: 'network: ' + (error?.message ?? error) };
  }
}
