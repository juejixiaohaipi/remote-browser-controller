// Remote Browser Controller - Content Script
// Injected into all pages

(function() {
  'use strict';

  console.log('[RBC] Content script loaded on', window.location.href);

  // ── Keep SW alive via persistent port (MV3) ──
  let rbcPort = null;
  function connectToBackground() {
    try {
      rbcPort = chrome.runtime.connect({ name: 'rbc-tab' });
      rbcPort.onDisconnect.addListener(() => {
        rbcPort = null;
        // Reconnect after short delay
        setTimeout(connectToBackground, 3000);
      });
      rbcPort.onMessage.addListener((msg) => {
        // 'ping' from background — respond to keep connection alive
        if (msg.type === 'ping') {
          try { rbcPort.postMessage({ type: 'pong' }); } catch {}
        }
      });
    } catch {
      setTimeout(connectToBackground, 5000);
    }
  }
  connectToBackground();

  // ── Dialog interceptor
  let pendingDialogResolve = null;

  function notifyDialog(dialogType, message) {
    console.log('[RBC] Dialog intercepted:', dialogType, message);
    chrome.runtime.sendMessage({
      type: 'content_dialog',
      dialogType,
      message: String(message)
    });
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
  const snapshotState = {
    eRefMap: new Map(),   // "e3" → HTMLElement
    nextId: 1,
  };

  // Resolve a selector or e# ref to an HTMLElement
  function resolveElement(ref) {
    if (!ref) return null;
    // e# snapshot ref
    if (/^e\d+$/.test(ref)) {
      return snapshotState.eRefMap.get(ref) || null;
    }
    return document.querySelector(ref);
  }

  // Build accessibility snapshot with stable e# refs
  function buildSnapshot() {
    const root = document.body;
    if (!root) return { elements: [], url: location.href, title: document.title };

    // Reset refs on each snapshot
    snapshotState.eRefMap.clear();
    snapshotState.nextId = 1;

    // Find all interactive/focusable elements
    const interactiveSelectors = [
      'a[href]', 'button:not([disabled])', 'input:not([type=hidden])',
      'select:not([disabled])', 'textarea:not([disabled])',
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

          const rect = el.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue; // invisible

          const eRef = 'e' + snapshotState.nextId++;
          snapshotState.eRefMap.set(eRef, el);

          const role = el.getAttribute('role')
            || (el.tagName === 'INPUT' ? 'textbox' : '')
            || el.tagName.toLowerCase();

          const inputType = el.type || '';
          const label = el.getAttribute('aria-label')
            || el.getAttribute('aria-labelledby')
            || (el.labels?.[0]?.textContent || '').trim()
            || el.textContent?.trim().slice(0, 80)
            || '';

          elements.push({
            eRef,
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            class: el.className.slice(0, 80) || undefined,
            role,
            type: inputType || undefined,
            label: label || undefined,
            placeholder: el.placeholder || undefined,
            value: el.value !== undefined && el.value !== '' ? String(el.value).slice(0, 60) : undefined,
            href: el.href !== undefined ? (el.tagName === 'A' ? (el.href.length > 100 ? el.href.slice(0, 100) + '...' : el.href) : undefined) : undefined,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
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
      el.click();
      return { success: true };
    },

    'element.type': async ({ selector, text, pressEnter }) => {
      const el = q(selector);
      el.focus();

      // Clear existing value
      el.value = '';

      // Simulate typing character by character
      for (const char of text) {
        const charCode = char.charCodeAt(0);
        el.dispatchEvent(new KeyboardEvent('keydown', { key: char, charCode, bubbles: true }));
        el.value += char;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: char, charCode, bubbles: true }));
      }

      el.dispatchEvent(new Event('change', { bubbles: true }));

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

    'element.scroll': async ({ selector, x, y }) => {
      if (selector) {
        const el = q(selector);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (x !== undefined || y !== undefined) {
        window.scrollTo({ top: y || 0, left: x || 0, behavior: 'smooth' });
      }
      return { success: true };
    },

    'element.clear': async ({ selector }) => {
      const el = q(selector);
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
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
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
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

    'page.screenshot': async ({ fullPage }) => {
      // Use the Capture Visible Tab API
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'capture_visible_tab', fullPage }, (dataUrl) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve({ screenshot: dataUrl });
          }
        });
      });
    },

    'page.getCookies': async () => {
      return { cookies: document.cookie };
    },

    'page.getLocalStorage': async () => {
      return { storage: { ...localStorage } };
    },

    'page.evaluate': async ({ fn, args }) => {
      // eslint-disable-next-line no-new-function
      const func = new Function('return ' + fn)();
      const result = func(...(args || []));
      return { result };
    },

    // Form operations
    'form.fill': async ({ data }) => {
      for (const [sel, value] of Object.entries(data)) {
        const el = resolveElement(sel);
        if (el) {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      return { success: true };
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
      const el = q(selector);
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { success: true };
    },

    // Dialog operations
    'dialog.accept': async () => {
      if (pendingDialogResolve) {
        pendingDialogResolve(true);
        pendingDialogResolve = null;
      }
      return { success: true };
    },

    'dialog.dismiss': async () => {
      if (pendingDialogResolve) {
        pendingDialogResolve(false);
        pendingDialogResolve = null;
      }
      return { success: true };
    },

    'dialog.getText': async () => {
      // Dialog text is handled separately
      return { text: '' };
    },

    // Wait operations
    'wait.forSelector': async ({ selector, timeout = 30000 }) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const el = resolveElement(selector);
        if (el) return { success: true, found: true };
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error(`Timeout waiting for selector: ${selector}`);
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

    // JavaScript evaluation
    'eval.js': async ({ script }) => {
      try {
        // eslint-disable-next-line no-eval
        const result = eval(script);
        return { result, success: true };
      } catch (err) {
        throw new Error(`JS Error: ${err.message}`);
      }
    },

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
    }
  };

  // Listen for commands from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'execute') {
      const { command, params } = message;
      console.log('[RBC] Execute command:', command, params);

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

  // Notify background when page loads
  chrome.runtime.sendMessage({
    type: 'content_page_loaded',
    url: window.location.href,
    title: document.title
  });

  console.log('[RBC] Content script ready');
})();
