/**
 * Playwright Relay — connects Playwright browser to BAP Gateway directly
 *
 * Architecture:
 *   Playwright ──ws──▶ BAP Gateway :3000
 *
 * No relay.js needed — playwright-relay.js speaks BAP protocol directly.
 *
 * Usage:
 *   node playwright-relay.js [--gateway ws://127.0.0.1:3000/ws]
 *                            [--token TOKEN]
 *                            [--device-id DEVICE_ID]
 *                            [--device-name NAME]
 *                            [--browser chromium|firefox|webkit]
 */

const { chromium, firefox, webkit } = require('playwright');

// ── CLI args ─────────────────────────────────────────────────────────────────
const argv = (() => {
  const args = {};
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith('--')) {
      const key = list[i].slice(2);
      args[key] = list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : true;
    }
  }
  return args;
})();

const BAP_GATEWAY  = argv['gateway']    || process.env.BAP_GATEWAY  || 'ws://127.0.0.1:3000/ws';
const DEVICE_ID    = argv['device-id']  || process.env.DEVICE_ID   || 'playwright-jerrypc';
const DEVICE_NAME  = argv['device-name']|| process.env.DEVICE_NAME || 'Playwright-JerryPC';
const BROWSER_TYPE = argv['browser']   || process.env.BROWSER      || 'chromium';
const AUTH_TOKEN   = argv['token']      || process.env.BAP_TOKEN   || 'XERJS7O4y_NF4fzyAlalN3i0udAd6wuT';

// ── State ─────────────────────────────────────────────────────────────────────
let bapWs   = null;
let browser = null;
let context = null;
let page    = null;

// ── Launch browser ────────────────────────────────────────────────────────────
async function launchBrowser() {
  const execMap = { chromium, firefox, webkit };
  const launcher = execMap[BROWSER_TYPE];
  if (!launcher) throw new Error(`Unknown browser: ${BROWSER_TYPE}`);

  console.log(`[Playwright] Launching ${BROWSER_TYPE}...`);
  browser = await launcher.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();

  page.on('dialog', async (dialog) => {
    console.log(`[Playwright Dialog] ${dialog.type()}: ${dialog.message()}`);
    await dialog.accept();
  });

  console.log(`[Playwright] Browser ready (version ${browser.version()})`);
}

// ── BAP command executor ─────────────────────────────────────────────────────
async function execCommand(method, params) {
  if (!page) throw new Error('No active page');

  switch (method) {
    // Navigation
    case 'browser.navigate':
    case 'page.navigate': {
      const url = params?.url;
      if (!url) throw new Error('url required');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return { url: page.url(), title: await page.title() };
    }
    case 'browser.reload':
    case 'page.reload': {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      return { url: page.url() };
    }
    case 'browser.back':
    case 'page.back': {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
      return { url: page.url() };
    }
    case 'browser.forward':
    case 'page.forward': {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
      return { url: page.url() };
    }
    case 'browser.close':
    case 'page.close': {
      await page.close();
      return { success: true };
    }

    // Tabs
    case 'tabs.list':
    case 'tabs.query':
    case 'browser.listTabs': {
      const pages = await context.pages();
      return {
        tabs: pages.map((p, i) => ({
          tabId: String(i),
          url: p.url(),
          title: p.url()
        }))
      };
    }
    case 'tabs.create':
    case 'browser.newTab': {
      const url = params?.url || 'about:blank';
      const newPage = await context.newPage();
      if (url !== 'about:blank') await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const pages = await context.pages();
      return { tabId: String(pages.length - 1), url: newPage.url(), success: true };
    }
    case 'tabs.switch': {
      const pages = await context.pages();
      const idx = parseInt(params?.tabId || '0', 10);
      if (idx >= 0 && idx < pages.length) page = pages[idx];
      return { tabId: params?.tabId, success: true };
    }
    case 'tabs.close': {
      if (params?.tabId !== undefined) {
        const pages = await context.pages();
        const idx = parseInt(params.tabId, 10);
        if (idx >= 0 && idx < pages.length) await pages[idx].close();
      }
      return { success: true };
    }

    // Page info
    case 'page.getTitle':
    case 'browser.getTitle': {
      return { title: await page.title() };
    }
    case 'page.getUrl':
    case 'browser.getUrl': {
      return { url: page.url() };
    }
    case 'page.getContent':
    case 'page.getHtml': {
      return { content: await page.content() };
    }
    case 'browser.snapshot':
    case 'page.snapshot': {
      return { html: await page.content(), title: await page.title(), url: page.url() };
    }

    // Screenshot
    case 'browser.screenshot':
    case 'page.screenshot':
    case 'tabs.capture': {
      if (params?.url) {
        await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      await page.waitForTimeout(500);
      const screenshot = await page.screenshot({ type: 'png' });
      return { data: screenshot.toString('base64') };
    }

    // Form / Input
    case 'page.fill':
    case 'element.type': {
      const sel = params?.selector || params?.id || params?.name;
      const text = String(params?.text ?? params?.value ?? '');
      if (!sel) throw new Error('selector required');
      await page.fill(sel, text);
      return { success: true, selector: sel };
    }
    case 'element.click': {
      const sel = params?.selector || params?.id || params?.name;
      if (!sel) throw new Error('selector required');
      await page.click(sel);
      return { success: true, selector: sel };
    }
    case 'form.fill': {
      const data = params?.data || {};
      for (const [sel, val] of Object.entries(data)) {
        await page.fill(sel, String(val));
      }
      return { success: true };
    }
    case 'form.submit': {
      await page.locator(params?.selector || 'form').evaluate((form) => form.submit());
      return { success: true };
    }

    // Eval
    case 'eval.js':
    case 'page.evaluate': {
      const script = params?.script || params?.expression || '';
      return { result: await page.evaluate(script) };
    }

    // Accessibility
    case 'accessibility.snapshot': {
      return { tree: await page.accessibility.snapshot() };
    }

    default:
      throw new Error(`Unsupported method: ${method}`);
  }
}

// ── BAP WebSocket ─────────────────────────────────────────────────────────────
function bapSend(data) {
  if (bapWs && bapWs.readyState === 1) {
    bapWs.send(JSON.stringify(data));
  }
}

function startBAP() {
  const { WebSocket } = require('ws');
  console.log(`[BAP] Connecting to ${BAP_GATEWAY}...`);
  bapWs = new WebSocket(BAP_GATEWAY);

  bapWs.on('open', () => {
    console.log('[BAP] Connected, authenticating...');
    bapWs.send(JSON.stringify({
      type: 'auth',
      token: AUTH_TOKEN,
      deviceId: DEVICE_ID,
      deviceName: DEVICE_NAME,
      browserType: 'playwright',
      role: 'browser',
      tags: ['playwright']
    }));
  });

  bapWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // ── Ping ────────────────────────────────────────────────────────────────
      if (msg.type === 'ping') {
        bapSend({ type: 'pong' });
        return;
      }

      // ── Auth response ─────────────────────────────────────────────────────
      if (msg.type === 'auth_ok') {
        console.log('[BAP] Auth OK, deviceId:', DEVICE_ID);
        return;
      }
      if (msg.type === 'auth_error') {
        console.error('[BAP] Auth error:', msg.error);
        bapWs.close();
        return;
      }

      // ── Command ───────────────────────────────────────────────────────────
      if (msg.type === 'command' && msg.id && msg.method) {
        execCommand(msg.method, msg.params || {})
          .then((result) => bapSend({ type: 'command_response', id: msg.id, result }))
          .catch((err) => bapSend({ type: 'command_response', id: msg.id, error: { code: -32000, message: err.message } }));
        return;
      }
    } catch (e) {
      console.error('[BAP] Parse error:', e.message);
    }
  });

  bapWs.on('close', (code, reason) => {
    console.log(`[BAP] Disconnected: code=${code} reason=${reason || 'none'}`);
    bapWs = null;
    if (browser) {
      console.log('[BAP] Reconnecting in 5s...');
      setTimeout(startBAP, 5000);
    }
  });

  bapWs.on('error', (e) => {
    console.error('[BAP] WS error:', e.message);
  });
}

// ── Startup ──────────────────────────────────────────────────────────────────
async function main() {
  try {
    await launchBrowser();
    startBAP();
  } catch (e) {
    console.error('[Playwright] Startup error:', e.message);
    if (browser) await browser.close().catch(() => {});
    setTimeout(main, 5000);
  }
}

process.on('SIGINT', async () => {
  console.log('[Playwright] Shutting down...');
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});

main();
