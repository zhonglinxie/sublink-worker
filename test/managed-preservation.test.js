import { describe, it, expect, vi, afterEach } from 'vitest';
import yaml from 'js-yaml';
import { renderProfile } from '../src/services/managedSubscriptions.js';
const original = {
    'mixed-port': 7890, mode: 'rule', ipv6: true,
    dns: { enable: true, 'enhanced-mode': 'fake-ip', nameserver: ['https://dns.example/dns-query'], 'fake-ip-filter': ['+.lan'] },
    proxies: [
        { name: 'US', type: 'ss', server: 'us.example', port: 443, cipher: 'aes-128-gcm', password: 'private', udp: false, 'dialer-proxy': 'DIRECT' },
        { name: 'JP', type: 'ss', server: 'jp.example', port: 443, cipher: 'aes-128-gcm', password: 'private' }
    ],
    'proxy-groups': [
        { name: '🚀 原节点选择', type: 'select', proxies: ['US', 'JP', 'DIRECT'], icon: 'https://icons.example/selector.svg' },
        { name: '🎬 流媒体', type: 'select', proxies: ['🚀 原节点选择', 'DIRECT', 'REJECT'] },
        { name: '🤖 AI服务', type: 'url-test', proxies: ['US', 'JP'], url: 'https://test.example/204', interval: 120, tolerance: 80, lazy: true },
        { name: '🐟 原兜底', type: 'select', proxies: ['🚀 原节点选择', 'DIRECT'] }
    ],
    'rule-providers': { media: { type: 'http', behavior: 'classical', url: 'https://rules.example/media.yaml', path: './media.yaml', interval: 86400 } },
    rules: ['IP-CIDR,192.168.0.0/16,DIRECT,no-resolve', 'DOMAIN-SUFFIX,ads.example,REJECT', 'RULE-SET,media,🎬 流媒体', 'GEOSITE,openai,🤖 AI服务', 'GEOIP,CN,DIRECT', 'MATCH,🐟 原兜底']
};
const profile = extra => ({ code: 'test', name: 'test', input: yaml.dump(original), enabled: true, excluded: [], groups: [], ...extra });
describe('managed subscriptions preserve the original configuration', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('leaves all original fields and their group/rule order intact without edits', async () => {
        const result = await renderProfile(profile());
        expect(result.config).toEqual(original);
        expect(result.sourceGroups.map(group => group.name)).toEqual(original['proxy-groups'].map(group => group.name));
        expect(result.preserved).toBe(true);
    });
    it('adds service rules and groups without replacing the existing layout or fallback', async () => {
        const result = await renderProfile(profile({ groups: [{ name: 'Hyperliquid', type: 'select', nodes: ['JP'], service: 'hyperliquid' }] }));
        expect(result.config['proxy-groups'].slice(0, 4)).toEqual(original['proxy-groups']);
        expect(result.config['proxy-groups'][4].name).toBe('Hyperliquid');
        expect(result.config.rules.filter(rule => !rule.includes(',Hyperliquid'))).toEqual(original.rules);
        expect(result.config.rules.slice(0, 2)).toEqual(original.rules.slice(0, 2));
        expect(result.config.rules.indexOf('DOMAIN-SUFFIX,hyperliquid.xyz,Hyperliquid')).toBeLessThan(result.config.rules.indexOf('RULE-SET,media,🎬 流媒体'));
        expect(result.config.rules.at(-1)).toBe('MATCH,🐟 原兜底');
        expect(result.config['rule-providers']).toEqual(original['rule-providers']);
        expect(result.config.dns).toEqual(original.dns);
    });
    it('binds AI rules to an existing original group without replacing its strategy or position', async () => {
        const result = await renderProfile(profile({ groups: [{ name: '🤖 AI服务', type: 'select', nodes: ['US'], service: 'ai' }] }));
        expect(result.config['proxy-groups']).toEqual(original['proxy-groups']);
        expect(result.config.rules).toContain('DOMAIN-SUFFIX,chatgpt.com,🤖 AI服务');
        expect(result.config.rules.filter(rule => original.rules.includes(rule))).toEqual(original.rules);
    });
    it('excludes explicit nodes while retaining nested groups and special members', async () => {
        const result = await renderProfile(profile({ excluded: ['JP'] }));
        expect(result.config['proxy-groups'][0].proxies).toEqual(['US', 'DIRECT']);
        expect(result.config['proxy-groups'][1]).toEqual(original['proxy-groups'][1]);
        expect(result.config['proxy-groups'][2]).toEqual({ ...original['proxy-groups'][2], proxies: ['US'] });
        expect(result.config.rules).toEqual(original.rules);
    });
    it('keeps the exact remote Clash configuration and usage header', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(yaml.dump(original), { headers: { 'subscription-userinfo': 'upload=1; download=2; total=100' } })));
        const result = await renderProfile(profile({ input: 'https://source.example/config' }));
        expect(result.config).toEqual(original);
        expect(result.userinfo).toBe('upload=1; download=2; total=100');
    });
});
