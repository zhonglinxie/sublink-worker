import yaml from 'js-yaml';
import { ClashConfigBuilder } from '../builders/ClashConfigBuilder.js';
import { ServiceError } from './errors.js';
import { serviceDomains, serviceRules } from './serviceGroups.js';
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
export async function renderProfile(profile) {
    const builder = new ClashConfigBuilder(profile.input, [], [], undefined, 'zh-CN', 'mihomo');
    builder.inlineSubscriptions = true;
    await builder.build();
    const cfg = yaml.load(builder.formatConfig());
    const all = cfg.proxies || [];
    if (!all.length) throw new ServiceError('未获取到节点，请检查源订阅是否可访问', 502);
    cfg.proxies = all.filter(n => !profile.excluded.includes(n.name));
    if (!cfg.proxies.length) throw new ServiceError('至少保留一个可用节点', 400);
    const nodes = new Set(cfg.proxies.map(n => n.name));
    if (profile.groups.some(g => nodes.has(g.name))) throw new ServiceError('分组名不能与节点名重复', 400);
    if (profile.groups.length) {
        cfg['proxy-groups'] = profile.groups.map(g => {
            const members = g.nodes.filter(n => nodes.has(n));
            if (!members.length) throw new ServiceError('分组没有有效节点：' + g.name, 400);
            return { name: g.name, type: g.type, proxies: members, ...(g.type === 'select' ? {} : { url: 'https://www.gstatic.com/generate_204', interval: 300 }) };
        });
        cfg.rules = [...serviceRules(profile.groups), 'MATCH,' + profile.groups[0].name];
        if (profile.groups.some(g => g.service)) cfg.mode = 'rule';
        delete cfg['rule-providers'];
    } else {
        cfg['proxy-groups'] = [{ name: '节点选择', type: 'select', proxies: [...nodes] }];
        cfg.rules = ['MATCH,节点选择'];
        delete cfg['rule-providers'];
    }
    // Managed exports must never ask a client to fetch a blocked source again.
    delete cfg['proxy-providers'];
    return { config: cfg, nodes: all.map(n => ({ name: n.name, type: n.type, server: n.server, port: n.port })), userinfo: builder.getSubscriptionUserinfo(), yaml: yaml.dump(cfg, { noRefs: true }) };
}
