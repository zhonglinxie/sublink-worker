import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createApp } from '../dist/vercel/createApp.js';
import { managementApp } from '../src/components/adminClient.js';
const html = await (await createApp().request('https://manager.example/?manage=1')).text();
const source = 'https://source.example/c/airport';
const baseProfile = { name: 'Airport', code: 'airport', input: source, enabled: true, excluded: [], groups: [] };
const nodes = [{ name: 'US HY2', type: 'hysteria2', server: 'us.example.com', port: 443 }, { name: 'US TUIC', type: 'tuic', server: '2001:db8::1', port: 8443 }, { name: '<script>alert(1)</script>', type: 'trojan', server: 'jp.example.com', port: 443 }];
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await tick(); } assert.fail('UI did not settle'); }
async function setup(t, overrides = {}) {
    const dom = new JSDOM(html, { url: 'https://manager.example/?manage=1', runScripts: 'outside-only', pretendToBeVisual: true });
    t.after(async () => { await tick(); await tick(); dom.window.close(); });
    const { window } = dom, $ = id => window.document.getElementById(id);
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    window.Response = Response;
    window.HTMLElement.prototype.scrollIntoView = function () {};
    let catalog = { revision: 1, profiles: [structuredClone(baseProfile), { ...structuredClone(baseProfile), name: 'Second', code: 'second' }] };
    const calls = [];
    window.fetch = async (url, options) => {
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ url, body, method: options.method });
        const custom = await overrides.fetch?.(url, options, body); if (custom) return custom;
        if (url === '/admin/session') return Response.json({ authenticated: true });
        if (url === '/admin/account' && options.method === 'GET') return Response.json({ username: 'admin' });
        if (url === '/admin/account' && options.method === 'PUT') return Response.json({ ok: true, username: body.username });
        if (url === '/admin/login') return Response.json({ ok: true });
        if (url === '/admin/profiles' && options.method === 'GET') return Response.json(catalog);
        if (url === '/admin/inspect') return Response.json({ nodes, userinfo: 'upload=1000000000; download=4000000000; total=100000000000; expire=1900000000' });
        if (url === '/admin/preview') return Response.json({ nodes, yaml: 'proxies: []' });
        if (url.startsWith('/admin/profiles/') && options.method === 'PUT') { catalog = { revision: catalog.revision + 1, profiles: [...catalog.profiles.filter(p => p.code !== body.profile.code), body.profile] }; return Response.json(catalog); }
        if (url === '/admin/logout') return Response.json({ ok: true });
        throw Error('Unexpected API request: ' + url);
    };
    window.eval('(' + managementApp.toString() + ')()');
    await until(() => !$('workspace').hidden && $('node-rows').children.length === 3);
    const input = (id, value) => { $(id).value = value; $(id).dispatchEvent(new window.Event('input', { bubbles: true })); };
    return { window, $, calls, input };
}
test('opens the first saved profile, loads usage and renders untrusted node names as text', async t => {
    const { $ } = await setup(t);
    assert.equal($('profile-title').textContent, 'Airport');
    assert.equal($('node-rows').children.length, 3);
    assert.equal($('node-rows').querySelector('script'), null);
    assert.match($('node-rows').textContent, /<script>/);
    assert.match($('usage-value').textContent, /5 GB/);
    assert.equal($('usage-meter').getAttribute('aria-valuenow'), '5');
    assert.equal($('savebar').hidden, true);
});
test('filters by protocol, batches only visible nodes and removes exclusions from groups', async t => {
    const { $, window } = await setup(t);
    $('preset-auto').click();
    $('protocol-filter').value = 'tuic'; $('protocol-filter').dispatchEvent(new window.Event('change'));
    assert.equal($('node-rows').children.length, 1);
    $('select-visible').click();
    assert.equal($('savebar').hidden, false);
    assert.match($('node-value').textContent, /2/);
    assert.equal($('group-editor').querySelectorAll('input[type=checkbox]').length, 2);
    assert.equal($('group-editor').querySelectorAll('select[multiple]').length, 0);
    $('save').click(); await until(() => $('savebar').hidden);
    assert.match($('subscription-list').children[0].textContent, /Airport/);
});
test('guards subscription switching and preserves drafts when staying', async t => {
    const { $, input } = await setup(t); input('name', 'Draft');
    $('subscription-list').children[1].click(); assert.equal($('discard-dialog').open, true);
    $('keep-editing').click(); assert.equal($('profile-title').textContent, 'Draft');
    $('subscription-list').children[1].click(); $('confirm-discard').click();
    await until(() => $('profile-title').textContent === 'Second' && $('loading').hidden); assert.equal($('savebar').hidden, true);
});
test('discard then cancel import does not resurrect the discarded draft', async t => {
    const { $, input } = await setup(t); input('name', 'Draft'); $('new').click(); $('confirm-discard').click(); $('import-cancel').click();
    assert.equal($('profile-title').textContent, 'Airport'); assert.equal($('savebar').hidden, true);
});
test('inspects before naming, avoids link collisions and creates the named link', async t => {
    const { $, calls, input } = await setup(t);
    $('new').click(); input('import-source', source); $('import-inspect').click();
    await until(() => !$('import-step-two').hidden);
    assert.equal($('import-code').value, 'airport-2');
    input('import-code', 'airport'); $('import-save').click(); await until(() => !$('import-error').hidden);
    assert.match($('import-error').textContent, /已被使用/); assert.equal(calls.filter(x => x.method === 'PUT').length, 0);
    input('import-name', 'New Airport'); input('import-code', 'new-airport'); $('import-save').click();
    await until(() => $('profile-title').textContent === 'New Airport' && $('loading').hidden);
    assert.equal($('export-link').textContent, 'https://manager.example/c/new-airport');
});
test('retains the current draft and exposes a reload action on revision conflict', async t => {
    const { $, input } = await setup(t, { fetch: url => url.startsWith('/admin/profiles/') ? Response.json({ error: 'conflict' }, { status: 409 }) : null });
    input('name', 'My draft'); $('save').click(); await until(() => !$('workspace-error').hidden);
    assert.equal($('name').value, 'My draft'); assert.equal($('savebar').hidden, false); assert.match($('workspace-error').textContent, /草稿已保留/);
});
test('ignores a late source response after switching subscriptions', async t => {
    let resolve, count = 0;
    const pending = new Promise(done => { resolve = done; });
    const { $, calls } = await setup(t, { fetch: async url => { if (url === '/admin/inspect' && ++count === 2) return pending; } });
    $('refresh').click(); await until(() => calls.filter(x => x.url === '/admin/inspect').length === 2);
    $('subscription-list').children[1].click(); await until(() => $('profile-title').textContent === 'Second' && $('loading').hidden);
    resolve(Response.json({ nodes: [{ name: 'STALE', type: 'ss', server: 'x', port: 1 }] })); await tick(); await tick();
    assert.doesNotMatch($('node-rows').textContent, /STALE/);
});
test('tabs support arrow key navigation and expose the active panel', async t => {
    const { $, window } = await setup(t);
    $('tab-overview').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal($('tab-nodes').getAttribute('aria-selected'), 'true'); assert.equal($('view-nodes').hidden, false); assert.equal($('view-overview').hidden, true);
});
test('shows a field error for a blank name and clears it when corrected', async t => {
    const { $, input } = await setup(t); input('name', ''); $('save').click();
    await until(() => !$('workspace-error').hidden);
    assert.equal($('name').getAttribute('aria-invalid'), 'true');
    assert.equal($('view-settings').hidden, false);
    input('name', 'Corrected'); assert.equal($('name').hasAttribute('aria-invalid'), false);
    $('save').click(); await until(() => $('savebar').hidden);
    assert.match($('save').textContent, /保存更改/); assert.ok($('save').querySelector('svg'));
});
test('a failed refresh preserves last known nodes and presents a retry', async t => {
    let count = 0;
    const { $ } = await setup(t, { fetch: url => url === '/admin/inspect' && ++count > 1 ? Response.json({ error: 'Source unavailable' }, { status: 502 }) : null });
    $('refresh').click(); await until(() => !$('workspace-error').hidden);
    assert.equal($('node-rows').children.length, 3); assert.match($('workspace-error').textContent, /重试/);
    assert.equal($('refresh').disabled, false); assert.equal($('savebar').hidden, true);
});
test('service presets add only the requested policies and retain the source fallback', async t => {
    const { $, calls } = await setup(t);
    $('preset-ai').click(); $('preset-hyperliquid').click(); $('preset-hyperliquid').click();
    assert.equal($('group-list').children.length, 2);
    assert.equal($('group-editor').querySelector('[aria-label="分组流量用途"]').value, 'hyperliquid');
    $('save').click(); await until(() => $('savebar').hidden);
    const groups = calls.findLast(call => call.method === 'PUT').body.profile.groups;
    assert.deepEqual(groups[0].nodes, ['US HY2', 'US TUIC']);
    assert.equal(groups[0].service, 'ai'); assert.equal(groups[1].service, 'hyperliquid');
    assert.deepEqual(groups[1].nodes, ['<script>alert(1)</script>']);
});
test('uses the original converter page and displays original groups in source order', async t => {
    const { $, window } = await setup(t, { fetch: url => url === '/admin/inspect' ? Response.json({ nodes, sourceGroups: [{ name: '🚀 原节点选择', type: 'select', nodes: ['US HY2', 'DIRECT'] }, { name: '🤖 AI服务', type: 'url-test', nodes: ['US TUIC'] }], sourceRuleCount: 15, userinfo: null }) : null });
    assert.ok(window.document.querySelector('[x-data="formData()"]'));
    assert.match(html, /selectedPredefinedRule/);
    assert.match(html, /groupByCountry/);
    assert.equal(window.document.querySelector('.sidebar'), null);
    assert.deepEqual([...$('original-groups').querySelectorAll('summary')].map(node => node.textContent), ['1. 🚀 原节点选择 · select', '2. 🤖 AI服务 · url-test']);
    $('preset-ai').click();
    assert.match($('group-editor').textContent, /保留该分组的成员、策略和原位置/);
    assert.match($('group-note').textContent, /15 条原分流规则/);
});
test('saves the original conversion result with its selected classifications and options', async t => {
    const { $, window } = await setup(t);
    const url = 'https://manager.example/clash?config=https%3A%2F%2Fsource.example%2Fsub&selectedRules=%5B%22Youtube%22%2C%22AI%20Services%22%5D&group_by_country=true';
    window.dispatchEvent(new window.CustomEvent('save-converted-subscription', { detail: { url } }));
    assert.equal($('import-dialog').open, true);
    const saved = new URL($('import-source').value), original = new URL(url);
    for (const [key, value] of original.searchParams) assert.equal(saved.searchParams.get(key), value);
    assert.equal(saved.searchParams.get('inline_subscriptions'), 'true');
});
test('account dialog checks confirmation and clears secrets after updating', async t => {
    const { $, window, calls, input } = await setup(t);
    $('account-open').click(); await until(() => $('account-dialog').open);
    input('account-username', 'owner'); input('account-current', 'old-password'); input('account-password', 'new-long-password'); input('account-confirm', 'different');
    $('account-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await until(() => !$('account-error').hidden); assert.match($('account-error').textContent, /不一致/);
    assert.equal(calls.some(call => call.url === '/admin/account' && call.method === 'PUT'), false);
    input('account-confirm', 'new-long-password'); $('account-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await until(() => !$('account-dialog').open);
    for (const id of ['account-current', 'account-password', 'account-confirm']) assert.equal($(id).value, '');
    assert.equal($('username').value, 'owner');
    assert.equal($('savebar').hidden, true);
});
test('login sends both the username and password', async t => {
    const { $, window, calls, input } = await setup(t);
    $('logout-mobile').click(); await until(() => !$('login-screen').hidden);
    input('username', 'owner'); input('password', 'new-long-password');
    $('login').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await until(() => calls.some(call => call.url === '/admin/login'));
    assert.deepEqual(calls.findLast(call => call.url === '/admin/login').body, { username: 'owner', password: 'new-long-password' });
    await until(() => !$('workspace').hidden && $('loading').hidden);
});
