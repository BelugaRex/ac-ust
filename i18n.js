// ============================================================
// i18n.js - Self-contained fetch-based i18n loader
// ============================================================
// 为什么不用 chrome.i18n.getMessage()?
// 实测 Edge/Chrome 在 manifest.json 新增 default_locale 后,
// 普通"重新加载"按钮不会初始化 i18n 系统,导致 __MSG_*__ 占位符
// 不被替换且 getMessage() 返回空字符串。
// 本模块通过 fetch(chrome.runtime.getURL()) 直接加载 messages.json,
// 完全绕过 chrome.i18n,在 popup / SW / content script 中均稳定可用。
// ============================================================

(function (global) {
  'use strict';

  const SOURCE_LANG = 'zh_CN';
  const cache = {};        // lang -> { key: { message, description } }
  let activeLang = null;
  let loadPromise = null;

  function pickLang() {
    const ui = (chrome.i18n?.getUILanguage?.() || '').replace('-', '_');
    // 精确匹配 → 模糊匹配 (zh_CN -> zh) → 源语言
    if (cache[ui]) return ui;
    const short = ui.split('_')[0];
    const fuzzy = Object.keys(cache).find(k => k.split('_')[0] === short);
    return fuzzy || SOURCE_LANG;
  }

  async function loadLang(lang) {
    if (cache[lang]) return cache[lang];
    try {
      const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      cache[lang] = await res.json();
    } catch (e) {
      cache[lang] = null;
    }
    return cache[lang];
  }

  async function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const ui = (chrome.i18n?.getUILanguage?.() || '').replace('-', '_');
      // 预加载 UI 语言 + 源语言（fallback）
      await Promise.all([loadLang(ui), loadLang(SOURCE_LANG)]);
      activeLang = pickLang();
    })();
    return loadPromise;
  }

  function substitute(msg, subs) {
    if (!subs || !subs.length) return msg;
    let out = msg;
    // $1, $2, ... → positional
    subs.forEach((s, i) => {
      out = out.split(`$${i + 1}`).join(String(s));
    });
    // $$ → literal $
    out = out.split('$$').join('$');
    return out;
  }

  function t(key, ...subs) {
    const msgs = (activeLang && cache[activeLang]) || cache[SOURCE_LANG] || {};
    const entry = msgs[key];
    if (!entry || typeof entry.message !== 'string') {
      // fallback: key name (so missing translations are visible but not broken)
      return subs.length ? `${key}` : key;
    }
    return substitute(entry.message, subs);
  }

  // Apply translations to all [data-i18n] and [data-i18n-html] elements in the DOM.
  // Call after load() resolves.
  function applyToDOM(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
  }

  global.I18n = { load, t, applyToDOM, getLang: () => activeLang || SOURCE_LANG };
})(typeof globalThis !== 'undefined' ? globalThis : self);
