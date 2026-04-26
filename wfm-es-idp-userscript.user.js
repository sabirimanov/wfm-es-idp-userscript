// ==UserScript==
// @name         WFM ES IDP helpers
// @namespace    https://github.com/sabirimanov/wfm-es-idp-userscript
// @version      0.5.2
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

  /** Set true to log every scripted action with a global order number in the console */
  const DEBUG_SCRIPT_ACTIONS = true;

  const LS_VALVE_PREFIX = "wfm_es_idp:valve_status:";
  const SERIAL_MAX_LEN = 16;
  const ICCID_LEN = 20;
  const HES_POLL_MS = 30_000;
  const HES_FIRST_CHECK_MS = 1000;
  /** Pause between scripted UI actions within a step (ms) */
  const ACTION_DELAY_MS = 550;
  /** Optional micro-delay before first batch (ms); set 0 to run fills as soon as the step is visible */
  const STEP_SETTLE_MS = 0;
  /** Wait after all fills in a step before clicking #nextStepBtn (ms) */
  const STEP_NEXT_AFTER_FILL_MS = 500;
  /** Legacy: used where only a click delay is needed (swal dismiss → Next, mapping validate gate) */
  const NEXT_AFTER_FORM_MS = 400;
  /** Small delay before programmatic Edit / Pull clicks so DOM is ready (ms) */
  const ACTION_CLICK_DELAY_MS = 80;
  /** Min time after mapping row is ready for input before Validate may run (ms) */
  const MAPPING_MIN_MS_AFTER_CLEAR = 120;
  /** Idle debounce on .mapping-input before scheduling Validate (ms) */
  const MAPPING_ICCID_IDLE_MS = 500;
  /** Min time after Edit click before Validate may run (ms) */
  const MAPPING_MIN_AFTER_EDIT_MS = 400;
  /** After last keystroke from HID scanner, wait this long then normalize #deviceId */
  const DEVICE_ID_SCAN_IDLE_MS = 300;
  /** Swal “Checklist saved successfully” → wait then reload (ms) */
  const CHECKLIST_SAVED_RELOAD_MS = 1000;

  let wfmActionSeq = 0;

  /** @param {string} message */
  function wfmLog(message) {
    if (!DEBUG_SCRIPT_ACTIONS) return;
    wfmActionSeq += 1;
    console.log(`[WFM ES IDP] ${wfmActionSeq}. ${message}`);
  }

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
    wfmLog(`set radio "${name}" → ${value}`);
  }

  /** @param {string} name @param {string} value */
  function setSelect(name, value) {
    const el = document.querySelector(`select[name="${cssAttr(name)}"]`);
    if (!(el instanceof HTMLSelectElement)) return;
    if (el.value === value) return;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    wfmLog(`set select "${name}" → ${value}`);
  }

  /** @param {string} s */
  function cssAttr(s) {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /** @param {HTMLElement | null | undefined} el */
  function isClickableDisabled(el) {
    if (!(el instanceof HTMLElement)) return true;
    if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
      return !!el.disabled;
    }
    if (el.getAttribute("aria-disabled") === "true") return true;
    return false;
  }

  /**
   * Clicks like a real pointer (many SPAs ignore bare HTMLElement.click()).
   * @param {HTMLElement | null | undefined} el
   */
  function clickEl(el) {
    if (!(el instanceof HTMLElement) || isClickableDisabled(el)) return;
    try {
      el.scrollIntoView({ block: "center", inline: "nearest" });
    } catch (_) {
      try {
        el.scrollIntoView();
      } catch (_) {
        /* ignore */
      }
    }
    try {
      el.focus({ preventScroll: true });
    } catch (_) {
      try {
        el.focus();
      } catch (_) {
        /* ignore */
      }
    }
    const r = el.getBoundingClientRect();
    const cx = Math.max(0, Math.floor(r.left + Math.min(r.width / 2, 80)));
    const cy = Math.max(0, Math.floor(r.top + Math.min(r.height / 2, 40)));

    const mouseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: cx,
      clientY: cy,
      screenX: cx + window.screenX,
      screenY: cy + window.screenY,
      button: 0,
      buttons: 1,
    };

    const tryPointer = typeof PointerEvent !== "undefined";
    if (tryPointer) {
      try {
        el.dispatchEvent(
          new PointerEvent("pointerdown", {
            ...mouseInit,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          })
        );
      } catch (_) {
        /* ignore */
      }
    }
    try {
      el.dispatchEvent(new MouseEvent("mousedown", mouseInit));
    } catch (_) {
      /* ignore */
    }
    if (tryPointer) {
      try {
        el.dispatchEvent(
          new PointerEvent("pointerup", {
            ...mouseInit,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            buttons: 0,
          })
        );
      } catch (_) {
        /* ignore */
      }
    }
    try {
      el.dispatchEvent(
        new MouseEvent("mouseup", {
          ...mouseInit,
          buttons: 0,
        })
      );
    } catch (_) {
      /* ignore */
    }
    try {
      el.dispatchEvent(
        new MouseEvent("click", {
          ...mouseInit,
          buttons: 0,
          detail: 1,
        })
      );
    } catch (_) {
      /* ignore */
    }
    if (typeof el.click === "function") {
      try {
        el.click();
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * Programmatic click with optional debug label (fills use setRadio/setSelect without click).
   * @param {HTMLElement | null | undefined} el
   * @param {string} [label]
   */
  function wfmClick(el, label) {
    if (label) wfmLog(label);
    clickEl(el);
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

  /**
   * Run fills synchronously in one batch (no delay between them), then optional delay before
   * the last action (usually #nextStepBtn). Single callback = fill-only, no Next.
   * @param {string} stepId
   * @param {(() => void)[]} actions
   */
  function runStepAutofillChain(stepId, actions) {
    const step = stepEl(stepId);
    if (!step || !isVisible(step)) return;
    if (step.dataset.wfmAutofillDone === "1") return;
    if (step.dataset.wfmAutofillPending === "1") return;
    step.dataset.wfmAutofillPending = "1";
    const token = state.stepAutofillTokens[stepId] ?? 0;
    if (actions.length === 0) {
      delete step.dataset.wfmAutofillPending;
      return;
    }
    if (actions.length === 1) {
      scheduleStepAction(stepId, token, STEP_SETTLE_MS, () => {
        wfmLog(`step ${stepId}: run single action`);
        actions[0]();
        step.dataset.wfmAutofillDone = "1";
        delete step.dataset.wfmAutofillPending;
      });
      return;
    }
    const last = actions[actions.length - 1];
    const fills = actions.slice(0, -1);
    let t = STEP_SETTLE_MS;
    scheduleStepAction(stepId, token, t, () => {
      wfmLog(`step ${stepId}: batch fill (${fills.length} callback(s))`);
      for (const fn of fills) fn();
    });
    t += STEP_NEXT_AFTER_FILL_MS;
    scheduleStepAction(stepId, token, t, () => {
      wfmLog(`step ${stepId}: after-fill action (e.g. Next)`);
      last();
      step.dataset.wfmAutofillDone = "1";
      delete step.dataset.wfmAutofillPending;
    });
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
   * Extract meter serial from full QR JSON (call only after scan has finished).
   * Prefers regex on complete string so trailing JSON is stripped in one shot.
   * @param {string} raw
   */
  function extractSerialFromPayload(raw) {
    const t = raw.trim();
    let m = t.match(/"SerialNumber"\s*:\s*"([^"]*)"/i);
    if (!m) m = t.match(/"SerialNumber"\s*:\s*"([^"]*)/i);
    if (m) {
      const s = m[1].slice(0, SERIAL_MAX_LEN);
      return s;
    }
    if (!/["{]/.test(t) && /^[A-Za-z0-9]{1,16}$/.test(t)) return t.slice(0, SERIAL_MAX_LEN);
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

  /**
   * After Pull HES has started on step 3, block delayed #nextStepBtn from other steps
   * until step 3 is finished (avoids Next before pull / grid; does not block 2→3 advance).
   */
  function step3hesFlowBlocksNonStep3Next() {
    const s3 = stepEl("3");
    if (!s3 || !isVisible(s3)) return false;
    if (!state.s3.pullAttempted) return false;
    if (state.s3.phase === "completed") return false;
    return true;
  }

  /**
   * Click #nextStepBtn only if that checklist step is still visible (stale timers)
   * and step 3 HES is not mid-flight (prevents Next before Pull / grid ready).
   * @param {string} stepId
   * @param {string} doneAttr dataset property e.g. "wfmS1NextDone"
   * @param {number} [delayMs] default NEXT_AFTER_FORM_MS; use 0 when caller already delayed
   * @param {() => void} [onAfterClick] runs only after a successful click (e.g. mark s3 completed)
   */
  function clickNextIfStepActive(stepId, doneAttr, delayMs, onAfterClick) {
    const wait = delayMs === undefined ? NEXT_AFTER_FORM_MS : delayMs;
    window.setTimeout(() => {
      if (stepId !== "3" && step3hesFlowBlocksNonStep3Next()) return;
      const st = stepEl(stepId);
      if (!st || !isVisible(st)) return;
      const n = nextStepBtn();
      if (!n) return;
      if (doneAttr && (/** @type {Record<string, string>} */ (n.dataset))[doneAttr]) return;
      if (doneAttr) (/** @type {Record<string, string>} */ (n.dataset))[doneAttr] = "1";
      wfmClick(n, `step ${stepId}: click #nextStepBtn`);
      if (typeof onAfterClick === "function") onAfterClick();
    }, wait);
  }

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

  /** @param {string} name @param {string} value */
  function isRadioChecked(name, value) {
    const el = document.querySelector(
      `input[type="radio"][name="${cssAttr(name)}"][value="${cssAttr(value)}"]`
    );
    return el instanceof HTMLInputElement && el.type === "radio" && el.checked;
  }

  /** Apply step 3 radios from HES grid (instant, no delays). */
  function fillStep3RadiosFromHesGrid() {
    const g = hesGrid();
    if (!g) return;
    setRadio("Sm Comm Registered", "Yes");
    if (gridCellSpanText(g, 5) !== "Not Available") {
      setRadio("Sm Reads Received", "Yes");
      setRadio("Sm Reads Verified", "Match");
    }
    const seventh = gridCellSpanText(g, 6);
    const meterId = (deviceIdInput() && deviceIdInput().value) || "";
    if (seventh === "Open" && meterId) {
      try {
        localStorage.setItem(LS_VALVE_PREFIX + meterId, "Open");
      } catch (_) {
        /* ignore */
      }
    }
  }

  /** True when HES-driven radios match grid (all required options checked). */
  function step3HesRadiosMatchGrid() {
    const g = hesGrid();
    if (!g) return false;
    if (!isRadioChecked("Sm Comm Registered", "Yes")) return false;
    if (gridCellSpanText(g, 5) !== "Not Available") {
      if (!isRadioChecked("Sm Reads Received", "Yes")) return false;
      if (!isRadioChecked("Sm Reads Verified", "Match")) return false;
    }
    return true;
  }

  const state = {
    stepAutofillTokens: /** @type {Record<string, number>} */ ({}),
    /** Tracks visibility so we reset autofill only on leave, not every tick while hidden */
    stepLastVisible: /** @type {Record<string, boolean>} */ ({}),
    preModalWasHidden: true,
    deviceIdListenersInstalled: false,
    mappingInputListenersInstalled: false,
    s2: /** @type {{ phase: string; editClicked: boolean; editClickScheduled: boolean; mappingCleared: boolean; mappingClearedAt: number; editClickedAt: number; keystrokesAfterClear: number; mappingUserInteractedTrusted: boolean; validateClicked: boolean; validateScheduled: boolean; radiosApplied: boolean; sawSimActiveSwal: boolean }} */ ({
      phase: "idle",
      editClicked: false,
      editClickScheduled: false,
      mappingCleared: false,
      mappingClearedAt: 0,
      editClickedAt: 0,
      keystrokesAfterClear: 0,
      mappingUserInteractedTrusted: false,
      validateClicked: false,
      validateScheduled: false,
      radiosApplied: false,
      sawSimActiveSwal: false,
    }),
    s3: /** @type {{
      phase: string;
      pollTickId: ReturnType<typeof setInterval> | null;
      hesResolved: boolean;
      pullDefaultText: string;
      pullAttempted: boolean;
      yesPollAttempts: number;
    }} */ ({
      phase: "idle",
      pollTickId: null,
      hesResolved: false,
      pullDefaultText: "",
      pullAttempted: false,
      yesPollAttempts: 0,
    }),
    swalObserver: /** @type {MutationObserver | null} */ (null),
    checklistSavedObserver: /** @type {MutationObserver | null} */ (null),
    checklistSavedReloadScheduled: false,
    deviceIdDebounceTimer: 0,
    mappingValidateDebounceTimer: 0,
  };

  function clearS3Timers() {
    if (state.s3.pollTickId) {
      clearInterval(state.s3.pollTickId);
      state.s3.pollTickId = null;
    }
  }

  function swalChecklistSavedVisible() {
    const el = document.getElementById("swal2-html-container");
    if (!el) return false;
    const text = (el.textContent || "").trim();
    const d = el.style.display;
    const visible = d === "block" || getComputedStyle(el).display === "block";
    return visible && text === "Checklist saved successfully";
  }

  function maybeScheduleChecklistSavedReload() {
    if (state.checklistSavedReloadScheduled) return;
    if (!swalChecklistSavedVisible()) return;
    state.checklistSavedReloadScheduled = true;
    window.setTimeout(() => {
      window.location.reload();
    }, CHECKLIST_SAVED_RELOAD_MS);
  }

  function attachChecklistSavedObserver() {
    if (state.checklistSavedObserver) return;
    state.checklistSavedObserver = new MutationObserver(() => maybeScheduleChecklistSavedReload());
    state.checklistSavedObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ["style", "class"],
    });
    maybeScheduleChecklistSavedReload();
  }

  /** Step 3 HES / yes-branch not finished — block step 4+ until #nextStepBtn advanced this visit */
  function step3BlocksFollowupSteps() {
    const s3 = stepEl("3");
    if (!s3 || !isVisible(s3)) return false;
    return state.s3.phase !== "completed";
  }

  function restoreHesButtonLabel() {
    const btn = hesBtn();
    if (btn && state.s3.pullDefaultText) btn.textContent = state.s3.pullDefaultText;
  }

  function handleDeviceIdInput(ev) {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement) || input.id !== "deviceId") return;
    if (state.deviceIdDebounceTimer) {
      window.clearTimeout(state.deviceIdDebounceTimer);
      state.deviceIdDebounceTimer = 0;
    }
    state.deviceIdDebounceTimer = window.setTimeout(() => {
      state.deviceIdDebounceTimer = 0;
      flushDeviceIdAfterScanIdle(input);
    }, DEVICE_ID_SCAN_IDLE_MS);
  }

  /** Run after no new characters for DEVICE_ID_SCAN_IDLE_MS — keeps serial only, then validate */
  function flushDeviceIdAfterScanIdle(input) {
    if (!(input instanceof HTMLInputElement) || input.id !== "deviceId") return;
    if (!document.body.contains(input)) return;
    const raw = input.value;
    const serial = extractSerialFromPayload(raw);

    if (serial.length < SERIAL_MAX_LEN) {
      delete input.dataset.wfmAutoValidated;
    }

    if (serial.length > 0 && input.value !== serial) {
      setInputValueAndNotify(input, serial);
      try {
        input.setSelectionRange(serial.length, serial.length);
      } catch (_) {
        /* ignore */
      }
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
    if (v) wfmClick(v, "pre-install: click #validateBtnId (device id)");
  }

  function installDeviceIdListeners() {
    if (state.deviceIdListenersInstalled) return;
    state.deviceIdListenersInstalled = true;
    document.addEventListener("input", handleDeviceIdInput, false);
    document.addEventListener("change", handleDeviceIdInput, false);
  }

  function handleMappingInput(ev) {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains("mapping-input")) return;
    const st = stepEl("2");
    if (!st || !isVisible(st) || state.s2.phase !== "mapping") return;
    if (!state.s2.mappingCleared) return;
    if (state.s2.validateClicked || state.s2.validateScheduled) return;
    if (ev.isTrusted) {
      state.s2.mappingUserInteractedTrusted = true;
      state.s2.keystrokesAfterClear += 1;
    }
    if (!state.s2.mappingUserInteractedTrusted) return;
    if (state.mappingValidateDebounceTimer) {
      window.clearTimeout(state.mappingValidateDebounceTimer);
      state.mappingValidateDebounceTimer = 0;
    }
    state.mappingValidateDebounceTimer = window.setTimeout(() => {
      state.mappingValidateDebounceTimer = 0;
      const st2 = stepEl("2");
      const mi = st2 && st2.querySelector("input.mapping-input");
      if (!(mi instanceof HTMLInputElement)) return;
      if (state.s2.phase !== "mapping" || !state.s2.mappingCleared) return;
      if (state.s2.validateClicked || state.s2.validateScheduled) return;
      if (state.s2.keystrokesAfterClear < 1) return;
      if (Date.now() - state.s2.mappingClearedAt < MAPPING_MIN_MS_AFTER_CLEAR) return;
      if (mi.value.trim().length < ICCID_LEN) return;
      if (!state.s2.mappingUserInteractedTrusted) return;
      scheduleStep2Validate();
    }, MAPPING_ICCID_IDLE_MS);
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

    function attemptValidate() {
      const st = stepEl("2");
      if (!st || !isVisible(st)) {
        state.s2.validateScheduled = false;
        state.s2.phase = "mapping";
        return;
      }
      if (state.s2.validateClicked) {
        state.s2.validateScheduled = false;
        return;
      }
      if (state.s2.phase !== "mapping") {
        state.s2.validateScheduled = false;
        return;
      }
      const waitEdit = MAPPING_MIN_AFTER_EDIT_MS - (Date.now() - state.s2.editClickedAt);
      if (state.s2.editClickedAt && waitEdit > 0) {
        window.setTimeout(attemptValidate, waitEdit + 40);
        return;
      }
      const waitClear = MAPPING_MIN_MS_AFTER_CLEAR - (Date.now() - state.s2.mappingClearedAt);
      if (waitClear > 0) {
        window.setTimeout(attemptValidate, waitClear + 40);
        return;
      }
      const mi = st.querySelector("input.mapping-input");
      if (!(mi instanceof HTMLInputElement) || mi.value.trim().length < ICCID_LEN) {
        state.s2.validateScheduled = false;
        return;
      }
      if (state.s2.keystrokesAfterClear < 1) {
        state.s2.validateScheduled = false;
        return;
      }
      const valBtn = findValidateBtn(st);
      state.s2.phase = "swal_wait";
      if (valBtn) wfmClick(valBtn, "step 2: click Validate (ICCID)");
      state.s2.validateClicked = true;
      attachSwalObserver();
    }

    window.setTimeout(attemptValidate, 0);
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
    /* Leave data-wfm-s0-next-done on #nextStepBtn when navigating back so we do not auto-click Next again. */
    updateStepVisibility("0", visible);
    if (!visible) return;
    runStepAutofillChain("0", [
      () => {
        setRadio("Sm IMEI Verified", "Yes");
        setRadio("Sm Metrology Verified", "Yes");
      },
      () => clickNextIfStepActive("0", "wfmS0NextDone", 0),
    ]);
  }

  function runStep1() {
    const step = stepEl("1");
    const visible = !!(step && isVisible(step));
    updateStepVisibility("1", visible);
    if (!visible) return;
    /* No #nextStepBtn: e.g. Sm Body Condition needs manual input when not scripted. */
    runStepAutofillChain("1", [
      () => {
        setSelect("Sm Display Function", "OK");
        setRadio("Sm Serial Verified", "Match");
        // () => setRadio("Sm Body Condition", "Not Damaged");
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
        mappingClearedAt: 0,
        editClickedAt: 0,
        keystrokesAfterClear: 0,
        mappingUserInteractedTrusted: false,
        validateClicked: false,
        validateScheduled: false,
        radiosApplied: false,
        sawSimActiveSwal: false,
      };
      if (state.swalObserver) {
        state.swalObserver.disconnect();
        state.swalObserver = null;
      }
      if (state.mappingValidateDebounceTimer) {
        window.clearTimeout(state.mappingValidateDebounceTimer);
        state.mappingValidateDebounceTimer = 0;
      }
    }
    state.stepLastVisible["2"] = visible;
    if (!visible) return;

    if (!state.s2.radiosApplied && step.dataset.wfmAutofillDone !== "1") {
      if (step.dataset.wfmS2RadiosPending !== "1") {
        step.dataset.wfmS2RadiosPending = "1";
        const token = state.stepAutofillTokens["2"] ?? 0;
        scheduleStepAction("2", token, STEP_SETTLE_MS, () => {
          setRadio("Sm ICCID Mapped", "Yes");
          setRadio("Sm SIM Activated", "Yes");
          state.s2.radiosApplied = true;
          delete step.dataset.wfmS2RadiosPending;
        });
      }
    }

    /**
     * Step 2 mapping: clear ICCID field → click Edit → focus → wait 20 chars → Validate;
     * #nextStepBtn only after “SIM is active” swal flow (see dismissSimActiveSwalThenNext).
     */
    if (state.s2.phase === "idle" && state.s2.radiosApplied) {
      const edit = findEditBtn(step);
      const mapInput = step.querySelector("input.mapping-input");
      if (edit && !state.s2.editClicked && !state.s2.editClickScheduled) {
        state.s2.editClickScheduled = true;
        window.setTimeout(() => {
          const st = stepEl("2");
          if (!st || !isVisible(st) || state.s2.phase !== "idle") return;
          const mi0 = st.querySelector("input.mapping-input");
          if (mi0 instanceof HTMLInputElement && mi0.value.trim() !== "") {
            setInputValueAndNotify(mi0, "");
            wfmLog("step 2: clear mapping-input (before Edit)");
          }
          window.setTimeout(() => {
            const st2 = stepEl("2");
            const ed = st2 && findEditBtn(st2);
            if (!st2 || !isVisible(st2) || state.s2.phase !== "idle" || !ed) return;
            wfmClick(ed, "step 2: click Edit");
            state.s2.editClicked = true;
            state.s2.editClickedAt = Date.now();
            state.s2.phase = "mapping";
            const mi = st2.querySelector("input.mapping-input");
            if (mi instanceof HTMLInputElement) {
              try {
                mi.focus();
              } catch (_) {
                /* ignore */
              }
              wfmLog("step 2: focus mapping-input (await 20-char ICCID)");
            }
            state.s2.mappingCleared = true;
            state.s2.mappingClearedAt = Date.now();
            state.s2.mappingUserInteractedTrusted = false;
            state.s2.keystrokesAfterClear = 0;
          }, ACTION_CLICK_DELAY_MS);
        }, ACTION_CLICK_DELAY_MS);
      }
    }
  }

  /** Step 2 SIM / mapping pipeline not finished — do not run step 3+ automation */
  function step2PipelineBlocking() {
    const step = stepEl("2");
    return !!(step && isVisible(step) && state.s2.phase !== "done");
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
    wfmClick(ok, "step 2: click swal confirm (SIM is active)");
    return true;
  }

  /** Until SIM swal is gone, retry Ok; then Next only after “SIM is active” was seen */
  function dismissSimActiveSwalThenNext() {
    let attempts = 0;
    const maxAttempts = 45;
    const tickMs = 100;

    const step = () => {
      attempts += 1;
      if (!swalActiveSim()) {
        if (!state.s2.sawSimActiveSwal) {
          wfmLog("step 2: swal closed without seeing “SIM is active” — skip #nextStepBtn (retry Validate if needed)");
          state.s2.validateClicked = false;
          state.s2.validateScheduled = false;
          state.s2.phase = "mapping";
          return;
        }
        wfmLog("step 2: “SIM is active” swal dismissed — schedule Next");
        clickNextIfStepActive("2", "wfmS2SimNextDone", STEP_NEXT_AFTER_FILL_MS);
        state.s2.phase = "done";
        return;
      }
      clickSwalConfirmRobust();
      if (attempts < maxAttempts) {
        window.setTimeout(step, tickMs);
      } else {
        clickSwalConfirmRobust();
        if (state.s2.sawSimActiveSwal) {
          clickNextIfStepActive("2", "wfmS2SimNextDone", STEP_NEXT_AFTER_FILL_MS);
        }
        state.s2.phase = "done";
      }
    };
    step();
  }

  function attachSwalObserver() {
    if (state.swalObserver) return;
    let started = false;
    const onSimSwalSeen = () => {
      state.s2.sawSimActiveSwal = true;
      wfmLog("step 2: swal visible with text “SIM is active”");
      if (state.swalObserver) {
        state.swalObserver.disconnect();
        state.swalObserver = null;
      }
      window.setTimeout(() => dismissSimActiveSwalThenNext(), NEXT_AFTER_FORM_MS);
    };
    state.swalObserver = new MutationObserver(() => {
      if (!swalActiveSim() || started) return;
      started = true;
      onSimSwalSeen();
    });
    state.swalObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    if (swalActiveSim()) {
      started = true;
      onSimSwalSeen();
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
        wfmClick(btn, "step 3: HES poll timer — click Pull HES");
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
      state.s3 = {
        phase: "idle",
        pollTickId: null,
        hesResolved: false,
        pullDefaultText: "",
        pullAttempted: false,
        yesPollAttempts: 0,
      };
    }
    state.stepLastVisible["3"] = visible;
    if (!visible) return;
    if (state.s3.phase === "completed") return;

    const grid = hesGrid();
    const pull = hesBtn();
    if (!pull || !grid) return;

    if (state.s3.phase === "idle") {
      if (state.s3.pullAttempted) return;
      state.s3.pullAttempted = true;
      const rawLabel = (pull.textContent || "").trim();
      state.s3.pullDefaultText =
        rawLabel.replace(/\s*\(\d+\)\s*$/, "").trim() || "Pull HES Data";
      wfmClick(pull, "step 3: click Pull HES (#btnGetHesDetails)");
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
          if (state.s3.phase === "wait_label") {
            state.s3.phase = "idle";
            state.s3.pullAttempted = false;
          }
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
    const maxPolls = 100;

    function tryFillAndMaybeNext() {
      state.s3.yesPollAttempts += 1;
      const st = stepEl("3");
      if (!st || !isVisible(st)) return;
      fillStep3RadiosFromHesGrid();
      if (!step3HesRadiosMatchGrid()) {
        if (state.s3.yesPollAttempts < maxPolls) {
          scheduleStepAction("3", token, 120, tryFillAndMaybeNext);
        } else {
          wfmLog("step 3: stopped polling HES radios (max attempts)");
        }
        return;
      }
      wfmLog("step 3: all HES radios match grid — schedule #nextStepBtn");
      clickNextIfStepActive(
        "3",
        "wfmS3NextDone",
        STEP_NEXT_AFTER_FILL_MS,
        () => {
          state.s3.phase = "completed";
          delete step.dataset.wfmS3YesChainPending;
          step.dataset.wfmS3YesChainDone = "1";
        }
      );
    }

    state.s3.yesPollAttempts = 0;
    scheduleStepAction("3", token, STEP_SETTLE_MS, tryFillAndMaybeNext);
  }

  function runStep4() {
    const step = stepEl("4");
    const visible = !!(step && isVisible(step));
    updateStepVisibility("4", visible);
    if (!visible) return;
    runStepAutofillChain("4", [
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
      () => clickNextIfStepActive("4", "wfmS4NextDone", 0),
    ]);
  }

  function runStep5() {
    const step = stepEl("5");
    const visible = !!(step && isVisible(step));
    updateStepVisibility("5", visible);
    if (!visible) return;
    runStepAutofillChain("5", [
      () => setRadio("Sm Battery Status", "OK"),
      () => clickNextIfStepActive("5", "wfmS5NextDone", 0),
    ]);
  }

  function runStep6() {
    const step = stepEl("6");
    const visible = !!(step && isVisible(step));
    updateStepVisibility("6", visible);
    if (!visible) return;
    runStepAutofillChain("6", [
      () => {
        setRadio("Sm IP Configured", "Yes");
        setRadio("Sm Port Configured", "Yes");
        setRadio("Sm Schedule Set", "Yes");
      },
      () => clickNextIfStepActive("6", "wfmS6NextDone", 0),
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
    runStepAutofillChain("8", [
      () => {
        const preview = document.getElementById("previewChecklistBtn");
        if (preview && !preview.dataset.wfmPreviewClicked) {
          preview.dataset.wfmPreviewClicked = "1";
          wfmClick(preview, "step 8: click preview checklist");
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
    const s2Blocking = step2PipelineBlocking();
    const s3Blocking = step3BlocksFollowupSteps();

    runStep2();
    if (!s2Blocking) {
      runStep3();
    }

    if (!hesBlocking && !s2Blocking && !s3Blocking) {
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
    }, 200);
  }

  if (DEBUG_SCRIPT_ACTIONS) {
    console.log("[WFM ES IDP] DEBUG_SCRIPT_ACTIONS = true — numbered action log enabled");
  }

  installDeviceIdListeners();
  installMappingInputListeners();
  attachChecklistSavedObserver();
  tick();
  const obs = new MutationObserver(() => scheduleTick());
  obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
})();
