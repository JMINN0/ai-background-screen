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
import { BROWSERS, currentBrowser } from './browser.js';
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
/**
 * 找出这台设备上所有可连的 devtools 通道，并认出每个通道属于哪个 App。
 *
 * **为什么不能写死 `chrome_devtools_remote`**（2026-11-12 实测）：
 * 多个 Chromium 浏览器同时存在时，它们会各自绑定 `chrome_devtools_remote_<pid>`，
 * 只有其中一个用无后缀的名字。写死名字的后果是永远只连到"碰巧拿到无后缀名"那个，
 * 其余浏览器看起来就像"没有通道"。这一条解释了之前 Chrome 时好时坏的怪现象。
 *
 * 判身份的可靠依据：`/json/version` 返回体里的 `Android-Package` 字段，
 * 它直接写着这个通道属于哪个包名，比看进程名、看 socket 名都准。
 *
 * 连不上的条目是残留 socket（进程已死但 inode 还在），直接跳过。
 */
// 扫描要 N 次 adb 往返（每个 socket 一次 forward + 一次 HTTP），而每个工具调用都会先 ensure()。
// 不加缓存的话，一次点击要付 8~9 轮 adb 往返的代价。TTL 取得短，避免缓存到已经消失的通道。
let SOCK_CACHE = { at: 0, list: [] };
const SOCK_TTL_MS = 4000;

export async function discoverSockets({ force = false } = {}) {
  if (!force && Date.now() - SOCK_CACHE.at < SOCK_TTL_MS) return SOCK_CACHE.list;

  const r = await adb(['shell', "cat /proc/net/unix 2>/dev/null | grep devtools | sed 's/.*@//'"]);
  const names = [...new Set(String(r.out || '').split('\n').map((x) => x.trim()).filter(Boolean))];
  const found = [];

  for (const name of names) {
    const port = 9500 + Math.floor(Math.random() * 400);   // 独立端口探测，不干扰主端口
    const fwd = await adb(['forward', `tcp:${port}`, `localabstract:${name}`]);
    if (!fwd.ok) continue;
    await sleep(250);
    try {
      const v = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2500) });
      if (v.ok) {
        const j = await v.json();
        found.push({ socket: name, pkg: j['Android-Package'] || '', browser: j.Browser || '' });
      }
    } catch { /* 残留 socket：进程没了，连不上 */ }
    await adb(['forward', '--remove', `tcp:${port}`]);
  }
  SOCK_CACHE = { at: Date.now(), list: found };
  return found;
}

export async function ensure() {
  // 端口不写死：两个 agent 同时 forward 同一端口会互相覆盖（隔壁逆向会话实测踩过）。
  if (!PORT) {
    const st = await loadState();
    PORT = st.port || 9300 + Math.floor(Math.random() * 200);
    await saveState({ ...st, port: PORT });
  }

  // 先扫一遍所有 devtools 通道，按包名找到目标浏览器真正的那个 socket
  const want = currentBrowser();
  let all = await discoverSockets().catch(() => []);
  let hit = all.find((x) => x.pkg === want.pkg);

  if (hit) {
    await adb(['forward', '--remove', `tcp:${PORT}`]);
    const f = await adb(['forward', `tcp:${PORT}`, `localabstract:${hit.socket}`]);
    if (f.ok) {
      await sleep(200);
      try {
        const r = await fetch(`${ENDPOINT()}/json/version`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const j = await r.json();
          return { ok: true, browser: j.Browser, port: PORT, actualKey: want.key, socket: hit.socket, note: '' };
        }
      } catch { /* 落到下面重扫 */ }
    }
    // 缓存里的 socket 可能已经随浏览器重启失效了 —— 强制重扫一次再试
    all = await discoverSockets({ force: true }).catch(() => []);
    hit = all.find((x) => x.pkg === want.pkg);
    if (hit) {
      await adb(['forward', '--remove', `tcp:${PORT}`]);
      const f2 = await adb(['forward', `tcp:${PORT}`, `localabstract:${hit.socket}`]);
      if (f2.ok) {
        await sleep(250);
        try {
          const r = await fetch(`${ENDPOINT()}/json/version`, { signal: AbortSignal.timeout(5000) });
          if (r.ok) {
            const j = await r.json();
            return { ok: true, browser: j.Browser, port: PORT, actualKey: want.key, socket: hit.socket, note: '' };
          }
        } catch { /* 真的连不上，进失败分支 */ }
      }
    }
  }

  // 目标浏览器没在跑。**先把可能残留的 forward 清掉** ——
  // 不清的话，下面的任何 fetch 都可能连到上一次 ensure() 留下的那个浏览器，
  // 表现为"要 Lemur 却悄悄操作了 Edge"。这个坑是审查抓出来的。
  await adb(['forward', '--remove', `tcp:${PORT}`]);

  // 把"现在有哪些真的能连"如实报出来，并优先推荐**本插件认识的**浏览器
  if (all.length) {
    const list = all.map((x) => `  · ${x.pkg}（${x.browser}，socket: ${x.socket}）`).join('\n');
    const known = all.find((x) => browserKeyByPkg(x.pkg));
    return {
      ok: false,
      hint: `${want.name} 没有开启调试通道。当前能连的有：\n${list}\n\n`
        + (known
          ? `要改用正在跑的那个：web_browser { select: "${browserKeyByPkg(known.pkg)}" }\n`
          : '这些包里没有本插件认识的浏览器（可能是别的 App 的 WebView）。\n')
        + '**不要启动第二个 Chromium 浏览器** —— 会挤掉已有的那个（2026-11-05 因此丢过 60 多个标签）。',
    };
  }

  // ---- 连不上。唯一可靠的判断是 socket 在不在 ----
  // 以前这里数进程：ps | grep -c <proc>。那是错的 —— force-stop 之后会残留进程，
  // 进程数还会因为时序不同而飘。实测过：Chrome 已被杀，进程数还报 1，
  // 于是提示"切到 Chrome"，切过去照样连不上。
  //
  // devtools socket 存在 == 至少有一个 Chromium 浏览器真的准备好被连了。
  const sock = await adb(['shell', 'cat /proc/net/unix 2>/dev/null | grep -c devtools_remote']);
  const sockAlive = Number((sock.out || '0').trim()) > 0;

  if (sockAlive) {
    // socket 在，但我们连不上 → 是我们这边的问题（forward 断了 / 端口被占）
    return {
      ok: false,
      hint: '有 Chromium 浏览器开着调试通道（devtools socket 存在），但本插件连不上。\n'
        + '这是我们这边的问题，不是浏览器的：\n'
        + '  · 先重试一次（工具会自动重建 forward）\n'
        + '  · 还不行就跑 adb_reconnect，然后重试\n'
        + `  · 确认端口 ${PORT} 没被别的工具占着`,
    };
  }

  // socket 都没有 == 没有任何浏览器处于可调试状态
  return {
    ok: false,
    hint: `现在没有任何 Chromium 浏览器开着调试通道（devtools socket 数为 0）。\n`
      + `\n要先判断这个任务到底需不需要浏览器 —— 能用 adb shell 或 vdisplay 办到的就别开：\n`
      + '  · 只是取数据/看接口 → 用 adb shell 或 web_fetch，不用浏览器\n'
      + `  · 要操作登录态页面 → 才需要 ${currentBrowser().name}\n`
      + '\n确实需要、而它又没在跑，按这两条选：\n'
      + `  ① 不想打扰用户（他在用手机、主屏有东西）→ 用虚拟屏启动，主屏焦点不动：\n`
      + '       vdisplay_start {}\n'
      + `       vdisplay_launch { pkg: "${currentBrowser().pkg}" }\n`
      + '     注意 vdisplay_launch 会先 force-stop 目标 App，等于重启它。\n'
      + `  ② 用户没在忙、手机也不紧张 → 直接开，但开之前告诉用户一声：\n     （用 am start，**不要用 monkey** —— 实测它会把自动旋转打开）\n`
      + `       adb shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${currentBrowser().pkg}\n`
      + '\nAndroid 没有"在后台启动一个 App"的接口；只有启动到虚拟屏才能既跑起来又不抢屏。',
  };
}

/** 数值夹紧。 */
function clampNum(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 按包名反查浏览器 key。 */
function browserKeyByPkg(pkg) {
  const hit = Object.values(BROWSERS).find((b) => b.pkg === String(pkg || ''));
  return hit ? hit.key : null;
}

/** 从 /json/version 的 Browser 字符串认出是哪个浏览器。认不出返回 null。 */
function identifyBrowser(browserString) {
  const s = String(browserString || '');
  if (/^Edg/i.test(s)) return 'edge';
  if (/^Chrome/i.test(s)) return 'chrome';
  if (/nubia/i.test(s)) return 'nubia';
  return null;
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

  // 浏览器已经关掉时 listTargets() 会抛异常。以前这里直接抛出去，
  // 于是 saveState 永远走不到 —— 状态里残留的 tabs/adopted 再也清不掉，
  // "收工"之后 web_tabs 仍把用户的标签标成"已接管"。所以先兜住。
  let mine = [];
  let browserDown = false;
  if (st.marker) {
    try {
      const targets = await listTargets();
      const tracked = new Set(st.tabs || []);
      // 双保险：URL 带标记的算我们的；state 里记过 id 的也算（点链接跳转后 URL 会丢标记）。
      mine = targets.filter((t) => (t.url || '').includes(st.marker) || tracked.has(t.id));
    } catch {
      browserDown = true;
    }
  }

  for (const t of mine) {
    await send(null, 'Target.closeTarget', { targetId: t.id }).catch(() => {});
  }

  // 不管浏览器在不在，状态都要清干净：
  //   tabs    —— 已经关掉的标签不该留着
  //   adopted —— 不清的话"收工"之后 web_tabs 仍把用户标签标成"已接管"，自相矛盾，而且无限增长
  await saveState({ ...st, tabs: [], adopted: [] });
  return { ok: true, closed: mine.length, ...(browserDown ? { reason: '浏览器没在运行，只清了本地状态' } : {}) };
}


/**
 * 列出浏览器里**所有**页面标签，包括用户自己的。
 *
 * 以前这个插件只能看见自己开的标签 —— 那是 2026-11-05 之后刻意加的限制，
 * 起因是工具擅自动了用户的浏览器，把他 60 多个标签弄丢了。
 * 现在列出全部是安全的：列出只是读，不碰任何人。
 *
 * mine    = 本插件开的（URL 带 #dsh-<marker>，或 state.tabs 里记过）
 * adopted = 用户自己的标签，但这次会话里被 web_attach 接管了
 * 其余    = 用户自己的，本插件没碰过
 */
export async function listAllTabs() {
  const st = await loadState();
  const marker = st.marker || '';
  const tracked = new Set(st.tabs || []);
  const adopted = new Set(st.adopted || []);
  const targets = await listTargets();
  return targets.map((t) => {
    const url = t.url || '';
    const isMine = Boolean((marker && url.includes(marker)) || tracked.has(t.id));
    return {
      targetId: t.id,
      title: (t.title || '').slice(0, 90),
      url: url.slice(0, 200),
      mine: isMine,
      adopted: !isMine && adopted.has(t.id),
    };
  });
}

/**
 * 接管一个已经存在的标签。
 *
 * **只登记，不导航、不刷新、不改 URL。** 目的是让 AI 能直接操作
 * 用户已经登录好的那个页面，而不是每次重新开一个再走一遍登录。
 *
 * 接管之后 web_read / web_click / web_fill 都能用；
 * 但 web_close 关它之前必须显式 confirm —— 用户自己的标签不能悄悄关掉。
 */
export async function attachTab(targetId, { wake = false } = {}) {
  const targets = await listTargets();
  const t = targets.find((x) => x.id === targetId);
  if (!t) {
    return { ok: false, hint: `标签 ${targetId} 不存在（可能已经被关掉了）。先跑一次 web_tabs 看当前有哪些。` };
  }

  // 先实测能不能驱动。冻结的标签在 /json/list 里照样存在，看不出来。
  let frozen = !(await probe(targetId));
  let woke = false;

  let reloaded = false;
  if (frozen && wake) {
    const w = await wakeTab(targetId);
    if (w.ok) { frozen = false; woke = true; reloaded = w.reloaded === true; }
    else return { ok: false, hint: w.hint };
  }

  const st = await loadState();
  const marker = st.marker || `dsh-${Math.random().toString(36).slice(2, 10)}`;
  await saveState({
    ...st,
    marker,
    port: PORT,
    adopted: [...new Set([...(st.adopted || []), targetId])],
  });
  return {
    ok: true,
    targetId,
    title: (t.title || '').slice(0, 90),
    url: (t.url || '').slice(0, 200),
    frozen,
    woke,
    reloaded,
  };
}

/**
 * 关掉一个指定的标签。
 *
 * 安全线分两种：
 *   - 本插件自己开的（URL 带标记，或 state.tabs 记过）→ 直接关
 *   - 用户自己的（包括接管来的）→ 必须 confirm:true，否则拒绝并说明原因
 *
 * 这条线是 2026-11-05 事故换来的：工具擅自动用户的浏览器，
 * 60 多个标签一次性没了，而且找不回来。
 */
export async function closeTab(targetId, { confirm = false } = {}) {
  const st = await loadState();
  const marker = st.marker || '';
  const targets = await listTargets();
  const t = targets.find((x) => x.id === targetId);
  if (!t) return { ok: false, hint: `标签 ${targetId} 不存在（可能已经关了）。` };

  const url = t.url || '';
  const createdByUs = Boolean((marker && url.includes(marker)) || (st.tabs || []).includes(targetId));
  const title = (t.title || '').slice(0, 90);
  const shownUrl = url.slice(0, 160);

  if (!createdByUs && !confirm) {
    const adopted = (st.adopted || []).includes(targetId);
    return {
      ok: false,
      needsUserConfirm: true,
      hint: `这是${adopted ? '你已接管的用户标签' : '用户自己的标签'}，本插件不擅自关闭。\n`
        + `  标题：${title || '(无标题)'}\n`
        + `  地址：${shownUrl}\n`
        + '要先问用户，得到同意后再带 confirm:true 重试。',
    };
  }

  await send(null, 'Target.closeTarget', { targetId }).catch(() => {});
  const nextTabs = (st.tabs || []).filter((x) => x !== targetId);
  const nextAdopted = (st.adopted || []).filter((x) => x !== targetId);
  await saveState({ ...st, tabs: nextTabs, adopted: nextAdopted });
  return { ok: true, targetId, title, userOwned: !createdByUs };
}

/**
 * 探一下这个标签的渲染进程还活不活。
 *
 * 实测背景（Edge 后台、75 个标签）：约一半标签对 CDP 完全无响应 ——
 * Runtime.evaluate 超时、Page.setWebLifecycleState 超时、Target.activateTarget
 * 返回成功但照样唤不醒。只有 Page.reload 能把它拉回来。
 * 判断一个标签好不好用，不能看它在 /json/list 里在不在（冻结的也在），只能实测。
 */
export async function probe(targetId, timeout = 3000) {
  let c;
  try { c = await client(targetId); } catch { return false; }
  try {
    await c.send('Runtime.evaluate', { expression: '1', returnByValue: true }, timeout);
    return true;
  } catch {
    return false;
  } finally {
    c.close();
  }
}

/**
 * 唤醒一个被浏览器休眠的标签。
 *
 * 手段只有 Page.reload —— 这会**重新加载页面**：滚动位置、未提交的表单、
 * SPA 内部状态都会丢。所以不自动做，由调用方显式要求。
 */
export async function wakeTab(targetId) {
  // 两步，尽量只用第一步。
  //
  // ① Target.activateTarget —— 浏览器级命令，冻结的标签也收得到。
  //    实测激活之后等 1.5 秒左右渲染进程会自己恢复，**页面状态一点不丢**。
  //    所以先轮询等它醒，别急着 reload。
  // ② 实在不醒才 Page.reload —— 这一步会丢滚动位置和未提交的表单，是下策。
  //
  // 踩过的坑：激活之后立刻发 Page.reload 会失败（ws 都连不上），必须给渲染进程时间。
  const act = await send(null, 'Target.activateTarget', { targetId }).then(() => true).catch(() => false);
  if (!act) return { ok: false, hint: '激活这个标签失败，它可能已经被关掉了。' };

  for (const wait of [1200, 1800, 2500]) {
    await sleep(wait);
    if (await probe(targetId, 2500)) return { ok: true, reloaded: false };
  }

  const rel = await send(targetId, 'Page.reload', {}).then(() => true).catch(() => false);
  if (!rel) {
    return {
      ok: false,
      hint: '标签激活了但它一直不响应，重新加载也发不出去。'
        + '\n让用户在浏览器里手动点一下这个标签，通常立刻恢复。',
    };
  }

  await sleep(2500);
  const alive = await probe(targetId, 6000);
  return alive
    ? { ok: true, reloaded: true }
    : { ok: false, hint: '重新加载之后仍然无响应，这个标签可能是坏的。换一个，或者让用户重新打开页面。' };
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
  // 握手本身也要超时。原版只挂 onopen/onerror：若 socket 半死不活两边都不触发，
  // 这个 Promise 就永远不 settle，整个工具调用挂住。
  await new Promise((res, rej) => {
    const t = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      rej(new Error('ws 握手超时（5s）'));
    }, 5000);
    ws.onopen = () => { clearTimeout(t); res(); };
    ws.onerror = () => { clearTimeout(t); rej(new Error('ws 连接失败')); };
  });
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
  // ① 先只定位，不点。用 JS 点击（el.click()）产生的事件 isTrusted=false，
  //    风控靶场里这一项权重最重。所以定位和点击必须分开：定位用 JS，点击走 CDP Input。
  const located = await evaluate(targetId, `
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
      el = hit.length ? hit.find((e) => !hit.some((o) => o !== e && e.contains(o))) || hit[hit.length - 1] : null;
    }
    if (!el) return JSON.stringify({ ok: false, reason: '找不到元素（selector=' + sel + ' text=' + want + '）' });
    el.scrollIntoView({ block: 'center' });
    const rc = el.getBoundingClientRect();
    return JSON.stringify({
      ok: true,
      x: rc.x + rc.width / 2,
      y: rc.y + rc.height / 2,
      w: rc.width,
      h: rc.height,
      vw: window.innerWidth,
      vh: window.innerHeight,
      scale: window.visualViewport ? window.visualViewport.scale : 1,
      tag: el.tagName,
      text: (el.innerText || el.value || '').slice(0, 40),
    });
  `).then(JSON.parse);

  if (!located.ok) return located;

  // ② 拟人点击：带弯曲的接近轨迹 + 双峰时序 + 目标区域内的随机落点。
  //    这些参数为什么这么定，见 screen/src/human.js 的注释。
  const human = await import('../../screen/src/human.js').catch(() => null);
  const tx = located.x;
  const ty = located.y;

  if (!human) {
    // 退路：模块加载不到就退回原生 CDP 点击，至少事件是可信的
    await send(targetId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', clickCount: 1, buttons: 1 });
    await send(targetId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1, buttons: 0 });
    return { ...located, method: 'cdp-input', humanized: false };
  }

  // 起点要落在**真实视口内**。写死 600 是桌面视口的假设，
  // 而这个页面只有 360x530，元素靠下时起点会跑到屏幕外，轨迹被截掉一截，
  // 直线度和采样数都会跟着掉。这里用定位时读回来的 vw/vh。
  const vw = located.vw || 360;
  const vh = located.vh || 530;
  const pad = 8;
  const sx = Math.max(pad, Math.min(vw - pad, tx - 120 - Math.random() * 160));
  const sy = Math.max(pad, Math.min(vh - pad, ty + 60 + Math.random() * 120));
  // 距离越近越容易走成直线，点数和弯曲度都要跟着加，保证直线度有余量
  const near = Math.hypot(tx - sx, ty - sy) < 140;
  const swipe = human.buildSwipe(sx, sy, tx, ty, {
    points: (near ? 18 : 12) + Math.floor(Math.random() * 6),
    overshoot: 0,
  });

  // ④ 先移动、再按下、再松开 —— 这个顺序不能反。
  //
  //    上一版直接用 buildSwipe 的输出（按下→移动→抬起）来"点击"，
  //    实际做的是一次**拖拽**：鼠标在目标位置上按着拖了一段才松手。
  //    拖拽敏感的页面（滑块、地图、文本选择）会因此走错分支，
  //    而且移动阶段带着 buttons:1 本身就是"按着左键在动"的信号。
  //
  //    真人点一个按钮是：先把指针移过去（不按键），到了再按下、再松开。
  const approach = swipe.events.filter((e) => e.action === 'MOVE');
  for (const e of approach) {
    await send(targetId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: e.x, y: e.y, buttons: 0,
    }).catch(() => {});
    await sleep(human.mouseDelay());
  }

  // 落点：在元素包围盒内随机，不要每次都点正中
  const jx = (Math.random() - 0.5) * Math.max(2, (located.w || 40) * 0.35);
  const jy = (Math.random() - 0.5) * Math.max(2, (located.h || 40) * 0.35);
  const px = Math.round(tx + clampNum(jx, -(located.w || 40) / 2 + 2, (located.w || 40) / 2 - 2));
  const py = Math.round(ty + clampNum(jy, -(located.h || 40) / 2 + 2, (located.h || 40) / 2 - 2));

  await send(targetId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: px, y: py, buttons: 0,
  }).catch(() => {});
  await sleep(human.thinkDelay(220));   // 到位之后、按下之前的短暂停顿

  await send(targetId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1, buttons: 1,
  }).catch(() => {});

  // 按下到抬起：真人 60~140ms，不能用 mouseDelay
  await sleep(human.keyDwellDelay());

  await send(targetId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1, buttons: 0,
  }).catch(() => {});

  return { ...located, text: located.text, method: 'cdp-input-humanized', humanized: true };
}

/**
 * 填值。默认 insertText —— 必须先把元素聚焦，然后让 Chromium 自己输入，
 * 这样 React 的 onChange 才会触发。
 */
export async function fill(targetId, selector, text) {
  // ① 先聚焦并清空。清空也走真实按键（Ctrl+A / Cmd+A 然后退格），
  //    直接改 value 会留下"文字凭空出现"的痕迹。
  const focus = await evaluate(targetId, `
    const sel = ${JSON.stringify(selector)};
    const el = document.querySelector(sel);
    if (!el) return 'NOTFOUND';
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (el.select) el.select();
    const rc = el.getBoundingClientRect();
    return JSON.stringify({ ok: true, x: rc.x + rc.width / 2, y: rc.y + rc.height / 2,
      w: rc.width, h: rc.height, hasValue: (el.value || '').length });
  `);
  if (focus === 'NOTFOUND') return { ok: false, reason: `找不到元素 ${selector}` };
  const box = JSON.parse(focus);

  const human = await import('../../screen/src/human.js').catch(() => null);

  // ② 有旧内容就先选中再删掉（用真实按键，不用 JS 改值）
  if (box.hasValue > 0) {
    await send(targetId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
    }).catch(() => {});
    await send(targetId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
    }).catch(() => {});
    await sleep(60);
    await send(targetId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    }).catch(() => {});
    await send(targetId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    }).catch(() => {});
    await sleep(80);
  }

  // ③ 逐字符真实敲进去。
  //    为什么不用 Input.insertText：它只往 DOM 里塞文字，**不产生 keydown/keyup**，
  //    风控靶场里这一项叫 input-without-keys，权重 18。
  //    所以每个字符都要走 keyDown → keyUp，而且 keydown 的 text 要让浏览器真的输入字符。
  for (const ch of Array.from(text)) {
    const code = /[a-zA-Z]/.test(ch) ? `Key${ch.toUpperCase()}`
      : /[0-9]/.test(ch) ? `Digit${ch}`
      : ch === ' ' ? 'Space'
      : ch === '.' ? 'Period'
      : ch === ',' ? 'Comma'
      : ch === '@' ? 'Digit2'
      : '';
    const vk = /[a-zA-Z]/.test(ch) ? ch.toUpperCase().charCodeAt(0)
      : /[0-9]/.test(ch) ? ch.charCodeAt(0)
      : ch === ' ' ? 32
      : 0;

    // keyDown 带上 text，浏览器才会把它真正输入到焦点元素里
    await send(targetId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: ch, code, text: ch,
      unmodifiedText: ch,
      windowsVirtualKeyCode: vk || undefined,
      nativeVirtualKeyCode: vk || undefined,
    }).catch(() => {});

    // 按住时长：真人不会一按就松
    await sleep(human ? human.keyDwellDelay() : 70);

    await send(targetId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: ch, code,
      windowsVirtualKeyCode: vk || undefined,
      nativeVirtualKeyCode: vk || undefined,
    }).catch(() => {});

    // 字符之间的间隔：双峰，有快速连击也有思考停顿
    await sleep(human ? human.keyFlightDelay() : 90);
  }

  await sleep(180);

  const back = await evaluate(targetId, `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'NOTFOUND';
    return String(el.value != null ? el.value : el.textContent || '');
  `);
  if (back === 'NOTFOUND') return { ok: false, reason: `填写后元素消失了（${selector}）` };
  if (back !== text) {
    return { ok: false, reason: `填写后内容不一致`, got: String(back).slice(0, 40), want: String(text).slice(0, 40) };
  }
  return { ok: true, value: String(back), method: 'cdp-key-events', chars: Array.from(text).length };
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
