// ThinkSmart voice client page v2: renders what the client streams on /events and sends the buttons back.
// Same contract as v1. Open with ?demo (or ?demo=<scene>) to preview without a client.
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');
const WEEK = 'SMTWTFS';
const DEMO = new URLSearchParams(location.search).get('demo');   // null when not a demo
if (DEMO !== null && /[?&]still\b/.test(location.search)) document.documentElement.classList.add('still');

const ui = {
  status: { state: 'idle', connected: false, uploading: false },
  models: { current: null, options: [] },
  thread: { entry: null, messages: [] },
  ptt: false,
  alarms: { synced: true, items: [], missed: [], ringing: null, volume: 70, tone: 'coffee', tones: {} },
  bluetooth: null,
};

const SUGGEST = [
  ['What is the weather in Beijing tomorrow?', '#ffb54729', '#ffcf7a', '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>'],
  ['Help me plan the weekend', '#5ee0ff24', '#8ff0ff', '<path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/>'],
  ['Tell me a bad joke', '#ff7ac824', '#ff9bd6', '<circle cx="12" cy="12" r="9"/><path d="M8 14.5a5 5 0 0 0 8 0M9 9.5h.01M15 9.5h.01"/>'],
  ['Turn the volume down a bit', '#9b7bff2b', '#c8b4ff', '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 12h4"/>'],
];

/* ---- clock ---- */
function tick() {
  const now = new Date();
  const hm = pad(now.getHours()) + ':' + pad(now.getMinutes());
  $('time').textContent = hm;
  $('bigTime').textContent = hm;
  $('bigDate').textContent = `${now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`;
  const h = now.getHours();
  $('greet').textContent = h < 5 ? 'It is late' : h < 9 ? 'Good morning' : h < 12 ? 'Good morning' : h < 14 ? 'Good afternoon' : h < 18 ? 'Good afternoon' : h < 23 ? 'Good evening' : 'It is late';
  $('ringTime').textContent = hm;
  tickAlarms();
}

/* ---- the orb's corona: 48 bars around the orb, one shape per state ----
   idle: short and still. connecting: 12 dashes, turned slowly by CSS. thinking: a comet orbiting (CSS).
   listening: the whole ring pushes outward with your voice, all bars together — loud is big, quiet barely moves.
   speaking: three lobes turning round the ring, swelling with the reply's volume.
   Only listening/speaking redraw every frame; any state change morphs the bars over 0.4 s, then the loop stops.
   All bars are drawn on one canvas: as 48 elements, restyling them 30 times a second kept
   the device main thread at ~93% and the page at ~17 fps. */
const BARS = 48, R_IN = 110, BAR_W = 6, REST = 8, REACH = 46;   // px; REST + REACH stays inside the canvas
const corona = document.createElement('canvas');
const CSIZE = 330, DPR = Math.min(2, window.devicePixelRatio || 1);
corona.width = corona.height = CSIZE * DPR;
corona.style.width = corona.style.height = '100%';
$('corona').appendChild(corona);
const cx = corona.getContext('2d');
const ANG = Array.from({ length: BARS }, (_, i) => i / BARS * Math.PI * 2);
const COS = ANG.map(Math.cos), SIN = ANG.map(Math.sin);
// per bar: [length px, opacity]; what is on screen, where a morph starts, and where the state wants it
const cur = new Float32Array(BARS * 2), from = new Float32Array(BARS * 2), tgt = new Float32Array(BARS * 2);
let barFill = null, barFillState = '';
function fillFor(state) {
  // one radial gradient for all bars: inner end --c2, outer end --c1
  if (barFillState !== state) {
    const css = getComputedStyle(document.body);
    barFill = cx.createRadialGradient(0, 0, R_IN, 0, 0, R_IN + REST + REACH);
    barFill.addColorStop(0, css.getPropertyValue('--c2').trim());
    barFill.addColorStop(1, css.getPropertyValue('--c1').trim());
    barFillState = state;
  }
  return barFill;
}
// Bars of (nearly) the same opacity share one path and one fill: 48 separate fills cost the device
// main thread ~20% of a core while speaking. The path takes each bar's transform as it is added.
const bucket = new Uint8Array(BARS);
function drawBars(bars) {
  const c = CSIZE * DPR / 2;
  cx.setTransform(1, 0, 0, 1, 0, 0);
  cx.clearRect(0, 0, corona.width, corona.height);
  cx.fillStyle = fillFor(document.body.dataset.state || 'idle');
  for (let i = 0; i < BARS; i++) bucket[i] = bars[i * 2] < .5 ? 0 : Math.max(1, Math.round(bars[i * 2 + 1] * 20));
  for (let q = 1; q <= 20; q++) {
    if (!bucket.includes(q)) continue;
    cx.beginPath();
    for (let i = 0; i < BARS; i++) {
      if (bucket[i] !== q) continue;
      cx.setTransform(COS[i] * DPR, SIN[i] * DPR, -SIN[i] * DPR, COS[i] * DPR, c, c);
      cx.roundRect(-BAR_W / 2, -R_IN - bars[i * 2], BAR_W, bars[i * 2], BAR_W / 2);
    }
    cx.setTransform(DPR, 0, 0, DPR, c, c);   // the radial gradient is centred on the orb
    cx.globalAlpha = q / 20;
    cx.fill();
  }
  cx.globalAlpha = 1;
}

// target shape of a state into out; v = sound level 0..1, p = phase (s), t = seconds in this state
function shapeOf(state, v, p, t, out) {
  for (let i = 0; i < BARS; i++) {
    const a = ANG[i], f = i / BARS;
    let len = REST, alpha = 1;
    if (state === 'thinking') { len = 6.6 + 28.5 * f * f; alpha = .1 + .9 * f ** 1.6; }
    else if (state === 'connecting') { len = i % 4 ? 4.2 : 16.5; alpha = i % 4 ? .35 : 1; }
    else if (state === 'listening') {
      // a short burst on waking says "I'm here", then the ring follows the voice as one
      const env = Math.max(v, .5 * Math.max(0, 1 - t / .6) ** 2);
      const grain = .84 + .16 * Math.sin(a * 5 + p * 3.1) * Math.sin(a * 3 - p * 2.3);
      len = REST - 1 + 1.2 * Math.sin(a * 4 + p * 1.5) + REACH * env * grain;
    } else if (state === 'speaking') {
      const lobe = .5 + .5 * Math.sin(a * 3 - p * 1.3);
      len = REST + 4 * lobe + REACH * v * (.3 + .7 * lobe);
      alpha = .6 + .4 * lobe;
    }
    out[i * 2] = len;
    out[i * 2 + 1] = alpha;
  }
}

// The mic level (RMS) in decibels, so a quiet voice visibly moves the corona. Measured on the device
// (2026-11-01, 9 listening turns): room noise -74..-80 dBFS with rare blips to -62, normal speech
// -60..-42 dBFS. The old linear scale (full at -23 dBFS) moved the corona 1–7% for that speech.
// Now noise stays 0, a quiet voice (-55) reaches ~30%, a normal one (-45) ~58%, a loud one (-30) 100%.
const MIC_FLOOR = -66, MIC_FULL = -30;   // dBFS
const micLevel = rms => Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-6) - MIC_FLOOR) / (MIC_FULL - MIC_FLOOR)));

const STILL = document.documentElement.classList.contains('still');
const level = { target: 0, value: 0, phase: 0, raf: 0, last: 0, state: '', since: 0, mix: 1 };
const isLive = s => s === 'listening' || s === 'speaking';
function setCorona(state) {
  if (state === level.state) return;
  // morph from what is on screen; a spinning corona is turned by CSS, so carry its angle into the bars
  const m = getComputedStyle($('corona')).transform.match(/matrix\(([^,]+),\s*([^,]+)/);
  const k = m ? Math.round(Math.atan2(+m[2], +m[1]) / (Math.PI * 2) * BARS) : 0;
  for (let i = 0; i < BARS; i++) {
    const j = ((i - k) % BARS + BARS) % BARS;
    from[i * 2] = cur[j * 2]; from[i * 2 + 1] = cur[j * 2 + 1];
  }
  level.state = state;
  level.since = performance.now();
  level.mix = level.last ? 0 : 1;   // the first paint just draws
  if (!isLive(state)) level.target = 0;
  if (STILL) {   // screenshots: one fairly loud, settled frame
    shapeOf(state, isLive(state) ? .7 : 0, 1.2, 9, cur);
    drawBars(cur);
    if (isLive(state)) drawLive(.7, 1.2);
    return;
  }
  if (!level.raf) {
    level.last = performance.now() - 34;
    level.raf = requestAnimationFrame(levelLoop);
  }
}
function levelLoop(now) {
  level.raf = requestAnimationFrame(levelLoop);
  if (now - level.last < 33) return;      // ~30 fps is plenty
  const dt = Math.min(.1, (now - level.last) / 1000);
  level.last = now;
  level.value += (level.target - level.value) * (level.target > level.value ? .55 : .2);
  level.phase += dt * 2.4;
  const live = isLive(level.state);
  shapeOf(level.state, level.value, level.phase, (now - level.since) / 1000, tgt);
  if (level.mix < 1) {
    level.mix = Math.min(1, level.mix + dt / .4);
    const e = 1 - (1 - level.mix) ** 3;
    for (let i = 0; i < tgt.length; i++) cur[i] = from[i] + (tgt[i] - from[i]) * e;
  } else cur.set(tgt);
  drawBars(cur);
  if (live || level.mix < 1) drawLive(level.value, level.phase);   // after live: let the level settle
  else {
    cancelAnimationFrame(level.raf);
    level.raf = 0;
    level.target = level.value = 0;
    $('corona').style.transform = $('core').style.transform = $('micRing').style.transform = $('mouth').style.transform = '';
  }
}
// The whole corona layer grows with the level too (compositor only, no repaint): with the longer bars,
// the tips go from r ≈ 117 px when quiet to ≈ 190 px when loud. Core, mouth, mic ring and the wave follow.
function drawLive(v, p) {
  $('corona').style.transform = `scale(${(1 + v * .16).toFixed(3)})`;
  $('core').style.transform = `scale(${(1 + v * .13).toFixed(3)})`;
  $('mouth').style.transform = `scaleY(${(.55 + v * 1.6).toFixed(3)})`;
  if (level.state === 'listening') $('micRing').style.transform = `scale(${(1 + v * .16).toFixed(3)})`;   // invisible otherwise
  const pending = $('pending');
  if (pending) pending.querySelectorAll('.wave b').forEach((b, i) => { b.style.transform = `scaleY(${(.18 + v * (.5 + .5 * Math.sin(p * 3 + i * 1.3))).toFixed(3)})`; });
}

/* ---- status: orb, title, hint, buttons ---- */
function modelName() {
  const cur = ui.models.current;
  return cur ? cur.label : 'Model';
}
const shownState = () => (ui.ptt ? 'listening' : ui.status.state);

function renderStatus() {
  const { state, connected } = ui.status;
  const shown = shownState();
  document.body.dataset.state = shown;
  const text = {
    idle: ['Say <em>“Xiaomai Xiaomai”</em>', connected ? 'Chat is kept; wake to continue' : 'Or tap the mic; hold to talk'],
    connecting: ['Connecting…', 'Listening starts once the Xiaozhi hub is connected'],
    listening: ui.ptt ? ['Release to <em>send</em>', 'Release when finished'] : ['I am listening', 'Pause when you finish and I will answer'],
    thinking: [`<em>${esc(modelName())}</em> is thinking`, 'Harder questions may take a moment'],
    speaking: ['Speaking', 'Say “Xiaomai Xiaomai” or tap Stop'],
  }[shown] || ['', ''];
  if (ui.status.recognising && !ui.ptt) text.splice(0, 2, 'Recognizing', 'Turning what you said into text');
  const micOff = ui.status.mic === false;
  document.body.classList.toggle('mic-off', micOff);
  const reports = ui.status.reports || 0;
  const sleeping = !!(ui.status.sleep && ui.status.sleep.active);
  document.body.classList.toggle('has-reports', reports > 0);
  document.body.classList.toggle('sleeping', sleeping);
  $('reportText').textContent = reports > 1 ? `${reports} reports waiting` : '1 report waiting';
  if (micOff && shown === 'idle') text.splice(0, 2, 'Mic is off', 'Flip the side mic switch to talk');
  else if (reports && shown === 'idle') text[1] = 'Report waiting: tap top-right, or say “Xiaomai Xiaomai”';
  else if (sleeping && shown === 'idle' && !connected) text[1] = 'Sleep hours: reports will not be spoken';
  $('title').innerHTML = text[0];
  $('hint').textContent = text[1];
  // recognising, thinking or speaking: the turn can be interrupted (the question is dropped if nothing was said yet)
  $('btnAbort').disabled = !connected || !(state === 'speaking' || state === 'thinking' || (ui.status.recognising && !ui.ptt));
  $('btnEnd').disabled = !connected;
  const link = $('link');
  link.classList.toggle('on', connected);
  link.querySelector('span').textContent = connected ? 'In conversation' : 'Idle';
  renderSide();
  renderPending();
  setCorona(shown);
  renderSettings();
  renderBright();
  renderScreenOff();
  renderVol();
  renderUpdate();
}

/* ---- models ---- */
const logoSrc = m => (m && m.logo ? `/static/logos/${m.logo}.svg` : '');

function renderModels() {
  const cur = ui.models.current;
  $('pillLogo').src = logoSrc(cur);
  $('pillLabel').textContent = cur ? cur.label : 'Choose model';
  $('pillModel').textContent = cur ? (cur.model || cur.company || '') : '';
  const grid = $('grid');
  grid.textContent = '';
  for (const m of ui.models.options) {
    const on = cur && cur.entry === m.entry;
    const b = document.createElement('button');
    b.className = 'card' + (on ? ' on' : '');
    b.innerHTML = `<img class="tile" src="${esc(logoSrc(m))}" alt="">` + (on ? '<span class="badge">In use</span>' : '') +
      `<span><b>${esc(m.label)}</b><small>${esc(m.model || '')}</small><small class="co">${esc(m.company || '')}</small></span>`;
    b.addEventListener('click', () => switchModel(m));
    grid.appendChild(b);
  }
  renderHead();
}

function openSheet(on) {
  $('sheet').classList.toggle('on', on);
}

// The page switches at once and the hub catches up; if it fails, back to what the client last said.
// While a switch is on its way, the client's events about the old model do not flip the page back.
const server = { models: null, thread: null };
const seenThreads = {};   // entry -> the client's messages for that model, shown at once when switching to it
let switching = null;

async function switchModel(m) {
  openSheet(false);
  if (ui.models.current && ui.models.current.entry === m.entry) return;
  if (DEMO) return demo.switchTo(m);
  switching = m.entry;
  ui.models = Object.assign({}, ui.models, { current: m });
  ui.thread = { entry: m.entry, messages: seenThreads[m.entry] || [] };
  renderModels(); renderThread(); renderStatus();
  let error = null;
  try {
    const r = await (await fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                 body: JSON.stringify({ kind: m.kind, vendor: m.vendor, entry: m.entry }) })).json();
    if (r.ok === false) error = r.error || 'Switch failed';
  } catch (e) {
    error = 'Switch failed: client not responding';
  }
  if (switching !== m.entry) return;   // another switch since
  switching = null;
  if (server.models) ui.models = server.models;
  if (server.thread) ui.thread = server.thread;
  renderModels(); renderThread(); renderStatus();
  toast(error || `Switched to ${m.label}`, error ? 'error' : '');
}

/* ---- settings: sleep hours ---- */
const sleepEdit = {};   // changes sent but not yet confirmed by a state event
let sleepTimer = null;
function sleepSetting() {
  return Object.assign({ enabled: false, start: '22:00', end: '07:00', active: false }, ui.status.sleep || {}, sleepEdit);
}
function renderSettings() {
  const s = sleepSetting();
  $('sleepSwitch').setAttribute('aria-checked', String(s.enabled));
  $('sleepTimes').classList.toggle('off', !s.enabled);
  $('sleepStart').textContent = s.start;
  $('sleepEnd').textContent = s.end;
  $('sleepNote').textContent = !s.enabled ? 'Sleep hours off: reports are spoken, volume and brightness as usual'
    : s.active ? `Sleep hours until ${s.end}` : `Sleep hours ${s.start}–${s.end} daily; not in them now`;
}
function sendSleep(changes, delay) {
  Object.assign(sleepEdit, changes);
  renderSettings();
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(async () => {
    const body = Object.assign({}, sleepEdit);
    if (DEMO) { ui.status.sleep = Object.assign(sleepSetting(), body); for (const k in body) delete sleepEdit[k]; return renderStatus(); }
    try {
      const r = await (await fetch('/api/sleep', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                   body: JSON.stringify(body) })).json();
      if (r.ok === false) toast(r.error || 'Could not save', 'error');
    } catch (e) {
      toast('Could not save: client not responding', 'error');
    }
    for (const k in body) if (sleepEdit[k] === body[k]) delete sleepEdit[k];
    renderSettings();
  }, delay);
}
function stepTime(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = ((h * 60 + m + minutes) % 1440 + 1440) % 1440;
  return pad(Math.floor(t / 60)) + ':' + pad(t % 60);
}
$('sleepSwitch').addEventListener('click', () => sendSleep({ enabled: !sleepSetting().enabled }, 0));
for (const b of document.querySelectorAll('.stepper button')) {
  b.addEventListener('click', () => sendSleep({ [b.dataset.k]: stepTime(sleepSetting()[b.dataset.k], Number(b.dataset.d)) }, 600));
}
/* ---- settings: screen brightness (the client hints the system's screen blanker) ---- */
let brightEdit = null;   // the slider's value while the finger is on it or the change is on its way
let brightTimer = null, brightSent = 0, brightDrag = false;
function brightSetting() {
  return Object.assign({ level: 100, dimmed: false }, ui.status.brightness || {},
                       brightEdit === null ? {} : { level: brightEdit, dimmed: false });
}
function renderBright() {
  const b = brightSetting();
  if (brightEdit === null) $('brightRange').value = b.level;
  $('brightRange').style.setProperty('--fill', b.level + '%');
  $('brightNum').textContent = b.level + '%';
  $('brightNote').textContent = b.dimmed ? 'Sleep hours dim the screen; drag the slider for this period'
    : 'Brightness stays after blanking. You can also say “Xiaomai Xiaomai, brighter” or “full brightness.”';
}
async function sendBright(body) {
  if (DEMO) { ui.status.brightness = { level: body.level, dimmed: false }; return; }
  try {
    const r = await (await fetch('/api/brightness', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                       body: JSON.stringify(body) })).json();
    if (r.ok === false) toast(r.error || 'Could not save', 'error');
  } catch (e) {
    toast('Could not save: client not responding', 'error');
  }
}
// The slider follows the finger itself (pointer events, like the mic button) instead of relying on
// the browser's own range dragging under touch. While dragging: at most one change every 150 ms
// (the blanker looks every 200 ms); the last one on release.
function dragBright(e) {
  const r = $('brightRange').getBoundingClientRect(), thumb = 48;
  brightEdit = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left - thumb / 2) / (r.width - thumb))) * 100);
  $('brightRange').value = brightEdit;
  renderBright();
  clearTimeout(brightTimer);
  const send = () => { brightSent = Date.now(); sendBright({ level: brightEdit }); };
  if (Date.now() - brightSent > 150) send();
  else brightTimer = setTimeout(send, 150);
}
$('brightRange').addEventListener('pointerdown', e => {
  e.preventDefault();
  brightDrag = true;
  try { $('brightRange').setPointerCapture(e.pointerId); } catch (err) { /* keeps following without capture */ }
  dragBright(e);
});
$('brightRange').addEventListener('pointermove', e => {
  if (brightDrag) dragBright(e);
});
function dropBright() {
  if (!brightDrag) return;
  brightDrag = false;
  clearTimeout(brightTimer);
  const level = brightEdit;
  sendBright({ level }).then(() => { if (brightEdit === level) brightEdit = null; renderStatus(); });
}
$('brightRange').addEventListener('pointerup', dropBright);
$('brightRange').addEventListener('pointercancel', dropBright);

/* ---- settings: auto screen-off (the client hints the system's screen blanker) ---- */
const offEdit = {};   // a change on its way
function offSetting() {
  return Object.assign({ enabled: true, minutes: 5 }, ui.status.screen_off || {}, offEdit);
}
function renderScreenOff() {
  const s = offSetting();
  $('offSwitch').setAttribute('aria-checked', String(s.enabled));
  $('offMinutes').classList.toggle('off', !s.enabled);
  for (const b of $('offMinutes').children) b.classList.toggle('on', Number(b.dataset.m) === s.minutes);
  $('offNote').textContent = s.enabled ? `Screen off after ${s.minutes} min idle with no conversation` : 'Screen stays on; no auto-off';
}
async function sendScreenOff(changes) {
  Object.assign(offEdit, changes);
  renderScreenOff();
  if (DEMO) { ui.status.screen_off = offSetting(); for (const k in changes) delete offEdit[k]; return renderStatus(); }
  try {
    const r = await (await fetch('/api/screen-off', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                      body: JSON.stringify(changes) })).json();
    if (r.ok === false) toast(r.error || 'Could not save', 'error');
  } catch (e) {
    toast('Could not save: client not responding', 'error');
  }
  for (const k in changes) if (offEdit[k] === changes[k]) delete offEdit[k];
  renderScreenOff();
}
$('offSwitch').addEventListener('click', () => sendScreenOff({ enabled: !offSetting().enabled }));
for (const b of $('offMinutes').children) b.addEventListener('click', () => sendScreenOff({ minutes: Number(b.dataset.m) }));

/* ---- settings: volumes (the device, which the keys and voice change too, and the alarms' own) ---- */
// Same finger-following slider as the brightness: at most one change every 150 ms while dragging, the
// last one on release; what the client says meanwhile doesn't move the thumb under the finger.
function slider(id, numId, get, send) {
  const el = $(id);
  let edit = null, timer = null, sent = 0, drag = false;
  function render() {
    const v = edit === null ? get() : edit;
    if (edit === null && v != null) el.value = v;
    el.style.setProperty('--fill', (v == null ? 0 : v) + '%');
    $(numId).textContent = v == null ? '' : v + '%';
  }
  function move(e) {
    const r = el.getBoundingClientRect(), thumb = 48;
    edit = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left - thumb / 2) / (r.width - thumb))) * 100);
    el.value = edit;
    render();
    clearTimeout(timer);
    const go = () => { sent = Date.now(); send(edit); };
    if (Date.now() - sent > 150) go();
    else timer = setTimeout(go, 150);
  }
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    drag = true;
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* keeps following without capture */ }
    move(e);
  });
  el.addEventListener('pointermove', e => { if (drag) move(e); });
  function drop() {
    if (!drag) return;
    drag = false;
    clearTimeout(timer);
    const v = edit;
    Promise.resolve(send(v)).then(() => { if (edit === v) edit = null; render(); });
  }
  el.addEventListener('pointerup', drop);
  el.addEventListener('pointercancel', drop);
  return render;
}
async function postJson(path, body) {
  try {
    const r = await (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                         body: JSON.stringify(body || {}) })).json();
    if (r.ok === false) toast(r.error || 'Could not save', 'error');
    return r;
  } catch (e) {
    toast('Could not save: client not responding', 'error');
    return { ok: false };
  }
}
const renderVol = slider('volRange', 'volNum', () => ui.status.volume,
  v => (DEMO ? (ui.status.volume = v) : postJson('/api/volume', { volume: v })));
const renderAlarmVol = slider('alarmVolRange', 'alarmVolNum', () => ui.alarms.volume,
  v => (DEMO ? (ui.alarms.volume = v) : postJson('/api/alarm-volume', { volume: v })));

/* ---- countdowns, alarms and reminders (alarms.py: the client keeps and rings them) ---- */
const KIND_ICON = { timer: 'Timer', alarm: 'Alarm', reminder: 'Reminder' };
const now_s = () => Date.now() / 1000;
function hhmm(t) {
  const d = new Date(t * 1000);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function dayText(t) {
  const d = new Date(t * 1000), today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 86400000);
  return { '-1': 'Yesterday', 0: 'Today', 1: 'Tomorrow', 2: 'In 2 days' }[days] || `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`;
}
function left(t) {
  const s = Math.max(0, Math.round(t - now_s()));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return (h ? h + ':' + pad(m) : m) + ':' + pad(s % 60);
}
function alarmRow(v) {
  if (v.kind === 'timer') {
    return [`<span data-left="${v.at}">${left(v.at)}</span>${v.label ? ' ' + esc(v.label) : ''}`,
            `Timer, rings ${hhmm(v.at)}${v.snoozed ? ' · snoozed' : ''}`];
  }
  const sub = [dayText(v.at)];
  if (v.repeat) sub.push(esc(v.repeat));
  if (v.snoozed) sub.push('Snoozed');
  if (v.kind === 'reminder') sub.push(v.spoken ? 'Spoken at the time' : v.spoken === false ? 'Ring only (no spoken line)' : 'Synthesizing speech');
  return [`${hhmm(v.at)}${v.label ? ' ' + esc(v.label) : ''}`, sub.join(' · ')];
}
function renderAlarms() {
  const a = ui.alarms;
  document.body.classList.toggle('alarms-paused', !a.synced);
  document.body.classList.toggle('ringing', !!a.ringing);
  document.body.classList.toggle('has-timer', a.items.some(v => v.kind === 'timer'));
  // home: the running countdowns and the next alarm or reminder
  const timers = a.items.filter(v => v.kind === 'timer').slice(0, 3);
  const next = a.items.find(v => v.kind !== 'timer');
  const chips = timers.map(v => `<div class="na timer">Timer <b data-left="${v.at}">${left(v.at)}</b>${v.label ? esc(v.label) : ''}</div>`);
  if (next) chips.push(`<div class="na">${KIND_ICON[next.kind]} <b>${dayText(next.at)} ${hhmm(next.at)}</b>${esc(next.label || '')}</div>`);
  if (!a.synced && a.items.length) chips.unshift('<div class="na paused">Clock not synced; alarms paused</div>');
  $('nextAlarms').innerHTML = chips.join('');
  // settings: the list, the tones, the missed ones
  $('alarmCount').textContent = a.items.length ? `${a.items.length} items` : '';
  $('alarmList').innerHTML = a.items.length ? a.items.map(v => {
    const [main, sub] = alarmRow(v);
    return `<div class="al ${v.kind}"><i>${KIND_ICON[v.kind]}</i><div class="al-text"><b>${main}</b><span>${sub}</span></div>` +
      `<button class="al-del" data-id="${v.id}">Delete</button></div>`;
  }).join('') : '<div class="alarm-empty">No alarms or reminders yet</div>';
  $('tones').innerHTML = Object.entries(a.tones || {}).map(([k, name]) =>
    `<button data-tone="${esc(k)}" class="${k === a.tone ? 'on' : ''}">${esc(name)}</button>`).join('');
  // home: the missed ones (newest first, at most 3 shown) until Got it
  $('missedBox').hidden = !a.missed.length;
  $('missedList').innerHTML = a.missed.slice(0, 3).map(m =>
    `<div class="mh"><b>${dayText(m.at)} ${hhmm(m.at)}</b>${KIND_ICON[m.kind] || ''}${m.label ? ' · ' + esc(m.label) : ''}` +
    `<small>${m.why === 'off' ? 'Device was off' : m.kind === 'reminder' ? 'Reminder rang 3 min' : 'Rang 10 min'}</small></div>`).join('') +
    (a.missed.length > 3 ? `<div class="mh more">${a.missed.length - 3} more</div>` : '');
  renderAlarmVol();
  renderRing();
  tickAlarms();
}
function renderRing() {
  const r = ui.alarms.ringing;
  if (!r) return;
  const items = r.items || [];
  $('ringKind').textContent = [...new Set(items.map(v => KIND_ICON[v.kind] || v.type))].join(', ') || 'Alarm';
  $('ringLabel').textContent = items.map(v => v.label).filter(Boolean).join(', ');
  $('ringNote').textContent = (r.notes || []).join('; ');
}
function tickAlarms() {
  for (const el of document.querySelectorAll('[data-left]')) el.textContent = left(Number(el.dataset.left));
  const timer = ui.alarms.items.find(v => v.kind === 'timer');
  $('timerText').textContent = timer ? left(timer.at) : '';
}
$('alarmList').addEventListener('click', e => {
  const b = e.target.closest('.al-del');
  if (!b) return;
  if (!b.classList.contains('armed')) {
    b.classList.add('armed');
    b.textContent = 'Confirm delete';
    setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Delete'; }, 4000);
    return;
  }
  if (DEMO) { ui.alarms.items = ui.alarms.items.filter(v => v.id !== Number(b.dataset.id)); return renderAlarms(); }
  postJson('/api/alarms/delete', { id: Number(b.dataset.id) }).then(r => { if (r.ok) toast('Deleted'); });
});
$('tones').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (DEMO) { ui.alarms.tone = b.dataset.tone; return renderAlarms(); }
  postJson('/api/alarm-tone', { tone: b.dataset.tone }).then(() => postJson('/api/alarm-tone', { tone: b.dataset.tone, preview: true }));
});
$('missedClear').addEventListener('click', () => (DEMO ? handlers.alarms(Object.assign({}, ui.alarms, { missed: [] }))
                                                       : postJson('/api/alarms/missed/clear')));
$('ringStop').addEventListener('click', () => post('/api/alarms/stop'));
$('ringSnooze').addEventListener('click', () => {
  if (DEMO) return post('/api/alarms/snooze');
  postJson('/api/alarms/snooze').then(r => { if (r.ok) toast('OK, 10 more minutes'); });   // postJson shows the error
});

/* ---- settings: software update (update.py: the root updater installs, the page only asks) ---- */
const UPD_STAGE = { preparing: 'Preparing', downloading: 'Downloading', installing: 'Installing',
                    testing: 'Rebooting and checking', rolling_back: 'Check failed, rolling back' };
let updArmed = 0;   // first tap on Update arms it, a second one within 5 s installs
let updStarting = 0;   // request sent, the updater hasn't reported yet (it takes a few seconds to start)
const mb = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
function ago(t) {
  const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60));
  return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
// After an update: the state it left, both versions, whatever this run installed. One tap installs
// the system layer and then the client, and an older updater keeps only the last one's message
// (already updated to 0.1.5); the versions themselves are always right.
function updDoneText(u, job) {
  const sys = (u || {}).system || {};
  if (!sys.current || !ui.version) return job.message || 'Update complete';
  return `Updated: system ${sys.current} · client ${ui.version}`
    + (/apply after reboot|重启设备后生效/.test(job.message || '') ? '; some changes apply after reboot' : '');
}
function updParts(u) {
  // what one tap installs, in the updater's order: the system layer (shell, audio...) first
  const parts = [], sys = u.system || {}, sa = sys.available;
  if (sa && !(sa.missing || []).length) parts.push({ key: 'system', name: 'System', ...sa });
  if (u.available) parts.push({ key: 'client', name: 'Client', ...u.available });
  return parts;
}
function renderUpdate() {
  const u = ui.update || {}, job = u.job || {}, sys = u.system || {};
  const parts = updParts(u), avail = parts.length > 0;
  const busy = job.state in UPD_STAGE;
  // between the confirming tap and the updater's first report: do not show the Update button again
  // (it looks like the tap missed). Ends when the updater reports (busy, or a result newer than the
  // tap) or after 30 s of silence.
  if (updStarting && (busy || (job.time || 0) * 1000 > updStarting - 2000 || Date.now() - updStarting > 30000)) updStarting = 0;
  const starting = !!updStarting;
  const recent = !!job.time && Date.now() / 1000 - job.time < 86400;
  const failed = !busy && recent && (job.state === 'failed' || job.state === 'rolled_back');
  const cur = !ui.version ? '' : sys.current ? `Client ${ui.version} · system ${sys.current}` : `Current ${ui.version}`;
  // a system layer this image can't take (it needs packages only a newer image has)
  const blocked = sys.available && (sys.available.missing || []).length
    ? `System ${sys.available.version} needs a reflash` : '';
  let title = 'Software update', text, bad = false, label = '', notes = '';
  if (!u.enabled) text = (cur ? cur + '。' : '') + 'Update service is not installed';
  else if (starting) {
    title = 'Starting update…';
    text = 'Connecting to the update server';
  } else if (busy) {
    const what = job.component === 'system' ? 'System' : 'Client';
    title = `Updating ${what} ${job.version}`;
    const pct = job.state === 'downloading' && job.progress != null ? ` ${Math.round(job.progress * 100)}%` : '';
    text = `${UPD_STAGE[job.state]}${pct}。` + (job.component === 'system' ? 'The screen may flash, ' : '')
      + 'voice pauses; do not unplug';
  } else if (avail) {
    title = 'New version ' + parts.map(p => `${p.name} ${p.version}`).join(' · ');
    text = failed ? job.message + '. You can try again'
      : `${cur}, download about ${mb(parts.reduce((n, p) => n + (p.size || 0), 0))}` + (blocked ? `。${blocked}` : '');
    bad = failed;
    if (Date.now() - updArmed < 5000) {
      // waiting for the confirming tap: the hint stays on the card for those 5 s
      bad = false;
      text = `Voice pauses during update (about ${parts.length > 1 ? 2 : 1} min)`
        + (parts.some(p => p.key === 'system') ? ', screen may flash' : '') + '. Tap Confirm update again to start';
    }
    notes = parts.map(p => (parts.length > 1 ? `<li class="h">${p.name} ${esc(p.version)}</li>` : '')
                          + (p.notes || []).map(n => `<li>${esc(n)}</li>`).join('')).join('');
    label = Date.now() - updArmed < 5000 ? 'Confirm update' : 'Update';
  } else {
    text = recent && job.state === 'done' ? `${updDoneText(u, job)}, up to date`
      : failed ? job.message
      : u.check_error ? `${cur}。${u.check_error}`
      : blocked ? `${cur}。${blocked}`
      : `${cur}, up to date` + (u.checked ? ` (checked ${ago(u.checked)})` : '');
    bad = failed || (!!u.check_error && !(recent && job.state === 'done'));
    label = 'Check for updates';
  }
  $('gearDot').classList.toggle('on', avail && !busy && !starting);
  $('updTitle').textContent = title;
  $('updSub').textContent = text;
  $('updSub').classList.toggle('bad', !!bad);   // toggle(x, undefined) would flip it
  $('updNotes').innerHTML = notes;
  const btn = $('updBtn');
  btn.hidden = !label;
  btn.textContent = label;
  btn.disabled = avail && ui.status.state !== 'idle';   // not in the middle of a conversation
  $('upd').classList.toggle('new', avail && !busy && !starting);
  $('updBar').hidden = !busy && !starting;
  $('updBar').classList.toggle('busy', starting || (busy && job.state !== 'downloading'));
  $('updFill').style.transform = job.state === 'downloading' ? `scaleX(${job.progress || 0})` : '';
}
function updateFinished(job) {
  // once per install, also when the page reloaded because the client restarted with the new version
  if (!job || !(job.state === 'done' || job.state === 'rolled_back' || job.state === 'failed')) return;
  if (Date.now() / 1000 - job.time > 300) return;
  try { if (localStorage.getItem('updShown') === String(job.time)) return; localStorage.setItem('updShown', String(job.time)); } catch (e) { /* no storage */ }
  toast(job.state === 'done' ? updDoneText(ui.update, job) : job.message, job.state === 'done' ? '' : 'error');
}
$('updBtn').addEventListener('click', async () => {
  const parts = updParts(ui.update || {});
  if (!parts.length) {
    if (DEMO) return toast('Checking for updates…');
    const r = await (await post('/api/update/check'))?.json?.();
    return toast(r && r.ok ? 'Checking for updates…' : 'Update service is not installed', r && r.ok ? '' : 'error');
  }
  const sys = parts.find(p => p.key === 'system'), cli = parts.find(p => p.key === 'client');
  if (Date.now() - updArmed > 5000) {
    updArmed = Date.now();
    renderUpdate();
    return setTimeout(renderUpdate, 5100);
  }
  updArmed = 0;
  updStarting = Date.now();
  renderUpdate();
  setTimeout(renderUpdate, 30100);
  if (DEMO) return;   // ?demo: shows the waiting state (and the button again after 30 s)
  const r = await (await post('/api/update/install', { version: cli ? cli.version : '', system: sys ? sys.version : '' }))?.json?.();
  if (!r || !r.ok) {
    updStarting = 0;
    renderUpdate();
    toast((r && r.error) || 'Could not start update', 'error');
  }
});
if (DEMO !== null) {
  // ?demo&upd=new|sys|both|busy|failed: preview the update card (opens the settings sheet)
  const kind = new URLSearchParams(location.search).get('upd');
  const avail = { version: '0.2.0', size: 9.4 * 1048576, notes: ['Chat orb now has a face', 'Fixed sleep hours that span midnight'] };
  const savail = { version: '0.3.0', size: 0.2 * 1048576, notes: ['Settings can switch Wi‑Fi', 'Works as a Bluetooth speaker'], missing: [] };
  const now = Date.now() / 1000;
  ui.version = '0.1.0';
  ui.update = { enabled: true, checked: now - 3600, available: kind && kind !== 'sys' ? avail : null,
                system: { current: '0.2.0', available: kind === 'sys' || kind === 'both' ? savail : null },
                job: kind === 'busy' ? { state: 'downloading', version: '0.3.0', progress: .42, time: now, component: 'system' }
                   : kind === 'failed' ? { state: 'rolled_back', version: '0.3.0', time: now, component: 'system',
                                           message: 'System 0.3.0 failed to start the screen UI and rolled back to 0.2.0' } : null };
  if (kind) $('settings').classList.add('on');
}

/* ---- settings: chat history (kept on the hub; clearing also clears the hub's copy) ---- */
let clearArmed = 0, memArmed = 0;   // first tap arms a button, a second one within 5 s clears
function renderClear() {
  $('clearBtn').textContent = Date.now() - clearArmed < 5000 ? 'Confirm clear' : 'Clear';
  $('clearBtn').classList.toggle('armed', Date.now() - clearArmed < 5000);
  $('clearMemBtn').textContent = Date.now() - memArmed < 5000 ? 'Confirm clear memory' : 'Clear memory only, keep history';
  $('clearMemBtn').classList.toggle('armed', Date.now() - memArmed < 5000);
}
function agentNote(r) {
  // Claude Code and Grok Bot keep their own context: clearing here doesn't touch it
  return (r.agents || []).length ? `${r.agents.join(' and ')} chats on their side were left alone` : '';
}
$('clearBtn').addEventListener('click', async () => {
  if (Date.now() - clearArmed > 5000) {
    clearArmed = Date.now();
    renderClear();
    setTimeout(renderClear, 5100);
    return toast('This deletes chat history for every model. Tap Confirm clear again.');
  }
  clearArmed = 0;
  renderClear();
  if (DEMO !== null) { handlers.thread({ entry: ui.thread.entry, messages: [] }); return toast('Chat history cleared'); }
  const r = await (await post('/api/history/clear', {}))?.json?.();
  if (!r || !r.ok) return toast((r && r.error) || 'Could not clear', 'error');
  const note = agentNote(r);
  toast('Chat history cleared' + (note ? '。' + note : ''));
});
$('clearMemBtn').addEventListener('click', async () => {
  if (Date.now() - memArmed > 5000) {
    memArmed = Date.now();
    renderClear();
    setTimeout(renderClear, 5100);
    return toast('The model forgets past chats; history stays. Tap Confirm clear memory again.');
  }
  memArmed = 0;
  renderClear();
  if (DEMO !== null) return toast('Memory cleared; history kept');
  const r = await (await post('/api/history/clear', { memory_only: true }))?.json?.();
  toast(r && r.ok ? 'Memory cleared; history kept' : (r && r.error) || 'Could not clear', r && r.ok ? '' : 'error');
});
renderClear();

// The device address, read each time the sheet opens (it can change with the WiFi)
async function renderIp() {
  let ip = DEMO !== null ? '192.168.1.23' : null;
  if (DEMO === null) {
    try { ip = (await (await fetch('/api/network')).json()).ip; } catch (e) { ip = null; }
  }
  $('ipNum').textContent = ip || 'Offline';
  $('ipSub').textContent = ip ? `On a computer on the same network, open http://${ip}:16688/admin for the hub console` : 'The device address shows here after Wi‑Fi connects';
}
$('btnSettings').addEventListener('click', () => { $('settings').classList.add('on'); renderIp(); renderWifiCard(); });
/* ---- settings: WiFi (the kiosk shell scans and joins: thinksmart-kiosk.py, the same code as its welcome page) ---- */
// The shell answers the client's page only on the device own screen (127.0.0.1); window.thinksmartShell
// says it can. An older shell can't: the card then only says so.
const shell = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.thinksmart;
const shellWifi = !!(shell && window.thinksmartShell && window.thinksmartShell.wifi);
const shellCalls = {};
let shellSeq = 0;
// The shell answers every command (a connect takes at most ~60 s: three short nmcli calls, a
// watched activation of at most 50 s, the cleanup); an older shell (the 20261101 image) doesn't when
// nmcli hangs. Waiting for ever would keep the Wi-Fi panel busy: after this, it counts as failed.
const SHELL_TIMEOUT = 90000;
function shellCall(cmd, args) {
  return new Promise(resolve => {
    const id = ++shellSeq;
    shellCalls[id] = resolve;
    setTimeout(() => window.thinksmartReply({ id, ok: false, reason: 'noreply' }), SHELL_TIMEOUT);
    const msg = Object.assign({ id, cmd }, args || {});
    if (shellWifi) shell.postMessage(JSON.stringify(msg));
    else wifiMock(msg);
  });
}
window.thinksmartReply = function (r) {
  const done = shellCalls[r.id];
  delete shellCalls[r.id];
  if (done) done(r);
};
// outside the kiosk (a desktop browser, ?demo): pretend to be a device; password "wrongpass" fails
function wifiMock(m) {
  const reply = (r, ms) => setTimeout(() => window.thinksmartReply(Object.assign({ id: m.id }, r)), ms);
  if (DEMO === null) return reply({ ok: false, reason: 'noshell' }, 0);
  if (m.cmd === 'wifi_status') reply({ ok: true, ssid: 'Home_5G', signal: 82 }, 100);
  else if (m.cmd === 'scan') reply({ ok: true, networks: [
    { ssid: 'Home_5G', signal: 82, secure: true, active: true, saved: true },
    { ssid: 'Home', signal: 70, secure: true, saved: true },
    { ssid: 'Living-room Wi‑Fi', signal: 54, secure: true },
    { ssid: 'Guest', signal: 40, secure: false },
    { ssid: 'TP-LINK_8A2C', signal: 22, secure: true },
  ] }, 700);
  else if (m.cmd === 'connect') {
    ['scan', 'join', 'auth', 'ip'].forEach((s, i) => setTimeout(() => window.thinksmartProgress({ id: m.id, stage: s }), 300 + i * 400));
    reply(m.password === 'wrongpass' ? { ok: false, reason: 'password' } : { ok: true }, 2000);
  } else reply({ ok: true }, 200);
}

const WIFI_REASONS = {
  password: 'Wrong password, try again',
  notfound: 'Network not found; too far or wrong name',
  timeout: 'Timed out; move closer to the router',
  noreply: 'Device did not answer; check the network later',
};
const WIFI_STAGES = { scan: 'Scanning…', join: 'Connecting to the router…', auth: 'Checking password…', ip: 'Password ok, getting an address…' };
const wifi = { nets: [], target: null, ssid: '', pw: '', showPw: false, busy: false, connectId: null };
const signalText = s => s > 75 ? 'Excellent signal' : s > 50 ? 'Good signal' : s > 25 ? 'Fair signal' : 'Weak signal';

async function renderWifiCard() {
  if (!shellWifi && DEMO === null) {
    $('wifiSub').textContent = 'This system layer is too old to change Wi‑Fi here. Update it under Software update above.';
    $('wifiBtn').hidden = true;
    return;
  }
  const r = await shellCall('wifi_status');
  $('wifiSub').textContent = !r.ok ? 'Cannot read Wi‑Fi status' : r.ssid ? `Connected ${r.ssid} · ${signalText(r.signal)}` : 'Not connected to Wi‑Fi';
}
function openWifi() {
  $('wifi').classList.add('on');
  wifiList();
  wifiScan();
}
function closeWifi() {
  if (wifi.busy) return;   // a connection attempt is on: it rolls back by itself if it fails
  if (document.activeElement) document.activeElement.blur();
  $('wifi').classList.remove('on');
  renderWifiCard();
  renderIp();
}
function wifiPane(id) {
  for (const p of document.querySelectorAll('.w-pane')) p.classList.toggle('on', p.id === id);
}
function wifiList() {
  if (document.activeElement) document.activeElement.blur();
  wifiPane('wList');
  renderNets();
}
async function wifiScan() {
  $('wScan').classList.add('spin');
  if (!wifi.nets.length) $('wNets').innerHTML = '<div class="w-empty">Scanning nearby Wi‑Fi…</div>';
  const r = await shellCall('scan');
  $('wScan').classList.remove('spin');
  wifi.nets = r.ok ? r.networks : [];
  renderNets(r.ok ? '' : 'Scan failed; tap refresh');
}
function bars(signal) {
  const lit = signal > 75 ? 4 : signal > 50 ? 3 : signal > 25 ? 2 : 1;
  return '<span class="bars">' + [1, 2, 3, 4].map(i => `<i class="${i <= lit ? 'lit' : ''}"></i>`).join('') + '</span>';
}
const LOCK = '<svg class="w-lock" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#b6c0e2" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
function renderNets(error) {
  const box = $('wNets');
  if (error || !wifi.nets.length) {
    box.innerHTML = `<div class="w-empty">${esc(error || 'No Wi‑Fi found nearby')}</div>`;
    return;
  }
  box.innerHTML = wifi.nets.map((n, i) =>
    `<button class="w-net${n.active ? ' cur' : ''}" data-i="${i}">${bars(n.signal)}<span class="name">${esc(n.ssid)}</span>` +
    (n.active ? '<span class="meta">Connected</span>' : n.saved ? '<span class="meta saved">Saved</span>' : '') +
    (n.secure ? LOCK : '') + '</button>').join('');
}
$('wNets').addEventListener('click', e => {
  const b = e.target.closest('.w-net');
  if (b) wifiJoin(wifi.nets[Number(b.dataset.i)], false);
});

// mode: 'type' (enter a password), 'saved' (a saved network: connect or forget), 'info' (the one
// connected: forget). Saved networks wait for a tap on Connect so Forget stays reachable.
function wifiJoin(net, hidden) {
  wifi.target = { ssid: net ? net.ssid : '', secure: net ? net.secure : true, hidden, saved: !!(net && net.saved),
                  mode: net && net.active ? 'info' : net && net.saved ? 'saved' : 'type' };
  wifi.ssid = wifi.target.ssid;
  wifi.pw = '';
  wifi.showPw = false;
  const t = wifi.target, q = net ? signalText(net.signal) : '';
  $('wJoinTitle').textContent = hidden ? 'Add hidden network' : t.ssid;
  $('wJoinHint').textContent = hidden ? 'Enter the network name and password (leave password blank if none), then tap Connect on the keyboard'
    : t.mode === 'info' ? 'Connected · ' + q
    : t.mode === 'saved' ? 'Saved network · ' + q + ', tap Connect with the saved password'
    : t.secure ? 'Secured · ' + q + ', enter the password then tap Connect' : 'Open · ' + q;
  wifiMsg('');
  wifiPane('wJoin');
  renderJoin();
  if (t.mode === 'type' && !t.secure && !hidden) wifiConnect();   // open network: nothing to type
  else wifiFocus();
}
const typing = () => wifi.target.mode === 'type';
// the system keyboard (injected by the kiosk shell) comes up with the focused field
function wifiFocus() {
  if (!typing() || wifi.busy) return;
  const t = wifi.target;
  const el = t.hidden && !wifi.ssid ? $('wSsid') : t.secure ? $('wPw') : $('wSsid');
  setTimeout(() => el.focus(), 50);
}
function canConnect() {
  const t = wifi.target;
  // a hidden network may be open: an empty password is allowed there, 1-7 characters never are
  const pwOk = t.hidden ? (wifi.pw.length === 0 || wifi.pw.length >= 8) : (!t.secure || wifi.pw.length >= 8);
  return !wifi.busy && (!t.hidden || wifi.ssid.length > 0) && pwOk;
}
function renderJoin() {
  const t = wifi.target;
  if ($('wSsid').value !== wifi.ssid) $('wSsid').value = wifi.ssid;
  if ($('wPw').value !== wifi.pw) $('wPw').value = wifi.pw;
  $('wPw').type = wifi.showPw ? 'text' : 'password';
  $('wPw').placeholder = t.hidden ? 'Leave blank if no password' : 'At least 8 characters';
  $('wSsid').disabled = $('wPw').disabled = wifi.busy;
  $('wEye').textContent = wifi.showPw ? 'Hide' : 'Show';
  $('wFieldSsid').style.display = typing() && t.hidden ? '' : 'none';
  $('wFieldPw').style.display = typing() && t.secure ? '' : 'none';
  $('wForget').hidden = !(t.saved || t.mode === 'info');
  $('wJoinBtn').hidden = t.mode !== 'saved';
  $('wJoinBtn').disabled = $('wForget').disabled = wifi.busy;
}
function wifiMsg(text, kind) {
  $('wMsg').className = 'w-msg' + (kind ? ' ' + kind : '');
  $('wMsg').innerHTML = (kind === 'wait' ? '<span class="w-spin"></span>' : '') + esc(text);
}
async function wifiConnect() {
  const t = wifi.target;
  if (t.mode !== 'saved' && !canConnect()) return;
  wifi.busy = true;
  renderJoin();
  const usingSaved = t.mode === 'saved';
  wifiMsg(usingSaved ? `Connecting to ${wifi.ssid} with saved password…` : `Connecting to ${wifi.ssid}…`, 'wait');
  wifi.connectId = shellSeq + 1;   // the id shellCall() is about to use: progress reports carry it
  const r = await shellCall('connect', { ssid: wifi.ssid, password: usingSaved || !t.secure ? '' : wifi.pw, hidden: !!t.hidden });
  wifi.connectId = null;
  wifi.busy = false;
  if (r.ok) {
    t.mode = 'info';
    t.saved = true;
    wifiMsg(`Connected ${wifi.ssid}`, 'ok');
    renderJoin();
    setTimeout(() => { if (!wifi.busy && $('wJoin').classList.contains('on')) { wifiList(); wifiScan(); } }, 1500);
    return;
  }
  // whatever went wrong (the shell already went back to the previous network), let the user type a password next
  if (t.secure) t.mode = 'type';
  if (r.reason === 'password') wifi.pw = '';
  wifiMsg(usingSaved && r.reason === 'password' ? 'Saved password failed; enter it again'
    : WIFI_REASONS[r.reason] || ('Connection failed' + (r.detail ? '：' + r.detail : '')) + ', back on the previous network', 'bad');
  renderJoin();
  wifiFocus();
}
window.thinksmartProgress = function (p) {
  if (wifi.busy && p.id === wifi.connectId && WIFI_STAGES[p.stage]) wifiMsg(WIFI_STAGES[p.stage], 'wait');
};
async function wifiForget() {
  if (wifi.busy) return;
  const ssid = wifi.target.ssid;
  wifi.busy = true;
  wifiMsg(`Forgetting ${ssid}…`, 'wait');
  renderJoin();
  const r = await shellCall('forget', { ssid });
  wifi.busy = false;
  if (!r.ok) {
    wifiMsg(`Could not forget ${ssid}; try again`, 'bad');
    return renderJoin();
  }
  wifi.target.saved = false;
  wifiMsg(`Forgot ${ssid}; you will need the password next time`, 'ok');
  renderJoin();
  wifi.nets = wifi.nets.map(n => n.ssid === ssid ? Object.assign({}, n, { saved: false }) : n);
  setTimeout(() => { if (!wifi.busy) { wifiList(); wifiScan(); } }, 1400);
}
$('wifiBtn').addEventListener('click', openWifi);
$('wClose').addEventListener('click', closeWifi);
$('wScan').addEventListener('click', wifiScan);
$('wHidden').addEventListener('click', () => wifiJoin(null, true));
$('wBack').addEventListener('click', () => { if (!wifi.busy) wifiList(); });
$('wForget').addEventListener('click', wifiForget);
$('wJoinBtn').addEventListener('click', wifiConnect);
// On pointerdown, not click: cancelling a touch's pointerdown (to keep the field focused and the system
// keyboard up) makes WebKitGTK send no click at all, so a click handler never ran on the device screen
// (a mouse in a desktop browser still clicks). The on-screen keyboard's keys work the same way.
$('wEye').addEventListener('pointerdown', e => { e.preventDefault(); wifi.showPw = !wifi.showPw; renderJoin(); });
$('wSsid').addEventListener('input', () => { wifi.ssid = $('wSsid').value; });
$('wPw').addEventListener('input', () => { wifi.pw = $('wPw').value; });
$('wSsid').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();   // keep the keyboard up: on to the password
  if (wifi.target.secure) $('wPw').focus();
});
$('wPw').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (!canConnect()) { e.preventDefault(); return; }   // keep typing
  wifiConnect();
});

/* ---- settings: Bluetooth speaker (bt.py; pairing only in the 3-minute "add a phone" window) ---- */
function btPlaying(d) {
  const song = [d.title, d.artist].filter(Boolean).join(' · ');
  return song || 'Now playing';
}
function renderBluetooth() {
  const b = ui.bluetooth;
  const on = !!(b && b.available && b.enabled);
  const live = b && b.enabled && (b.devices || []).find(d => d.streaming);
  document.body.classList.toggle('bt-playing', !!live);
  $('btChipText').textContent = live ? `${live.name} · ${btPlaying(live)}` : '';
  if (!b) return;
  $('btSwitch').setAttribute('aria-checked', String(on));
  $('btSwitch').disabled = !b.available;
  $('btCard').classList.toggle('off', !on);
  $('btName').textContent = on && b.name ? `Shows on phones as “${b.name}”` : '';
  let note;
  if (!b.available) note = 'Bluetooth missing or the service is not running.';
  else if (!b.enabled) note = 'When on, a phone can use this device as a Bluetooth speaker.';
  else if (b.window) note = `Waiting for a phone (${b.window}s left): tap “${b.name}” in phone Bluetooth settings. No PIN.`;
  else note = 'Paired phones reconnect with one tap. Music ducks or pauses for talk or alarms.';
  if (on && b.direct) note += ' Note: old system layer routes phone audio around the client, so wake-word while playing is hard.';
  $('btNote').textContent = note;
  const phones = b.devices || [];
  $('btList').innerHTML = phones.length ? phones.map(d =>
    `<div class="al phone${d.streaming ? ' live' : ''}"><i>Phone</i><div class="al-text"><b>${esc(d.name)}</b>` +
    `<span${d.streaming ? ' class="live"' : ''}>${d.streaming ? esc(btPlaying(d)) : d.connected ? 'Connected' : 'Paired, not connected'}</span></div>` +
    (btIsArmed(d.address) ? `<button class="al-del armed" data-addr="${esc(d.address)}">Confirm forget</button></div>`
                          : `<button class="al-del" data-addr="${esc(d.address)}">Forget</button></div>`)).join('')
    : '<div class="alarm-empty">No paired phones yet</div>';
  $('btAdd').classList.toggle('on', !!b.window);
  $('btAdd').textContent = b.window ? `Stop waiting (${b.window}s)` : '+ Add phone';
}
// 「Forget」 needs a second tap within 4 s. Kept by address, not on the button: while Add phone waits
// the list is redrawn every second (the countdown), which would drop a state kept on the DOM.
let btArmed = null;   // {addr, until}
const btIsArmed = addr => !!btArmed && btArmed.addr === addr && Date.now() < btArmed.until;
async function btPost(body) {
  if (DEMO !== null) {
    const b = ui.bluetooth;
    if ('enabled' in body) b.enabled = body.enabled;
    if ('window' in body) b.window = body.window ? 180 : 0;
    if (body.remove) b.devices = b.devices.filter(d => d.address !== body.remove);
    renderBluetooth();
    return { ok: true };
  }
  return postJson('/api/bluetooth', body);   // {ok: false} after it has shown the error
}
$('btSwitch').addEventListener('click', () => btPost({ enabled: !(ui.bluetooth && ui.bluetooth.enabled) }));
$('btAdd').addEventListener('click', () => btPost({ window: !(ui.bluetooth && ui.bluetooth.window) }));
$('btList').addEventListener('click', e => {
  const b = e.target.closest('.al-del');
  if (!b) return;
  if (!btIsArmed(b.dataset.addr)) {
    btArmed = { addr: b.dataset.addr, until: Date.now() + 4000 };
    renderBluetooth();
    setTimeout(renderBluetooth, 4100);
    return;
  }
  btArmed = null;
  btPost({ remove: b.dataset.addr }).then(r => { if (r && r.ok !== false) toast('Forgot; pair this phone again'); });
});


// Power off: halts the system (it stays dark with the power cable in), so unplugging can't damage it
let powerArmed = 0;
function renderPower() {
  $('powerBtn').textContent = Date.now() - powerArmed < 5000 ? 'Confirm power off' : 'Power off';
  $('powerBtn').classList.toggle('armed', Date.now() - powerArmed < 5000);
}
$('powerBtn').addEventListener('click', async () => {
  if (Date.now() - powerArmed > 5000) {
    powerArmed = Date.now();
    renderPower();
    setTimeout(renderPower, 5100);
    return toast('After shutdown, unplug, wait 30s, then plug back in. Tap Confirm power off again.');
  }
  powerArmed = 0;
  renderPower();
  if (DEMO !== null) return toast('Demo mode will not shut down');
  const r = await (await post('/api/power-off', {}))?.json?.();
  if (!r || !r.ok) toast((r && r.error) || 'Could not power off', 'error');
});
$('settingsClose').addEventListener('click', () => {
  $('settings').classList.remove('on');
  if (!DEMO) postJson('/api/alarm-tone', { stop: true });   // a tone being tried stops with the settings
});
$('reportPill').addEventListener('click', () => { post('/api/reports/play'); toast('Playing it now'); });

/* ---- right side: welcome screen or conversation ---- */
// The welcome screen (clock) when idle with nothing going on: no messages yet, or the conversation
// is over (the hub closed the connection). The hub keeps the history, so the thread is rarely empty;
// it comes back with the chat page on the next wake. While the connection lasts (~2 minutes) the
// chat page stays. A new conversation shows the chat (and its "listening" bubble) from the wake on.
function welcomeShown(messages, state, connected) {
  return ['idle', 'connecting'].includes(state) && (!messages || !connected);
}
function renderSide() {
  document.body.classList.toggle('fresh', welcomeShown(ui.thread.messages.length, shownState(), !!ui.status.connected));
}

function entryModel(entry) {
  return ui.models.options.find(o => o.entry === entry) || ui.models.current;
}

function renderHead() {
  const m = entryModel(ui.thread.entry);
  $('headLogo').src = logoSrc(m);
  $('headTitle').textContent = m ? `Chat with ${m.label}` : 'Chat';
  const n = ui.thread.messages.length;
  $('headMeta').textContent = n ? `${n} messages · ${ui.status.connected ? 'in conversation' : 'saved'}` : 'New chat';
}

function fmtTime(t) {
  const d = new Date(t * 1000);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// A reply grows sentence by sentence; the text just shows as it is (no per-sentence highlight)
function fillMsg(el, m) {
  const html = esc(m.text) + (m.interrupted ? '<span class="cut">Stopped</span>' : '') + `<span class="ts">${fmtTime(m.time)}</span>`;
  if (m.role === 'bot') el.querySelector('.body').innerHTML = html;
  else el.innerHTML = html;
}

function msgEl(m) {
  const el = document.createElement('div');
  el.className = 'msg ' + m.role;
  el.dataset.id = m.id;
  if (m.role === 'bot') {
    el.innerHTML = `<img class="tile" src="${esc(logoSrc(entryModel(m.entry)))}" alt=""><div class="body"></div>`;
  }
  fillMsg(el, m);
  return el;
}

function scrollDown() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

function renderThread() {
  const box = $('messages');
  box.textContent = '';
  for (const m of ui.thread.messages) {
    const el = msgEl(m);
    el.style.animation = 'none';
    box.appendChild(el);
  }
  markLive();
  renderHead();
  renderSide();
  renderPending();
  scrollDown();
}

function upsertMessage(m) {
  if (m.entry !== ui.thread.entry) return;
  const i = ui.thread.messages.findIndex(x => x.id === m.id);
  const box = $('messages');
  if (i >= 0) {
    ui.thread.messages[i] = m;
    const el = box.querySelector(`[data-id="${m.id}"]`);
    if (el) fillMsg(el, m);
  } else {
    ui.thread.messages.push(m);
    box.insertBefore(msgEl(m), $('pending'));
  }
  markLive();
  renderHead();
  renderSide();
  scrollDown();
}

function markLive() {
  // the reply being spoken right now: its logo gets a ring
  const box = $('messages');
  box.querySelectorAll('.live').forEach(el => el.classList.remove('live'));
  const last = ui.thread.messages[ui.thread.messages.length - 1];
  if (ui.status.state === 'speaking' && last && last.role === 'bot') {
    const el = box.querySelector(`[data-id="${last.id}"]`);
    if (el) el.classList.add('live');
  }
}

// Placeholder at the end of the conversation while the user talks or the model thinks
function renderPending() {
  const shown = shownState();
  // recognising: the user stopped and the hub is turning it into text (it can take a few seconds)
  const kind = ui.status.recognising && !ui.ptt ? 'user recog' : shown === 'listening' ? (ui.ptt ? 'user ptt' : 'user') :
    shown === 'thinking' ? 'bot' : '';
  let el = $('pending');
  if (el && el.dataset.kind === kind) return;
  if (el) el.remove();
  if (!kind) return;
  el = document.createElement('div');
  el.id = 'pending';
  el.dataset.kind = kind;
  el.className = 'msg pending ' + kind;
  if (kind.startsWith('user')) {
    el.innerHTML = `<span class="wave">${'<b></b>'.repeat(5)}</span>${kind === 'user recog' ? 'Recognizing…' : ui.ptt ? 'Release when done' : 'Listening…'}`;
  } else {
    el.innerHTML = `<img class="tile" src="${esc(logoSrc(entryModel(ui.thread.entry)))}" alt="">` +
      `<div class="body"><span class="dots"><i></i><i></i><i></i></span><span class="label">Thinking</span></div>`;
  }
  $('messages').appendChild(el);
  scrollDown();
}

/* ---- overlays ---- */
let toastTimer = null;
function toast(text, kind) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast on' + (kind === 'error' ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast' + (kind === 'error' ? ' error' : ''); }, kind === 'error' ? 4500 : 2500);
}

let hudTimer = null;
function showVolume(v) {
  $('hudFill').style.transform = `scaleX(${Math.max(0, Math.min(100, v)) / 100})`;
  $('hudNum').textContent = v;
  $('hud').classList.add('on');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => $('hud').classList.remove('on'), 1600);
}

/* ---- events from the client ---- */
const handlers = {
  snapshot(s) {
    if (ui.build && s.build && s.build !== ui.build) return location.reload();   // client restarted (deployed)
    ui.build = s.build;
    ui.status = s.status; ui.models = server.models = s.models; ui.thread = server.thread = s.thread;
    switching = null;
    for (const k in seenThreads) delete seenThreads[k];
    seenThreads[s.thread.entry] = s.thread.messages;
    if (s.update) { ui.version = s.version; ui.update = s.update; }   // the demo's snapshots have none
    if (s.alarms) ui.alarms = s.alarms;
    if (s.bluetooth) ui.bluetooth = s.bluetooth;
    renderModels(); renderThread(); renderStatus(); renderAlarms(); renderBluetooth();
    updateFinished((s.update || {}).job);
  },
  power(p) {
    $('powerOff').classList.toggle('on', p.state === 'off');
  },
  update(u) {
    ui.update = u;
    renderUpdate();
    updateFinished(u.job);
  },
  state(s) {
    ui.status = s; renderStatus(); markLive(); renderHead();
  },
  model(m) {
    server.models = m;
    if (switching && (!m.current || m.current.entry !== switching)) return;
    ui.models = m; renderModels(); renderStatus();
  },
  thread(t) {
    server.thread = t;
    if (t.reset) for (const k in seenThreads) delete seenThreads[k];   // cleared, or the hub's history loaded
    seenThreads[t.entry] = t.messages;
    if (switching && t.entry !== switching) return;
    ui.thread = t; renderThread();
  },
  message: m => upsertMessage(m),
  toast: t => toast(t.text, t.kind),
  volume(v) {
    // a ring's own volume (keys while it rings) is shown, but isn't the device volume
    if (!v.ring) { ui.status.volume = v.volume; renderVol(); }
    if (v.source !== 'page') showVolume(v.volume);
  },
  alarms(a) {
    ui.alarms = a; renderAlarms();
  },
  bluetooth(b) {
    ui.bluetooth = b; renderBluetooth();
  },
  level(l) {
    level.target = ui.status.state === 'speaking' ? Math.min(1, l.out * 6) : micLevel(l.mic);
  },
};

function connectEvents() {
  const es = new EventSource('/events');
  for (const [name, fn] of Object.entries(handlers)) es.addEventListener(name, e => fn(JSON.parse(e.data)));
}

/* ---- buttons ---- */
function post(path, body) {
  if (DEMO) return demo.action(path, body);
  const opts = { method: 'POST' };
  if (body) Object.assign(opts, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return fetch(path, opts).catch(() => toast('Client not responding', 'error'));
}

// Mic: a tap wakes (or interrupts a reply and listens); holding it is push-to-talk
let holdTimer = null;
function pttStart() {
  ui.ptt = true;
  $('btnMic').classList.add('hold');
  renderStatus();
}
function pttEnd() {
  ui.ptt = false;
  $('btnMic').classList.remove('hold');
  renderStatus();
}
$('btnMic').addEventListener('pointerdown', e => {
  e.preventDefault();
  holdTimer = setTimeout(() => {
    holdTimer = null;
    pttStart();
    post('/api/ptt/start');
  }, 350);
});
function release() {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
    post('/api/wake');
  } else if (ui.ptt) {
    pttEnd();
    post('/api/ptt/stop');
  }
}
$('btnMic').addEventListener('pointerup', release);
$('btnMic').addEventListener('pointercancel', release);
$('btnMic').addEventListener('pointerleave', () => { if (ui.ptt) release(); });
$('btnAbort').addEventListener('click', () => post('/api/abort'));
$('btnEnd').addEventListener('click', () => { post('/api/end'); toast('Conversation ended; history saved'); });
$('modelPill').addEventListener('click', () => openSheet(true));
$('sheetClose').addEventListener('click', () => openSheet(false));
document.addEventListener('contextmenu', e => e.preventDefault());

for (const [q, bg, fg, icon] of SUGGEST) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.innerHTML = `<i style="background:${bg};color:${fg}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></i>${esc(q)}`;
  b.addEventListener('click', () => post('/api/text', { text: q }));
  $('chips').appendChild(b);
}

/* ---- demo: fake client for previewing the page on a desktop browser ---- */
const demo = DEMO === null ? null : (() => {
  const M = (label, model, logo, company, vendor) => ({ kind: 'llm', vendor, label, model, logo, company, entry: 'llm:' + vendor });
  const options = [
    M('Claude', 'claude-sonnet-4-5', 'claude-color', 'Anthropic', 'claude'),
    M('DeepSeek', 'deepseek-chat', 'deepseek-color', 'DeepSeek', 'deepseek'),
    M('Qwen', 'qwen-max', 'qwen-color', 'Alibaba Qwen', 'qwen'),
    M('Doubao', 'doubao-1.5-pro', 'doubao-color', 'ByteDance Doubao', 'doubao'),
    M('Gemini', 'gemini-2.5-flash', 'gemini-color', 'Google', 'gemini'),
    M('Kimi', 'kimi-k2', 'kimi-color', 'Moonshot', 'kimi'),
    M('GPT', 'gpt-4.1', 'openai', 'OpenAI', 'openai'),
    M('Zhipu GLM', 'glm-4.6', 'zhipu-color', 'Zhipu', 'glm'),
  ];
  let seq = 0, bot = null, timer = null, stopped = false;
  const threads = {};
  const entry = () => ui.models.current.entry;
  const now = () => Date.now() / 1000;
  const state = (s, connected = true) => handlers.state({ state: s, connected, uploading: s === 'listening' });
  const say = (role, text) => {
    const m = { id: ++seq, role, text, time: now(), entry: entry() };
    (threads[m.entry] = threads[m.entry] || []).push(m);
    handlers.message({ ...m });
    return m;
  };
  const sentence = text => {
    if (!bot) { state('speaking'); bot = say('bot', text); return; }
    bot.text += text;
    handlers.message({ ...bot });
  };
  const done = (cut) => {
    if (bot && cut) { bot.interrupted = true; handlers.message({ ...bot }); }
    bot = null;
  };

  // fake microphone / speaker levels: syllable-like bursts
  setInterval(() => {
    const t = performance.now() / 1000;
    const v = Math.max(0, Math.abs(Math.sin(t * 6.3)) * (.55 + .45 * Math.sin(t * 1.7)) + (Math.random() - .5) * .25);
    handlers.level({ mic: v * .07, out: v * .17 });
  }, 100);

  const tones = { coffee: 'Coffee Time', morning: 'Dawn', bright: 'Bright Morning', hop: 'Sunny Hop', marimba: 'Morning Marimba' };
  const alarmsDemo = () => ({
    synced: true, volume: 70, tone: 'coffee', tones, ringing: null,
    items: [
      { id: 3, kind: 'timer', type: 'Timer', label: 'Boil eggs', at: now() + 271, repeat: '', snoozed: false },
      { id: 1, kind: 'alarm', type: 'Alarm', label: 'Wake up', at: now() + 9 * 3600, repeat: 'Weekdays (Mon–Fri)', snoozed: false },
      { id: 2, kind: 'reminder', type: 'Reminder', label: 'Hang laundry', at: now() + 26 * 3600, repeat: '', snoozed: false, spoken: true },
    ],
    missed: [{ kind: 'reminder', label: 'Take medicine', at: now() - 3 * 3600, why: 'unanswered', noted: now() - 3 * 3600 },
             { kind: 'alarm', label: 'Wake up', at: now() - 20 * 3600, why: 'off', noted: now() - 20 * 3600 }],
  });
  const steps = [
    ['idle', 4000, () => {
      handlers.snapshot({ status: { state: 'idle', connected: false, uploading: false, volume: 60 }, alarms: alarmsDemo(),
                          bluetooth: { available: true, enabled: true, powered: true, window: 0, name: 'ThinkSmart View', direct: false,
                                       devices: [{ address: 'AA:BB:CC:DD:EE:01', name: 'Zhang iPhone', paired: true, connected: true, streaming: true,
                                                   title: 'Sunny Day', artist: 'Jay Chou' },
                                                 { address: 'AA:BB:CC:DD:EE:02', name: 'Redmi K70', paired: true, connected: false, streaming: false }] },
                          models: { current: options[0], options }, thread: { entry: options[0].entry, messages: [] } });
    }],
    ['settings', 3000, () => $('settings').classList.add('on')],
    [null, 300, () => $('settings').classList.remove('on')],
    ['ring', 4000, () => handlers.alarms(Object.assign(alarmsDemo(), {
      ringing: { items: [alarmsDemo().items[1]], notes: [], started: now() } }))],
    [null, 300, () => handlers.alarms(alarmsDemo())],
    ['connecting', 1600, () => state('connecting', false)],
    ['listening', 3200, () => state('listening')],
    [null, 500, () => say('user', 'What will the weather in Beijing be like tomorrow? Good for a hike?')],
    ['thinking', 2600, () => state('thinking')],
    [null, 1700, () => sentence('Beijing tomorrow: sunny to cloudy, 9–19°C, ')],
    [null, 1700, () => sentence('light north wind, air quality good.')],
    ['speaking', 2200, () => sentence('Great hiking weather - Xiangshan maples should be at their peak.')],
    [null, 2400, () => sentence('Mornings and evenings are cooler; bring a light jacket.')],
    [null, 2600, () => { done(); state('listening'); }],
    [null, 500, () => say('user', 'Suggest a quieter trail then')],
    [null, 2000, () => state('thinking')],
    [null, 1800, () => sentence('Try entering via the Beijing Botanical Garden, Cherry Valley to Guixiaoshi. ')],
    ['chat', 2400, () => sentence('Fewer people than the east gate, with a creek and metasequoia along the way.')],
    ['cut', 1400, () => { done(true); state('idle'); }],
    ['models', 3200, () => openSheet(true)],
    [null, 600, () => switchTo(options[1])],
    ['volume', 2400, () => showVolume(60)],
    ['ptt', 2600, () => { pttStart(); state('listening'); }],
    [null, 400, () => { pttEnd(); say('user', 'Introduce yourself in one sentence'); state('thinking'); }],
    [null, 1800, () => sentence('I am Xiaomai, the voice assistant on this screen. Call me anytime.')],
    [null, 3200, () => { done(); state('idle'); }],
    [null, 3000, () => { state('idle', false); toast('Conversation ended; history saved'); }],
  ];

  function switchTo(m) {
    openSheet(false);
    handlers.model({ current: m, options });
    handlers.thread({ entry: m.entry, messages: (threads[m.entry] || []).slice() });
    toast(`Switched to ${m.label}`);
  }

  function run(i, jump) {
    if (stopped) return;
    const [name, wait, fn] = steps[i % steps.length];
    if (i % steps.length === 0) { seq = 0; for (const k in threads) delete threads[k]; }
    fn();
    if (jump && name === jump) return;          // ?demo=<scene>: stop on that scene
    if (jump) return run(i + 1, jump);
    timer = setTimeout(() => run(i + 1), wait);
  }

  // tapping around stops the script and lets the buttons do something plausible
  function action(path, body) {
    stopped = true;
    clearTimeout(timer);
    const answer = q => {
      say('user', q);
      state('thinking');
      timer = setTimeout(() => {
        sentence('This is demo mode. ');
        timer = setTimeout(() => { sentence('Real answers need the live client.'); timer = setTimeout(() => { done(); state('idle'); }, 2600); }, 1500);
      }, 1600);
    };
    if (path === '/api/wake') state('listening');
    else if (path === '/api/ptt/start') state('listening');
    else if (path === '/api/ptt/stop') answer('(hold-to-talk text)');
    else if (path === '/api/text') answer(body.text);
    else if (path === '/api/abort') { done(true); state('idle'); }
    else if (path === '/api/end') { done(); state('idle', false); }
    else if (path.startsWith('/api/alarms/')) handlers.alarms(Object.assign({}, ui.alarms, { ringing: null }));
    return Promise.resolve();
  }

  return { start: () => run(0, DEMO || null), action, switchTo };
})();

tick();
setInterval(tick, 1000);
renderStatus();
renderThread();
if (demo) demo.start();
else connectEvents();
