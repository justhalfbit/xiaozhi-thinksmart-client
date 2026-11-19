const el = id => document.getElementById(id);
const panel = el('partyPanel'), label = el('partyStatus'), install = el('partyInstall');
let timer, generation = 0, viewer;

async function refresh(current) {
  try {
    const res = await fetch('/api/clash-party', {cache:'no-store'});
    if (!res.ok) throw Error('无法读取安装状态');
    const state = await res.json();
    if (current !== generation) return;
    label.textContent = state.ready ? '' : state.phase || 'Clash Party 尚未安装';
    install.hidden = state.ready || state.busy;
    install.textContent = state.phase ? '重试安装或启动' : '一键安装 Clash Party';
    if (state.ready && !viewer) {
      const {default:RFB} = await import('/clash-view/core/rfb.js');
      if (current !== generation) return;
      const rfb = new RFB(el('partyDisplay'), 'ws://' + location.host + '/api/clash-party/display');
      viewer = rfb;
      rfb.scaleViewport = true;
      rfb.addEventListener('connect', () => { if (viewer === rfb) el('partyKeyboard').hidden = false; });
      rfb.addEventListener('disconnect', () => {
        if (viewer === rfb) {
          viewer = null;
          el('partyKeyboard').hidden = el('partyInput').hidden = true;
          label.textContent = '正在重新连接窗口';
        }
      });
    }
  } catch (e) {
    if (current === generation) label.textContent = e.message;
  } finally {
    if (current === generation) timer = setTimeout(() => refresh(current), 2000);
  }
}

function select(open) {
  clearTimeout(timer);
  generation++;
  if (viewer) { const previous = viewer; viewer = null; previous.disconnect(); }
  el('generalPanel').hidden = open;
  panel.hidden = !open;
  el('generalTab').setAttribute('aria-pressed', String(!open));
  el('partyTab').setAttribute('aria-pressed', String(open));
  el('partyKeyboard').hidden = el('partyInput').hidden = install.hidden = true;
  el('partyInput').reset();
  if (open) refresh(generation);
}
el('generalTab').onclick = () => select(false);
el('partyTab').onclick = () => select(true);
new MutationObserver(() => {
  if (!el('settings').classList.contains('on') && !panel.hidden) select(false);
}).observe(el('settings'), {attributes:true, attributeFilter:['class']});
install.onclick = async () => {
  install.disabled = true;
  try {
    const r = await fetch('/api/clash-party/install', {method:'POST'});
    if (!r.ok) throw Error('无法启动安装服务');
    label.textContent = '正在准备安装';
    install.hidden = true;
  } catch (e) { label.textContent = e.message; }
  finally { install.disabled = false; }
};
el('partyKeyboard').onclick = () => {
  el('partyInput').hidden = false;
  el('partyInput').querySelector('input').focus();
};
el('partyInput').onsubmit = async event => {
  event.preventDefault();
  const form = el('partyInput'), input = form.querySelector('input');
  if (!input.value) return;
  try {
    const r = await fetch('/api/clash-party/paste', {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text:input.value})});
    if (!r.ok) throw Error('发送失败，请重新选择窗口中的输入框');
    input.blur(); form.reset(); form.hidden = true;
  } catch (e) { label.textContent = e.message; }
};
