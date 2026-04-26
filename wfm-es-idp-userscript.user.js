// ==UserScript==
// @name         WFM ES IDP helpers
// @namespace    https://github.com/sabirimanov/wfm-es-idp-userscript
// @version      0.2.1
// @description  Automate pre-install modal serial capture, checklist steps 0–6 and 8, HES polling
// @author       you
// @homepageURL  https://github.com/sabirimanov/wfm-es-idp-userscript
// @updateURL    https://raw.githubusercontent.com/sabirimanov/wfm-es-idp-userscript/master/wfm-es-idp-userscript.user.js
// @downloadURL  https://raw.githubusercontent.com/sabirimanov/wfm-es-idp-userscript/master/wfm-es-idp-userscript.user.js
// @match        https://wfm-idp.smartgasconnect.ai/Preinstallation/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const LS_VALVE_PREFIX = "wfm_es_idp:valve_status:";
  const SERIAL_PREFIX_LEN = 17;
  const SERIAL_MAX_LEN = 16;
  const ICCID_LEN = 20;
  const HES_POLL_MS = 30_000;
  const HES_FIRST_CHECK_MS = 1000;

  /** @param {Element | null | undefined} el */
  function isVisible(el) {
    return !!el && !el.classList.contains("hidden");
  }

  /** @param {string} name @param {string} value */
  function setRadio(name, value) {
    const el = document.querySelector(
      `input[type="radio"][name="${cssAttr(name)}"][value="${cssAttr(value)}"]`
    );
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || el.checked) return;
    el.checked = true;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** @param {string} name @param {string} value */
  function setSelect(name, value) {
    const el = document.querySelector(`select[name="${cssAttr(name)}"]`);
    if (!(el instanceof HTMLSelectElement)) return;
    if (el.value === value) return;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** @param {string} s */
  function cssAttr(s) {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /** @param {HTMLElement | null} btn */
  function clickEl(btn) {
    if (btn && !btn.disabled) btn.click();
  }

  /**
   * Stable serial extraction from partial/complete JSON QR payload (HID types char-by-char).
   * Prefers "SerialNumber":"…" ; falls back to skip SERIAL_PREFIX_LEN then take SERIAL_MAX_LEN.
   * @param {string} raw
   */
  function extractSerialFromPayload(raw) {
    const key = '"SerialNumber":"';
    const idx = raw.indexOf(key);
    if (idx !== -1) {
      let out = "";
      for (let i = idx + key.length; i < raw.length; i++) {
        const c = raw[i];
        if (c === '"') break;
        out += c;
        if (out.length >= SERIAL_MAX_LEN) break;
      }
      return out;
    }
    const m = raw.match(/"SerialNumber"\s*:\s*"([^"]*)/);
    if (m) return m[1].slice(0, SERIAL_MAX_LEN);
    if (raw.length >= SERIAL_PREFIX_LEN + SERIAL_MAX_LEN) {
      return raw.slice(SERIAL_PREFIX_LEN, SERIAL_PREFIX_LEN + SERIAL_MAX_LEN);
    }
    if (raw.length > SERIAL_PREFIX_LEN) {
      return raw.slice(SERIAL_PREFIX_LEN, SERIAL_MAX_LEN + SERIAL_PREFIX_LEN);
    }
    return "";
  }

  /** @param {HTMLElement} grid @param {number} childIndex */
  function gridCellSpanText(grid, childIndex) {
    const cell = grid.children[childIndex];
    const span = cell && cell.querySelector("span");
    return (span && span.textContent && span.textContent.trim()) || "";
  }

  const preModal = () => document.getElementById("preInstallationModelModal");
  const deviceIdInput = () => document.getElementById("deviceId");
  const validateBtn = () => document.getElementById("validateBtnId");
  const nextStepBtn = () => document.getElementById("nextStepBtn");
  const hesBtn = () => document.getElementById("btnGetHesDetails");
  const hesGrid = () => document.getElementById("hesDynamicGrid");

  /** @param {string} step */
  function stepEl(step) {
    return document.querySelector(`.checklist-step[data-step="${step}"]`);
  }

  /** @param {HTMLElement} step */
  function findEditBtn(step) {
    const buttons = step.querySelectorAll("button.edit-btn");
    for (const b of buttons) {
      if (b.textContent && b.textContent.trim() === "Edit") return b;
    }
    return null;
  }

  /** @param {HTMLElement} step */
  function findValidateBtn(step) {
    const buttons = step.querySelectorAll("button.edit-btn");
    for (const b of buttons) {
      if (b.textContent && b.textContent.trim() === "Validate") return b;
    }
    return null;
  }

  const state = {
    preModalWasHidden: true,
    deviceIdInputBound: false,
    s2: /** @type {{ phase: string; editClicked: boolean; mappingCleared: boolean; validateClicked: boolean }} */ ({
      phase: "idle",
      editClicked: false,
      mappingCleared: false,
      validateClicked: false,
    }),
    s3: /** @type {{
      phase: string;
      pollTickId: ReturnType<typeof setInterval> | null;
      hesResolved: boolean;
      pullDefaultText: string;
    }} */ ({
      phase: "idle",
      pollTickId: null,
      hesResolved: false,
      pullDefaultText: "",
    }),
    swalObserver: /** @type {MutationObserver | null} */ (null),
  };

  function clearS3Timers() {
    if (state.s3.pollTickId) {
      clearInterval(state.s3.pollTickId);
      state.s3.pollTickId = null;
    }
  }

  function restoreHesButtonLabel() {
    const btn = hesBtn();
    if (btn && state.s3.pullDefaultText) btn.textContent = state.s3.pullDefaultText;
  }

  function bindDeviceIdScanner() {
    if (state.deviceIdInputBound) return;
    const input = deviceIdInput();
    if (!input) return;
    state.deviceIdInputBound = true;
    input.addEventListener(
      "input",
      () => {
        const serial = extractSerialFromPayload(input.value);
        if (serial !== input.value) {
          const pos = serial.length;
          input.value = serial;
          try {
            input.setSelectionRange(pos, pos);
          } catch (_) {
            /* ignore */
          }
        }
        if (serial.length === SERIAL_MAX_LEN) {
          const v = validateBtn();
          if (v) clickEl(v);
        }
      },
      true
    );
  }

  function ensurePreModalFocus() {
    const modal = preModal();
    const vis = modal && isVisible(modal);
    if (vis && state.preModalWasHidden) {
      bindDeviceIdScanner();
      const inp = deviceIdInput();
      if (inp) {
        inp.focus();
        inp.select();
      }
    }
    state.preModalWasHidden = !vis;
  }

  function runStep0() {
    const step = stepEl("0");
    if (!step || !isVisible(step)) return;
    setRadio("Sm IMEI Verified", "Yes");
    setRadio("Sm Metrology Verified", "Yes");
  }

  function runStep1() {
    const step = stepEl("1");
    if (!step || !isVisible(step)) return;
    setRadio("Sm Serial Verified", "Match");
    setRadio("Sm Body Condition", "Not Damaged");
    setSelect("Sm Display Function", "OK");
  }

  function runStep2() {
    const step = stepEl("2");
    if (!step || !isVisible(step)) {
      state.s2 = { phase: "idle", editClicked: false, mappingCleared: false, validateClicked: false };
      if (state.swalObserver) {
        state.swalObserver.disconnect();
        state.swalObserver = null;
      }
      return;
    }

    setRadio("Sm ICCID Mapped", "Yes");
    setRadio("Sm SIM Activated", "Yes");

    const mapInput = step.querySelector("input.mapping-input");
    if (state.s2.phase === "idle") {
      const edit = findEditBtn(step);
      if (edit && !state.s2.editClicked) {
        clickEl(edit);
        state.s2.editClicked = true;
        state.s2.phase = "mapping";
      }
    }

    if (state.s2.phase === "mapping" && mapInput instanceof HTMLInputElement) {
      if (!state.s2.mappingCleared) {
        mapInput.value = "";
        state.s2.mappingCleared = true;
        mapInput.focus();
      }
      if (mapInput.value.length >= ICCID_LEN && !state.s2.validateClicked) {
        const valBtn = findValidateBtn(step);
        if (valBtn) clickEl(valBtn);
        state.s2.validateClicked = true;
        state.s2.phase = "swal_wait";
        attachSwalObserver();
      }
    }
  }

  function swalActiveSim() {
    const el = document.getElementById("swal2-html-container");
    if (!el) return false;
    const text = (el.textContent || "").trim();
    const d = el.style.display;
    const visible = d === "block" || getComputedStyle(el).display === "block";
    return visible && text === "SIM is active";
  }

  function attachSwalObserver() {
    if (state.swalObserver) return;
    state.swalObserver = new MutationObserver(() => {
      if (!swalActiveSim()) return;
      const ok = document.querySelector("button.swal2-confirm.swal-tailwind-btn");
      if (ok) clickEl(ok);
      const next = nextStepBtn();
      if (next) clickEl(next);
      if (state.swalObserver) {
        state.swalObserver.disconnect();
        state.swalObserver = null;
      }
      state.s2.phase = "done";
    });
    state.swalObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    if (swalActiveSim()) {
      const ok = document.querySelector("button.swal2-confirm.swal-tailwind-btn");
      if (ok) clickEl(ok);
      const next = nextStepBtn();
      if (next) clickEl(next);
      state.swalObserver.disconnect();
      state.swalObserver = null;
      state.s2.phase = "done";
    }
  }

  function startHesPolling() {
    const btn = hesBtn();
    if (!btn) return;
    if (!state.s3.pullDefaultText) {
      const raw = (btn.textContent || "").trim();
      state.s3.pullDefaultText = raw.replace(/\s*\(\d+\)\s*$/, "").trim() || "Pull HES Data";
    }

    let secondsLeft = Math.floor(HES_POLL_MS / 1000);
    btn.textContent = `${state.s3.pullDefaultText} (${secondsLeft})`;
    if (state.s3.pollTickId) clearInterval(state.s3.pollTickId);
    state.s3.pollTickId = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        clickEl(btn);
        secondsLeft = Math.floor(HES_POLL_MS / 1000);
      }
      btn.textContent = `${state.s3.pullDefaultText} (${secondsLeft})`;
    }, 1000);
  }

  function hesFirstColumnText() {
    const grid = hesGrid();
    return grid ? gridCellSpanText(grid, 0) : "";
  }

  function runStep3() {
    const step = stepEl("3");
    if (!step || !isVisible(step)) {
      clearS3Timers();
      restoreHesButtonLabel();
      state.s3 = {
        phase: "idle",
        pollTickId: null,
        hesResolved: false,
        pullDefaultText: "",
      };
      return;
    }

    const grid = hesGrid();
    const pull = hesBtn();
    if (!pull || !grid) return;

    if (state.s3.phase === "idle") {
      const rawLabel = (pull.textContent || "").trim();
      state.s3.pullDefaultText =
        rawLabel.replace(/\s*\(\d+\)\s*$/, "").trim() || "Pull HES Data";
      clickEl(pull);
      state.s3.phase = "wait_first";
      setTimeout(() => {
        if (state.s3.phase !== "wait_first") return;
        const t = hesFirstColumnText();
        if (t === "No") {
          state.s3.phase = "polling";
          startHesPolling();
          return;
        }
        if (t === "Yes") {
          state.s3.hesResolved = true;
          state.s3.phase = "yes_branch";
          clearS3Timers();
          restoreHesButtonLabel();
          runStep3YesBranch();
          return;
        }
        state.s3.phase = "wait_label";
        setTimeout(() => {
          if (state.s3.phase === "wait_label") state.s3.phase = "idle";
        }, 2000);
      }, HES_FIRST_CHECK_MS);
      return;
    }

    if (state.s3.phase === "polling") {
      const t = hesFirstColumnText();
      if (t === "Yes") {
        clearS3Timers();
        restoreHesButtonLabel();
        state.s3.hesResolved = true;
        state.s3.phase = "yes_branch";
        runStep3YesBranch();
      }
      return;
    }

    if (state.s3.phase === "yes_branch" && state.s3.hesResolved) {
      runStep3YesBranch();
    }
  }

  function runStep3YesBranch() {
    const grid = hesGrid();
    if (!grid) return;

    setRadio("Sm Comm Registered", "Yes");

    const sixth = gridCellSpanText(grid, 5);
    if (sixth !== "Not Available") {
      setRadio("Sm Reads Received", "Yes");
      setRadio("Sm Reads Verified", "Match");
    }

    const seventh = gridCellSpanText(grid, 6);
    const meterId = (deviceIdInput() && deviceIdInput().value) || "";
    if (seventh === "Open" && meterId) {
      try {
        localStorage.setItem(LS_VALVE_PREFIX + meterId, "Open");
      } catch (_) {
        /* ignore */
      }
    }

    const n = nextStepBtn();
    if (n && !n.dataset.wfmS3NextDone) {
      n.dataset.wfmS3NextDone = "1";
      clickEl(n);
    }
  }

  function runStep4() {
    const step = stepEl("4");
    if (!step || !isVisible(step)) return;
    const meterId = (deviceIdInput() && deviceIdInput().value) || "";
    let valve = "Closed";
    try {
      valve = localStorage.getItem(LS_VALVE_PREFIX + meterId) || "Closed";
    } catch (_) {
      /* ignore */
    }
    setSelect("Sm Valve Status", valve === "Open" ? "Open" : "Closed");
    const n = nextStepBtn();
    if (n && !n.dataset.wfmS4NextDone) {
      n.dataset.wfmS4NextDone = "1";
      clickEl(n);
    }
  }

  function runStep5() {
    const step = stepEl("5");
    if (!step || !isVisible(step)) return;
    setRadio("Sm Battery Status", "OK");
    const n = nextStepBtn();
    if (n && !n.dataset.wfmS5NextDone) {
      n.dataset.wfmS5NextDone = "1";
      clickEl(n);
    }
  }

  function runStep6() {
    const step = stepEl("6");
    if (!step || !isVisible(step)) return;
    setRadio("Sm IP Configured", "Yes");
    setRadio("Sm Port Configured", "Yes");
    setRadio("Sm Schedule Set", "Yes");
    const n = nextStepBtn();
    if (n && !n.dataset.wfmS6NextDone) {
      n.dataset.wfmS6NextDone = "1";
      clickEl(n);
    }
  }

  function runStep8() {
    const step = stepEl("8");
    if (!step || !isVisible(step)) return;
    const fileInp = document.querySelector('input[type="file"][name="Sm Image1"]');
    if (!(fileInp instanceof HTMLInputElement)) return;
    if (fileInp.hasAttribute("required")) return;
    const preview = document.getElementById("previewChecklistBtn");
    if (preview && !preview.dataset.wfmPreviewClicked) {
      preview.dataset.wfmPreviewClicked = "1";
      clickEl(preview);
    }
  }

  function tick() {
    ensurePreModalFocus();
    runStep0();
    runStep1();

    const step3 = stepEl("3");
    const hesBlocking = step3 && isVisible(step3) && state.s3.phase === "polling" && !state.s3.hesResolved;

    runStep2();
    runStep3();

    if (!hesBlocking) {
      runStep4();
      runStep5();
      runStep6();
      runStep8();
    }
  }

  let debounceTimer = 0;
  function scheduleTick() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = 0;
      tick();
    }, 120);
  }

  tick();
  const obs = new MutationObserver(() => scheduleTick());
  obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
})();
