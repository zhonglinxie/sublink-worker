/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
function managementApp() {
    const $ = id => document.getElementById(id);
    let catalog = { revision: 0, profiles: [] }, current = null, nodes = [];
    const message = text => { $('message').textContent = text; };
    async function api(path, method = 'GET', data) {
        const r = await fetch('/admin/' + path, { method, headers: { 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
        const d = await r.json();
        if (!r.ok) { if (r.status === 401) { $('login').hidden = false; $('workspace').hidden = true; } throw Error(d.error || '请求失败'); }
        return d;
    }
    function blank() { return { code: '', name: '', input: '', enabled: true, excluded: [], groups: [] }; }
    function read() {
        return { ...current, code: $('code').value.trim(), name: $('name').value.trim(), input: $('source').value, enabled: $('enabled').checked };
    }
    function choose(profile) {
        current = structuredClone(profile || blank()); nodes = [];
        for (const id of ['code', 'name']) $(id).value = current[id];
        $('code').disabled = catalog.profiles.some(p => p.code === current.code);
        $('source').value = current.input; $('enabled').checked = current.enabled;
        $('nodes').replaceChildren(); $('usage').textContent = '点击“读取节点与用量”获取最新数据';
        $('preview').value = ''; renderGroups(); updateLink();
    }
    function updateLink() { $('export').textContent = location.origin + '/c/' + $('code').value.trim(); }
    function renderGroups() {
        $('groups').replaceChildren();
        current.groups.forEach((g, i) => {
            const row = document.createElement('div'); row.className = 'group';
            const name = document.createElement('input'); name.value = g.name; name.placeholder = '分组名称'; name.setAttribute('aria-label', '分组名称'); name.oninput = () => g.name = name.value;
            const type = document.createElement('select'); type.setAttribute('aria-label', '分组方式');
            for (const [value, label] of [['select', '手动选择'], ['url-test', '自动测速'], ['fallback', '故障切换']]) type.add(new Option(label, value));
            type.value = g.type; type.onchange = () => g.type = type.value;
            const members = document.createElement('select'); members.multiple = true; members.size = 5; members.setAttribute('aria-label', '分组节点');
            const available = [...new Set([...g.nodes, ...nodes.filter(n => !current.excluded.includes(n.name)).map(n => n.name)])];
            for (const n of available) { const o = new Option(n, n); o.selected = g.nodes.includes(n); members.add(o); }
            members.onchange = () => g.nodes = [...members.selectedOptions].map(o => o.value);
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除分组'; remove.onclick = () => { current.groups.splice(i, 1); renderGroups(); };
            row.append(name, type, members, remove); $('groups').append(row);
        });
    }
    function renderNodes() {
        $('nodes').replaceChildren();
        nodes.forEach(n => {
            const label = document.createElement('label'); label.className = 'node';
            const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !current.excluded.includes(n.name);
            check.onchange = () => { current.excluded = current.excluded.filter(x => x !== n.name); if (!check.checked) current.excluded.push(n.name); renderGroups(); };
            const text = document.createElement('span'); text.textContent = n.name + ' · ' + n.type + ' · ' + n.server + ':' + n.port;
            label.append(check, text); $('nodes').append(label);
        });
    }
    function usage(value) {
        if (!value) return '源订阅未提供用量信息';
        const pairs = Object.fromEntries(value.split(';').map(x => x.trim().split('=')));
        const gb = n => (Number(n) / 1e9).toFixed(2) + ' GB';
        const used = Number(pairs.upload || 0) + Number(pairs.download || 0);
        const total = Number(pairs.total || 0);
        return '已用 ' + gb(used) + (total ? ' / ' + gb(total) + '，剩余 ' + gb(Math.max(0, total - used)) : '') + (Number(pairs.expire) > 0 ? ' · 到期 ' + new Date(Number(pairs.expire) * 1000).toLocaleString() : '');
    }
    async function load(preferred) {
        catalog = await api('profiles'); $('profiles').replaceChildren(new Option('新建订阅', ''));
        catalog.profiles.forEach(p => $('profiles').add(new Option(p.name + (p.enabled ? '' : '（已停用）'), p.code)));
        const p = catalog.profiles.find(p => p.code === preferred); $('profiles').value = p?.code || ''; choose(p);
        $('login').hidden = true; $('workspace').hidden = false;
    }
    const run = action => async () => { try { message('处理中…'); await action(); } catch (e) { message(e.message); } };
    $('login').onsubmit = async event => { event.preventDefault(); await run(async () => { await api('login', 'POST', { password: $('password').value }); $('password').value = ''; await load(); message('登录成功'); })(); };
    $('profiles').onchange = () => choose(catalog.profiles.find(p => p.code === $('profiles').value));
    $('new').onclick = () => { $('profiles').value = ''; choose(); };
    $('code').oninput = updateLink;
    $('refresh').onclick = run(async () => {
        current = read();
        const data = await api('preview', 'POST', current); nodes = data.nodes;
        $('usage').textContent = usage(data.userinfo); $('preview').value = data.yaml;
        renderNodes(); renderGroups(); message('已读取 ' + nodes.length + ' 个节点。用量来自源订阅，多源时显示首个提供用量的来源。');
    });
    $('add-group').onclick = () => { current.groups.push({ name: '分组 ' + (current.groups.length + 1), type: 'select', nodes: nodes.filter(n => !current.excluded.includes(n.name)).map(n => n.name) }); renderGroups(); };
    $('save').onclick = run(async () => {
        current = read(); const code = current.code;
        await api('profiles/' + encodeURIComponent(code), 'PUT', { revision: catalog.revision, profile: current });
        await load(code); message('配置已保存到服务端，可在其他设备登录查看');
    });
    $('reload').onclick = run(async () => { await load(current?.code); message('已加载服务端最新配置'); });
    $('copy').onclick = run(async () => { if (!catalog.profiles.some(p => p.code === $('code').value.trim())) throw Error('请先保存订阅，再复制链接'); await navigator.clipboard.writeText($('export').textContent); message('订阅链接已复制'); });
    $('logout').onclick = run(async () => { await api('logout', 'POST', {}); $('login').hidden = false; $('workspace').hidden = true; $('source').value = ''; $('preview').value = ''; catalog = { revision: 0, profiles: [] }; current = null; nodes = []; message('已退出'); });
    run(async () => { const s = await api('session'); if (s.authenticated) await load(); message(s.authenticated ? '已加载订阅' : '请登录'); })();
}
export const AdminPage = () => <html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>订阅管理</title><style>{`
:root{font:15px system-ui;color:#17253a;background:#f5f7fa}*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:auto;padding:36px 22px}header{display:flex;justify-content:space-between;align-items:center}h1{font-size:26px;margin:0}h2{font-size:18px;margin:0 0 18px}p{line-height:1.7;color:#59677a}section,form{background:white;padding:24px;border:1px solid #dce3eb;border-radius:14px;margin:20px 0}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}input:not([type=checkbox]),select,textarea{font:inherit;background:white;border:1px solid #ccd6e2;border-radius:7px;padding:10px;max-width:100%}input[type=checkbox]{width:18px;height:18px;accent-color:#2563eb}textarea{width:100%;margin-top:8px;line-height:1.5}button{font:inherit;cursor:pointer;border:1px solid #cad5e2;border-radius:7px;padding:10px 16px;background:#fff;color:#24334a}button.primary{color:#fff;background:#2563eb;border-color:#2563eb}button:hover{filter:brightness(.96)}label{display:block;margin:10px 0}.fields{display:grid;grid-template-columns:1fr 1fr;gap:16px}.fields input{width:100%}.node{display:flex;gap:12px;align-items:center;padding:10px;border-bottom:1px solid #edf0f4;overflow-wrap:anywhere}.group{display:grid;grid-template-columns:1fr 160px;gap:10px;padding:16px;background:#f7f9fc;margin:12px 0;border-radius:8px}.group select[multiple]{grid-column:1/-1}#message{position:sticky;top:0;background:#eaf2ff;border-radius:8px;padding:14px;z-index:2;min-height:46px}#export{overflow-wrap:anywhere;font-family:monospace}#usage{font-size:18px;color:#233f66}.muted{font-size:13px}a{color:#245cba}[hidden]{display:none!important}@media(max-width:600px){.fields,.group{grid-template-columns:1fr}main{padding:24px 14px}section{padding:18px}}
`}</style></head><body><main><header><h1>订阅管理</h1><a href="/">打开转换工具</a></header><p>导入订阅、选择节点、调整分组，并用固定链接同步到客户端。</p><div id="message" role="status" aria-live="polite"></div><form id="login"><label>管理密码<input id="password" type="password" required autocomplete="current-password" /></label><button class="primary" type="submit">登录</button></form><div id="workspace" hidden><section><div class="row"><select id="profiles" aria-label="选择订阅"></select><button id="new">新建订阅</button><button id="reload">刷新配置</button><button id="logout">退出</button></div></section><section><h2>订阅与链接</h2><div class="fields"><label>显示名称<input id="name" placeholder="例如 hjy-airport" maxlength="100" /></label><label>链接后缀<input id="code" placeholder="hjy-airport" pattern="[a-zA-Z0-9_-]+" maxlength="64" /></label></div><label>源订阅或节点内容<textarea id="source" rows="5" placeholder="订阅 URL、Clash YAML、Base64 或节点分享链接" /></label><label class="row"><input id="enabled" type="checkbox" />启用此订阅</label><div class="row"><button id="refresh">读取节点与用量</button><button id="save" class="primary">保存到服务端</button><button id="copy">复制订阅链接</button></div><p id="export"></p><p class="muted">已保存的后缀保持固定。停用后，客户端更新会收到停用提示。</p></section><section><h2>用量</h2><div id="usage"></div></section><section><h2>导出节点</h2><p class="muted">取消勾选可从导出配置中排除节点。</p><div id="nodes"></div></section><section><h2>节点分组</h2><p>第一个分组作为默认出口；不创建分组时，自动生成包含全部选中节点的选择组。</p><p class="muted">支持手动选择、自动测速、故障切换。按住 Command / Ctrl 可多选分组节点。</p><div id="groups"></div><button id="add-group">添加分组</button></section><section><h2>配置预览</h2><textarea id="preview" rows="8" readonly aria-label="导出配置预览" /></section></div></main><script dangerouslySetInnerHTML={{ __html: `(${managementApp.toString()})();` }} /></body></html>;
