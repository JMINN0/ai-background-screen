/**
 * vd.js — 私有虚拟屏（headless virtual display）的核心。
 *
 * 原理：用 uid 2000 调 scrcpy-server 的 `new_display`，它走
 * DisplayManager.createNewVirtualDisplay，带回这些标志：
 *   FLAG_OWN_CONTENT_ONLY  内容不跟主屏同步（不是镜像）
 *   FLAG_OWN_FOCUS         不抢主屏焦点（Android 14+ 才有）
 *   FLAG_TRUSTED / FLAG_OWN_DISPLAY_GROUP / FLAG_PRESENTATION …
 * 关键：**没有 FLAG_PUBLIC**，所以这块屏不画在物理屏幕上，用户完全看不见。
 *
 * 四个实测坑（都会让人白折腾半天）：
 * 1. socket 名是 `scrcpy_<scid>`，**有下划线**。写成 scrcpy<scid> 会连不上，
 *    server 卡在 accept 不建屏，日志只打到 "Device:" 那一行。
 * 2. screencap -d 要的是 SurfaceFlinger 的 64 位 display id，不是逻辑 displayId。
 *    传逻辑 id 会报 "Display Id '64' is not valid"；不带 -d 就截到主屏，
 *    于是看起来像"这块屏在镜像主屏"，其实是截图截错了。
 * 3. scrcpy-server 启动后会删自己的 jar（unlinkSelf），所以要放在 chmod 555 的目录里。
 * 4. 客户端一断，server 退出、屏立刻消失。必须常驻一个哑客户端。
 *
 * 判据：`dumpsys display` 里看 **DisplayDeviceInfo** 那一行，
 * 同时有 FLAG_OWN_CONTENT_ONLY + FLAG_OWN_FOCUS 才是"能托管 App"的屏。
 * mBaseDisplayInfo 那一段永远不带这两个标志，别拿它判断（我踩过）。
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adbTarget } from './target.js';

const pexec = promisify(execFile);
const ADB = process.env.ADB_BIN || 'adb';
const REMOTE_DIR = '/data/local/tmp/dshvd';
const REMOTE_JAR = `${REMOTE_DIR}/scrcpy-server.jar`;
const SERVER_VER = '5.0.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function adb(args, timeout = 30000) {
  try {
    // 目标地址每次现取：adb 插件会把 adbd 迁到别的端口并写在 state.json 里。
    const target = await adbTarget();
    const { stdout, stderr } = await pexec(ADB, ['-s', target, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: stdout || '', err: stderr || '' };
  } catch (e) {
    const out = typeof e.stdout === 'string' ? e.stdout : '';
    const err = typeof e.stderr === 'string' && e.stderr ? e.stderr : String(e.message || e);
    return { ok: false, out, err };
  }
}

export async function shell(cmd, timeout = 30000) {
  const r = await adb(['shell', cmd], timeout);
  return `${r.out}${r.err}`.trim();
}

/** 插件自带的 jar 路径（打包在 assets 里）。 */
function localJar() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'assets', 'scrcpy-server.jar');
}

/** 确保设备上有 jar，且在 555 目录里（防自杀）。 */
export async function ensureJar() {
  const r = await shell(`ls -l ${REMOTE_JAR} 2>/dev/null | wc -l`);
  if (Number(r.trim()) > 0) {
    const d = await shell(`stat -c '%a' ${REMOTE_DIR} 2>/dev/null`);
    if (d.trim() !== '555') await shell(`chmod 555 ${REMOTE_DIR}`);
    return { ok: true, existed: true, remote: REMOTE_JAR };
  }
  const local = localJar();
  try { await access(local); } catch {
    return { ok: false, hint: `设备上没有 jar，插件包里也没有：${local}（需要 scrcpy-server-v${SERVER_VER}，可从 GitHub 下载放进 assets/）` };
  }
  await shell(`mkdir -p ${REMOTE_DIR}`);
  const p = await adb(['push', local, REMOTE_JAR], 120000);
  if (!p.ok) return { ok: false, hint: `推送 jar 失败：${p.err}` };
  await shell(`chmod 555 ${REMOTE_DIR}`);
  return { ok: true, existed: false, remote: REMOTE_JAR };
}

/** 列出当前的 displayId 集合，用于差集。 */
async function displayIds() {
  const out = await shell(`dumpsys display 2>/dev/null | grep -oE "mDisplayId=[0-9]+" | sort -u`);
  return new Set(out.split('\n').map((s) => s.replace('mDisplayId=', '').trim()).filter(Boolean));
}

async function sfIds() {
  const out = await shell(`dumpsys SurfaceFlinger --display-id 2>/dev/null | grep scrcpy`);
  const ids = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/Display (\d+)/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

const state = {
  child: null,
  sockets: [],
  scid: null,
  port: null,
  displayId: null,
  sfId: null,
  width: 720,
  height: 1280,
  startedAt: 0,
  lastShotHash: null,
  lastShotPath: null,
};

/** 建一块私有虚拟屏。返回 {ok, displayId, sfId} */
export async function start({ width = 720, height = 1280, dpi = 320 } = {}) {
  if (state.displayId) return { ok: true, displayId: state.displayId, sfId: state.sfId, reused: true };

  const jar = await ensureJar();
  if (!jar.ok) return { ok: false, hint: jar.hint };

  // 权限前提：shell 必须有 ADD_TRUSTED_DISPLAY（本机有，Pixel 没有）
  const perm = await shell(`dumpsys package com.android.shell 2>/dev/null | grep -c "ADD_TRUSTED_DISPLAY: granted=true"`);
  if (Number(perm.trim()) === 0) {
    return { ok: false, hint: '这台机器的 com.android.shell 没有 ADD_TRUSTED_DISPLAY 权限，私有虚拟屏起不来（scrcpy 官方 issue #5523）。这条路只在一部分机型上可用。' };
  }

  const before = await displayIds();
  const beforeSf = await sfIds();

  // scid 会被 scrcpy 用 Integer.parseInt(radix 16) 解析，必须是**有符号 32 位**内的正整数。
  // 用 0xffffffff 随机会得到 cd7bccd6 这种超范围值，server 直接 NumberFormatException 退出（踩过）。
  const scid = (1 + Math.floor(Math.random() * 0x7ffffffe)).toString(16).padStart(8, '0');
  const port = 28000 + Math.floor(Math.random() * 900);
  state.scid = scid;
  state.port = port;

  const target = await adbTarget();
  await adb(['forward', `tcp:${port}`, `localabstract:scrcpy_${scid}`]);

  const cmd = `CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server ${SERVER_VER} `
    // display_ime_policy=hide 是必须的：不加这个，虚拟屏上的输入框会把系统输入法焦点
    // 抢过去（实测 mDisplayIdToShowIme 会变成虚拟屏的 id），用户在主屏打字时键盘就没了。
    // 代价：虚拟屏上也打不了字（没有输入法连接），所以文字要么用深链带参数进去，要么用坐标点选。
    + `log_level=info tunnel_forward=true display_ime_policy=hide new_display=${width}x${height}/${dpi} `
    + `control=true audio=false scid=${scid}`;
  // 把 server 的输出落到日志文件：出问题时没有日志只能瞎猜（刚踩过：服务秒退却不知道为什么）
  const logPath = '/tmp/dsh-vd-server.log';
  const { openSync } = await import('node:fs');
  let fd = 'ignore';
  try { fd = openSync(logPath, 'w'); } catch { /* 写不了就用 ignore */ }
  state.logPath = logPath;

  const cleanupForward = async () => {
    try { await adb(['forward', '--remove', `tcp:${port}`]); } catch { /* 清不掉不影响返回 */ }
  };

  // ---- 这里是整个插件唯一能把引擎进程带崩的调用 ----
  // Node 行为：spawn 找不到可执行文件（ENOENT）时 emit 'error'；没有 'error' 监听
  // 就是 Unhandled 'error' event → uncaughtException → 进程直接退出
  // （本机 node 24.22.1 实测 exit 1）。环境升级清空过 apt 装的 adb，这场景真实发生过。
  // 所以做两层：① 同步 try/catch 兜 spawn 自身的参数/stdio 错误；
  //            ② 等 spawn/error 落定，失败就返回可读 hint，绝不把异常抛出去。
  let child;
  try {
    child = spawn(ADB, ['-s', target, 'shell', cmd], { detached: true, stdio: ['ignore', fd, fd] });
  } catch (e) {
    await cleanupForward();
    return { ok: false, hint: `无法启动 adb（${ADB}）：${e?.message || e}。先装 android-tools-adb（apt-get install -y android-tools-adb）` };
  }
  let spawnError = null;
  child.on('error', (e) => { if (!spawnError) spawnError = e; state.child = null; });
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    child.once('spawn', done);
    child.once('error', done);
    setTimeout(done, 3000).unref?.();
  });
  if (spawnError) {
    try { child.kill('SIGKILL'); } catch { /* 没起来就没什么可杀 */ }
    await cleanupForward();
    return {
      ok: false,
      hint: `启动 adb 失败（${ADB}）：${spawnError?.message || spawnError}\n`
        + '先装 android-tools-adb（apt-get install -y android-tools-adb）再重试。',
    };
  }
  state.child = child;
  child.unref?.();

  await sleep(1800);

  // 哑客户端 ×2（video + control），断开即销毁
  const connect = () => new Promise((res) => {
    const s = net.connect(port, '127.0.0.1', () => res(s));
    s.on('error', () => res(null));
    s.on('data', () => {});
  });
  const s1 = await connect();
  await sleep(500);
  const s2 = await connect();
  state.sockets = [s1, s2].filter(Boolean);
  state.startedAt = Date.now();

  // 等屏出现（差集）
  for (let i = 0; i < 20; i += 1) {
    await sleep(400);
    const now = await displayIds();
    const added = [...now].filter((d) => !before.has(d));
    if (added.length) {
      state.displayId = added[0];
      state.width = width; state.height = height;
      break;
    }
  }
  if (!state.displayId) {
    await stop();
    return { ok: false, hint: 'server 起来了但没等到新屏出现。常见原因：socket 名没带下划线、客户端没连上、或者权限不足。' };
  }

  for (let i = 0; i < 10; i += 1) {
    await sleep(300);
    const nowSf = await sfIds();
    const added = [...nowSf].filter((d) => !beforeSf.has(d));
    if (added.length) { state.sfId = added[0]; break; }
  }

  // 校验能力标志
  const flags = await shell(`dumpsys display 2>/dev/null | grep "DisplayDeviceInfo.*scrcpy" | head -1`);
  const canHost = /FLAG_OWN_CONTENT_ONLY/.test(flags) && /FLAG_OWN_FOCUS/.test(flags);

  return {
    ok: true,
    displayId: state.displayId,
    sfId: state.sfId,
    canHost,
    flags: (flags.match(/FLAG_[A-Z_]+/g) || []).join(' '),
  };
}

/** 销毁虚拟屏。 */
export async function stop() {
  // 先断推流：屏马上就没了，继续抓帧只会报错
  try { const m = await import('./stream.js'); await m.shutdown(); } catch {}
  for (const s of state.sockets) { try { s.destroy(); } catch {} }
  state.sockets = [];
  if (state.child) { try { state.child.kill('SIGKILL'); } catch {} state.child = null; }
  if (state.scid) {
    await shell(`ps -A 2>/dev/null | grep ${state.scid} | awk '{print $2}' | xargs -r kill`);
    await adb(['forward', '--remove', `tcp:${state.port}`]);
  }
  state.displayId = null; state.sfId = null; state.scid = null; state.port = null;
  state.lastShotHash = null; state.lastShotPath = null;   // 不清会把上一块屏的旧图当成新屏画面
  return { ok: true };
}

export async function status() {
  const ids = await displayIds();
  const sf = await sfIds();
  const app = state.displayId ? await shell(`dumpsys window displays 2>/dev/null | grep -A20 "mDisplayId=${state.displayId}" | grep -m1 mCurrentFocus`) : '';
  return {
    running: Boolean(state.displayId),
    displayId: state.displayId,
    sfId: state.sfId,
    uptimeSec: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
    allDisplays: [...ids].sort((a, b) => a - b),
    scrcpyScreens: [...sf],
    focusedApp: app.trim(),
  };
}

/**
 * 把 App 投到虚拟屏。
 *
 * 必须先 force-stop：如果这个 App 已经跑在主屏后台，`am start --display N` 只会把
 * 那个已有任务拉到前台（实测踩过：计算器就是这么跑到主屏、把用户的视频顶掉的）。
 * 投完还要**校验主屏焦点没变**，变了立刻切回去——「不影响主屏」是硬要求。
 */
export async function launch(pkg, activity) {
  const s = await start();
  if (!s.ok) return { ok: false, hint: s.hint };

  const mainBefore = await mainFocus();

  await shell(`am force-stop ${pkg}`);
  await sleep(600);

  // 省略 activity 时不能只写 `-n <pkg>`——实测报 Bad component name。
  // 先用 resolve-activity 查出默认入口，查不到再退回 monkey 的 launcher intent。
  let comp;
  if (activity) {
    comp = `-n ${pkg}/${activity}`;
  } else {
    const res = await shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg} 2>/dev/null | tail -1`);
    const m = String(res).trim().match(/^([\w.]+)\/([\w.$]+)$/);
    comp = m ? `-n ${m[1]}/${m[2]}` : `-a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${pkg}`;
  }
  const out = await shell(`am start --display ${state.displayId} ${comp}`);
  await sleep(2000);

  // 校验是不是真的落在虚拟屏上
  const onVd = await shell(`dumpsys window displays 2>/dev/null | grep -A30 "mDisplayId=${state.displayId}" | grep -m1 mCurrentFocus`);
  const landedOnVd = onVd.includes(pkg);

  // 校验主屏
  const mainAfter = await mainFocus();
  // 只有**两边都测到**且真的不同，才算"主屏被抢"。空值代表"没测到"，不能当变化——
  // 之前用空值比较，导致前后都是 B 站却报"主屏被抢、已切回"（假报警，踩过）。
  const bothKnown = Boolean(mainBefore) && Boolean(mainAfter);
  let restored = false;
  if (bothKnown && mainAfter !== mainBefore) {
    // 主屏被抢了 → 立刻切回原来的 App
    const prevPkg = mainBefore.split('/')[0];
    if (prevPkg) { await shell(`monkey -p ${prevPkg} -c android.intent.category.LAUNCHER 1`); restored = true; await sleep(800); }
  }

  return {
    ok: landedOnVd && !restored,
    displayId: state.displayId,
    landedOnVd,
    mainFocusBefore: mainBefore,
    mainFocusAfter: await mainFocus(),
    restoredMain: restored,
    out: out.trim() || (landedOnVd ? '已在虚拟屏上启动' : '没落在虚拟屏上'),
  };
}


/**
 * 取当前虚拟屏的一帧，只算哈希，不落盘。
 *
 * 为什么要这个：之前的 input() 只要 adb 不报错就返回 ok:true，**点空了也算成功**。
 * 实测（隔壁对线会话 15 张截图里有 5 张与上一张逐像素相同）意味着 17.6% 的操作是白点的，
 * 而调用方完全看不出来，只能靠额外交一张截图 + 模型看图才可能发现。
 * 所以每个输入动作前后各取一次哈希，变了才算真生效。
 */
async function frameHash() {
  if (!state.sfId) return null;
  const r = await adb(['exec-out', 'screencap', '-p', '-d', String(state.sfId)], 20000);
  if (!r.ok || !r.out) return null;
  const { createHash } = await import('node:crypto');
  return createHash('sha1').update(r.out, 'utf8').digest('hex');
}

/**
 * 定向输入。kind: tap | swipe | text | key | paste
 *
 * 默认会在动作前后各取一次画面哈希：**画面没变就返回 changed:false**，
 * 让调用方知道"这一下没生效"，而不是像以前那样一律 ok:true（实测 17.6% 白点）。
 * 传 verify:false 可跳过校验（省 2 次截图，约 0.3 秒），适合连续点同一个界面时。
 */
export async function input(kind, a = {}) {
  const s = await start();
  if (!s.ok) return { ok: false, hint: s.hint };
  const d = state.displayId;
  let cmd;
  // 归一化坐标：给 nx/ny（0..1）就按当前屏尺寸换算，省得调用方猜坐标系。
  // 实测白点率 17.6% 的主因不是点不准，是模型不知道屏多大、坐标系对不上。
  const toX = () => (a.nx !== undefined && a.nx !== null)
    ? Math.round(Number(a.nx) * state.width)
    : Math.trunc(Number(a.x) || 0);
  const toY = () => (a.ny !== undefined && a.ny !== null)
    ? Math.round(Number(a.ny) * state.height)
    : Math.trunc(Number(a.y) || 0);

  if (kind === 'tap') cmd = `input -d ${d} tap ${toX()} ${toY()}`;
  else if (kind === 'swipe') cmd = `input -d ${d} swipe ${Math.trunc(Number(a.x1)||0)} ${Math.trunc(Number(a.y1)||0)} ${Math.trunc(Number(a.x2)||0)} ${Math.trunc(Number(a.y2)||0)} ${Number(a.ms) || 300}`;
  else if (kind === 'text') {
    const txt = String(a.text ?? '');
    // 实测：非 ASCII（中文）走 input text 会让设备侧抛 NPE，而且异常文本会被当输出回填。
    // 别假装支持——直接告诉调用方改用 paste。
    if (/[^\x00-\x7F]/.test(txt)) {
      return { ok: false, hint: 'input text 只支持 ASCII。中文等非 ASCII 字符请改用 kind:"paste"（需先让剪贴板里有内容）。' };
    }
    if (!/^[\w\s.,:/@#%&*()\-+=?!']{0,400}$/.test(txt)) return { ok: false, hint: 'text 含不支持的字符' };
    cmd = `input -d ${d} text "${txt.replace(/["\\$`]/g, '')}"`;
  } else if (kind === 'key') cmd = `input -d ${d} keyevent ${String(a.key || '').replace(/[^A-Z0-9_]/gi, '')}`;
  else if (kind === 'paste') cmd = `input -d ${d} keyevent 279`;   // KEYCODE_PASTE：从剪贴板粘贴，不经过输入法
  else return { ok: false, hint: `不认识的输入类型：${kind}` };

  const verify = a.verify !== false;
  const before = verify ? await frameHash() : null;
  const out = await shell(cmd);
  if (!verify) return { ok: true, displayId: d, out: out.trim(), changed: null };

  await sleep(Number(a.settleMs) || 500);
  const after = await frameHash();
  const changed = before && after ? before !== after : null;
  return {
    ok: changed !== false,          // 画面没变 = 这次操作大概率没生效
    displayId: d,
    changed,
    hint: changed === false
      ? '画面没有变化，这一下可能没生效（坐标偏了 / 控件不可点 / 界面还没加载完）。建议重新截一张图确认位置，不要盲目重复点同一坐标。'
      : undefined,
    out: out.trim(),
  };
}

/**
 * 截虚拟屏。返回本地路径。
 *
 * 带**画面去重**：如果这一帧和上次截的完全一样，直接返回上次那个路径并标 `unchanged:true`，
 * 调用方就不用再 read_image 了。为什么值得做：一张 720x1280 截图约 1.1k tokens
 * 且永久留在上下文里，长任务翻几屏就把上下文吃满了（实测 15 屏 → 上下文 203k→243k）。
 */
export async function shot(dir = '/tmp', { width = 540, format = 'jpeg' } = {}) {
  const s = await start();
  if (!s.ok) return { ok: false, hint: s.hint };
  if (!state.sfId) return { ok: false, hint: '没拿到这块屏的 SurfaceFlinger id，无法截图。' };

  // 先算哈希，和上次比
  const hash = await frameHash();
  if (hash && hash === state.lastShotHash && state.lastShotPath) {
    // 文件还在就直接复用，省一次 pull 也省一次模型看图
    try {
      const { access } = await import('node:fs/promises');
      await access(state.lastShotPath);
      return { ok: true, path: state.lastShotPath, displayId: state.displayId, unchanged: true, hint: '画面和上次截图完全一样，同一张图可直接复用，不用再看一次。' };
    } catch { /* 文件没了就正常截 */ }
  }
  const remotePng = `/sdcard/dsh-vd-${Date.now()}.png`;
  const cap = await shell(`screencap -p -d ${state.sfId} ${remotePng}`);
  if (/Failed|invalid/i.test(cap)) return { ok: false, hint: `截图失败：${cap}` };

  // 默认转成 540 宽 JPEG：实测文字完全可读，体积和 token 都省约 44%
  // （raw PNG 1229 tokens → 540 宽 JPEG 691 tokens）。
  let remote = remotePng;
  if (format === 'jpeg') {
    const jpgRemote = remotePng.replace(/\.png$/, '.jpg');
    const conv = await shell(`ffmpeg -y -loglevel error -i ${remotePng} -vf scale=${Math.max(240, Math.min(1080, width))}:-1 -q:v 4 ${jpgRemote} 2>&1 | head -2`);
    const ok = await shell(`ls ${jpgRemote} 2>/dev/null | wc -l`);
    if (Number(String(ok).trim()) > 0) { remote = jpgRemote; await shell(`rm -f ${remotePng}`); }
    else if (conv) return { ok: false, hint: `转 JPEG 失败（保留了原 PNG）：${conv}` };
  }
  await mkdir(dir, { recursive: true });
  const local = join(dir, `vd-${Date.now()}.png`);
  const pull = await adb(['pull', remote, local], 60000);
  await shell(`rm -f ${remote}`);
  if (!pull.ok) return { ok: false, hint: `拉取失败：${pull.err}` };
  state.lastShotHash = hash;
  state.lastShotPath = local;
  return {
    ok: true, path: local, displayId: state.displayId, unchanged: false,
    // **一定要带尺寸**：之前完全不返回，调用方只能猜坐标系。
    width: state.width, height: state.height,
    hint: `屏尺寸 ${state.width}x${state.height}；点击可以用归一化坐标 nx/ny（0..1）避免算错。`,
  };
}

/** 主屏截图（只读，不打扰）。 */
export async function mainShot(dir = '/tmp') {
  await mkdir(dir, { recursive: true });
  const remote = `/sdcard/dsh-main-${Date.now()}.png`;
  await shell(`screencap -p ${remote}`);
  const local = join(dir, `main-${Date.now()}.png`);
  const pull = await adb(['pull', remote, local], 60000);
  await shell(`rm -f ${remote}`);
  return pull.ok ? { ok: true, path: local } : { ok: false, hint: pull.err };
}

/**
 * 主屏（display 0）当前前台是谁。
 *
 * 不能用 `dumpsys activity activities | grep topResumedActivity` —— 那是**全局**的，
 * 虚拟屏上的 Activity 也会算进来，会误判「主屏被抢」。
 * 也不能用固定行数的 `grep -A40`：有虚拟屏时 display 0 那一段会变长，40 行不够（踩过）。
 * 所以整段解析：找到 "Display: mDisplayId=0" 之后，一直读到下一个 "Display:" 为止。
 *
 * 建屏/销毁的瞬间焦点可能是 null，读一次会拿到空。重试四次，仍空就返回 '' 表示"没测到"，
 * 让调用方区分「没变化」和「没测到」，而不是拿空值当变化（踩过：误判后去 monkey 桌面，把用户屏幕切了）。
 */
export async function mainFocus() {
  for (let i = 0; i < 4; i += 1) {
    const out = await shell('dumpsys window displays 2>/dev/null');
    const lines = out.split('\n');
    let inside = false;
    for (const line of lines) {
      if (/Display:\s*mDisplayId=/.test(line)) {
        inside = /Display:\s*mDisplayId=0\b/.test(line);
        continue;
      }
      if (inside) {
        const m = line.match(/mCurrentFocus=Window\{[0-9a-f]+ u0 ([\w.]+)\/([\w.$]+)\}/);
        if (m) return `${m[1]}/${m[2]}`;
      }
    }
    await sleep(300);
  }
  return '';
}
