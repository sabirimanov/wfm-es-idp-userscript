// ==UserScript==
// @name         WFM ES IDP helpers
// @namespace    https://github.com/sabirimanov/wfm-es-idp-userscript
// @version      0.2.5
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
  const SERIAL_MAX_LEN = 16;
  const ICCID_LEN = 20;
  const HES_POLL_MS = 30_000;
  const HES_FIRST_CHECK_MS = 1000;
  /** Pause between scripted UI actions (ms) */
  const ACTION_DELAY_MS = 250;

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

  /** @param {string} stepId */
  function bumpStepAutofillToken(stepId) {
    state.stepAutofillTokens[stepId] = (state.stepAutofillTokens[stepId] ?? 0) + 1;
  }

  /**
   * @param {string} stepId
   * @param {number} tokenAtSchedule
   * @param {number} delayMs
   * @param {() => void} fn
   */
  function scheduleStepAction(stepId, tokenAtSchedule, delayMs, fn) {
    window.setTimeout(() => {
      if ((state.stepAutofillTokens[stepId] ?? 0) !== tokenAtSchedule) return;
      const st = stepEl(stepId);
      if (!st || !isVisible(st)) return;
      fn();
    }, delayMs);
  }

  /** @param {string} stepId @param {number} baseDelayMs @param {(() => void)[]} actions */
  function runStepAutofillChain(stepId, baseDelayMs, actions) {
    const step = stepEl(stepId);
    if (!step || !isVisible(step)) return;
    if (step.dataset.wfmAutofillDone === "1") return;
    if (step.dataset.wfmAutofillPending === "1") return;
    step.dataset.wfmAutofillPending = "1";
    const token = state.stepAutofillTokens[stepId] ?? 0;
    let t = baseDelayMs;
    for (let i = 0; i < actions.length; i++) {
      const act = actions[i];
      const isLast = i === actions.length - 1;
      scheduleStepAction(stepId, token, t, () => {
        act();
        if (isLast) {
          step.dataset.wfmAutofillDone = "1";
          delete step.dataset.wfmAutofillPending;
        }
      });
      t += ACTION_DELAY_MS;
    }
  }

  /** @param {string} stepId */
  function resetStepAutofill(stepId) {
    bumpStepAutofillToken(stepId);
    const el = stepEl(stepId);
    if (el) {
      delete el.dataset.wfmAutofillDone;
      delete el.dataset.wfmAutofillPending;
    }
  }

  /**
   * Stable serial extraction from partial/complete JSON QR payload (HID types char-by-char).
   * Uses the "SerialNumber":"…" prefix or the same pattern with flexible whitespace.
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
    return "";
  }

  /** @param {HTMLInputElement} el @param {string} value */
  function setInputValueAndNotify(el, value) {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
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
    stepAutofillTokens: /** @type {Record<string, number>} */ ({}),
    /** Tracks visibility so we reset autofill only on leave, not every tick while hidden */
    stepLastVisible: /** @type {Record<string, boolean>} */ ({}),
    preModalWasHidden: true,
    deviceIdListenersInstalled: false,
    mappingInputListenersInstalled: false,
    s2: /** @type {{ phase: string; editClicked: boolean; editClickScheduled: boolean; mappingCleared: boolean; mappingClearScheduled: boolean; validateClicked: boolean; validateScheduled: boolean; radiosApplied: boolean }} */ ({
      phase: "idle",
      editClicked: false,
      editClickScheduled: false,
      mappingCleared: false,
      mappingClearScheduled: false,
      validateClicked: false,
      validateScheduled: false,
      radiosApplied: false,
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

  function handleDeviceIdInput(ev) {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement) || input.id !== "deviceId") return;
    const raw = input.value;
    const serial = extractSerialFromPayload(raw);
    if (serial.length < SERIAL_MAX_LEN) {
      delete input.dataset.wfmAutoValidated;
    }
    if (serial.length === 0) {
      return;
    }
    if (serial !== raw) {
      setInputValueAndNotify(input, serial);
      try {
        input.setSelectionRange(serial.length, serial.length);
      } catch (_) {
        /* ignore */
      }
      if (serial.length === SERIAL_MAX_LEN) {
        tryValidateDeviceId(input);
      }
      return;
    }
    if (serial.length === SERIAL_MAX_LEN) {
      tryValidateDeviceId(input);
    }
  }

  /** @param {HTMLInputElement} input */
  function tryValidateDeviceId(input) {
    if (input.dataset.wfmAutoValidated === "1") return;
    input.dataset.wfmAutoValidated = "1";
    const v = validateBtn();
    if (v) clickEl(v);
  }

  function installDeviceIdListeners() {
    if (state.deviceIdListenersInstalled) return;
    state.deviceIdListenersInstalled = true;
    document.addEventListener("input", handleDeviceIdInput, false);
  }

  function handleMappingInput(ev) {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains("mapping-input")) return;
    const st = stepEl("2");
    if (!st || !isVisible(st) || state.s2.phase !== "mapping") return;
    if (!state.s2.mappingCleared) return;
    if (state.s2.validateClicked || state.s2.validateScheduled) return;
    if (input.value.trim().length < ICCID_LEN) return;
    scheduleStep2Validate();
  }

  function installMappingInputListeners() {
    if (state.mappingInputListenersInstalled) return;
    state.mappingInputListenersInstalled = true;
    document.addEventListener("input", handleMappingInput, false);
    document.addEventListener("change", handleMappingInput, false);
  }

  function scheduleStep2Validate() {
    if (state.s2.validateScheduled || state.s2.validateClicked) return;
    state.s2.validateScheduled = true;
    state.s2.phase = "swal_wait";
    window.setTimeout(() => {
      const st = stepEl("2");
      if (!st || !isVisible(st)) {
        state.s2.validateScheduled = false;
        state.s2.phase = "mapping";
        return;
      }
      if (state.s2.validateClicked) return;
      const valBtn = findValidateBtn(st);
      if (valBtn) clickEl(valBtn);
      state.s2.validateClicked = true;
      attachSwalObserver();
    }, ACTION_DELAY_MS);
  }

  function ensurePreModalFocus() {
    const modal = preModal();
    const vis = modal && isVisible(modal);
    if (vis && state.preModalWasHidden) {
      installDeviceIdListeners();
      const inp = deviceIdInput();
      if (inp) {
        inp.focus();
        inp.select();
      }
    }
    state.preModalWasHidden = !vis;
  }

  /** @param {string} stepId @param {boolean} visible @param {() => void} [onLeave] */
  function updateStepVisibility(stepId, visible, onLeave) {
    const was = state.stepLastVisible[stepId] === true;
    if (was && !visible) {
      resetStepAutofill(stepId);
      if (onLeave) onLeave();
    }
    state.stepLastVisible[stepId] = visible;
  }

  function runStep0() {
    const step = stepEl("0");
    const visible = !!(step && isVisible(step));
    updateStepVisibility("0", visible);
    if (!visible) return;
    runStepAutofillChain("0", ACTION_DELAY_MS, [
      () => setRadio("Sm IMEI Verified", "Yes"),
      () => setRadio("Sm Metrology Verified", "Yes"),
    ]);
  }

  function runStep1() {
    const step = stepEl("1");
    const visible = !!(step && isVisible(step));
    updateStepVisibility("1", visible, () => {
      const n = nextStepBtn();
      if (n) delete n.dataset.wfmS1NextDone;
    });
    if (!visible) return;
    runStepAutofillChain("1", ACTION_DELAY_MS, [
      () => setRadio("Sm Serial Verified", "Match"),
      () => setRadio("Sm Body Condition", "Not Damaged"),
      () => setSelect("Sm Display Function", "OK"),
      () => {
        const n = nextStepBtn();
        if (n && !n.dataset.wfmS1NextDone) {
          n.dataset.wfmS1NextDone = "1";
          clickEl(n);
        }
      },
    ]);
  }

  function runStep2() {
    const step = stepEl("2");
    const visible = !!(step && isVisible(step));
    if (state.stepLastVisible["2"] && !visible) {
      resetStepAutofill("2");
      state.s2 = {
        phase: "idle",
        editClicked: false,
        editClickScheduled: false,
        mappingCleared: false,
        mappingClearScheduled: false,
        validateClicked: false,
        validateScheduled: false,
        radiosApplied: false,
      };
      if (state.swalObserver) {
        state.swalObserver.disconnect();
        state.swalObserver = null;
      }
    }
    state.stepLastVisible["2"] = visible;
    if (!visible) return;

    if (!state.s2.radiosApplied && step.dataset.wfmAutofillDone !== "1") {
      if (step.dataset.wfmS2RadiosPending !== "1") {
        step.dataset.wfmS2RadiosPending = "1";
        const token = state.stepAutofillTokens["2"] ?? 0;
        scheduleStepAction("2", token, ACTION_DELAY_MS, () => setRadio("Sm ICCID Mapped", "Yes"));
        scheduleStepAction("2", token, ACTION_DELAY_MS * 2, () => {
          setRadio("Sm SIM Activated", "Yes");
          state.s2.radiosApplied = true;
          delete step.dataset.wfmS2RadiosPending;
        });
      }
    }

    const mapInput = step.querySelector("input.mapping-input");

    if (state.s2.phase === "idle" && state.s2.radiosApplied) {
      const edit = findEditBtn(step);
      if (edit && !state.s2.editClicked && !state.s2.editClickScheduled) {
        state.s2.editClickScheduled = true;
        window.setTimeout(() => {
          const st = stepEl("2");
          if (!st || !isVisible(st) || state.s2.phase !== "idle") return;
          clickEl(edit);
          state.s2.editClicked = true;
          state.s2.phase = "mapping";
        }, ACTION_DELAY_MS);
      }
    }

    if (state.s2.phase === "mapping" && mapInput instanceof HTMLInputElement) {
      if (!state.s2.mappingClearScheduled) {
        state.s2.mappingClearScheduled = true;
        window.setTimeout(() => {
          const st = stepEl("2");
          const mi = st && st.querySelector("input.mapping-input");
          if (!(mi instanceof HTMLInputElement)) return;
          setInputValueAndNotify(mi, "");
          state.s2.mappingCleared = true;
          mi.focus();
          if (mi.value.trim().length >= ICCID_LEN) {
            scheduleStep2Validate();
          }
        }, ACTION_DELAY_MS);
      }
      if (
        state.s2.mappingCleared &&
        mapInput.value.trim().length >= ICCID_LEN &&
        !state.s2.validateClicked &&
        !state.s2.validateScheduled
      ) {
        scheduleStep2Validate();
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

  /** Visible SweetAlert2 confirm (Ok) — class list varies by build */
  function findSwalConfirmButton() {
    const containers = document.querySelectorAll(".swal2-container");
    for (const root of containers) {
      if (!(root instanceof HTMLElement)) continue;
      const cs = getComputedStyle(root);
      if (cs.display === "none") continue;
      if (root.classList.contains("swal2-backdrop-hidden")) continue;
      const popup = root.querySelector(".swal2-popup");
      const scope = popup || root;
      const candidates = [
        scope.querySelector("button.swal2-confirm.swal-tailwind-btn"),
        scope.querySelector("button.swal2-confirm"),
        root.querySelector("button.swal2-confirm"),
      ];
      for (const btn of candidates) {
        if (!(btn instanceof HTMLElement)) continue;
        const bcs = getComputedStyle(btn);
        if (bcs.display === "none" || bcs.visibility === "hidden") continue;
        if (btn instanceof HTMLButtonElement && btn.disabled) continue;
        return btn;
      }
    }
    return null;
  }

  function clickSwalConfirmRobust() {
    const ok = findSwalConfirmButton();
    if (!ok) return false;
    try {
      ok.focus();
    } catch (_) {
      /* ignore */
    }
    clickEl(ok);
    return true;
  }

  /** Until SIM swal is gone, retry Ok; then Next (overlay must close first) */
  function dismissSimActiveSwalThenNext() {
    let attempts = 0;
    const maxAttempts = 45;
    const tickMs = 100;

    const step = () => {
      attempts += 1;
      if (!swalActiveSim()) {
        window.setTimeout(() => {
          const next = nextStepBtn();
          if (next) clickEl(next);
          state.s2.phase = "done";
        }, ACTION_DELAY_MS);
        return;
      }
      clickSwalConfirmRobust();
      if (attempts < maxAttempts) {
        window.setTimeout(step, tickMs);
      } else {
        clickSwalConfirmRobust();
        window.setTimeout(() => {
          const next = nextStepBtn();
          if (next) clickEl(next);
          state.s2.phase = "done";
        }, ACTION_DELAY_MS);
      }
    };
    step();
  }

  function attachSwalObserver() {
    if (state.swalObserver) return;
    let started = false;
    state.swalObserver = new MutationObserver(() => {
      if (!swalActiveSim() || started) return;
      started = true;
      if (state.swalObserver) {
        state.swalObserver.disconnect();
        state.swalObserver = null;
      }
      window.setTimeout(() => dismissSimActiveSwalThenNext(), ACTION_DELAY_MS);
    });
    state.swalObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    if (swalActiveSim()) {
      started = true;
      if (state.swalObserver) {
        state.swalObserver.disconnect();
        state.swalObserver = null;
      }
      window.setTimeout(() => dismissSimActiveSwalThenNext(), ACTION_DELAY_MS);
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
    const visible = !!(step && isVisible(step));
    if (state.stepLastVisible["3"] && !visible) {
      clearS3Timers();
      restoreHesButtonLabel();
      resetStepAutofill("3");
      const el = stepEl("3");
      if (el) {
        delete el.dataset.wfmS3YesChainDone;
        delete el.dataset.wfmS3YesChainPending;
      }
      const n = nextStepBtn();
      if (n) delete n.dataset.wfmS3NextDone;
      state.s3 = {
        phase: "idle",
        pollTickId: null,
        hesResolved: false,
        pullDefaultText: "",
      };
    }
    state.stepLastVisible["3"] = visible;
    if (!visible) return;

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
  }

  function runStep3YesBranch() {
    const step = stepEl("3");
    if (!step || !isVisible(step)) return;
    if (step.dataset.wfmS3YesChainDone === "1") return;
    if (step.dataset.wfmS3YesChainPending === "1") return;
    const grid = hesGrid();
    if (!grid) return;

    step.dataset.wfmS3YesChainPending = "1";
    const token = state.stepAutofillTokens["3"] ?? 0;
    let t = ACTION_DELAY_MS;

    scheduleStepAction("3", token, t, () => setRadio("Sm Comm Registered", "Yes"));
    t += ACTION_DELAY_MS;

    scheduleStepAction("3", token, t, () => {
      const g = hesGrid();
      if (!g) return;
      if (gridCellSpanText(g, 5) !== "Not Available") {
        setRadio("Sm Reads Received", "Yes");
      }
    });
    t += ACTION_DELAY_MS;

    scheduleStepAction("3", token, t, () => {
      const g = hesGrid();
      if (!g) return;
      if (gridCellSpanText(g, 5) !== "Not Available") {
        setRadio("Sm Reads Verified", "Match");
      }
    });
    t += ACTION_DELAY_MS;

    scheduleStepAction("3", token, t, () => {
      const g = hesGrid();
      if (!g) return;
      const seventh = gridCellSpanText(g, 6);
      const meterId = (deviceIdInput() && deviceIdInput().value) || "";
      if (seventh === "Open" && meterId) {
        try {
          localStorage.setItem(LS_VALVE_PREFIX + meterId, "Open");
        } catch (_) {
          /* ignore */
        }
      }
    });
    t += ACTION_DELAY_MS;

    scheduleStepAction("3", token, t, () => {
      const n = nextStepBtn();
      if (n && !n.dataset.wfmS3NextDone) {
        n.dataset.wfmS3NextDone = "1";
        clickEl(n);
      }
      delete step.dataset.wfmS3YesChainPending;
      step.dataset.wfmS3YesChainDone = "1";
    });
  }

  function runStep4() {
    const step = stepEl("4");
    const visible = !!(step && isVisible(step));
    updateStepVisibility("4", visible, () => {
      const n = nextStepBtn();
      if (n) delete n.dataset.wfmS4NextDone;
    });
    if (!visible) return;
    runStepAutofillChain("4", ACTION_DELAY_MS, [
      () => {
        const meterId = (deviceIdInput() && deviceIdInput().value) || "";
        let valve = "Closed";
        try {
          valve = localStorage.getItem(LS_VALVE_PREFIX + meterId) || "Closed";
        } catch (_) {
          /* ignore */
        }
        setSelect("Sm Valve Status", valve === "Open" ? "Open" : "Closed");
      },
      () => {
        const n = nextStepBtn();
        if (n && !n.dataset.wfmS4NextDone) {
          n.dataset.wfmS4NextDone = "1";
          clickEl(n);
        }
      },
    ]);
  }

  function runStep5() {
    const step = stepEl("5");
    const visible = !!(step && isVisible(step));
    updateStepVisibility("5", visible, () => {
      const n = nextStepBtn();
      if (n) delete n.dataset.wfmS5NextDone;
    });
    if (!visible) return;
    runStepAutofillChain("5", ACTION_DELAY_MS, [
      () => setRadio("Sm Battery Status", "OK"),
      () => {
        const n = nextStepBtn();
        if (n && !n.dataset.wfmS5NextDone) {
          n.dataset.wfmS5NextDone = "1";
          clickEl(n);
        }
      },
    ]);
  }

  function runStep6() {
    const step = stepEl("6");
    const visible = !!(step && isVisible(step));
    updateStepVisibility("6", visible, () => {
      const n = nextStepBtn();
      if (n) delete n.dataset.wfmS6NextDone;
    });
    if (!visible) return;
    runStepAutofillChain("6", ACTION_DELAY_MS, [
      () => setRadio("Sm IP Configured", "Yes"),
      () => setRadio("Sm Port Configured", "Yes"),
      () => setRadio("Sm Schedule Set", "Yes"),
      () => {
        const n = nextStepBtn();
        if (n && !n.dataset.wfmS6NextDone) {
          n.dataset.wfmS6NextDone = "1";
          clickEl(n);
        }
      },
    ]);
  }

  function runStep8() {
    const step = stepEl("8");
    const visible = !!(step && isVisible(step));
    updateStepVisibility("8", visible, () => {
      const preview = document.getElementById("previewChecklistBtn");
      if (preview) delete preview.dataset.wfmPreviewClicked;
    });
    if (!visible) return;
    const fileInp = document.querySelector('input[type="file"][name="Sm Image1"]');
    if (!(fileInp instanceof HTMLInputElement)) return;
    if (fileInp.hasAttribute("required")) return;
    runStepAutofillChain("8", ACTION_DELAY_MS, [
      () => {
        const preview = document.getElementById("previewChecklistBtn");
        if (preview && !preview.dataset.wfmPreviewClicked) {
          preview.dataset.wfmPreviewClicked = "1";
          clickEl(preview);
        }
      },
    ]);
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

  installDeviceIdListeners();
  installMappingInputListeners();
  tick();
  const obs = new MutationObserver(() => scheduleTick());
  obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
})();
