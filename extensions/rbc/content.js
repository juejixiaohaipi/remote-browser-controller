// Remote Browser Controller - Content Script
// Injected into all pages

(function() {
  'use strict';

  // Debug logging toggle — read from chrome.storage.local.rbcDebug.
  // Set via devtools: chrome.storage.local.set({ rbcDebug: true })
  let DEBUG = false;
  try {
    chrome.storage?.local?.get?.(['rbcDebug']).then(r => { DEBUG = !!r.rbcDebug; }).catch(() => {});
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area === 'local' && changes.rbcDebug) DEBUG = !!changes.rbcDebug.newValue;
    });
  } catch {}
  const dlog = (...args) => { if (DEBUG) console.log(...args); };

  console.log('[RBC] Content script loaded on', window.location.href);

  // ── Keep SW alive via persistent port (MV3) ──
  let rbcPort = null;
  let reconnectCount = 0;
  const MAX_RECONNECT = 100; // Max reconnection attempts to prevent infinite loops

  // Detect orphaned content script: extension was reloaded/uninstalled,
  // chrome.runtime becomes undefined and recovery requires a page reload.
  function isContextValid() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch { return false; }
  }

  function connectToBackground() {
    if (reconnectCount >= MAX_RECONNECT) {
      console.error('[RBC] Max reconnection attempts reached, giving up');
      return;
    }
    // Guard: chrome.runtime undefined → orphaned content script. Retrying is futile.
    if (!isContextValid()) {
      console.warn('[RBC] Extension context invalidated — content script orphaned. Reload the page.');
      return;
    }

    try {
      rbcPort = chrome.runtime.connect({ name: 'rbc-tab' });
      const lastErr = chrome.runtime && chrome.runtime.lastError && chrome.runtime.lastError.message;
      if (lastErr) {
        console.error(`[RBC] connect lastError: ${lastErr}`);
        if (lastErr.includes('Extension context') || lastErr.includes('Receiving end')) {
          return; // orphan — don't retry
        }
        reconnectCount++;
        setTimeout(connectToBackground, Math.min(5000 * Math.pow(2, reconnectCount), 30000));
        return;
      }

      rbcPort.onDisconnect.addListener(() => {
        rbcPort = null;
        if (!isContextValid()) {
          console.warn('[RBC] Extension context lost on disconnect — giving up.');
          return;
        }
        reconnectCount++;
        const delay = Math.min(1000 * Math.pow(2, reconnectCount), 10000);
        console.log(`[RBC] Port disconnected, reconnecting in ${delay}ms (attempt ${reconnectCount}/${MAX_RECONNECT})`);
        setTimeout(connectToBackground, delay);
      });
      rbcPort.onMessage.addListener((msg) => {
        reconnectCount = 0; // Reset only after confirmed communication
        if (msg.type === 'ping') {
          try { rbcPort.postMessage({ type: 'pong' }); } catch {}
        }
      });
    } catch (err) {
      const rawMsg = (err && err.message) || String(err);
      // Common orphan signatures:
      //   TypeError: Cannot read properties of undefined (reading 'connect')
      //   Error: Extension context invalidated
      if (!isContextValid()
          || rawMsg.includes('Extension context')
          || rawMsg.includes('context invalidated')
          || rawMsg.includes("reading 'connect'")
          || rawMsg.includes("reading 'sendMessage'")) {
        console.warn('[RBC] Extension context invalidated — stopping retries. Reload the page.');
        return;
      }
      reconnectCount++;
      console.error(`[RBC] Failed to connect port (attempt ${reconnectCount}/${MAX_RECONNECT}):`, rawMsg);
      if (reconnectCount < MAX_RECONNECT) {
        setTimeout(connectToBackground, 5000);
      }
    }
  }
  connectToBackground();

  // ── Dialog interceptor
  // Native alert/confirm/prompt are synchronous and cannot wait for remote commands.
  // We auto-dismiss them and track the last dialog so the server can query it.
  let lastDialog = null;

  function notifyDialog(dialogType, message) {
    dlog('[RBC] Dialog intercepted:', dialogType, message);
    lastDialog = { dialogType, message: String(message), timestamp: Date.now() };
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage({
        type: 'content_dialog',
        dialogType,
        message: String(message)
      });
    } catch {}
  }

  window.alert = function(message) {
    notifyDialog('alert', message);
    return undefined;
  };

  window.confirm = function(message) {
    notifyDialog('confirm', message);
    return false;
  };

  window.prompt = function(message) {
    notifyDialog('prompt', message);
    return null;
  };

  // Command handlers

  // ── Accessibility Snapshot (e# refs) ───────────────────────────────
  // eRefMap stores WeakRefs so detached nodes (e.g., after SPA route swap)
  // can be GC'd instead of leaking. URL is tracked too — if the page URL
  // changes between snapshot and resolve, the old refs are invalidated.
  const snapshotState = {
    eRefMap: new Map(),       // "e3" → WeakRef<HTMLElement>
    nextId: 1,
    snapshotUrl: '',
  };

  // Resolve a selector or e# ref to an HTMLElement
  function resolveElement(ref) {
    if (!ref) return null;
    if (/^e\d+$/.test(ref)) {
      // Invalidate refs if URL changed since snapshot (SPA navigation)
      if (snapshotState.snapshotUrl && snapshotState.snapshotUrl !== location.href) {
        return null;
      }
      const weak = snapshotState.eRefMap.get(ref);
      const el = weak?.deref?.() || null;
      // Guard against detached nodes
      if (el && !el.isConnected) return null;
      return el;
    }
    return document.querySelector(ref);
  }

  // Visibility check: CSS display/visibility/opacity + size + viewport
  function isElementVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    if (rect.bottom < 0 || rect.right < 0) return false;
    if (rect.top > window.innerHeight && rect.left > window.innerWidth) return false;
    return true;
  }

  // Build accessibility snapshot with stable e# refs
  function buildSnapshot() {
    const root = document.body;
    if (!root) return { elements: [], url: location.href, title: document.title };

    // Reset refs on each snapshot
    snapshotState.eRefMap.clear();
    snapshotState.nextId = 1;
    snapshotState.snapshotUrl = location.href;

    // Find all interactive/focusable elements
    const interactiveSelectors = [
      'a[href]', 'button', 'input:not([type=hidden])',
      'select', 'textarea',
      '[contenteditable]', '[role=button]', '[role=link]', '[role=menuitem]',
      '[role=tab]', '[role=radio]', '[role=checkbox]', '[role=switch]',
      '[role=textbox]', '[role=searchbox]', '[role=combobox]',
      '[tabindex]:not([tabindex=-1])',
    ];

    const seenEls = new Set();
    const elements = [];

    for (const sel of interactiveSelectors) {
      try {
        for (const el of root.querySelectorAll(sel)) {
          if (seenEls.has(el)) continue;
          seenEls.add(el);

          if (!isElementVisible(el)) continue;
          const rect = el.getBoundingClientRect();

          const eRef = 'e' + snapshotState.nextId++;
          snapshotState.eRefMap.set(eRef, new WeakRef(el));

          const implicitRole = (() => {
            const tag = el.tagName;
            if (tag === 'A') return 'link';
            if (tag === 'BUTTON') return 'button';
            if (tag === 'SELECT') return 'combobox';
            if (tag === 'TEXTAREA') return 'textbox';
            if (tag === 'INPUT') {
              const t = (el.type || 'text').toLowerCase();
              if (t === 'checkbox') return 'checkbox';
              if (t === 'radio') return 'radio';
              if (t === 'range') return 'slider';
              if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
              return 'textbox';
            }
            return tag.toLowerCase();
          })();
          const role = el.getAttribute('role') || implicitRole;

          const inputType = el.type || '';
          const labelledById = el.getAttribute('aria-labelledby');
          const labelledByText = labelledById
            ? labelledById.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ')
            : '';
          const label = el.getAttribute('aria-label')
            || labelledByText
            || (el.labels?.[0]?.textContent || '').trim()
            || el.textContent?.trim().slice(0, 80)
            || '';

          elements.push({
            eRef,
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            class: (typeof el.className === 'string' ? el.className : el.getAttribute('class') || '').slice(0, 80) || undefined,
            role,
            type: inputType || undefined,
            label: label || undefined,
            placeholder: el.placeholder || undefined,
            value: el.value !== undefined && el.value !== '' ? String(el.value).slice(0, 60) : undefined,
            href: el.href !== undefined ? (el.tagName === 'A' ? (el.href.length > 100 ? el.href.slice(0, 100) + '...' : el.href) : undefined) : undefined,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            disabled: el.disabled === true ? true : undefined,
            checked: (el.type === 'checkbox' || el.type === 'radio') ? el.checked : undefined,
            readOnly: el.readOnly === true ? true : undefined,
            required: el.required === true ? true : undefined,
            ariaExpanded: el.getAttribute('aria-expanded') || undefined,
          });
        }
      } catch {}
    }

    return {
      elements,
      url: location.href,
      title: document.title,
      count: elements.length,
    };
  }

  // ── Element helpers ──────────────────────────────────────────────

  function q(ref) {
    const el = resolveElement(ref);
    if (!el) throw new Error(`Element not found: ${ref}`);
    return el;
  }

  const handlers = {
    // Element operations
    'element.click': async ({ selector }) => {
      const el = q(selector);
      const tag = (el.tagName || '').toLowerCase();
      // Per HTMLElement.click() spec, the synthetic click is dispatched UNLESS
      // the element is a form control that's disabled (then return without
      // firing). visibility:hidden, opacity:0, pointer-events:none, off-screen,
      // zero-size, aria-disabled — NONE of these block programmatic dispatch:
      // listeners still fire. So the only true reject reason is form-disabled;
      // everything else is informational and we still call el.click().
      //
      // We deliberately do NOT scrollIntoView here: el.click() is coordinate-
      // independent, and forcing a scroll has UI side effects (closes sticky
      // headers, blurs Chrome autofill, triggers lazy re-renders that detach
      // the very element we're about to click).
      const formDisabled = el.disabled === true;
      const rect = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const inViewport = rect.width > 0 && rect.height > 0
        && cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight;
      // Best-effort overlay detection — only meaningful when target is inside
      // viewport with non-zero hit area. Reported as info, never blocks.
      let obscuredBy = null;
      if (inViewport && cs.visibility !== 'hidden') {
        const top = document.elementFromPoint(cx, cy);
        if (top && top !== el && !el.contains(top) && !top.contains(el)) {
          const tt = (top.tagName || '').toLowerCase();
          const id = top.id ? '#' + top.id : '';
          const cls = (typeof top.className === 'string' && top.className)
            ? '.' + top.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')
            : '';
          obscuredBy = tt + id + cls;
        }
      }
      const bbox = { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
      if (formDisabled) {
        return { success: false, found: true, tag, disabled: true, inViewport, obscuredBy, bbox,
                 reason: 'element is form-disabled — HTMLElement.click() skips dispatch on form-disabled elements per spec' };
      }
      // Surface other suspicious states as warnings, but still fire — the
      // click event WILL be dispatched and listeners will see it.
      const warnings = [];
      if (rect.width === 0 || rect.height === 0) warnings.push('zero-size (display:none / detached / collapsed parent) — listeners may have unhooked');
      if (cs.visibility === 'hidden') warnings.push('visibility:hidden — element invisible but listeners still notified');
      if (el.getAttribute('aria-disabled') === 'true') warnings.push('aria-disabled=true — semantic hint; some apps self-no-op such clicks');
      if (!inViewport && rect.width > 0 && rect.height > 0) warnings.push('element off-screen — click dispatched programmatically; some listeners only attach when in view');

      // ── Click probe ─────────────────────────────────────────────────────
      // Install a window-capture listener BEFORE clicking so we can answer
      // "was the click event actually dispatched on the page tree?" Capture
      // phase on window fires before any handler on target/ancestors, so even
      // if site code calls stopPropagation() we still observe it.
      //
      // We deliberately do NOT await an async observation window here: if
      // el.click() triggers navigation (e.g. <input type="submit">), the
      // content-script context is destroyed during the wait and the message
      // port closes — the response never reaches background.js. Synchronous
      // probe + sync URL/scroll diff is enough for diagnostic purposes; the
      // LLM picks up the post-click DOM via the next page_observe anyway.
      let dispatched = false;
      let isTrusted = null;
      let defaultPrevented = false;
      let targetTag = null;
      const probe = (e) => {
        if (e.composedPath().indexOf(el) !== -1) {
          dispatched = true;
          isTrusted = e.isTrusted;
          defaultPrevented = e.defaultPrevented;
          targetTag = (e.target?.tagName || '').toLowerCase();
        }
      };
      window.addEventListener('click', probe, { capture: true });
      const urlBefore = location.href;
      const htmlSizeBefore = document.body?.innerHTML?.length || 0;
      const scrollBefore = window.scrollY;
      el.click();
      // Listener fires synchronously during dispatch. Synchronous DOM
      // mutations and same-task URL/scroll changes are already visible.
      window.removeEventListener('click', probe, true);
      const urlChanged = location.href !== urlBefore;
      const htmlSizeAfter = document.body?.innerHTML?.length || 0;
      const htmlChanged = Math.abs(htmlSizeAfter - htmlSizeBefore) > 100;
      const scrollChanged = window.scrollY !== scrollBefore;
      const pageReacted = urlChanged || htmlChanged || scrollChanged;
      return {
        success: true, found: true, tag, disabled: false, inViewport, obscuredBy, bbox,
        dispatched, isTrusted, defaultPrevented, targetTag,
        pageReacted, urlChanged, htmlChanged, scrollChanged,
        ...(warnings.length ? { warnings } : {}),
      };
    },

    'element.type': async ({ selector, text, pressEnter }) => {
      const el = q(selector);
      el.focus();

      // Use native value setter so React/Vue observe the change (their onChange
      // listeners hook the prototype setter — direct .value= bypasses them).
      // Uses Array.from to iterate by Unicode code points (CJK/emoji safe).
      const chars = Array.from(String(text ?? ''));

      if (el.isContentEditable) {
        el.textContent = '';
        let acc = '';
        for (const char of chars) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
          acc += char;
          el.textContent = acc;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
        }
      } else {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        const setValue = (v) => { nativeSetter ? nativeSetter.call(el, v) : (el.value = v); };
        setValue('');
        let acc = '';
        for (const char of chars) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
          acc += char;
          setValue(acc);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      if (pressEnter) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new Event('submit', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
      }

      return { success: true };
    },

    'element.select': async ({ selector, value }) => {
      const el = q(selector);
      const option = Array.from(el.options).find(opt => opt.value === value || opt.text === value);
      if (!option) throw new Error(`Option not found: ${value}`);
      el.value = option.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true };
    },

    'element.check': async ({ selector, checked }) => {
      const el = q(selector);
      el.checked = checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true };
    },

    'element.hover': async ({ selector }) => {
      const el = q(selector);
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
      return { success: true };
    },

    'keyboard.press': async ({ key, modifiers, selector }) => {
      const target = selector ? q(selector) : (document.activeElement || document.body);
      const modList = modifiers || [];
      const keyMap = {
        'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
        'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
        'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
        'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
        'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
        'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
        'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
        'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
        'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
        'Home': { key: 'Home', code: 'Home', keyCode: 36 },
        'End': { key: 'End', code: 'End', keyCode: 35 },
        'PageUp': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
        'PageDown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
        'Space': { key: ' ', code: 'Space', keyCode: 32 },
      };
      const mapped = keyMap[key] || { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
      const eventInit = {
        ...mapped,
        bubbles: true,
        cancelable: true,
        ctrlKey: modList.includes('Control') || modList.includes('Ctrl'),
        shiftKey: modList.includes('Shift'),
        altKey: modList.includes('Alt'),
        metaKey: modList.includes('Meta') || modList.includes('Command'),
      };
      target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
      target.dispatchEvent(new KeyboardEvent('keyup', eventInit));

      // Tab: manually move focus since dispatched events don't trigger default behavior
      if (key === 'Tab') {
        const focusable = [...document.querySelectorAll(
          'a[href],button:not([disabled]),input:not([type=hidden]):not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
        )];
        const idx = focusable.indexOf(target);
        const next = eventInit.shiftKey ? focusable[idx - 1] : focusable[idx + 1];
        if (next) next.focus();
      }
      return { success: true };
    },

    'mouse.click': async ({ x, y, button = 'left', clickCount = 1 }) => {
      const buttonMap = { left: 0, middle: 1, right: 2 };
      const buttonNum = buttonMap[button] ?? 0;
      const el = document.elementFromPoint(x, y);
      const target = el || document.body;
      const eventInit = {
        clientX: x, clientY: y,
        screenX: x + window.screenX, screenY: y + window.screenY,
        button: buttonNum, buttons: 1 << buttonNum,
        bubbles: true, cancelable: true, view: window,
      };
      for (let i = 0; i < clickCount; i++) {
        target.dispatchEvent(new MouseEvent('mousedown', eventInit));
        target.dispatchEvent(new MouseEvent('mouseup', eventInit));
        target.dispatchEvent(new MouseEvent('click', { ...eventInit, detail: i + 1 }));
      }
      if (clickCount === 2) {
        target.dispatchEvent(new MouseEvent('dblclick', eventInit));
      }
      return { success: true, element: el ? el.tagName.toLowerCase() : null };
    },

    'element.scroll': async ({ selector, x, y }) => {
      if (selector) {
        const el = q(selector);
        // instant: handler returns as soon as scroll position is final,
        // so callers can immediately read coordinates / take screenshots
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      } else if (x !== undefined || y !== undefined) {
        window.scrollTo({ top: y || 0, left: x || 0, behavior: 'instant' });
      }
      // One rAF to let layout settle
      await new Promise(r => requestAnimationFrame(() => r()));
      return { success: true };
    },

    'element.clear': async ({ selector }) => {
      const el = q(selector);
      if (el.isContentEditable) {
        el.textContent = '';
        el.innerHTML = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
      } else {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) { nativeSetter.call(el, ''); } else { el.value = ''; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { success: true };
    },

    // Snapshot with e# refs
    'browser.snapshot': async () => {
      return buildSnapshot();
    },

    // Advanced fill — uses native value setter to work with Vue/React hidden inputs
    // Supports single fill: { selector, value } or batch fill: { data: Record<selector, value> }
    // Both CSS selectors AND e# refs are supported
    'page.fill': async ({ selector, value, data }) => {
      const results = [];
      const fields = data ? Object.entries(data) : [[selector, value]];
      for (const [sel, val] of fields) {
        const el = resolveElement(sel);
        if (!el) { results.push({ selector: sel, error: `Element not found: ${sel}` }); continue; }
        el.focus();
        el.value = '';
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) { nativeSetter.call(el, val); } else { el.value = val; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
        results.push({ selector: sel, success: true, tagName: el.tagName, value: el.value });
      }
      return { results };
    },

    // Page content
    'page.getTitle': async () => {
      return { title: document.title };
    },

    'page.getUrl': async () => {
      return { url: window.location.href };
    },

    'page.getContent': async ({ selector }) => {
      if (selector) {
        const el = document.querySelector(selector);
        return { content: el ? el.textContent.trim() : '' };
      }
      return { content: document.body.textContent.trim() };
    },

    'page.getHtml': async ({ selector }) => {
      if (selector) {
        const el = document.querySelector(selector);
        return { html: el ? el.innerHTML : '' };
      }
      return { html: document.body.innerHTML };
    },

    'page.screenshot': async ({ fullPage, format, quality, maxHeight }) => {
      // This handler is the FALLBACK for full-page captures (background.js
      // tries CDP captureBeyondViewport first; if that fails — debugger
      // blocked / not attached — it forwards here for scroll-and-stitch).
      // For viewport-only captures, background.js handles directly via
      // chrome.tabs.captureVisibleTab and never reaches this code.
      const fmt = (format === 'jpeg') ? 'image/jpeg' : 'image/png';
      const q = (typeof quality === 'number' && quality > 0 && quality <= 100) ? quality / 100 : 0.85;
      const maxH = (typeof maxHeight === 'number' && maxHeight > 0) ? maxHeight : 12000; // safety cap

      const captureViewport = () => new Promise((resolve, reject) => {
        if (!isContextValid()) { reject(new Error('Extension context invalidated')); return; }
        try {
          chrome.runtime.sendMessage({ type: 'capture_visible_tab' }, (dataUrl) => {
            const err = chrome.runtime && chrome.runtime.lastError;
            if (err) reject(new Error(err.message));
            else resolve(dataUrl);
          });
        } catch (e) { reject(e); }
      });

      if (!fullPage) {
        const dataUrl = await captureViewport();
        return { screenshot: dataUrl, dataUrl, format: fmt === 'image/jpeg' ? 'jpeg' : 'png', fullPage: false };
      }

      // Full-page: scroll-and-stitch.
      // chrome.tabs.captureVisibleTab is rate-limited (~2 calls/sec in MV3),
      // so we wait 600ms between captures to stay safely under that.
      const originalX = window.scrollX;
      const originalY = window.scrollY;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const fullWidth = Math.max(document.documentElement.scrollWidth, vw);
      const fullHeightRaw = Math.max(document.documentElement.scrollHeight, vh);
      const fullHeight = Math.min(fullHeightRaw, maxH);
      const truncated = fullHeightRaw > maxH;
      const rows = Math.ceil(fullHeight / vh);
      const cols = Math.ceil(fullWidth / vw);
      const tiles = [];

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          window.scrollTo(col * vw, row * vh);
          // Wait long enough to (a) let lazy-loaded content render and
          // (b) stay under captureVisibleTab's rate limit.
          await new Promise(r => setTimeout(r, 600));
          let dataUrl;
          try {
            dataUrl = await captureViewport();
          } catch (e) {
            // Single tile failure shouldn't kill the whole capture; pad with
            // empty tile and continue.
            console.warn('[RBC] page.screenshot tile failed:', e.message);
            continue;
          }
          tiles.push({ dataUrl, x: col * vw, y: row * vh });
        }
      }
      window.scrollTo(originalX, originalY);

      const canvas = document.createElement('canvas');
      canvas.width = fullWidth;
      canvas.height = fullHeight;
      const ctx = canvas.getContext('2d');
      for (const tile of tiles) {
        const img = new Image();
        try {
          await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = tile.dataUrl; });
          ctx.drawImage(img, tile.x, tile.y);
        } catch (e) { console.warn('[RBC] page.screenshot stitch tile failed:', e.message); }
      }
      const out = canvas.toDataURL(fmt, fmt === 'image/jpeg' ? q : undefined);
      return {
        screenshot: out, dataUrl: out,
        format: fmt === 'image/jpeg' ? 'jpeg' : 'png',
        fullPage: true,
        fullWidth, fullHeight,
        ...(truncated ? { truncated: true, originalHeight: fullHeightRaw } : {}),
      };
    },

    'page.getCookies': async () => {
      return { cookies: document.cookie };
    },

    'page.getLocalStorage': async () => {
      return { storage: { ...localStorage } };
    },

    // CDP-free DOM walk for interactive elements + page-level diagnostics
    // (notices, focus, form grouping). Static content-script code — no eval,
    // no chrome.debugger — so it keeps working when DevTools is open on the
    // tab or another extension holds the debugger, and bypasses both
    // extension and page CSP since it's loaded statically by the manifest.
    'page.dom_tree': async () => {
      const escapeId = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s);

      // Best-effort stable selector: prefer #id, then [name], then a tag+role
      // hint. Returns null if we can't synthesize anything useful.
      const selectorFor = (el) => {
        if (!el) return null;
        if (el.id) return '#' + escapeId(el.id);
        const name = el.getAttribute && el.getAttribute('name');
        if (name) return `${el.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
        return null;
      };

      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        return true;
      };

      // ── Walk interactive elements ─────────────────────────────────────
      const out = [];
      const all = document.querySelectorAll(
        'a, button, input, select, textarea, [role="button"], [role="link"], ' +
        '[role="checkbox"], [role="radio"], [role="combobox"], [role="textbox"], ' +
        '[role="menuitem"], [role="tab"], summary, label[for]'
      );
      let idx = 0;
      const vw = window.innerWidth, vh = window.innerHeight;
      for (const el of all) {
        if (!(el instanceof HTMLElement)) continue;
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const inputType = tag === 'input' ? (el.type || 'text').toLowerCase() : null;
        const role = el.getAttribute('role')
          || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : inputType ? inputType : '');
        const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 80);
        const id = el.id || '';
        const value = (el.value || '').toString().slice(0, 40);
        const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
        const required = el.required === true || el.getAttribute('aria-required') === 'true';
        const ariaInvalid = el.getAttribute('aria-invalid') === 'true';
        const inViewport = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
        // Chrome :autofill pseudo-class lights up after password manager fills.
        let autofilled = false;
        try { autofilled = !!(el.matches && (el.matches(':autofill') || el.matches(':-webkit-autofill'))); } catch (e) {}
        // checked state for checkbox/radio
        const checked = (inputType === 'checkbox' || inputType === 'radio') ? !!el.checked : undefined;
        const focused = document.activeElement === el;

        out.push({
          tag, role,
          ...(id ? { id } : {}),
          name, value,
          ...(disabled ? { disabled: true } : {}),
          ...(required ? { required: true } : {}),
          ...(ariaInvalid ? { invalid: true } : {}),
          ...(autofilled ? { autofilled: true } : {}),
          ...(focused ? { focused: true } : {}),
          ...(checked !== undefined ? { checked } : {}),
          ...(inputType ? { inputType } : {}),
          ...(el.getAttribute && el.getAttribute('autocomplete') ? { autocomplete: el.getAttribute('autocomplete') } : {}),
          ...(el.getAttribute && el.getAttribute('placeholder') ? { placeholder: el.getAttribute('placeholder') } : {}),
          ...(inViewport ? { inViewport: true } : {}),
          selector: selectorFor(el),
          box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        });
        if (++idx >= 200) break;
      }

      // ── Page-level notices: alerts and validation messages ────────────
      // These are typically how login pages surface failure ("Your password
      // is incorrect"), captcha prompts, account-locked warnings, etc.
      // Without this, the agent only sees the form and assumes idle state.
      const notices = [];
      const noticeSelectors = [
        '[role="alert"]',
        '[role="alertdialog"]',
        '[aria-live="assertive"]',
        '[aria-live="polite"]',
        '[aria-invalid="true"]',
        '.a-alert-content',         // Amazon-specific
        '.a-alert-error',           // Amazon-specific
        '.error', '.errorMessage', '.error-message',
        '.warning', '.alert-danger', '.alert-warning',
      ];
      const seenNoticeText = new Set();
      for (const sel of noticeSelectors) {
        let matches;
        try { matches = document.querySelectorAll(sel); } catch (e) { continue; }
        for (const el of matches) {
          if (!(el instanceof HTMLElement)) continue;
          if (!isVisible(el)) continue;
          const text = (el.innerText || el.textContent || '').trim().slice(0, 240);
          if (!text || seenNoticeText.has(text)) continue;
          // Skip notices that just mirror an interactive element's name (e.g.
          // the alert IS the input wrapper) — keeps signal high.
          if (text.length < 3) continue;
          seenNoticeText.add(text);
          const kind = sel.includes('alert') ? 'alert'
            : sel.includes('invalid') ? 'invalid'
            : sel.includes('warning') || sel.includes('warn') ? 'warning'
            : sel.includes('error') ? 'error'
            : 'alert';
          notices.push({ kind, text, selector: selectorFor(el) });
          if (notices.length >= 8) break;
        }
        if (notices.length >= 8) break;
      }

      // ── Focused element ────────────────────────────────────────────────
      let focusedSelector = null;
      let focusedTag = null;
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae !== document.documentElement) {
        focusedSelector = selectorFor(ae);
        focusedTag = (ae.tagName || '').toLowerCase();
      }

      // ── Form grouping ─────────────────────────────────────────────────
      // Tells the agent which inputs belong together (login form vs search
      // form vs newsletter signup), so it doesn't fire blind across forms.
      const forms = [];
      const formNodes = document.querySelectorAll('form');
      for (const form of formNodes) {
        if (!isVisible(form)) continue;
        const fields = form.querySelectorAll('input, textarea, select, button');
        const fieldSelectors = [];
        for (const f of fields) {
          if (!isVisible(f)) continue;
          const s = selectorFor(f);
          if (s) fieldSelectors.push(s);
          if (fieldSelectors.length >= 20) break;
        }
        if (fieldSelectors.length === 0) continue;
        forms.push({
          selector: selectorFor(form),
          name: (form.getAttribute('name') || form.getAttribute('aria-label') || form.id || '').slice(0, 60),
          action: form.getAttribute('action') || '',
          fieldSelectors,
        });
        if (forms.length >= 6) break;
      }

      return {
        count: out.length,
        nodes: out,
        notices,
        focusedSelector,
        focusedTag,
        forms,
        viewport: { w: vw, h: vh, scrollY: window.scrollY },
      };
    },

    // Read .value or .textContent of the first element matching selector.
    // Static, no eval — replaces the page.evaluate-based read path so it
    // keeps working when CDP is blocked.
    'element.read': async ({ selector }) => {
      if (!selector) throw new Error('selector required');
      const el = document.querySelector(selector);
      if (!el) return { found: false, value: null };
      const v = (el.value !== undefined && el.value !== null)
        ? String(el.value)
        : (el.textContent || '');
      return { found: true, value: v, tag: (el.tagName || '').toLowerCase() };
    },

    // NOTE: Normally intercepted by background.js (CDP Runtime.evaluate) to
    // bypass page CSP. This content-script fallback only runs if a caller sends
    // the command directly to the tab (e.g. chrome.tabs.sendMessage from another
    // extension component). It will fail silently on CSP-restricted pages.
    'page.evaluate': async ({ fn, args }) => {
      return new Promise((resolve, reject) => {
        const callbackId = '_rbc_eval_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        const handler = (event) => {
          if (event.data?.type === callbackId) {
            window.removeEventListener('message', handler);
            if (event.data.error) reject(new Error(event.data.error));
            else resolve({ result: event.data.result });
          }
        };
        window.addEventListener('message', handler);
        const script = document.createElement('script');
        script.textContent = `(function(){try{const fn=(${fn});const r=fn(${(args||[]).map(a=>JSON.stringify(a)).join(',')});window.postMessage({type:'${callbackId}',result:typeof r==='undefined'?null:JSON.parse(JSON.stringify(r))},'*')}catch(e){window.postMessage({type:'${callbackId}',error:e.message},'*')}})()`;
        document.documentElement.appendChild(script);
        script.remove();
        setTimeout(() => {
          window.removeEventListener('message', handler);
          reject(new Error('page.evaluate timed out (CSP may have blocked script injection; prefer eval.js via background CDP)'));
        }, 10000);
      });
    },

    // Form operations
    // Passive autofill / pre-filled detection — NO focus/blur/dispatch side effects
    // on the inspected inputs (previous version fired input+change on every field,
    // stealing focus and triggering page validators).
    'form.detectFill': async ({ selectors }) => {
      const inputSel = selectors || 'input[type=text], input[type=password], input[type=email], input[type="username"], input[type=tel], input:not([type])';
      const inputs = Array.from(document.querySelectorAll(inputSel)).filter(el => isElementVisible(el));

      const results = inputs.map(el => {
        const id = el.id || '';
        const name = el.name || '';
        const inputType = (el.type || 'text').toLowerCase();
        const label = (el.labels?.[0]?.textContent || '').trim() ||
                      el.placeholder || el.getAttribute('aria-label') || '';

        // Autofill detection via the standard :autofill pseudo-class (Chrome 108+)
        // plus legacy :-webkit-autofill. No brittle background-color string matching.
        let cssAutofillMatch = false;
        try {
          cssAutofillMatch = !!(el.matches?.(':autofill') || el.matches?.(':-webkit-autofill'));
        } catch {}

        const rawValue = el.value;
        const hasValue = typeof rawValue === 'string' && rawValue.length > 0;

        const autocomplete = el.getAttribute('autocomplete') || '';
        const hasAutocompleteHint = !!(autocomplete && autocomplete !== 'off' && autocomplete !== 'new-password');

        const defaultValue = el.defaultValue || '';
        const valueChanged = hasValue && rawValue !== defaultValue;

        const filled = hasValue;
        const meaningfulFilled = valueChanged || cssAutofillMatch;

        return {
          selector: id ? `#${id}` : (name ? `[name="${name}"]` : `[${inputType}]`),
          id: id || undefined,
          name: name || undefined,
          type: inputType,
          label: label || undefined,
          value: rawValue || '',
          hasValue,
          valueLength: (rawValue || '').length,
          defaultValue: defaultValue || undefined,
          valueChanged,
          cssAutofillMatch,
          autocompleteAttr: autocomplete || undefined,
          hasAutocompleteHint,
          filled,
          meaningfulFilled,
          recommendation: meaningfulFilled ? 'skip_and_submit' : (!filled ? 'needs_fill' : 'check_manually'),
        };
      });

      // Aggregate summary
      const summary = {
        totalFields: results.length,
        allMeaningfulFilled: results.length > 0 && results.every(r => r.meaningfulFilled),
        allFilled: results.length > 0 && results.every(r => r.filled),
        anyAutofillSignal: results.some(r => r.cssAutofillMatch),
        fieldsNeedingFill: results.filter(r => !r.meaningfulFilled).map(r => ({ type: r.type, label: r.label, id: r.id })),
        fieldsAlreadyFilled: results.filter(r => r.meaningfulFilled).map(r => ({ type: r.type, label: r.label, id: r.id, valuePreview: r.value.slice(0, 3) + '***' })),
      };

      return { results, summary };
    },

    'form.fill': async ({ data }) => {
      // Delegate to page.fill which uses native setter for React/Vue compatibility
      return handlers['page.fill']({ data });
    },

    'form.submit': async ({ selector }) => {
      if (selector) {
        const form = resolveElement(selector);
        if (!form) throw new Error(`Form not found: ${selector}`);
        form.submit();
      } else {
        const form = document.querySelector('form');
        if (!form) throw new Error('No form found on page');
        form.submit();
      }
      return { success: true };
    },

    'form.clear': async ({ selector }) => {
      return handlers['element.clear']({ selector });
    },

    // Dialog operations
    'dialog.accept': async () => {
      const dialog = lastDialog;
      lastDialog = null;
      return { success: true, dialog };
    },

    'dialog.dismiss': async () => {
      const dialog = lastDialog;
      lastDialog = null;
      return { success: true, dialog };
    },

    'dialog.getText': async () => {
      return { text: lastDialog?.message || '', dialogType: lastDialog?.dialogType || null };
    },

    // Wait operations
    'wait.forSelector': async ({ selector, timeout = 30000 }) => {
      // Fast path
      const existing = resolveElement(selector);
      if (existing) return { success: true, found: true };

      // MutationObserver-based wait — hits as soon as the node is inserted,
      // with no 100ms polling latency and negligible CPU overhead.
      return new Promise((resolve, reject) => {
        let done = false;
        const observer = new MutationObserver(() => {
          if (done) return;
          const el = resolveElement(selector);
          if (el) {
            done = true;
            observer.disconnect();
            clearTimeout(timer);
            resolve({ success: true, found: true });
          }
        });
        observer.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id', 'style', 'hidden'],
        });
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          observer.disconnect();
          reject(new Error(`Timeout waiting for selector: ${selector}`));
        }, timeout);
      });
    },

    'wait.forNavigation': async ({ timeout = 30000 }) => {
      // Detect navigation via beforeunload, hashchange, popstate, or URL polling (SPA).
      // Note: for full cross-page navigations, this content script will be destroyed.
      const startUrl = location.href;
      await new Promise((resolve, reject) => {
        let pollInterval = null;

        function cleanup() {
          clearTimeout(timeoutId);
          if (pollInterval) clearInterval(pollInterval);
          window.removeEventListener('beforeunload', done);
          window.removeEventListener('hashchange', done);
          window.removeEventListener('popstate', onPopState);
        }
        function done() { cleanup(); resolve(); }
        function onPopState() { if (location.href !== startUrl) done(); }

        const timeoutId = setTimeout(() => { cleanup(); reject(new Error('Navigation timeout')); }, timeout);

        window.addEventListener('beforeunload', done);
        window.addEventListener('hashchange', done);
        window.addEventListener('popstate', onPopState);

        // Poll for SPA-style URL changes (pushState doesn't fire popstate)
        pollInterval = setInterval(() => {
          if (location.href !== startUrl) done();
        }, 200);
      });
      return { success: true, url: location.href };
    },

    'wait.forNetworkIdle': async ({ timeout = 30000, idleTime = 500 }) => {
      return new Promise((resolve, reject) => {
        let lastActivity = Date.now();
        let checkTimer = null;
        let observer = null;

        const cleanup = () => {
          if (checkTimer) clearInterval(checkTimer);
          if (observer) observer.disconnect();
        };

        const timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error('Network idle timeout'));
        }, timeout);

        if (typeof PerformanceObserver !== 'undefined') {
          try {
            observer = new PerformanceObserver(() => { lastActivity = Date.now(); });
            observer.observe({ entryTypes: ['resource'] });
          } catch {}
        }

        checkTimer = setInterval(() => {
          if (Date.now() - lastActivity >= idleTime) {
            clearTimeout(timeoutId);
            cleanup();
            resolve({ success: true });
          }
        }, 100);
      });
    },

    // Frame operations — content scripts cannot switch execution context to iframes.
    // Use chrome.scripting.executeScript with frameIds from background instead.
    'frame.switch': async ({ frameId }) => {
      if (frameId === 'parent' || frameId === 'top') {
        throw new Error(`frame.switch('${frameId}') is not supported from content script context`);
      }
      const frame = document.querySelector(`iframe[name="${frameId}"], iframe[id="${frameId}"]`);
      if (!frame) throw new Error(`Frame not found: ${frameId}`);
      throw new Error('frame.switch is not supported from content script — use background scripting API with frameIds');
    },

    // eval.js is always handled by background.js via CDP (Runtime.evaluate).
    // Content-script path removed: it was unreachable and would fail under
    // strict CSP anyway.

    // File operations
    'file.download': async ({ url, filename }) => {
      // Trigger download by creating a link
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || '';
      a.click();
      return { success: true };
    },

    'file.getDownloaded': async () => {
      // Can't access downloaded files from content script
      return { files: [] };
    },

    'file.read': async ({ selector }) => {
      const input = document.querySelector(selector || 'input[type="file"]');
      if (!input || !input.files[0]) throw new Error('No file selected');
      const file = input.files[0];
      const reader = new FileReader();
      return new Promise((resolve, reject) => {
        reader.onload = () => resolve({ content: reader.result, filename: file.name });
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
    },

    'file.upload': async ({ selector, dataUrl, filename, mimeType }) => {
      const input = resolveElement(selector) || document.querySelector('input[type="file"]');
      if (!input) throw new Error('No file input found: ' + (selector || 'input[type="file"]'));
      const resp = await fetch(dataUrl);
      const blob = await resp.blob();
      const file = new File([blob], filename || 'upload', { type: mimeType || blob.type });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { success: true, filename: file.name, size: file.size, type: file.type };
    }
  };

  // Listen for commands from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'execute') {
      const { command, params } = message;
      dlog('[RBC] Execute command:', command, params);

      const handler = handlers[command];
      if (!handler) {
        sendResponse({ error: { code: -32601, message: `Unknown command: ${command}` } });
        return;
      }

      handler(params)
        .then(sendResponse)
        .catch(err => {
          console.error('[RBC] Command error:', err);
          sendResponse({ error: { code: -32000, message: err.message } });
        });

      return true; // Async response
    }

    if (message.type === 'capture_visible_tab') {
      // This is handled by background script with tabs.captureVisibleTab permission
      return false;
    }

    return false;
  });

  // Note: page.loaded event is sent by background.js via chrome.tabs.onUpdated (includes tabId).
  // No need to duplicate it here.

  console.log('[RBC] Content script ready');
})();
