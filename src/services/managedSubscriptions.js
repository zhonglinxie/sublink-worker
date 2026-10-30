import yaml from 'js-yaml';
import { ClashConfigBuilder } from '../builders/ClashConfigBuilder.js';
import { ServiceError } from './errors.js';
import { serviceDomains, serviceRules } from './serviceGroups.js';
import { fetchSubscriptionWithFormat } from '../parsers/subscription/httpSubscriptionFetcher.js';
const key = 'admin:subscriptions:v1';
export const validCode = code => typeof code === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(code);
export async function readCatalog(kv) {
    const raw = await kv.get(key);
    return { raw, data: raw ? JSON.parse(raw) : { revision: 0, profiles: [] } };
}
export async function updateCatalog(kv, revision, change) {
    const { raw, data } = await readCatalog(kv);
    if (revision !== data.revision) throw new ServiceError('配置已在其他设备更新，请刷新后重试', 409);
    const next = { revision: data.revision + 1, profiles: change(data.profiles) };
    if (!kv.compareAndSet || !await kv.compareAndSet(key, raw, JSON.stringify(next))) throw new ServiceError('配置已更新，请刷新后重试', 409);
    return next;
}
export function validateProfile(value) {
    if (!value || !validCode(value.code) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) throw new ServiceError('请填写名称与有效的链接后缀', 400);
    if (typeof value.input !== 'string' || !value.input.trim() || value.input.length > 200000) throw new ServiceError('请输入订阅地址或节点内容（最多 200 KB）', 400);
    if (!Array.isArray(value.excluded) || value.excluded.length > 2000 || value.excluded.some(x => typeof x !== 'string')) throw new ServiceError('节点选择无效', 400);
    if (!Array.isArray(value.groups) || value.groups.length > 100 || value.groups.some(g => !g || typeof g.name !== 'string' || !g.name.trim() || g.name.length > 100 || !['select', 'url-test', 'fallback'].includes(g.type) || !Array.isArray(g.nodes) || g.nodes.some(n => typeof n !== 'string'))) throw new ServiceError('分组配置无效', 400);
    if (value.groups.some(g => g.service !== undefined && !Object.hasOwn(serviceDomains, g.service))) throw new ServiceError('未知的服务分组类型', 400);
    const services = value.groups.filter(g => g.service).map(g => g.service);
    if (new Set(services).size !== services.length) throw new ServiceError('同一服务只能绑定一个分组', 400);
    const names = value.groups.map(g => g.name);
    if (new Set(names).size !== names.length || names.includes('DIRECT') || names.includes('REJECT')) throw new ServiceError('分组名称重复或使用保留名称', 400);
    return { code: value.code, name: value.name.trim(), input: value.input.trim(), excluded: value.excluded, groups: value.groups.map(g => ({ name: g.name, type: g.type, nodes: g.nodes, ...(g.service ? { service: g.service } : {}) })), enabled: value.enabled !== false, updatedAt: new Date().toISOString() };
}
function clashDocument(input) {
    try {
        const cfg = yaml.load(input);
        return cfg && typeof cfg === 'object' && Array.isArray(cfg.proxies) && cfg.proxies.length && (cfg.rules?.length || cfg['proxy-groups']?.length || cfg['rule-providers']) ? cfg : null;
    } catch { return null; }
}
async function sourceConfig(input) {
    let content = input.trim(), userinfo;
    if (/^https?:\/\/\S+$/.test(content)) {
        const result = await fetchSubscriptionWithFormat(content, 'mihomo');
        if (!result) throw new ServiceError('源订阅暂时无法读取，请稍后重试', 502);
        content = result.content; userinfo = result.subscriptionUserinfo;
    }
    const original = clashDocument(content);
    if (original) return { config: original, userinfo, preserved: true };
    const builder = new ClashConfigBuilder(content, [], [], undefined, 'zh-CN', 'mihomo');
    builder.inlineSubscriptions = true;
    const templates = [], apply = builder.applyConfigOverrides.bind(builder);
    // Mixed inputs may contain one routing template; two competing templates must not be flattened silently.
    builder.applyConfigOverrides = config => {
        if (config.rules || config['proxy-groups']) templates.push(structuredClone(config));
        apply(config);
    };
    await builder.build();
    if (templates.length > 1) throw new ServiceError('多个来源包含独立分流配置，请分开导入以保留各自规则', 400);
    const generated = yaml.load(builder.formatConfig());
    return { config: templates.length ? { ...generated, ...templates[0], proxies: generated.proxies } : generated, userinfo: userinfo || builder.getSubscriptionUserinfo(), preserved: Boolean(templates.length) };
}
export async function renderProfile(profile) {
    const source = await sourceConfig(profile.input), cfg = source.config;
    const all = cfg.proxies || [], excluded = new Set(profile.excluded);
    cfg.proxies = all.filter(node => !excluded.has(node.name));
    if (!cfg.proxies.length) throw new ServiceError('至少保留一个可用节点', 400);
    const nodeNames = new Set(cfg.proxies.map(node => node.name));
    const originalGroups = structuredClone(cfg['proxy-groups'] || []);
    const originalRules = [...(cfg.rules || [])];
    const additions = profile.groups.map(group => {
        if (nodeNames.has(group.name)) throw new ServiceError('分组名不能与节点名重复', 400);
        if (originalGroups.some(original => original.name === group.name)) return null;
        const members = group.nodes.filter(name => nodeNames.has(name));
        if (!members.length) throw new ServiceError('分组没有有效节点：' + group.name, 400);
        return { name: group.name, type: group.type, proxies: members, ...(group.type === 'select' ? {} : { url: 'https://www.gstatic.com/generate_204', interval: 300 }) };
    }).filter(Boolean);
    cfg['proxy-groups'] = [...originalGroups, ...additions];
    // Exclusions remove only explicit node references; nested groups, built-ins and provider selectors stay intact.
    for (const group of cfg['proxy-groups']) {
        if (Array.isArray(group.proxies)) group.proxies = group.proxies.filter(name => !excluded.has(name));
        if (Array.isArray(group.proxies) && !group.proxies.length && !group.use?.length && !group['include-all'] && !group['include-all-providers']) throw new ServiceError('排除节点后原分组为空：' + group.name + '。请保留至少一个节点', 400);
    }
    const extraRules = serviceRules(profile.groups);
    if (source.preserved && originalRules.length) {
        // Preserve protective rules and every original rule's relative order while making new service policies effective.
        const protective = new Set(['DIRECT', 'REJECT', ...originalGroups.filter(group => group.proxies?.length && group.proxies.every(name => ['DIRECT', 'REJECT'].includes(name))).map(group => group.name)]);
        const terminal = originalRules.findIndex(rule => {
            const parts = rule.split(',');
            const target = parts.at(-1) === 'no-resolve' ? parts.at(-2) : parts.at(-1);
            return !protective.has(target);
        });
        const position = terminal < 0 ? originalRules.length : terminal;
        cfg.rules = [...originalRules.slice(0, position), ...extraRules, ...originalRules.slice(position)];
    } else {
        // Node-only subscriptions inherit the converter's existing categories and routing, rather than a new catch-all policy.
        cfg.rules = [...originalRules.slice(0, -1), ...extraRules, ...originalRules.slice(-1)];
    }
    return {
        config: cfg, nodes: all.map(node => ({ name: node.name, type: node.type, server: node.server, port: node.port })),
        sourceGroups: originalGroups.map(group => ({ name: group.name, type: group.type, nodes: group.proxies || [] })),
        sourceRuleCount: originalRules.length, preserved: source.preserved,
        userinfo: source.userinfo, yaml: yaml.dump(cfg, { noRefs: true, lineWidth: -1 })
    };
}
