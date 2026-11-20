const el = id => document.getElementById(id);
const panel = el('partyPanel'), controls = el('partyControls'), install = el('partyInstall');
const feedback = el('partyFeedback'), groupSelect = el('partyGroup'), profileSelect = el('partyProfile');
let state, groupName, timer, generation = 0, busy = false, message = '';
let delays = new Map();

async function api(path, body) {
  const response = await fetch('/api/clash-party' + path, body === undefined
    ? {cache:'no-store'} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw Error('代理服务未就绪');
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '请求失败');
  return data;
}

function options(select, items, selected) {
  const choices = items.map(item => new Option(item.name, item.id));
  select.replaceChildren(...choices);
  select.value = selected;
}

function showNodes() {
  const group = state?.groups.find(g => g.name === groupName);
  el('partyGroupsCard').hidden = state?.mode === 'direct';
  groupSelect.hidden = !group;
  el('partyNodesHead').hidden = !group;
  if (group) el('partyNodesHead').querySelector('b').textContent = group.selectable ? '选择节点' : '节点 · 自动策略';
  const list = el('partyNodes');
  if (!group) {
    list.textContent = '当前配置没有代理组';
    return;
  }
  const measured = delays.get(groupName);
  const rows = group.nodes.map(node => {
    const row = document.createElement('div'), pick = document.createElement('button'), test = document.createElement('button');
    row.className = 'party-node';
    pick.className = 'party-name';
    const current = node.name === group.current;
    pick.setAttribute('aria-pressed', String(current));
    pick.textContent = (current ? '✓ ' : '') + node.name;
    pick.disabled = !group.selectable;
    pick.onclick = () => act({op:'node', group:group.name, node:node.name});
    test.className = 'party-delay';
    const tested = measured?.has(node.name);
    const delay = tested ? measured.get(node.name) : node.delay;
    test.textContent = delay == null ? (tested ? '失败' : '测速') : delay === 0 ? '超时' : delay + ' ms';
    test.setAttribute('aria-label', '测试 ' + node.name + ' 的延迟');
    test.onclick = () => act({op:'delay', group:group.name, node:node.name});
    row.append(pick,test);
    return row;
  });
  list.replaceChildren(...rows);
}

function render(next) {
  if (state?.current !== next.current) delays.clear();
  if (state?.mode !== next.mode && next.mode === 'global') groupName = 'GLOBAL';
  state = next;
  for (const [id, on] of [['partySystem',state.system],['partyTun',state.tun]]) {
    el(id).setAttribute('aria-checked', String(on));
    el(id).classList.toggle('on', on);
  }
  for (const button of el('partyModes').children) button.setAttribute('aria-pressed',String(button.dataset.mode === state.mode));
  const profiles = [...state.profiles];
  if (!profiles.some(p => p.id === state.current)) profiles.unshift({name:'空白配置',id:state.current});
  options(profileSelect, profiles, state.current);
  if (!state.groups.some(g => g.name === groupName)) groupName = state.groups[0]?.name;
  options(groupSelect, state.groups.map(g => ({id:g.name,name:g.name})), groupName);
  showNodes();
}

async function refresh(current) {
  try {
    const status = await api('');
    if (current !== generation || busy) return;
    install.hidden = status.ready || status.busy;
    install.textContent = status.phase ? '重试安装或启动' : '一键安装 Clash Party';
    if (status.ready) {
      const next = await api('/panel');
      if (current !== generation || busy) return;
      if (controls.hidden || JSON.stringify(next) !== JSON.stringify(state)) render(next);
      controls.hidden = false;
      feedback.textContent = message;
    } else {
      controls.hidden = true;
      feedback.textContent = status.phase || 'Clash Party 尚未安装';
    }
  } catch (e) {
    if (current === generation && !busy) { controls.hidden = true; feedback.textContent = e.message; }
  } finally {
    if (current === generation && !busy) timer = setTimeout(() => refresh(current), 5000);
  }
}

async function act(body) {
  if (busy) return;
  busy = controls.disabled = install.disabled = true;
  clearTimeout(timer);
  generation++;
  feedback.textContent = body.op === 'delay' ? '正在测试节点延迟…' : body.op === 'import' ? '正在导入订阅…' : '正在应用…';
  try {
    if (body.op === 'delay') {
      const measured = delays.get(body.group) || new Map();
      delays.set(body.group, measured);
      const members = body.node ? [body.node] : state.groups.find(g => g.name === body.group).nodes.map(n => n.name);
      const current = generation;
      for (let start = 0; start < members.length && generation === current; start += 6) {
        feedback.textContent = '正在测速 ' + start + ' / ' + members.length;
        const result = await api('/panel', {...body, nodes:members.slice(start,start+6)});
        for (const [node, ms] of Object.entries(result.delays)) measured.set(node,ms);
        showNodes();
      }
    } else {
      await api(body.op === 'install' ? '/install' : '/panel', body);
    }
    if (body.op === 'import') el('partySubscription').reset();
    message = body.op === 'import' ? '订阅已添加' : '';
  } catch (e) { message = e.message; }
  finally {
    busy = controls.disabled = install.disabled = false;
    if (!panel.hidden) {
      feedback.textContent = message;
      if (state) render(state);
      refresh(++generation);
    }
  }
}

function select(open) {
  clearTimeout(timer);
  generation++;
  panel.hidden = !open;
  el('generalPanel').hidden = open;
  el('generalTab').setAttribute('aria-pressed',String(!open));
  el('partyTab').setAttribute('aria-pressed',String(open));
  if (open && !busy) { message = ''; refresh(generation); }
}
el('generalTab').onclick = () => select(false);
el('partyTab').onclick = () => select(true);
new MutationObserver(() => {
  if (!el('settings').classList.contains('on') && !panel.hidden) select(false);
}).observe(el('settings'), {attributes:true,attributeFilter:['class']});
install.onclick = () => act({op:'install'});
el('partySystem').onclick = () => act({op:'sys',value:!state.system});
el('partyTun').onclick = () => act({op:'tun',value:!state.tun});
el('partyModes').onclick = e => { if (e.target.dataset.mode) act({op:'mode',mode:e.target.dataset.mode}); };
el('partySubscription').onsubmit = e => {
  e.preventDefault();
  act({op:'import',url:el('partyUrl').value.trim(),name:el('partyName').value.trim()});
};
profileSelect.onchange = () => act({op:'profile',value:profileSelect.value});
groupSelect.onchange = () => { groupName = groupSelect.value; showNodes(); };
el('partyBatch').onclick = () => act({op:'delay',group:groupName});
