import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
const cookieName = 'sublink_session';
export async function digest(value) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function randomToken() { return [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join(''); }
export function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
export function sameOrigin(c) { return c.req.header('Origin') === new URL(c.req.url).origin; }
export async function authenticated(c, runtime) {
    const token = getCookie(c, cookieName);
    if (!runtime.config.adminPasswordHash || !token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const session = await runtime.kv?.get('admin:session:' + await digest(token));
    return session === runtime.config.adminPasswordHash;
}
export async function login(c, runtime, password) {
    if (typeof password !== 'string' || password.length > 256 || !safeEqual(await digest(password), runtime.config.adminPasswordHash)) return false;
    const token = randomToken();
    await runtime.kv.put('admin:session:' + await digest(token), runtime.config.adminPasswordHash, { expirationTtl: 86400 });
    setCookie(c, cookieName, token, { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Strict', path: '/', maxAge: 86400 });
    return true;
}
export async function logout(c, runtime) {
    const token = getCookie(c, cookieName);
    if (token) await runtime.kv.delete('admin:session:' + await digest(token));
    deleteCookie(c, cookieName, { path: '/' });
}
