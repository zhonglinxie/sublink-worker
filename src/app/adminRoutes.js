import { bodyLimit } from 'hono/body-limit';
import { authenticated, sameOrigin, login, logout, accountInfo, changeAccount } from '../services/adminAuth.js';
import { readCatalog, updateCatalog, validateProfile, renderProfile, validCode } from '../services/managedSubscriptions.js';

export function registerAdminRoutes(app, runtime) {
    app.use('/admin/*', bodyLimit({ maxSize: 300000 }));
    app.use('/admin/*', async (c, next) => {
        c.header('Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        if (!runtime.config.adminPasswordHash || !runtime.kv?.compareAndSet) return c.json({ error: '管理功能尚未配置持久化存储和登录密码' }, 503);
        if (c.req.method !== 'GET' && !sameOrigin(c)) return c.json({ error: '请求来源不匹配，请刷新页面' }, 403);
        if (!['/admin/login', '/admin/session'].includes(c.req.path) && !await authenticated(c, runtime)) return c.json({ error: '请先登录' }, 401);
        try { await next(); } catch (e) { return c.json({ error: e.status ? e.message : '操作失败，请稍后重试' }, e.status || 500); }
    });
    app.post('/admin/login', async c => {
        const { username, password } = await c.req.json();
        return await login(c, runtime, username, password) ? c.json({ ok: true }) : c.json({ error: '用户名或密码不正确' }, 401);
    });
    app.get('/admin/session', async c => c.json({ authenticated: await authenticated(c, runtime) }));
    app.get('/admin/account', async c => c.json(await accountInfo(runtime)));
    app.put('/admin/account', async c => c.json(await changeAccount(c, runtime, await c.req.json())));
    app.post('/admin/logout', async c => { await logout(c, runtime); return c.json({ ok: true }); });
    app.get('/admin/profiles', async c => c.json((await readCatalog(runtime.kv)).data));
    app.post('/admin/inspect', async c => {
        const { input } = await c.req.json();
        // Source inspection must work before a new subscription has a name or link.
        const result = await renderProfile(validateProfile({ name: 'Preview', code: 'preview', input, excluded: [], groups: [] }));
        return c.json({ nodes: result.nodes, userinfo: result.userinfo || null });
    });
    app.post('/admin/preview', async c => {
        const profile = validateProfile(await c.req.json());
        const result = await renderProfile(profile);
        return c.json({ nodes: result.nodes, userinfo: result.userinfo || null, yaml: result.yaml });
    });
    app.put('/admin/profiles/:code', async c => {
        const { revision, profile: value } = await c.req.json();
        const profile = validateProfile(value);
        if (profile.code !== c.req.param('code')) return c.json({ error: '链接后缀不匹配' }, 400);
        // A failed source refresh cannot replace a previously working configuration.
        if (profile.enabled) await renderProfile(profile);
        const data = await updateCatalog(runtime.kv, revision, profiles => [...profiles.filter(p => p.code !== profile.code), profile]);
        return c.json(data);
    });
}

export async function managedExport(c, runtime) {
    if (!runtime.kv || !runtime.config.adminPasswordHash || !validCode(c.req.param('code'))) return null;
    const profile = (await readCatalog(runtime.kv)).data.profiles.find(p => p.code === c.req.param('code'));
    if (!profile) return null;
    if (!profile.enabled) return c.text('Subscription disabled', 410, { 'Cache-Control': 'no-store' });
    try {
        const result = await renderProfile(profile);
        const headers = { 'Content-Type': 'text/yaml; charset=utf-8', 'Cache-Control': 'private, no-store', 'Profile-Title': encodeURIComponent(profile.name), 'Content-Disposition': `attachment; filename="${profile.code}.yaml"` };
        if (result.userinfo) headers['Subscription-Userinfo'] = result.userinfo;
        return c.text(result.yaml, 200, headers);
    } catch { return c.text('Subscription source temporarily unavailable', 503, { 'Cache-Control': 'no-store' }); }
}
