import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { ServiceError } from './errors.js';
const cookieName = 'sublink_session';
const accountKey = 'admin:account:v1';
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
export async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))); }
export function randomToken() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
export function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
export function sameOrigin(c) { return c.req.header('Origin') === new URL(c.req.url).origin; }
async function readAccount(runtime) {
    const raw = await runtime.kv.get(accountKey);
    // The environment credential bootstraps existing installations until the owner first signs in.
    return { raw, account: raw ? JSON.parse(raw) : { username: 'admin', password: { algorithm: 'sha256', hash: runtime.config.adminPasswordHash }, version: runtime.config.adminPasswordHash } };
}
async function derive(password, salt, iterations) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations, salt: Uint8Array.from(salt.match(/../g), part => parseInt(part, 16)) }, key, 256));
}
async function passwordRecord(password) {
    const salt = hex(crypto.getRandomValues(new Uint8Array(16))), iterations = 600000;
    return { algorithm: 'pbkdf2-sha256', salt, iterations, hash: await derive(password, salt, iterations) };
}
async function matches(password, record) {
    if (typeof password !== 'string' || !password || password.length > 256) return false;
    return safeEqual(record.algorithm === 'sha256' ? await digest(password) : await derive(password, record.salt, record.iterations), record.hash);
}
async function issueSession(c, runtime, version) {
    const old = getCookie(c, cookieName), token = randomToken();
    await runtime.kv.put('admin:session:' + await digest(token), version, { expirationTtl: 86400 });
    setCookie(c, cookieName, token, { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Strict', path: '/', maxAge: 86400 });
    if (old) await runtime.kv.delete('admin:session:' + await digest(old));
}
export async function authenticated(c, runtime) {
    const token = getCookie(c, cookieName);
    if (!runtime.config.adminPasswordHash || !token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const { account } = await readAccount(runtime);
    return await runtime.kv.get('admin:session:' + await digest(token)) === account.version;
}
export async function accountInfo(runtime) { return { username: (await readAccount(runtime)).account.username }; }
async function attemptState(c, runtime) {
    const ip = c.req.header('x-real-ip') || c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
    const key = 'admin:login-attempt:' + await digest(ip);
    const raw = await runtime.kv.get(key), saved = raw ? JSON.parse(raw) : null;
    return { key, raw, count: saved?.until > Date.now() ? saved.count : 0, until: saved?.until > Date.now() ? saved.until : Date.now() + 900000 };
}
export async function login(c, runtime, username, password) {
    const attempts = await attemptState(c, runtime);
    if (attempts.count >= 10) throw new ServiceError('登录尝试过多，请 15 分钟后重试', 429);
    let { raw, account } = await readAccount(runtime);
    if (!safeEqual(username, account.username) || !await matches(password, account.password)) {
        // Atomic counters prevent concurrent guesses from resetting the failure count.
        for (let i = 0; i < 5; i++) {
            const state = i ? await attemptState(c, runtime) : attempts;
            if (await runtime.kv.compareAndSet(state.key, state.raw, JSON.stringify({ count: state.count + 1, until: state.until }))) break;
        }
        return false;
    }
    if (!raw) {
        const next = { username: account.username, password: await passwordRecord(password), version: randomToken() };
        if (await runtime.kv.compareAndSet(accountKey, null, JSON.stringify(next))) account = next;
        else {
            account = (await readAccount(runtime)).account;
            if (!safeEqual(username, account.username) || !await matches(password, account.password)) return false;
        }
    }
    const state = await attemptState(c, runtime);
    await runtime.kv.compareAndSet(state.key, state.raw, JSON.stringify({ count: 0, until: Date.now() + 900000 }));
    await issueSession(c, runtime, account.version);
    return true;
}
export async function changeAccount(c, runtime, value) {
    const { raw, account } = await readAccount(runtime);
    const { currentPassword, newPassword, confirmPassword } = value || {};
    const username = typeof value?.username === 'string' ? value.username.trim() : account.username;
    if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) throw new ServiceError('用户名需为 3–64 位字母、数字、点、短横线或下划线', 400);
    if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 256) throw new ServiceError('新密码需为 12–256 个字符', 400);
    if (newPassword !== confirmPassword) throw new ServiceError('两次输入的新密码不一致', 400);
    if (!await matches(currentPassword, account.password)) throw new ServiceError('当前密码不正确', 400);
    const next = { username, password: await passwordRecord(newPassword), version: randomToken() };
    if (!await runtime.kv.compareAndSet(accountKey, raw, JSON.stringify(next))) throw new ServiceError('账号已在其他设备修改，请重新登录', 409);
    // Version rotation invalidates every older session, including sessions whose keys have not expired.
    await issueSession(c, runtime, next.version);
    return { ok: true, username };
}
export async function logout(c, runtime) {
    const token = getCookie(c, cookieName);
    if (token) await runtime.kv.delete('admin:session:' + await digest(token));
    deleteCookie(c, cookieName, { path: '/' });
}
