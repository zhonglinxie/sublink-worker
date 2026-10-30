// Kept self-contained so the Hono page can ship one inline script without a frontend runtime.
export function managementApp() {
    const $ = id => document.getElementById(id);
    const clone = value => JSON.parse(JSON.stringify(value));
    const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
    let catalog = { revision: 0, profiles: [] }, current = null, baseline = null, nodes = [], userinfo = null, sourceGroups = [], sourceRuleCount = 0;
    let activeTab = 'overview', activeGroup = 0, epoch = 0, loading = false, mutating = false, accountBusy = false, sourceVersion = '', pendingLeave = null, importData = null, importVersion = 0, pendingConversion = null, toastTimer;
    const dirty = () => current && JSON.stringify(current) !== JSON.stringify(baseline);
    const link = code => location.origin + '/c/' + code;
    const text = (id, value) => { $(id).textContent = value; };
    function toast(message, error = false) {
        clearTimeout(toastTimer); text('toast', message); $('toast').classList.toggle('error', error); $('toast').hidden = false;
        toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 4000);
    }
    function showError(id, message) { text(id, message); $(id).hidden = !message; if (message) $(id).focus(); }
    async function api(path, method = 'GET', data) {
        const response = await fetch('/admin/' + path, { method, headers: { 'Content-Type': 'application/json' }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
        let value;
        try { value = await response.json(); } catch { throw Error('服务器响应异常，请稍后重试'); }
        if (!response.ok) {
            if (response.status === 401) { $('login-screen').hidden = false; $('workspace').hidden = true; $('savebar').hidden = true; $('account-dialog').close(); }
            const error = Error(response.status === 409 ? '其他设备已修改了配置。当前草稿已保留，请先复制需要的内容，再重新加载服务端配置。' : value.error || '请求失败');
            error.status = response.status; throw error;
        }
        return value;
    }
    async function action(button, task, errorId) {
        if (button?.disabled) return;
        const content = button ? [...button.childNodes] : [];
        if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = '处理中…'; }
        try { await task(); } catch (error) { if (errorId) showError(errorId, error.message); else toast(error.message, true); }
        finally { if (button) { button.disabled = false; button.removeAttribute('aria-busy'); button.replaceChildren(...content); } }
    }
    function usage(value) {
        const data = Object.fromEntries((value || '').split(';').map(part => part.trim().split('=')));
        const number = key => Math.max(0, Number(data[key]) || 0);
        const used = number('upload') + number('download'), total = number('total');
        const bytes = number => { const units = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (number >= 1000 && i < 4) { number /= 1000; i++; } return number.toLocaleString('zh-CN', { maximumFractionDigits: i >= 3 ? 2 : 1 }) + ' ' + units[i]; };
        const expire = number('expire');
        return { known: Boolean(value), used, total, percent: total ? Math.min(100, Math.round(used / total * 100)) : 0, usedLabel: bytes(used), totalLabel: bytes(total), remaining: bytes(Math.max(0, total - used)), expire: expire ? new Date(expire * 1000).toLocaleDateString('zh-CN') : '源订阅未提供' };
    }
    function sourceLabel(input) { try { const url = new URL(input.trim()); return /^https?:$/.test(url.protocol) ? url.hostname : '粘贴的节点内容'; } catch { return '粘贴的节点内容'; } }
    function eligible() { return nodes.filter(node => !current.excluded.includes(node.name)); }
    function updateDirty() { $('savebar').hidden = !dirty() || $('workspace').hidden; $('preview').hidden = true; $('preview').value = ''; }
    function renderSidebar() {
        $('subscription-list').replaceChildren(); $('mobile-profiles').replaceChildren();
        [...catalog.profiles].sort((a, b) => a.code.localeCompare(b.code)).forEach(profile => {
            const button = el('button', undefined, 'subscription-item'); button.type = 'button'; button.setAttribute('aria-current', String(profile.code === current?.code));
            button.append(el('span', '↗', 'muted'), el('span', profile.name, 'name'), el('span', '', 'dot' + (profile.enabled ? '' : ' off')));
            button.onclick = () => leave(() => choose(profile)); $('subscription-list').append(button);
            $('mobile-profiles').add(new Option(profile.name, profile.code));
        });
        $('mobile-profiles').add(new Option('＋ 导入新订阅', '__new__')); $('mobile-profiles').value = current?.code || '__new__';
    }
    function renderSummary() {
        if (!current) return;
        const u = usage(userinfo), count = eligible().length;
        text('profile-title', current.name || '未命名订阅');
        text('profile-status', current.enabled ? '● 已启用' : '● 已停用'); $('profile-status').classList.toggle('off', !current.enabled);
        const groupCount = sourceGroups.length + current.groups.filter(group => !sourceGroups.some(original => original.name === group.name)).length;
        text('export-link', link(current.code)); text('nodes-count', nodes.length ? String(nodes.length) : ''); text('groups-count', groupCount || '');
        $('usage-value').replaceChildren(el('span', u.known ? u.usedLabel : '—'), el('small', u.known && u.total ? '/ ' + u.totalLabel : u.known ? '已使用' : '源订阅未提供'));
        $('usage-progress').style.width = u.percent + '%';
        if (u.total) $('usage-meter').setAttribute('aria-valuenow', u.percent); else $('usage-meter').removeAttribute('aria-valuenow');
        $('usage-meter').setAttribute('aria-valuetext', u.total ? '已使用 ' + u.percent + '%' : '总流量未知');
        text('usage-note', u.total ? '剩余 ' + u.remaining + ' · 已使用 ' + u.percent + '%' : u.known ? '源订阅未提供总流量' : '用量由源订阅提供，不在此处估算');
        $('node-value').replaceChildren(el('span', nodes.length ? String(count) : '—'), el('small', nodes.length ? '/ ' + nodes.length + ' 个节点' : '等待源订阅数据'));
        text('node-note', nodes.length ? current.excluded.length ? '按你的选择导出' : '全部节点已加入导出' : '读取后即可筛选节点');
        $('group-value').replaceChildren(el('span', String(sourceGroups.length + current.groups.filter(group => !sourceGroups.some(original => original.name === group.name)).length)), el('small', '个分组'));
        text('group-note', '保留来源分组顺序与 ' + sourceRuleCount + ' 条原分流规则');
        text('source-label', sourceLabel(current.input)); text('expire-label', u.expire);
        text('saved-label', current.updatedAt ? new Date(current.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未保存');
        text('node-summary', count + ' / ' + nodes.length + ' 已选择'); updateDirty();
    }
    function visibleNodes() {
        const query = $('node-search').value.trim().toLowerCase(), protocol = $('protocol-filter').value;
        return nodes.filter(n => (!protocol || n.type === protocol) && [n.name, n.type, n.server].some(value => String(value).toLowerCase().includes(query)));
    }
    function setIncluded(names, included) {
        const selected = new Set(names); current.excluded = current.excluded.filter(name => !selected.has(name));
        if (!included) {
            current.excluded.push(...names);
            // An excluded node cannot remain as a hidden member of a custom group.
            current.groups.forEach(group => { group.nodes = group.nodes.filter(name => !selected.has(name)); });
        }
        renderNodes(); renderGroups(); renderSummary();
    }
    function renderNodes() {
        const visible = visibleNodes(); $('node-rows').replaceChildren();
        visible.forEach(node => {
            const included = !current.excluded.includes(node.name), row = el('tr', undefined, included ? '' : 'excluded');
            const cell = el('td'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = included; checkbox.setAttribute('aria-label', '导出 ' + node.name);
            checkbox.onchange = () => setIncluded([node.name], checkbox.checked); cell.append(checkbox);
            const protocol = el('td'); protocol.append(el('span', node.type, 'pill'));
            row.append(cell, el('td', node.name), protocol, el('td', node.server + ':' + node.port, 'mono'), el('td', node.server.includes(':') ? 'IPv6' : 'IPv4 / 域名', 'muted')); $('node-rows').append(row);
        });
        const selected = visible.filter(n => !current.excluded.includes(n.name)).length;
        $('select-visible').checked = visible.length > 0 && selected === visible.length;
        $('select-visible').indeterminate = selected > 0 && selected < visible.length; $('select-visible').disabled = !visible.length;
        $('nodes-empty').hidden = visible.length > 0; text('filter-summary', '显示 ' + visible.length + ' / ' + nodes.length + ' 个节点');
    }
    function groupButton(label, click, className = 'small') { const button = el('button', label, className); button.type = 'button'; button.onclick = click; return button; }
    function renderGroups() {
        $('original-groups-section').hidden = !sourceGroups.length; $('original-groups').replaceChildren();
        sourceGroups.forEach((group, index) => {
            const details = el('details'), summary = el('summary', (index + 1) + '. ' + group.name + ' · ' + group.type);
            details.append(summary, el('p', group.nodes.join(' · ') || '沿用来源的 Provider / 筛选设置', 'muted')); $('original-groups').append(details);
        });
        const groups = current.groups; $('groups-empty').hidden = Boolean(groups.length); $('groups-layout').hidden = !groups.length; $('group-list').replaceChildren(); $('group-editor').replaceChildren();
        if (!groups.length) return;
        activeGroup = Math.min(activeGroup, groups.length - 1);
        groups.forEach((group, index) => {
            const button = el('button', undefined, 'group-item' + (index === activeGroup ? ' active' : ''));
            button.setAttribute('aria-pressed', String(index === activeGroup)); button.append(el('span', group.name || '未命名分组'), el('small', index === 0 ? '默认' : group.nodes.length + ' 节点'));
            button.onclick = () => { activeGroup = index; renderGroups(); }; $('group-list').append(button);
        });
        const group = groups[activeGroup], editor = $('group-editor'), fields = el('div', undefined, 'two');
        if (group.service && sourceGroups.some(original => original.name === group.name)) {
            editor.append(el('h3', group.name), el('p', '服务规则绑定到已有来源分组，保留该分组的成员、策略和原位置。', 'note'), groupButton('移除附加服务规则', () => { groups.splice(activeGroup, 1); renderGroups(); renderSummary(); }, 'small danger')); return;
        }
        const nameLabel = el('label', '分组名称', 'field'), name = el('input'); name.value = group.name; name.maxLength = 100; name.setAttribute('aria-label', '分组名称');
        name.oninput = () => { group.name = name.value; const selected = $('group-list').children[activeGroup]; selected.querySelector('span').textContent = name.value || '未命名分组'; renderSummary(); }; nameLabel.append(name);
        const typeLabel = el('label', '选择方式', 'field'), type = el('select'); type.setAttribute('aria-label', '分组选择方式');
        [['select', '手动选择'], ['url-test', '自动测速'], ['fallback', '故障切换']].forEach(([value, label]) => type.add(new Option(label, value)));
        type.value = group.type; type.onchange = () => { group.type = type.value; renderSummary(); }; typeLabel.append(type); fields.append(nameLabel, typeLabel); editor.append(fields);
        const serviceLabel = el('label', '流量用途', 'field'), service = el('select'); service.setAttribute('aria-label', '分组流量用途');
        [['', '通用 · 不绑定服务'], ['ai', 'AI · ChatGPT / Claude / Gemini'], ['hyperliquid', 'Hyperliquid · 网页 / API / WebSocket']].forEach(([value, label]) => service.add(new Option(label, value)));
        service.value = group.service || ''; service.onchange = () => { if (service.value) group.service = service.value; else delete group.service; renderSummary(); }; serviceLabel.append(service); serviceLabel.style.marginTop = '16px'; editor.append(serviceLabel);
        const tools = el('div', undefined, 'row between wrap'); tools.style.marginTop = '22px'; tools.append(el('h3', '分组节点 · ' + group.nodes.length));
        const batch = el('div', undefined, 'row'); batch.append(groupButton('全选', () => { group.nodes = eligible().map(n => n.name); renderGroups(); renderSummary(); }, 'text-button'), groupButton('清空', () => { group.nodes = []; renderGroups(); renderSummary(); }, 'text-button')); tools.append(batch); editor.append(tools);
        const search = el('input'); search.type = 'search'; search.placeholder = '搜索可加入的节点…'; search.setAttribute('aria-label', '搜索分组节点'); search.style.marginTop = '12px'; editor.append(search);
        const members = el('div', undefined, 'member-list'); editor.append(members);
        const memberRows = () => {
            members.replaceChildren(); const available = eligible().filter(n => n.name.toLowerCase().includes(search.value.toLowerCase()));
            available.forEach(node => {
                const label = el('label', undefined, 'member'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = group.nodes.includes(node.name); checkbox.setAttribute('aria-label', '加入分组 ' + node.name);
                checkbox.onchange = () => { group.nodes = group.nodes.filter(name => name !== node.name); if (checkbox.checked) group.nodes.push(node.name); tools.querySelector('h3').textContent = '分组节点 · ' + group.nodes.length; renderSummary(); };
                label.append(checkbox, el('span', node.name), el('small', node.type, 'pill')); members.append(label);
            });
            if (!available.length) members.append(el('p', '没有可加入的节点，请先在「节点」中选择导出节点。', 'note'));
        }; search.oninput = memberRows; memberRows();
        const actions = el('div', undefined, 'group-actions');
        if (!sourceRuleCount && activeGroup > 0) actions.append(groupButton('设为默认出口', () => { groups.unshift(groups.splice(activeGroup, 1)[0]); activeGroup = 0; renderGroups(); renderSummary(); }));
        if (activeGroup > 0) actions.append(groupButton('上移 ↑', () => { [groups[activeGroup - 1], groups[activeGroup]] = [groups[activeGroup], groups[activeGroup - 1]]; activeGroup--; renderGroups(); renderSummary(); }));
        if (activeGroup < groups.length - 1) actions.append(groupButton('下移 ↓', () => { [groups[activeGroup + 1], groups[activeGroup]] = [groups[activeGroup], groups[activeGroup + 1]]; activeGroup++; renderGroups(); renderSummary(); }));
        actions.append(groupButton('移除分组', () => { groups.splice(activeGroup, 1); activeGroup = Math.max(0, activeGroup - 1); renderGroups(); renderSummary(); }, 'small danger')); editor.append(actions);
        if (!group.nodes.length) editor.append(el('p', '请至少选择一个节点，才能保存此分组。', 'note'));
    }
    function tab(name, focus = false) {
        activeTab = name;
        ['overview', 'nodes', 'groups', 'settings'].forEach(value => { const button = $('tab-' + value); button.setAttribute('aria-selected', String(value === name)); button.tabIndex = value === name ? 0 : -1; $('view-' + value).hidden = value !== name; });
        if (focus) $('tab-' + name).focus();
    }
    async function inspect() {
        if (!current || loading) return;
        const mine = ++epoch, input = current.input;
        loading = true; $('loading').hidden = false; $('refresh').disabled = true; $('check-source').disabled = true; showError('workspace-error', '');
        try {
            const result = await api('inspect', 'POST', { input });
            // Ignore a late response if the user switched subscriptions or edited the source.
            if (mine !== epoch || input !== current?.input) return;
            nodes = result.nodes; userinfo = result.userinfo; sourceGroups = result.sourceGroups || []; sourceRuleCount = result.sourceRuleCount || 0; sourceVersion = input;
            const protocol = $('protocol-filter').value; $('protocol-filter').replaceChildren(new Option('所有协议', ''));
            [...new Set(nodes.map(n => n.type))].sort().forEach(type => $('protocol-filter').add(new Option(type.toUpperCase(), type)));
            if ([...$('protocol-filter').options].some(option => option.value === protocol)) $('protocol-filter').value = protocol;
            text('fetched-label', new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' · 刚刚更新'); renderNodes(); renderGroups(); renderSummary();
        } catch (error) { if (mine === epoch) showError('workspace-error', '读取失败：' + error.message + '。可点击「更新数据」重试。'); }
        finally { if (mine === epoch) { loading = false; $('loading').hidden = true; $('refresh').disabled = false; $('check-source').disabled = false; } }
    }
    async function choose(profile) {
        epoch++; loading = false; current = profile ? clone(profile) : null; baseline = current ? clone(current) : null; nodes = []; userinfo = null; sourceGroups = []; sourceRuleCount = 0; sourceVersion = ''; activeGroup = 0;
        $('profile-content').hidden = !current; $('empty-workspace').hidden = Boolean(current); $('savebar').hidden = true; $('loading').hidden = true; $('refresh').disabled = false; $('check-source').disabled = false; showError('workspace-error', ''); renderSidebar();
        if (!current) return;
        try { localStorage.setItem('sublink:last-profile', current.code); } catch { /* Storage can be disabled in private browsing. */ }
        $('name').value = current.name; $('code').value = current.code; $('source').value = current.input; $('enabled').checked = current.enabled; $('source-details').open = false; $('advanced').open = false; $('node-search').value = ''; $('protocol-filter').value = ''; text('fetched-label', '正在读取');
        tab('overview'); renderSummary(); renderNodes(); renderGroups(); await inspect();
    }
    function leave(next) {
        if (mutating) { toast('正在保存，请稍等'); return; }
        if (dirty()) { pendingLeave = next; $('discard-dialog').showModal(); return; }
        next();
    }
    async function load(preferred) {
        catalog = await api('profiles'); $('login-screen').hidden = true; $('workspace').hidden = false;
        let remembered; try { remembered = localStorage.getItem('sublink:last-profile'); } catch { /* Selection persistence is optional. */ }
        await choose(catalog.profiles.find(p => p.code === (preferred || remembered)) || catalog.profiles[0]);
        if (pendingConversion) { const input = pendingConversion; pendingConversion = null; openImport(); $('import-source').value = input; }
    }
    function validate(profile) {
        const prefix = profile === current ? '' : 'import-';
        const invalid = (field, message) => {
            const input = $(prefix + field); input.setAttribute('aria-invalid', 'true');
            let hint = $(prefix + field + '-error');
            if (!hint) { hint = el('span', '', 'field-error'); hint.id = prefix + field + '-error'; input.after(hint); }
            hint.textContent = message; input.setAttribute('aria-describedby', hint.id);
            if (profile === current) tab('settings');
            throw Error(message);
        };
        if (!profile.name.trim()) invalid('name', '请填写订阅名称');
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile.code)) invalid('code', '链接后缀只能使用 1–64 位字母、数字、短横线和下划线');
        if (!profile.input.trim()) throw Error('请填写源订阅或节点内容');
        const names = new Set(['DIRECT', 'REJECT']);
        const services = profile.groups.filter(group => group.service).map(group => group.service);
        if (new Set(services).size !== services.length) { tab('groups'); throw Error('同一服务只能绑定一个分组，请检查流量用途'); }
        profile.groups.forEach(group => {
            if (!group.name.trim() || names.has(group.name) || nodes.some(node => node.name === group.name) || !group.nodes.length) {
                tab('groups');
                throw Error(!group.name.trim() ? '请填写每个分组的名称' : !group.nodes.length ? '分组「' + group.name + '」至少需要一个节点' : '分组名称与节点、其他分组或保留名称重复：' + group.name);
            }
            names.add(group.name);
        });
        if (nodes.length && profile === current && !eligible().length && profile.enabled) throw Error('请至少保留一个导出节点');
    }
    async function save() {
        validate(current); if (mutating) return;
        const draft = clone(current), version = epoch; mutating = true; $('profile-content').inert = true;
        try {
            catalog = await api('profiles/' + encodeURIComponent(draft.code), 'PUT', { revision: catalog.revision, profile: draft });
            if (version !== epoch) return;
            current = clone(catalog.profiles.find(p => p.code === draft.code)); baseline = clone(current); $('name').value = current.name; renderSidebar(); renderSummary(); toast('已保存，在客户端更新订阅即可生效');
            if (sourceVersion !== current.input) await inspect();
        } finally { mutating = false; $('profile-content').inert = false; }
    }
    function openImport() {
        importVersion++; importData = null; $('import-step-one').hidden = false; $('import-step-two').hidden = true; $('import-source').value = ''; $('import-file').value = ''; showError('import-error', ''); $('import-dialog').showModal();
    }
    function closeImport() { if (mutating) return; importVersion++; $('import-dialog').close(); }
    function makeCode(input) {
        let code = 'my-airport'; try { code = new URL(input.trim()).pathname.split('/').filter(Boolean).pop() || 'my-airport'; } catch { /* Pasted content gets a readable default. */ }
        code = code.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 55) || 'my-airport';
        const base = code; let i = 2; while (catalog.profiles.some(profile => profile.code === code)) code = base + '-' + i++;
        return code;
    }
    function addGroup(type = 'select') {
        if (!nodes.length) { toast('请先成功读取源订阅，再创建分组', true); return; }
        let name = type === 'url-test' ? '自动选择' : '新分组', i = 2, base = name;
        while (current.groups.some(group => group.name === name) || sourceGroups.some(group => group.name === name)) name = base + ' ' + i++;
        current.groups.push({ name, type, nodes: eligible().map(n => n.name) }); activeGroup = current.groups.length - 1; renderGroups(); renderSummary();
    }
    function addServiceGroup(service) {
        if (!eligible().length) { toast('请先读取并保留至少一个节点', true); return; }
        const existing = current.groups.findIndex(group => group.service === service);
        if (existing >= 0) { activeGroup = existing; renderGroups(); toast('此服务分组已经存在'); return; }
        const original = sourceGroups.find(group => service === 'ai' ? /AI|人工智能|ChatGPT|OpenAI|Claude/i.test(group.name) : /hyperliquid/i.test(group.name));
        if (original) { current.groups.push({ name: original.name, type: 'select', service, nodes: eligible().map(n => n.name) }); activeGroup = current.groups.length - 1; renderGroups(); renderSummary(); return; }
        let name = service === 'ai' ? 'AI' : 'Hyperliquid', base = name, i = 2;
        while (current.groups.some(group => group.name === name) || sourceGroups.some(group => group.name === name) || nodes.some(node => node.name === name)) name = base + ' ' + i++;
        const isUS = name => /(^|[\s|_-])(US|USA)(?=$|[\s|_-])|美国|🇺🇸/i.test(name);
        const preferred = eligible().filter(node => service === 'ai' ? isUS(node.name) : !isUS(node.name));
        current.groups.push({ name, service, type: 'select', nodes: (preferred.length ? preferred : eligible()).map(n => n.name) }); activeGroup = current.groups.length - 1;
        renderGroups(); renderSummary();
    }
    function clearAccountSecrets() { ['account-current', 'account-password', 'account-confirm'].forEach(id => { $(id).value = ''; }); }
    async function openAccount() {
        clearAccountSecrets(); showError('account-error', '');
        await action(null, async () => { const account = await api('account'); $('account-username').value = account.username; $('account-dialog').showModal(); $('account-current').focus(); });
    }
    async function copy() {
        try { await navigator.clipboard.writeText(link(current.code)); toast(dirty() ? '链接已复制。当前修改尚未保存，客户端仍会读取原配置。' : '订阅链接已复制'); }
        catch { tab('overview'); const range = document.createRange(); range.selectNodeContents($('export-link')); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); toast('自动复制不可用，链接已选中，请手动复制', true); }
    }
    async function logout() { await api('logout', 'POST', {}); epoch++; current = null; baseline = null; nodes = []; userinfo = null; catalog = { revision: 0, profiles: [] }; $('workspace').hidden = true; $('login-screen').hidden = false; $('savebar').hidden = true; $('source').value = ''; $('preview').value = ''; $('password').value = ''; $('password').focus(); }
    $('login').onsubmit = event => { event.preventDefault(); showError('login-error', ''); action($('login-submit'), async () => { await api('login', 'POST', { username: $('username').value.trim(), password: $('password').value }); $('password').value = ''; await load(); }, 'login-error'); };
    $('username').value = 'admin';
    $('account-open').onclick = $('account-open-mobile').onclick = openAccount;
    $('account-close').onclick = $('account-cancel').onclick = () => { if (!accountBusy) { $('account-dialog').close(); clearAccountSecrets(); } };
    $('account-dialog').oncancel = event => { if (accountBusy) event.preventDefault(); else clearAccountSecrets(); };
    $('account-form').onsubmit = event => {
        event.preventDefault(); showError('account-error', '');
        action($('account-save'), async () => {
            if ($('account-password').value !== $('account-confirm').value) throw Error('两次输入的新密码不一致');
            const value = { username: $('account-username').value.trim(), currentPassword: $('account-current').value, newPassword: $('account-password').value, confirmPassword: $('account-confirm').value };
            accountBusy = true; $('account-form').inert = true;
            try { const result = await api('account', 'PUT', value); $('username').value = result.username; clearAccountSecrets(); $('account-dialog').close(); toast('账号已更新，其他设备需重新登录；订阅链接继续有效'); }
            finally { accountBusy = false; $('account-form').inert = false; }
        }, 'account-error');
    };
    $('mobile-profiles').onchange = () => { const value = $('mobile-profiles').value; $('mobile-profiles').value = current?.code || '__new__'; leave(() => value === '__new__' ? openImport() : choose(catalog.profiles.find(p => p.code === value))); };
    $('new').onclick = $('empty-import').onclick = () => leave(openImport);
    $('refresh').onclick = $('check-source').onclick = inspect;
    $('copy').onclick = $('copy-inline').onclick = copy;
    $('name').oninput = () => { current.name = $('name').value; renderSummary(); };
    $('source').oninput = () => { current.input = $('source').value; updateDirty(); };
    $('enabled').onchange = () => { current.enabled = $('enabled').checked; renderSummary(); };
    $('save').onclick = () => action($('save'), save, 'workspace-error');
    $('discard').onclick = () => leave(() => choose(baseline));
    $('reload').onclick = () => leave(() => action($('reload'), () => load(current?.code), 'workspace-error'));
    $('logout').onclick = $('logout-mobile').onclick = () => leave(() => action($('logout-mobile'), logout));
    $('keep-editing').onclick = () => { pendingLeave = null; $('discard-dialog').close(); };
    $('confirm-discard').onclick = () => {
        const next = pendingLeave; pendingLeave = null; $('discard-dialog').close();
        current = clone(baseline); $('name').value = current.name; $('source').value = current.input; $('enabled').checked = current.enabled;
        renderSummary(); renderNodes(); renderGroups(); next?.();
    };
    $('discard-dialog').oncancel = () => { pendingLeave = null; };
    document.querySelectorAll('[data-tab]').forEach(button => {
        button.onclick = () => tab(button.dataset.tab);
        button.onkeydown = event => { const names = ['overview', 'nodes', 'groups', 'settings']; let next;
            if (event.key === 'ArrowRight') next = names[(names.indexOf(activeTab) + 1) % names.length];
            if (event.key === 'ArrowLeft') next = names[(names.indexOf(activeTab) + names.length - 1) % names.length];
            if (event.key === 'Home') next = names[0]; if (event.key === 'End') next = names[3];
            if (next) { event.preventDefault(); tab(next, true); }
        };
    });
    $('go-settings').onclick = () => tab('settings', true);
    $('node-search').oninput = $('protocol-filter').onchange = renderNodes;
    $('select-visible').onchange = () => setIncluded(visibleNodes().map(n => n.name), $('select-visible').checked);
    $('include-all').onclick = () => { current.excluded = []; renderNodes(); renderGroups(); renderSummary(); };
    $('reset-filter').onclick = () => { $('node-search').value = ''; $('protocol-filter').value = ''; renderNodes(); };
    $('add-group').onclick = () => addGroup(); $('preset-auto').onclick = () => addGroup('url-test');
    $('preset-ai').onclick = () => addServiceGroup('ai'); $('preset-hyperliquid').onclick = () => addServiceGroup('hyperliquid');
    $('generate-preview').onclick = () => action($('generate-preview'), async () => { validate(current); const version = epoch, draft = JSON.stringify(current), result = await api('preview', 'POST', current); if (version === epoch && draft === JSON.stringify(current)) { $('preview').value = result.yaml; $('preview').hidden = false; } });
    $('import-close').onclick = $('import-cancel').onclick = closeImport;
    window.addEventListener('save-converted-subscription', event => {
        if (!event.detail?.url) return;
        const url = new URL(event.detail.url, location.origin);
        if (url.origin !== location.origin) return;
        // Reuse the original converter's chosen categories and options; inline remote nodes for saved subscription management.
        url.searchParams.set('inline_subscriptions', 'true');
        $('managed-subscriptions').open = true; $('managed-subscriptions').scrollIntoView({ block: 'start' });
        if ($('workspace').hidden) { pendingConversion = url.href; toast('请先登录，再保存当前转换结果'); $('username').focus(); }
        else leave(() => { openImport(); $('import-source').value = url.href; });
    });
    $('import-dialog').oncancel = event => { if (mutating) event.preventDefault(); else importVersion++; };
    $('import-file').onchange = async () => { const file = $('import-file').files[0]; if (!file) return; if (file.size > 200000) { showError('import-error', '配置文件不能超过 200 KB'); return; } const version = importVersion; const content = await file.text(); if (version === importVersion) $('import-source').value = content; };
    $('import-inspect').onclick = () => action($('import-inspect'), async () => {
        showError('import-error', ''); const input = $('import-source').value.trim(); if (!input) throw Error('请粘贴订阅链接，或选择一个配置文件');
        const version = importVersion, result = await api('inspect', 'POST', { input }); if (version !== importVersion || !$('import-dialog').open) return;
        importData = { input, ...result }; const code = makeCode(input); $('import-name').value = code; $('import-code').value = code; text('import-link', link(code)); text('import-count', result.nodes.length);
        const u = usage(result.userinfo); text('import-usage', u.known ? '已使用 ' + u.usedLabel + (u.total ? ' / ' + u.totalLabel : '') : '源订阅未提供用量信息');
        $('import-step-one').hidden = true; $('import-step-two').hidden = false; $('import-name').focus();
    }, 'import-error');
    $('import-code').oninput = () => text('import-link', link($('import-code').value));
    $('import-back').onclick = () => { $('import-step-one').hidden = false; $('import-step-two').hidden = true; showError('import-error', ''); };
    $('import-save').onclick = () => action($('import-save'), async () => {
        showError('import-error', ''); if (!importData) throw Error('请先读取节点');
        const profile = { name: $('import-name').value.trim(), code: $('import-code').value.trim(), input: importData.input, enabled: true, excluded: [], groups: [] }; validate(profile);
        if (catalog.profiles.some(p => p.code === profile.code)) throw Error('此链接后缀已被使用，请换一个，避免覆盖现有订阅');
        mutating = true; $('import-step-two').inert = true;
        try { catalog = await api('profiles/' + encodeURIComponent(profile.code), 'PUT', { revision: catalog.revision, profile }); $('import-dialog').close(); await choose(catalog.profiles.find(p => p.code === profile.code)); toast('订阅已创建，可以复制链接添加到客户端'); }
        finally { mutating = false; $('import-step-two').inert = false; }
    }, 'import-error');
    window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
    document.addEventListener('input', event => {
        const input = event.target;
        if (input.getAttribute('aria-invalid') === 'true') {
            $(input.getAttribute('aria-describedby'))?.remove(); input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby');
        }
    });
    action(null, async () => { const session = await api('session'); if (session.authenticated) await load(); else $('password').focus(); }, 'login-error');
}
