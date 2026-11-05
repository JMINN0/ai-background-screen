/**
 * cdp.js — 不占屏的浏览器控制。
 *
 * 原理：Edge/Chromium 暴露 `@chrome_devtools_remote` 这个 unix socket，
 * `adb forward` 把它接到本机 tcp:9222，然后用 WebSocket 说 DevTools 协议。
 *
 * 三条硬规矩（都是实测踩出来的）：
 * 1. **只碰自己开的标签**。用户现有标签一律不动、不关。自己开的 targetId 记在 state 里。
 * 2. **不新建窗口**。用户 2026-11-05 定死的浏览器边界：只在「AI操作」分组内增删，
 *    不许新建窗口/分组、不许触发会话恢复。所以 createTarget 一律 newWindow:false；
 *    Android Edge 在 false 下可能拒绝建标签 —— 那就返回明确错误交给调用方，**不退回 true**。
 * 3. **填值必须 Input.insertText**（或原生 setter + dispatch input）。直接赋 .value，
 *    React 的 value tracker 认为没变化，onChange 不触发 —— 就是"填了但页面说空"的根因。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { adbTarget } from './target.js';

const pexec = promisify(execFile);
const ADB = process.env.ADB_BIN || 'adb';
// 浏览器不写死：由 src/browser.js 管，默认 Edge，调用时可以切换。
// Chromium 系的 devtools socket 都叫 chrome_devtools_remote，同一时刻只允许一个进程绑定。
import { currentBrowser } from './browser.js';
let PORT = Number(process.env.WEB_CDP_PORT || 0);   // 0 = 自动挑
const ENDPOINT = () => `http://127.0.0.1:${PORT}`;
const STATE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugin-web');
const STATE = join(STATE_DIR, 'state.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function adb(args, timeout = 20000) {
  try {
    // 目标地址每次现取：adb 插件的 adbd 端口会变，硬编码 5555 会静默失联。
    const target = await adbTarget();
    const { stdout } = await pexec(ADB, ['-s', target, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, out: stdout || '' };
  } catch (e) {
    return { ok: false, out: '', err: String(e.message || e) };
  }
}

async function loadState() {
  try { return JSON.parse(await readFile(STATE, 'utf8')); } catch { return { tabs: [] }; }
}
async function saveState(s) {
  try { await mkdir(STATE_DIR, { recursive: true }); await writeFile(STATE, JSON.stringify(s, null, 2)); } catch {}
}

/** 探活；挂了就重建 forward（Edge 被杀会留下失效的 forward）。 */
export async function ensure() {
  // 端口不写死：两个 agent 同时 forward 同一端口会互相覆盖（隔壁逆向会话实测踩过）。
  if (!PORT) {
    const st = await loadState();
    PORT = st.port || 9300 + Math.floor(Math.random() * 200);
    await saveState({ ...st, port: PORT });
  }
  for (let i = 0; i < 2; i += 1) {
    try {
      const r = await fetch(`${ENDPOINT()}/json/version`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j = await r.json();
        return { ok: true, browser: j.Browser, port: PORT };
      }
    } catch { /* 继续修复 */ }
    if (i === 0) {
      await adb(['forward', '--remove', `tcp:${PORT}`]);
      await adb(['forward', `tcp:${PORT}`, `localabstract:${currentBrowser().socket}`]);
      await sleep(600);
    }
  }
  const proc = await adb(['shell', `ps -A 2>/dev/null | grep -c ${currentBrowser().proc}`]);
  const sock = await adb(['shell', 'cat /proc/net/unix 2>/dev/null | grep -c devtools_remote']);
  const alive = Number((proc.out || '0').trim()) > 0 && Number((sock.out || '0').trim()) > 0;
  return {
    ok: false,
    hint: alive
      ? `${currentBrowser().name} 在跑但 CDP 连不上（forward 可能残留）。跑一次 adb_reconnect 或重试。`
      : `浏览器没在运行（进程 ${(proc.out || '0').trim()}、socket ${(sock.out || '0').trim()}）。`
        + `\n短时占用前台把它拉起来：adb shell monkey -p ${currentBrowser().pkg} -c android.intent.category.LAUNCHER 1`
        + `\n或者让用户自己打开 ${currentBrowser().name}。起来后本插件会自动接上。`,
  };
}

export async function listTargets({ type = 'page' } = {}) {
  const r = await fetch(`${ENDPOINT()}/json/list`, { signal: AbortSignal.timeout(6000) });
  const all = await r.json();
  return all.filter((t) => !type || t.type === type);
}

/**
 * 打开一个只属于本插件的标签。
 *
 * 打标记：URL 里塞 `#dsh-<marker>`。这样即使进程崩了、state 丢了、或重启了，
 * 也能从 URL 认出哪些标签是自己的 —— 绝不会误关用户的标签（隔壁会话给的建议）。
 */
export async function openTab(rawUrl, { reuse = true } = {}) {
  const st = await loadState();
  const marker = st.marker || `dsh-${Math.random().toString(36).slice(2, 10)}`;
  const withMark = (u) => (u.includes('#') ? `${u.split('#')[0]}#${marker}` : `${u}#${marker}`);

  const targets = await listTargets();
  const mine = targets.filter((t) => (t.url || '').includes(marker));

  if (reuse && mine.length) {
    const id = mine[0].id;
    await navigate(id, withMark(rawUrl));
    await saveState({ ...st, marker, port: PORT, tabs: [...new Set([...(st.tabs || []), id])] });
    return { ok: true, targetId: id, reused: true, marker };
  }

  // 新建标签：**一律 newWindow:false**。
  // 用户 2026-11-05 的硬规则：不许新建窗口 / 新建分组 / 触发会话恢复。
  // Android Edge 在 newWindow:false 下可能拒绝建标签（后台时尤其），这时**不退回 true**，
  // 而是把"要不要新建窗口"的决定交回调用方 —— 让 agent 去问用户，别自己动用户的浏览器。
  const created = await send(null, 'Target.createTarget', { url: withMark(rawUrl), newWindow: false })
    .catch((e) => ({ error: e.message }));
  const id = created?.result?.targetId;
  if (!id) {
    return {
      ok: false,
      needsUserConfirm: true,
      hint: '建标签失败：浏览器可能在后台，CDP 在后台状态下无法新建标签。\n'
        + '按用户规则本插件不新建窗口，所以不会退回 newWindow:true。\n'
        + '请先跟用户确认，再把浏览器切到前台重试；或复用一个本插件已有的标签（reuse:true）。\n'
        + `（原始错误：${created?.error || '未知'}）`,
    };
  }
  await saveState({ ...st, marker, port: PORT, tabs: [...new Set([...(st.tabs || []), id])] });
  await sleep(800);
  return { ok: true, targetId: id, reused: false, marker };
}

/** 只关带本插件标记的标签。用户的一个都不碰。 */
export async function closeOwnTabs() {
  const st = await loadState();
  if (!st.marker) return { ok: true, closed: 0, reason: '没有标记，什么都不关' };
  const targets = await listTargets();
  const tracked = new Set(st.tabs || []);
  // 双保险：URL 带标记的算我们的；state 里记过 id 的也算（点链接跳转后 URL 会丢标记）。
  const mine = targets.filter((t) => (t.url || '').includes(st.marker) || tracked.has(t.id));
  for (const t of mine) {
    await send(null, 'Target.closeTarget', { targetId: t.id }).catch(() => {});
  }
  await saveState({ ...st, tabs: [] });
  return { ok: true, closed: mine.length };
}


async function wsUrl(targetId) {
  const targets = await listTargets({ type: null });
  const t = targets.find((x) => x.id === targetId);
  if (!t?.webSocketDebuggerUrl) throw new Error(`target ${targetId} 不存在或没有 ws（页面可能已关闭）`);
  return t.webSocketDebuggerUrl;
}

/** 连一个 page target，返回 send/close。targetId 传 null 时连 browser 级。 */
async function client(targetId) {
  const url = targetId ? await wsUrl(targetId) : `${ENDPOINT().replace('http', 'ws')}/devtools/browser`;
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  return {
    send(method, params = {}, timeout = 20000) {
      const mid = ++id;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => { pending.delete(mid); rej(new Error(`${method} 超时`)); }, timeout);
        pending.set(mid, (m) => { clearTimeout(timer); res(m); });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}

/** 给 browser 级通道发命令（createTarget 要用它）。 */
export async function send(targetId, method, params) {
  const c = await client(targetId);
  try { return await c.send(method, params); } finally { c.close(); }
}

export async function navigate(targetId, url) {
  await send(targetId, 'Page.navigate', { url });
  await sleep(1200);
  const t = (await listTargets({ type: null })).find((x) => x.id === targetId);
  return { url: t?.url, title: t?.title };
}

/** 在页面里求值，返回字符串/JSON。 */
export async function evaluate(targetId, expression) {
  const r = await send(targetId, 'Runtime.evaluate', {
    expression: `(() => { ${expression} })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.error) throw new Error(r.error.message);
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description || ex.text);
  return r.result?.result?.value;
}

export async function readPage(targetId) {
  return evaluate(targetId, `
    return JSON.stringify({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 4000)
    });
  `).then((s) => JSON.parse(s));
}

/**
 * 点一个元素。两种定位方式：
 *  - selector：CSS 选择器
 *  - text：按可见文字匹配（点最内层那个包含该文字的可点元素）
 * 用原生 click()，React/Vue 也会走合成事件。
 */
export async function click(targetId, { selector = '', text = '' } = {}) {
  return evaluate(targetId, `
    const sel = ${JSON.stringify(selector)};
    const want = ${JSON.stringify(text)};
    let el = null;
    if (sel) el = document.querySelector(sel);
    if (!el && want) {
      const target = want.trim().toLowerCase();
      const all = Array.from(document.querySelectorAll(
        'button, a, [role=button], input, label, li, span, div, p, h1, h2, h3, td, th'));
      const hit = all.filter((e) => {
        const t = ((e.innerText || e.value || e.textContent || '').trim()).toLowerCase();
        return t && t.includes(target);
      });
      // 取最内层：一个元素的子元素也命中时，优先子元素
      el = hit.length ? hit.find((e) => !hit.some((o) => o !== e && e.contains(o))) || hit[hit.length - 1] : null;
    }
    if (!el) return JSON.stringify({ ok: false, reason: '找不到元素（selector=' + sel + ' text=' + want + '）' });
    el.scrollIntoView({ block: 'center' });
    el.click();
    return JSON.stringify({ ok: true, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 40) });
  `).then(JSON.parse);
}

/**
 * 填值。默认 insertText —— 必须先把元素聚焦，然后让 Chromium 自己输入，
 * 这样 React 的 onChange 才会触发。
 */
export async function fill(targetId, selector, text) {
  const focus = await evaluate(targetId, `
    const sel = ${JSON.stringify(selector)};
    const el = document.querySelector(sel);
    if (!el) return 'NOTFOUND';
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (el.select) el.select();
    return el.tagName;
  `);
  if (focus === 'NOTFOUND') return { ok: false, reason: `找不到元素 ${selector}` };

  // 清空已有内容
  await send(targetId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 })
    .catch(() => {});
  await send(targetId, 'Input.insertText', { text });
  await sleep(150);

  const back = await evaluate(targetId, `
    const el = document.querySelector(${JSON.stringify(selector)});
    return JSON.stringify({ value: el?.value ?? el?.innerText ?? '', len: (el?.value ?? '').length });
  `).then(JSON.parse);
  return { ok: true, ...back };
}

export async function screenshot(targetId, dir = '/tmp') {
  const r = await send(targetId, 'Page.captureScreenshot', { format: 'png' });
  const b64 = r.result?.data;
  if (!b64) throw new Error('截图失败：没有返回数据');
  const path = join(dir, `web-${Date.now()}.png`);
  await writeFile(path, Buffer.from(b64, 'base64'));
  return { path, bytes: Buffer.from(b64, 'base64').length };
}

/**
 * 收工：把 forward 删掉。隔壁会话实测过，残留的 forward 会导致
 * 「socket 归零但 forward 还在 → 所有请求 socket hang up」，很难查。
 */
export async function release() {
  if (!PORT) return { ok: true, skipped: true };
  await adb(['forward', '--remove', `tcp:${PORT}`]);
  return { ok: true, removed: `tcp:${PORT}` };
}

// DEVICE 不再有模块级常量（端口会变），需要地址时调 adbTarget()。
export const constants = { get port() { return PORT; }, endpoint: ENDPOINT, STATE, adbTarget };
