// Run with: node --test tests/test_i18n.cjs (no npm dependencies).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(language, saved, blocked = false, search = '') {
  const values = new Map(saved ? [['thinksmart.uiLocale', saved]] : []);
  const picker = {value: '', addEventListener(event, fn) { this[event] = fn; }};
  const context = {navigator: {language}, URLSearchParams,
    localStorage: {getItem(k) { if (blocked) throw Error('disabled'); return values.get(k); }, setItem(k,v) { values.set(k,v); }},
    location: {search, reload() { this.reloaded = true; }},
    NodeFilter: {SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2},
    document: {documentElement: {}, body: {}, title: '小麦',
      createTreeWalker() {return {nextNode() {return null;}};},
      querySelectorAll(selector) {return selector === '[data-language-picker]' ? [picker] : [];}}
  };
  context.window = context;
  const root = path.join(__dirname, '..', 'web');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'zh-Hant.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'i18n.js'), 'utf8'), context);
  return {context, api: context.UII18n, values, picker};
}

test('traditional locale aliases and explicit saved preferences', () => {
  for (const language of ['zh-TW','zh-HK','zh-MO','zh-Hant','zh-Hant-TW']) {
    assert.equal(load(language).api.locale, 'zh-Hant');
  }
  assert.equal(load('zh-TW', 'zh-Hans').api.locale, 'zh-Hans');
  assert.equal(load('en-US', 'zh-Hant').api.locale, 'zh-Hant');
  assert.equal(load('zh-CN').api.locale, 'zh-Hans');
});

test('known UI copy is translated; arbitrary content and prototype names remain unchanged', () => {
  const {api} = load('zh-TW');
  assert.equal(api.t('设置'), '設定');
  assert.equal(api.t('软件更新'), '軟體更新');
  assert.equal(api.t('我的WiFi名称：设置网络'), '我的WiFi名称：设置网络');
  assert.equal(api.t('用户说：明天北京天气怎么样？'), '用户说：明天北京天气怎么样？');
  assert.equal(api.t('toString'), 'toString');
});

test('storage-disabled browsers can still load and translate', () => {
  assert.equal(load('zh-TW', null, true).api.t('设置'), '設定');
});

test('bookmarked locale initializes new devices without overriding a saved preference', () => {
  assert.equal(load('en-US', null, false, '?lang=zh-Hant').api.locale, 'zh-Hant');
  assert.equal(load('en-US', 'zh-Hans', false, '?lang=zh-Hant').api.locale, 'zh-Hans');
  assert.equal(load('en-US', null, false, '?lang=invalid').api.locale, 'zh-Hans');
});

test('selector persists preference and document language is accessible', () => {
  const {api,context,picker,values} = load('zh-TW');
  api.init();
  assert.equal(context.document.documentElement.lang, 'zh-Hant');
  assert.equal(picker.value, 'zh-Hant');
  picker.value = 'zh-Hans'; picker.change();
  assert.equal(values.get('thinksmart.uiLocale'), 'zh-Hans');
  assert.equal(context.location.reloaded, true);
});
