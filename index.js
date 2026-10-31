/**
 * Host half of dsh-lit-shot.
 *
 * Keeps one resident Windows agent (`scripts/agent.ps1`) alive. The agent owns the
 * global hotkey and the full-screen selection overlay, so a capture costs a screen
 * copy plus one window show instead of a cold PowerShell start. This half only
 * speaks a line protocol with it, holds the newest unclaimed capture, and exposes
 * the routes the composer button uses.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_PATH = fileURLToPath(new URL('./scripts/agent.ps1', import.meta.url));
const SETTINGS_PATH = join(homedir(), '.dsh', 'dsh-lit-shot', 'settings.json');
const DEFAULT_HOTKEY = 'Alt+A';
const MAX_EDGE = 1920;
const CAPTURE_TIMEOUT_MS = 180_000;
const RESTART_DELAYS_MS = [500, 1_000, 2_000, 5_000];
const POWERSHELL = process.env.SystemRoot === undefined
  ? 'powershell.exe'
  : join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/**
 * Read and shape one decoded capture into the response body plus envelope.
 * @param {{path: string, width: number, height: number}} event - the agent event.
 * @returns {Promise<object>} the shot payload.
 */
async function readShot(event) {
  try {
    const bytes = await readFile(event.path);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      width: Number(event.width),
      height: Number(event.height),
      mediaType: 'image/png',
      name: `screenshot-${stamp}.png`,
      at: Date.now(),
    };
  } finally {
    await rm(event.path, { force: true }).catch(() => {});
  }
}

/**
 * Write one JSON response, tolerating a client that already went away.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status code.
 * @param {object} body - JSON body.
 */
function sendJson(res, status, body) {
  try {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  } catch {
    /* the socket is gone */
  }
}

/**
 * Read a small JSON request body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<Record<string, unknown>>} the parsed object, or an empty object.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export const inject = ['webServer'];

/**
 * Mount the capture routes and the resident agent.
 * @param {object} ctx - the Host plugin context.
 */
export function apply(ctx) {
  let child = null;
  let disposed = false;
  let ready = false;
  let hotkey = DEFAULT_HOTKEY;
  let registeredHotkey = '';
  let pendingSpec = '';
  let hotkeyOk = false;
  let hotkeyError = '';
  let lastError = '';
  let lastFocus = { ok: false, hwnd: 0, at: 0 };
  let attempts = 0;
  let restartTimer = null;
  let stdoutBuffer = '';
  let stderrTail = '';
  let pending = null;
  let waiter = null;
  let hotkeyWaiter = null;

  /** One capture request waiting for the agent. */
  function settleWaiter(error, shot) {
    if (waiter === null) return;
    const current = waiter;
    waiter = null;
    clearTimeout(current.timer);
    if (error !== undefined) current.reject(error);
    else current.resolve(shot);
  }

  /**
   * Take one decoded agent capture and hand it to the waiter or the pending slot.
   * @param {{path: string, width: number, height: number}} event - the agent event.
   */
  async function receiveShot(event) {
    let shot;
    try {
      shot = await readShot(event);
    } catch (error) {
      settleWaiter(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (waiter !== null) settleWaiter(undefined, shot);
    else pending = shot;
  }

  /**
   * Handle one line of the agent protocol.
   * @param {string} line - one JSON line.
   */
  function onAgentLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event === null || typeof event !== 'object') return;
    switch (event.event) {
      case 'ready':
        ready = event.ok === true;
        hotkeyError = typeof event.error === 'string' ? event.error : '';
        if (event.ok === true) {
          registeredHotkey = pendingSpec === '' ? hotkey : pendingSpec;
          hotkeyOk = true;
        } else {
          hotkeyOk = registeredHotkey !== '';
        }
        attempts = 0;
        break;
      case 'hotkey': {
        hotkeyError = typeof event.error === 'string' ? event.error : '';
        if (event.ok === true) {
          registeredHotkey = pendingSpec === '' ? hotkey : pendingSpec;
          hotkeyOk = true;
        } else {
          hotkeyOk = registeredHotkey !== '';
        }
        if (hotkeyWaiter !== null) {
          const current = hotkeyWaiter;
          hotkeyWaiter = null;
          clearTimeout(current.timer);
          current.resolve({ ok: event.ok === true, error: hotkeyError });
        }
        break;
      }
      case 'shot':
        void receiveShot({ path: String(event.path ?? ''), width: Number(event.width), height: Number(event.height) });
        break;
      case 'cancel':
        settleWaiter(undefined, { cancelled: true });
        break;
      case 'focus':
        lastFocus = { ok: event.ok === true, hwnd: Number(event.hwnd) || 0, at: Date.now() };
        break;
      case 'error':
        lastError = typeof event.error === 'string' ? event.error : 'unknown error';
        break;
      default:
        break;
    }
  }

  /** Write one command line to the agent, ignoring a dead pipe. */
  function command(line) {
    if (child === null || child.stdin === null || child.stdin.destroyed) return false;
    try {
      child.stdin.write(`${line}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** Start the resident agent. */
  function startAgent() {
    if (disposed) return;
    stdoutBuffer = '';
    const proc = spawn(POWERSHELL, [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', AGENT_PATH, '-Hotkey', hotkey, '-MaxEdge', String(MAX_EDGE),
      '-DshPid', String(process.pid),
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    ready = false;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let index = stdoutBuffer.indexOf('\n');
      while (index >= 0) {
        const line = stdoutBuffer.slice(0, index).trim();
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (line !== '') onAgentLine(line);
        index = stdoutBuffer.indexOf('\n');
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
    });
    proc.on('error', (error) => {
      lastError = error instanceof Error ? error.message : String(error);
    });
    proc.on('exit', (code) => {
      if (child === proc) child = null;
      ready = false;
      settleWaiter(new Error('截屏进程已退出'));
      if (hotkeyWaiter !== null) {
        const current = hotkeyWaiter;
        hotkeyWaiter = null;
        clearTimeout(current.timer);
        current.resolve({ ok: false, error: '截屏进程已退出' });
      }
      if (disposed) return;
      if (attempts >= RESTART_DELAYS_MS.length) {
        lastError = stderrTail.trim() === '' ? `截屏进程退出（code ${code ?? 'null'}）` : stderrTail.trim().split('\n').slice(-3).join(' ');
        return;
      }
      const delay = RESTART_DELAYS_MS[attempts];
      attempts += 1;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        startAgent();
      }, delay);
    });
  }

  /** Persist the hotkey preference. */
  async function saveSettings() {
    try {
      await mkdir(dirname(SETTINGS_PATH), { recursive: true });
      await writeFile(SETTINGS_PATH, `${JSON.stringify({ hotkey }, null, 2)}\n`, 'utf8');
    } catch {
      /* a read-only profile keeps the in-memory value */
    }
  }

  /** Load the persisted hotkey preference, if any. */
  async function loadSettings() {
    try {
      const parsed = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'));
      if (typeof parsed.hotkey === 'string' && parsed.hotkey.trim() !== '') hotkey = parsed.hotkey.trim();
    } catch {
      /* first run */
    }
  }

  /**
   * Ask the composer button for one capture and wait for the drag to finish.
   * @returns {Promise<object>} the shot payload, or `{cancelled: true}`.
   */
  function captureOnce() {
    return new Promise((resolve, reject) => {
      if (waiter !== null) {
        reject(new Error('上一次截图还没完成'));
        return;
      }
      if (!command('capture')) {
        reject(new Error('截屏进程没有运行'));
        return;
      }
      const timer = setTimeout(() => {
        if (waiter !== null) settleWaiter(new Error('等待框选超时'));
      }, CAPTURE_TIMEOUT_MS);
      waiter = {
        resolve: (shot) => resolve(shot),
        reject: (error) => reject(error),
        timer,
      };
    });
  }

  /**
   * Apply a new hotkey by asking the agent to re-register it.
   * @param {string} spec - for example `Ctrl+Shift+A`.
   * @returns {Promise<{ok: boolean, error: string}>} the registration result.
   */
  function applyHotkey(spec) {
    return new Promise((resolve) => {
      pendingSpec = spec;
      if (!command(`hotkey ${spec}`)) {
        pendingSpec = '';
        resolve({ ok: false, error: '截屏进程没有运行' });
        return;
      }
      const timer = setTimeout(() => {
        hotkeyWaiter = null;
        pendingSpec = '';
        resolve({ ok: false, error: '截屏进程没有响应' });
      }, 5_000);
      hotkeyWaiter = {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        timer,
      };
    });
  }

  /**
   * Route guard: same-origin marker header plus a JSON reply on refusal.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {string} method - required method.
   * @returns {boolean} whether the handler may continue.
   */
  function guard(req, res, method) {
    if (req.method !== method) {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return false;
    }
    if (req.headers['x-dsh-lit-shot'] !== '1') {
      sendJson(res, 403, { ok: false, error: 'missing x-dsh-lit-shot header' });
      return false;
    }
    return true;
  }

  /**
   * Take one capture for the composer button.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   */
  async function captureHandler(req, res) {
    if (!guard(req, res, 'POST')) return;
    req.resume();
    if (!ready) {
      sendJson(res, 503, { ok: false, error: lastError === '' ? '截屏进程尚未就绪' : lastError });
      return;
    }
    try {
      const shot = await captureOnce();
      if (shot.cancelled === true) sendJson(res, 200, { ok: false, cancelled: true });
      else sendJson(res, 200, { ok: true, ...shot });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Report whether a hotkey capture is waiting for this composer.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   */
  function pendingHandler(req, res) {
    if (!guard(req, res, 'GET')) return;
    if (pending === null) {
      sendJson(res, 200, { ok: true, shot: null });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      shot: { id: pending.id, width: pending.width, height: pending.height, name: pending.name, at: pending.at },
    });
  }

  /**
   * Hand out the picture bytes for one pending capture.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {URL} url - the parsed request URL.
   */
  function shotHandler(req, res, url) {
    if (!guard(req, res, 'GET')) return;
    const id = url.searchParams.get('id');
    if (pending === null || (id !== null && id !== pending.id)) {
      sendJson(res, 404, { ok: false, error: '截图已失效' });
      return;
    }
    sendJson(res, 200, { ok: true, ...pending });
  }

  /**
   * Mark one pending capture as consumed so it is not inserted twice.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   */
  async function claimHandler(req, res) {
    if (!guard(req, res, 'POST')) return;
    const body = await readJsonBody(req);
    if (pending !== null && (body.id === undefined || body.id === pending.id)) pending = null;
    sendJson(res, 200, { ok: true });
  }

  /**
   * Read the current hotkey and registration state.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   */
  function settingsGetHandler(req, res) {
    if (!guard(req, res, 'GET')) return;
    sendJson(res, 200, {
      ok: true,
      hotkey: registeredHotkey === '' ? hotkey : registeredHotkey,
      hotkeyOk,
      error: hotkeyError,
      agent: ready,
      defaultHotkey: DEFAULT_HOTKEY,
      focus: lastFocus,
    });
  }

  /**
   * Register and persist a new hotkey.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   */
  async function settingsPostHandler(req, res) {
    if (!guard(req, res, 'POST')) return;
    const body = await readJsonBody(req);
    const spec = typeof body.hotkey === 'string' ? body.hotkey.trim() : '';
    if (spec === '' || spec.length > 40) {
      sendJson(res, 400, { ok: false, error: '快捷键为空' });
      return;
    }
    if (!ready) {
      sendJson(res, 503, { ok: false, error: '截屏进程尚未就绪' });
      return;
    }
    const result = await applyHotkey(spec);
    if (result.ok) {
      hotkey = spec;
      await saveSettings();
      sendJson(res, 200, { ok: true, hotkey: spec });
      return;
    }
    sendJson(res, 200, { ok: false, error: result.error, hotkey: registeredHotkey === '' ? hotkey : registeredHotkey });
  }

  /**
   * One route entry: switch on path and method.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   */
  async function handler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      switch (url.pathname) {
        case '/dsh-lit-shot/capture':
          await captureHandler(req, res);
          return;
        case '/dsh-lit-shot/pending':
          pendingHandler(req, res);
          return;
        case '/dsh-lit-shot/shot':
          shotHandler(req, res, url);
          return;
        case '/dsh-lit-shot/claim':
          await claimHandler(req, res);
          return;
        case '/dsh-lit-shot/settings':
          if (req.method === 'POST') await settingsPostHandler(req, res);
          else settingsGetHandler(req, res);
          return;
        case '/dsh-lit-shot/cancel':
          if (!guard(req, res, 'POST')) return;
          req.resume();
          command('cancel');
          settleWaiter(undefined, { cancelled: true });
          sendJson(res, 200, { ok: true });
          return;
        default:
          sendJson(res, 404, { ok: false, error: 'not found' });
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  ctx.effect(() => {
    const unregister = ctx.webServer.register({ kind: 'exact', path: '/dsh-lit-shot/capture', handler });
    const unregisterPending = ctx.webServer.register({ kind: 'exact', path: '/dsh-lit-shot/pending', handler });
    const unregisterShot = ctx.webServer.register({ kind: 'exact', path: '/dsh-lit-shot/shot', handler });
    const unregisterClaim = ctx.webServer.register({ kind: 'exact', path: '/dsh-lit-shot/claim', handler });
    const unregisterSettings = ctx.webServer.register({ kind: 'exact', path: '/dsh-lit-shot/settings', handler });
    const unregisterCancel = ctx.webServer.register({ kind: 'exact', path: '/dsh-lit-shot/cancel', handler });
    void loadSettings().then(() => {
      startAgent();
    });
    return () => {
      disposed = true;
      if (restartTimer !== null) clearTimeout(restartTimer);
      if (child !== null) {
        try {
          child.stdin.write('quit\n');
          child.kill();
        } catch {
          /* already gone */
        }
      }
      unregister();
      unregisterPending();
      unregisterShot();
      unregisterClaim();
      unregisterSettings();
      unregisterCancel();
    };
  });
}
