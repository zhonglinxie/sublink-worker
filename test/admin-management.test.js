import { afterEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';
import { digest } from '../src/services/adminAuth.js';
const origin = 'https://manager.example.com';
const source = 'proxies:\n  - {name: US, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: secret}\n  - {name: TW, type: ss, server: example.net, port: 443, cipher: aes-128-gcm, password: secret}\n';
async function setup() {
    const kv = new MemoryKVAdapter();
    const hash = await digest('test-long-random-password');
    const app = createApp({ kv, config: { adminPasswordHash: hash } });
    const response = await app.request(origin + '/admin/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-long-random-password' }) });
    expect(response.status).toBe(200);
    return { app, kv, cookie: response.headers.get('set-cookie').split(';')[0] };
}
function send(app, cookie, path, method, body) {
    return app.request(origin + path, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const profile = { name: 'Airport', code: 'my-airport', input: source, excluded: ['TW'], enabled: true, groups: [{ name: 'My group', type: 'fallback', nodes: ['US'] }] };
describe('single-owner management', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('requires login and rejects cross-origin writes and legacy overwrites', async () => {
        const { app, cookie } = await setup();
        expect((await app.request(origin + '/admin/profiles')).status).toBe(401);
        expect((await app.request(origin + '/admin/profiles/x', { method: 'PUT', headers: { Cookie: cookie, Origin: 'https://attacker.example' }, body: '{}' })).status).toBe(403);
        expect((await app.request(origin + '/shorten-v2?url=https://a.example/clash?config=test&shortCode=known')).status).toBe(401);
        expect((await send(app, cookie, '/admin/login', 'POST', { password: 'incorrect' })).status).toBe(401);
    });
    it('saves across sessions, exports selected groups, and preserves legacy links', async () => {
        const { app, kv, cookie } = await setup();
        await kv.put('legacy', '?config=ss%3A%2F%2Fexample');
        expect((await send(app, cookie, '/admin/profiles/my-airport', 'PUT', { revision: 0, profile })).status).toBe(200);
        const loaded = await (await app.request(origin + '/admin/profiles', { headers: { Cookie: cookie } })).json();
        expect(loaded.revision).toBe(1);
        const exported = await app.request(origin + '/c/my-airport');
        expect(exported.status).toBe(200);
        const result = yaml.load(await exported.text());
        expect(result.proxies.map(x => x.name)).toEqual(['US']);
        expect(result['proxy-groups'][0].type).toBe('fallback');
        expect(result.rules).toEqual(['MATCH,My group']);
        expect(result['proxy-providers']).toBeUndefined();
        expect((await app.request(origin + '/c/legacy')).status).toBe(302);
        expect((await send(app, cookie, '/admin/profiles/my-airport', 'PUT', { revision: 0, profile })).status).toBe(409);
        expect((await send(app, cookie, '/admin/profiles/my-airport', 'PUT', { revision: 1, profile: { ...profile, enabled: false } })).status).toBe(200);
        expect((await app.request(origin + '/c/my-airport')).status).toBe(410);
        await send(app, cookie, '/admin/logout', 'POST', {});
        expect((await app.request(origin + '/admin/profiles', { headers: { Cookie: cookie } })).status).toBe(401);
    });
    it('passes usage through and refuses to replace a working profile with a failed source', async () => {
        const { app, cookie } = await setup();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(source, { headers: { 'subscription-userinfo': 'upload=1; download=2; total=100' } })));
        const remote = { ...profile, input: 'https://source.example/sub' };
        expect((await send(app, cookie, '/admin/profiles/my-airport', 'PUT', { revision: 0, profile: remote })).status).toBe(200);
        expect((await app.request(origin + '/c/my-airport')).headers.get('subscription-userinfo')).toContain('total=100');
        vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
        expect((await send(app, cookie, '/admin/profiles/my-airport', 'PUT', { revision: 1, profile: remote })).status).not.toBe(200);
        const loaded = await (await app.request(origin + '/admin/profiles', { headers: { Cookie: cookie } })).json();
        expect(loaded.revision).toBe(1);
    });
    it('uses atomic updates to reject simultaneous edits', async () => {
        const { app, cookie } = await setup();
        const results = await Promise.all([send(app, cookie, '/admin/profiles/my-airport', 'PUT', { revision: 0, profile }), send(app, cookie, '/admin/profiles/second', 'PUT', { revision: 0, profile: { ...profile, code: 'second' } })]);
        expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    });
    it('inspects a source before naming a subscription without persisting it', async () => {
        const { app, cookie } = await setup();
        expect((await send(app, '', '/admin/inspect', 'POST', { input: source })).status).toBe(401);
        const response = await send(app, cookie, '/admin/inspect', 'POST', { input: source });
        expect(response.status).toBe(200);
        expect((await response.json()).nodes.map(node => node.name)).toEqual(['US', 'TW']);
        const catalog = await (await app.request(origin + '/admin/profiles', { headers: { Cookie: cookie } })).json();
        expect(catalog).toEqual({ revision: 0, profiles: [] });
        expect((await send(app, cookie, '/admin/inspect', 'POST', { input: '' })).status).toBe(400);
    });
});
