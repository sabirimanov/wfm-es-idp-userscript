// ==UserScript==
// @name         WFM ES IDP helpers
// @namespace    https://github.com/sabirimanov/wfm-es-idp-userscript
// @version      0.1.0
// @description  Replace labels and automate simple form actions on matched pages
// @author       you
// @homepageURL  https://github.com/sabirimanov/wfm-es-idp-userscript
// @updateURL    https://raw.githubusercontent.com/sabirimanov/wfm-es-idp-userscript/master/wfm-es-idp-userscript.user.js
// @downloadURL  https://raw.githubusercontent.com/sabirimanov/wfm-es-idp-userscript/master/wfm-es-idp-userscript.user.js
// @match        https://example.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  /** @type {{ from: string; to: string }[]} */
  const TEXT_REPLACEMENTS = [
    { from: "Original phrase", to: "Replacement" },
  ];

  /** Tweak selectors and values for your site */
  const FORM = {
    /** input[type=radio] or input[name=...][value=...] */
    radioSelectors: [
      // 'input[name="role"][value="admin"]',
    ],
    /** { selector, value } */
    textInputs: [
      // { selector: '#email', value: 'user@example.com' },
    ],
    /** { selector, checked } */
    checkboxes: [
      // { selector: '#remember', checked: true },
    ],
  };

  function replaceTextInElement(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "NOSCRIPT") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let n;
    while ((n = walker.nextNode())) {
      let t = n.nodeValue;
      if (!t || !t.trim()) continue;
      let changed = false;
      for (const { from, to } of TEXT_REPLACEMENTS) {
        if (t.includes(from)) {
          t = t.split(from).join(to);
          changed = true;
        }
      }
      if (changed) n.nodeValue = t;
    }
  }

  function applyFormActions() {
    for (const sel of FORM.radioSelectors) {
      const el = document.querySelector(sel);
      if (el instanceof HTMLInputElement && el.type === "radio") {
        el.checked = true;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    for (const { selector, value } of FORM.textInputs) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    for (const { selector, checked } of FORM.checkboxes) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        el.checked = checked;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }

  function run() {
    replaceTextInElement(document.body);
    applyFormActions();
  }

  run();

  let debounceTimer = 0;
  function scheduleRun() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = 0;
      run();
    }, 150);
  }

  const obs = new MutationObserver(() => {
    scheduleRun();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
