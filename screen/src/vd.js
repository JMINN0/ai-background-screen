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

import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  // import.meta.url 在常规 ESM 下是有的，但宿主用 bundle 方式加载插件时会是 undefined，
  // 实测表现：vdisplay_start 直接报
  //   The "path" argument must be of type string or an instance of URL. Received undefined
  // 这是发布版必须兜住的坑——不能假设宿主一定按 ESM 文件加载。
  // 三级兜底，取第一个真实存在的：
  //   ① 常规 ESM：从模块自身位置往上找 assets/
  //   ② 环境变量 DSH_SCREEN_JAR（给特殊部署留的口子）
  //   ③ 从 DSH_HOME 推 profile 里的安装位置
  const cands = [];
  try {
    const u = import.meta?.url;
    if (typeof u === 'string' && u) {
      cands.push(join(dirname(fileURLToPath(u)), '..', 'assets', 'scrcpy-server.jar'));
    }
  } catch { /* import.meta.url 不可用，走后面的兜底 */ }
  if (process.env.DSH_SCREEN_JAR) cands.push(process.env.DSH_SCREEN_JAR);
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  // 不写死 profile 名：别人可能装在 web / desktop / 自建 profile 下，逐个扫一遍。
  const profilesDir = join(home, 'profiles');
  try {
    for (const p of readdirSync(profilesDir)) {
      cands.push(join(profilesDir, p, 'node_modules', 'dsh-go-plugin-screen', 'assets', 'scrcpy-server.jar'));
    }
  } catch { /* 没有 profiles 目录就跳过 */ }

  for (const c of cands) {
    try { if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  return cands[0];   // 一个都不存在时返回首选，交给调用方报清晰的错
}

/** 确保设备上有 jar，且在 555 目录里（防自杀）。 */
export async function ensureJar() {
  const local = localJar();
  let localSize = 0;
  try {
    const { stat } = await import('node:fs/promises');
    localSize = (await stat(local)).size;
  } catch { /* 见下面的报错 */ }

  // 目录必须可写才推得进去。早期版本推完会把目录 chmod 555「保护」起来，
  // 结果是**永远无法升级 jar**，而且一旦目录已是 555 又缺 jar，就直接死锁
  // （实测 push 报 Permission denied）。所以每次先确保可写。
  await shell(`mkdir -p ${REMOTE_DIR} 2>/dev/null; chmod 777 ${REMOTE_DIR} 2>/dev/null`);

  const remoteSize = await shell(`stat -c '%s' ${REMOTE_JAR} 2>/dev/null || echo 0`);
  const have = Number(String(remoteSize).trim()) || 0;

  if (!localSize) {
    if (have > 0) {
      await shell(`chmod 444 ${REMOTE_JAR} 2>/dev/null`);
      return { ok: true, existed: true, remote: REMOTE_JAR, hint: '插件包里没有 jar，用设备上已有的（版本可能与客户端不匹配）' };
    }
    return { ok: false, hint: `设备上没有 jar，插件包里也没有：${local}（需要 scrcpy-server-v${SERVER_VER}，可从 GitHub 下载放进 assets/）` };
  }

  // 大小一致就当作同一个版本，跳过推送（省一次 700KB 传输）
  if (have === localSize) {
    await shell(`chmod 444 ${REMOTE_JAR} 2>/dev/null`);
    return { ok: true, existed: true, remote: REMOTE_JAR };
  }

  const p = await adb(['push', local, REMOTE_JAR], 120000);
  if (!p.ok) return { ok: false, hint: `推送 jar 失败：${p.err}` };
  // 文件本身设只读（防误改），目录保持可写（否则下次升级又会失败）
  await shell(`chmod 444 ${REMOTE_JAR} 2>/dev/null`);
  return { ok: true, existed: false, remote: REMOTE_JAR, hint: have > 0 ? 'jar 版本已更新' : '' };
}

/** 列出当前的 displayId 集合，用于差集。 */
/**
 * 读屏 id 列表。
 * **查询失败时返回 null**，而不是空集合——空集和"屏真的没了"无法区分，
 * 早期版本因此把一次 adb 抖动当成"虚拟屏消失"，直接把正常屏拆了重建
 * （复核实测：单次失败 3.6 秒后重建、旧屏上 App 的上下文全丢）。
 */
async function displayIds() {
  const out = await shell(`dumpsys display 2>/dev/null | grep -oE "mDisplayId=[0-9]+" | sort -u`);
  if (!String(out || '').trim() || /error|not found|failed/i.test(String(out))) return null;
  return new Set(out.split('\n').map((s) => s.replace('mDisplayId=', '').trim()).filter(Boolean));
}

async function sfIds() {
  // 不要先 grep 再判空：grep 无匹配时输出为空，和"dumpsys 查询失败"长得一模一样，
  // 于是屏真的没了也会被当成"查询失败"，alive() 保守判活，start() 复用一块死屏，
  // 最后 am start --display 抛 SecurityException（性能测试那路实测踩到）。
  // 现在拿全量输出：只要里面有 Display 行，就说明 dumpsys 正常工作过，
  // 此时"没有 scrcpy 行"= 确实不存在虚拟屏，返回空集合。
  const out = await shell(`dumpsys SurfaceFlinger --display-id 2>/dev/null`);
  const text = String(out || '');
  if (!/Display\s+\d+/.test(text)) return null;   // 一行 Display 都没有 → 查询失败
  const ids = new Set();
  for (const line of text.split('\n')) {
    if (!/scrcpy/i.test(line)) continue;
    const m = line.match(/Display\s+(\d+)/);
    if (m) ids.add(m[1]);
  }
  return ids;   // 空集合 = 确实没有 scrcpy 虚拟屏，不是查询失败
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
  lastShotImgWidth: 0,
  systemDecorations: false,
  launchedPkgs: [],
  // HWC 虚拟屏：部分 Qualcomm 设备的 HWC 支持合成虚拟屏，能让 3D 游戏不再黑屏。
  // hwcPrev 记的是开启前的原值，hwcChanged 表示这次是不是我们改的——只恢复自己改过的。
  hwcPrev: null,
  hwcChanged: false,
};

/** 建一块私有虚拟屏。返回 {ok, displayId, sfId} */
export async function start({ width = 0, height = 0, dpi = 320, systemDecorations = false, orientation, hwc = 'auto' } = {}) {
  // **尺寸自动探测**：不传 width/height 时按物理屏比例生成同比例的虚拟屏。
  // 虚拟屏是合成的（scrcpy new_display），跟物理屏大小无关，但比例会影响 App 的
  // 布局判断（平板/手机模式、横竖屏）。写死 720x1280 在 9:19.4 的屏上窄 25%，
  // 少数 App 会进错布局。默认值从设备真实比例推，换手机也适用。
  if (!width || !height) {
    let pw = 0;
    let ph = 0;
    try {
      const r = await shell('wm size 2>/dev/null');
      const m = String(r || '').match(/(\d+)x(\d+)/);
      if (m) { pw = Number(m[1]); ph = Number(m[2]); }
    } catch { /* 拿不到就用兜底 */ }
    if (pw > 0 && ph > 0) {
      // 宽度基准 720，长边不超过 1600（太高的屏会拖慢截图和编码）
      const scale = Math.min(720 / pw, 1600 / ph);
      width = Math.max(320, Math.round(pw * scale));
      height = Math.max(320, Math.round(ph * scale));
    } else {
      width = 720; height = 1280;
    }
  }

  // 处理 orientation 参数：landscape 时自动交换宽高
  let finalWidth = width;
  let finalHeight = height;
  if (orientation === 'landscape') {
    // 横屏：确保宽 > 高
    if (width < height) {
      finalWidth = height;
      finalHeight = width;
    }
  } else if (orientation === 'portrait') {
    // 竖屏：确保高 > 宽
    if (width > height) {
      finalWidth = height;
      finalHeight = width;
    }
  }
  // 如果 orientation 是具体数值（旋转角度），这里暂时不处理，
  // 因为 scrcpy new_display 不直接支持旋转参数，只支持尺寸。
  // 旋转由 App 自己根据屏幕尺寸判断（横屏 App 看到宽>高的屏会自动横屏）。
  if (state.displayId) {
    if (state.systemDecorations === systemDecorations && await alive()) {
      // 复用分支以前不返回 canHost/flags，tools.js 把它当 false，
      // 于是第二次 vdisplay_start 会误报"不能托管 App"，让 AI 放弃一个正常屏。
      const fl = await shell(`dumpsys display 2>/dev/null | grep "DisplayDeviceInfo.*scrcpy" | head -1`);
      return {
        ok: true, displayId: state.displayId, sfId: state.sfId, reused: true,
        width: state.width, height: state.height,
        canHost: /FLAG_OWN_CONTENT_ONLY/.test(fl) && /FLAG_OWN_FOCUS/.test(fl),
        flags: (fl.match(/FLAG_[A-Z_]+/g) || []).join(' '),
      };
    }
    // 走到这里说明：要么装饰设置变了要重建，要么记着有屏但实际已经没了
    // （server 被回收 / adb 断开 / 被 pkill）。清干净重来，别继续报"已就绪"骗调用方。
    forget('旧屏配置变化或已失效，重建');
  }

  const jar = await ensureJar();
  if (!jar.ok) return { ok: false, hint: jar.hint };

  // 权限前提：shell 必须有 ADD_TRUSTED_DISPLAY（本机有，Pixel 没有）
  const perm = await shell(`dumpsys package com.android.shell 2>/dev/null | grep -c "ADD_TRUSTED_DISPLAY: granted=true"`);
  if (Number(perm.trim()) === 0) {
    return { ok: false, hint: '这台机器的 com.android.shell 没有 ADD_TRUSTED_DISPLAY 权限，私有虚拟屏起不来（scrcpy 官方 issue #5523）。这条路只在一部分机型上可用。' };
  }

  // displayIds/sfIds 查询失败会返回 null，这里兜底成空集合（start 时还没有旧屏可比）
  const before = (await displayIds()) || new Set();
  const beforeSf = (await sfIds()) || new Set();

  // scid 会被 scrcpy 用 Integer.parseInt(radix 16) 解析，必须是**有符号 32 位**内的正整数。
  // 用 0xffffffff 随机会得到 cd7bccd6 这种超范围值，server 直接 NumberFormatException 退出（踩过）。
  // ---- HWC 虚拟屏（让 3D 游戏不再黑屏）----
  // 背景：虚拟屏默认走 GPU 软件合成，SurfaceView 拿不到硬件叠加层 → 3D 游戏全黑。
  // 实测 REDMAGIC NX809J（Adreno 8 Gen 3）：vendor.display.vds_allow_hwc=1 但
  // debug.sf.enable_hwc_vds=0，把它置 1 后王者荣耀在虚拟屏正常渲染。
  //
  // 这是**全局** SurfaceFlinger 属性，会影响整台设备，所以：
  //   1. 只在硬件声明支持（vds_allow_hwc=1）时才开，不盲开；
  //   2. 记下原值，stop() 时只恢复我们自己改过的那种；
  //   3. 任何一步失败都静默降级，不能因为开不了 HWC 就建不了屏。
  // 它是 debug.* 属性，重启设备自动复原，不会留下永久改动。
  if (hwc !== 'off') {
    const allow = (await shell('getprop vendor.display.vds_allow_hwc')).trim();
    if (allow === '1' || hwc === 'on') {
      const prev = (await shell('getprop debug.sf.enable_hwc_vds')).trim() || '0';
      state.hwcPrev = prev;
      if (prev !== '1') {
        await shell('setprop debug.sf.enable_hwc_vds 1');
        const now = (await shell('getprop debug.sf.enable_hwc_vds')).trim();
        state.hwcChanged = now === '1';
      }
    }
  }

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
    // vd_system_decorations=false（scrcpy ≥3.1）：不加这个，虚拟屏上会自带
    // 二级桌面 launcher、导航栏和权限弹窗——AI 截图会把这些系统 UI 一起截进去，
    // 以为是自己要操作的界面。实测关掉后屏上窗口数=0，画面干净。
    + `log_level=info tunnel_forward=true display_ime_policy=hide vd_system_decorations=${systemDecorations ? 'true' : 'false'} new_display=${finalWidth}x${finalHeight}/${dpi} `
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

  // 这个固定等待**不能省**：试过改成"能连上就往下走"，结果连太早 server 还没准备完，
  // 屏建不出来（实测 10.6 秒后失败）。1800ms 是 server 初始化 + new_display 的时序要求。
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
    if (!now) { await sleep(300); continue; }   // 查询失败这一轮跳过，别误判成屏没出来
    const added = [...now].filter((d) => !before.has(d));
    if (added.length) {
      state.displayId = added[0];
      state.width = finalWidth; state.height = finalHeight;
      state.systemDecorations = systemDecorations;
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
    if (!nowSf) { await sleep(300); continue; }
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
    width: state.width, height: state.height,
    flags: (flags.match(/FLAG_[A-Z_]+/g) || []).join(' '),
    // HWC 是否生效：true 表示这次的屏有硬件合成，3D 游戏能正常渲染
    hwc: state.hwcChanged || state.hwcPrev === '1',
  };
}

/**
 * **同步**把 HWC 属性恢复原值。只给进程退出钩子用 —— 那里不能 await。
 *
 * 为什么必须有：debug.sf.enable_hwc_vds 是全局 SurfaceFlinger 属性，
 * 开着的时候整台设备的合成策略都变了。正常路径 stop() 会恢复它，
 * 但守护进程被 SIGKILL / OOM 杀掉时 stop() 根本不会执行 ——
 * 属性就永远停在 1，直到手机重启。
 *
 * SIGKILL 抓不到，所以这个函数也只能覆盖 SIGTERM/正常退出。
 * 但对 OOM 和时间超时这两种最常见的情况是有效的。
 */
export function restoreHwcSync() {
  if (!state.hwcChanged) return false;
  let target = process.env.ADB_TARGET || '127.0.0.1:5555';
  try {
    const dir = process.env.DSH_ADB_STATE_DIR
      || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugin-adb');
    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const port = Number(st?.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) target = `127.0.0.1:${port}`;
  } catch { /* 读不到就用默认回环地址 */ }

  const ADBBIN = process.env.ADB_BIN || 'adb';
  try {
    execFileSync(ADBBIN, ['-s', target, 'shell',
      `setprop debug.sf.enable_hwc_vds ${state.hwcPrev || '0'}`], { timeout: 5000 });
    state.hwcChanged = false;
    return true;
  } catch {
    return false;
  }
}

/** 销毁虚拟屏。 */
export async function stop({ forceStopApps = false } = {}) {
  const pkgList = [...(state.launchedPkgs || [])];
  const killed = [];
  // 默认**不杀**投过的 App：里面有可能是 DSH、Shizuku、微信这类不能随便杀的。
  // 需要清后台时调用方显式传 forceStopApps:true，并且自己判断这个包该不该杀。
  if (forceStopApps) {
    for (const pkg of pkgList) {
      // 硬保护：这些包杀了会直接影响用户（DSH 就是当前 App 本身）
      if (/^(io\.github\.ccch1mneyyy\.dsh_app|moe\.shizuku\.)/.test(pkg)) continue;
      await shell(`am force-stop ${pkg}`);
      killed.push(pkg);
    }
  }
  // 逐个包判断：以前只要有一个命中就把整个列表都报成"还在跑"（复核实测）。
  const still = [];
  for (const pkg of pkgList) {
    // 用 pidof 精确匹配进程名：grep 子串会命中同类包
    // （实测 com.android.settings 已 force-stop，却因为命中
    //   com.android.settings.intelligence 而误报"仍在后台"）。
    const pid = await shell(`pidof ${pkg} 2>/dev/null || true`);
    if (String(pid || '').trim()) still.push(pkg);
  }
  const scid = state.scid;
  if (scid) await shell(`pkill -f '${scid}' 2>/dev/null`);
  // 清掉本次用的 adb forward：以前从不清，复核实测攒了 9 条残留。
  if (state.port) await adb(['forward', '--remove', `tcp:${state.port}`], 10000).catch(() => {});
  // 不能用 --remove-all：那会删掉别的插件（比如 web_* 的 CDP）的 forward。只删自己那条。
  for (const sk of state.sockets || []) { try { sk?.destroy(); } catch { /* ignore */ } }
  if (state.child) { try { state.child.kill('SIGKILL'); } catch { /* ignore */ } }
  // 恢复 HWC 属性。只恢复这次由我们改成的那个值——
  // 如果开机时它本来就是 1，说明用户或别的工具故意开着，我们不去动它。
  if (state.hwcChanged) {
    await shell(`setprop debug.sf.enable_hwc_vds ${state.hwcPrev || '0'}`);
    state.hwcChanged = false;
  }
  state.hwcPrev = null;
  state.sockets = [];
  state.child = null;
  state.displayId = null; state.sfId = null; state.scid = null; state.port = null;
  state.lastShotHash = null; state.lastShotPath = null;
  state.lastShotImgWidth = 0;   // 不清的话 stop→start 后坐标换算会用上旧宽度（偏 44%）
  state.launchedPkgs = [];
  return {
    ok: true,
    killed,
    stillRunning: still,
    hint: still.length
      ? `虚拟屏已销毁。这些 App 仍在后台运行：${still.join('、')}。如果要清掉，下次 stop 时传 forceStopApps:true（DSH 和 Shizuku 会被跳过）。`
      : '虚拟屏已销毁，没有需要清理的后台 App。',
  };
}

/**
 * 虚拟屏是不是**真的**还活着。
 * 只看 state.displayId 会撒谎：server 被系统回收、adb 断开、用户手动 pkill 之后，
 * state 里还留着旧的 displayId，于是 status 报"运行中"、start 报"已就绪"、
 * shot 报原始的 "Display Id is not valid"（复核实测踩到）。
 * 这里用两个客观信号交叉验证：屏还在不在 displayIds 里、SF id 还在不在 sfIds 里。
 */
/**
 * 重新解析当前 scrcpy 虚拟屏的 SurfaceFlinger display id。
 *
 * 为什么需要：屏幕一转向（游戏强制横屏就会），SurfaceFlinger 会**重建**这块虚拟屏
 * 并分配一个新的 SF display id，而逻辑 displayId 保持不变。实测证据：
 *
 *   逻辑 id 110 / 空屏   → SF …8400646736，图层 0，截图 0% 非黑
 *   逻辑 id 110 / MC 起  → SF …9638300942，图层 4，截图 95.45% 非黑
 *   逻辑 id 110 / 转屏后 → SF 换新，缓存里的旧 id 不在列表里
 *
 * 早期版本把「缓存的 sfId 不在列表里」当成「屏已死」，于是每次截图都 forget() 杀掉
 * scrcpy server 再重建一块空屏，结果永远是全黑——**根本不是 3D 渲染不出来**。
 *
 * @returns {Promise<string|null>} 唯一确定的 scrcpy SF id；0 个或多个时返回 null
 */
async function resolveScrcpySfId() {
  const out = await shell(`dumpsys SurfaceFlinger --display-id 2>/dev/null | grep scrcpy`);
  if (!String(out || '').trim()) return null;
  const ids = [];
  for (const line of String(out).split('\n')) {
    // 形如：Display 11529215048987737530 (Virtual display): displayName="scrcpy"
    const m = line.match(/Display\s+(\d+).*scrcpy/);
    if (m) ids.push(m[1]);
  }
  if (ids.length !== 1) return null;   // 多个时分不清，宁可不更新
  return ids[0];
}

/** 确保 state.sfId 是当前有效的；变了就更新，**不重建屏**。 */
async function refreshSfId() {
  if (!state.sfId) { const r = await resolveScrcpySfId(); if (r) state.sfId = r; return state.sfId; }
  const cur = await resolveScrcpySfId();
  if (!cur) return state.sfId;              // 查不到（可能刚好在转屏瞬间）→ 先用旧的
  if (cur !== state.sfId) {
    state.sfId = cur;                       // 转屏导致 id 变了 → 更新即可，不要杀 server
  }
  return state.sfId;
}

async function alive() {
  if (!state.displayId) return false;
  const [ids, sf] = await Promise.all([displayIds(), sfIds()]);
  // null = 查询失败（adb 抖动），不能据此判定屏没了 → 保守认为还活着
  if (!ids || !sf) return true;
  const hasDisplay = ids.has(String(state.displayId));
  if (!hasDisplay) return false;                 // 逻辑屏真没了 → 确实死了
  if (state.sfId && sf.has(String(state.sfId))) return true;   // 缓存的 SF id 还有效
  // 逻辑屏在、但缓存的 SF id 不在列表里 → **多半是转屏换了 id**，重新解析而不是判死
  const fresh = await resolveScrcpySfId();
  if (fresh) { state.sfId = fresh; return true; }
  return false;
}

/** 状态不一致时，把内存状态清干净，免得后面每个工具都报假消息。 */
function forget(reason) {
  const dead = { displayId: state.displayId, sfId: state.sfId, port: state.port };
  try { state.child?.kill('SIGKILL'); } catch { /* ignore */ }
  for (const sk of state.sockets || []) { try { sk?.destroy(); } catch { /* ignore */ } }
  state.child = null; state.sockets = [];
  state.displayId = null; state.sfId = null; state.scid = null; state.port = null;
  state.lastShotHash = null; state.lastShotPath = null; state.lastShotImgWidth = 0;
  state.systemDecorations = false;
  return { ...dead, reason };
}

/** 取虚拟屏上当前前台 App 的窗口串（胶囊用来显示"AI 在操作 XX"）。 */
export async function focusedApp() {
  if (!state.displayId) return '';
  const r = await shell(`dumpsys window displays 2>/dev/null | grep -A30 "mDisplayId=${state.displayId}" | grep -m1 mCurrentFocus`);
  return String(r || '').trim();
}

export async function status() {
  const ids = await displayIds();
  const sf = await sfIds();
  const app = state.displayId ? await shell(`dumpsys window displays 2>/dev/null | grep -A20 "mDisplayId=${state.displayId}" | grep -m1 mCurrentFocus`) : '';
  return {
    running: await alive(),
    displayId: state.displayId,
    sfId: state.sfId,
    uptimeSec: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
    width: state.width, height: state.height,   // 转屏后这两个值会变，坐标空间跟着变
    allDisplays: ids ? [...ids].sort((a, b) => a - b) : null,   // null 表示查询失败，不是没有屏
    scrcpyScreens: sf ? [...sf] : null,
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
  if (!state.launchedPkgs.includes(pkg)) state.launchedPkgs.push(pkg);
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
  // **绝对不对主屏做任何操作。**
  // 以前这里会在"判定主屏被抢"时跑 monkey 把原来的 App 拉回来，
  // 但那个判定在"用户自己在这 2 秒里切了 App"时会误判——于是插件反过来
  // 用 monkey 改了用户的主屏，比它要防的问题更打扰人（复核实测踩到）。
  // 现在只观察、只报告，让调用方决定。
  const mainChanged = bothKnown && mainAfter !== mainBefore;
  const restored = false;

  return {
    ok: landedOnVd && !restored,
    displayId: state.displayId,
    landedOnVd,
    mainFocusBefore: mainBefore,
    mainFocusAfter: mainAfter,
    mainChanged,
    restoredMain: false,
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
/**
 * 往 scrcpy 的控制 socket 发一条控制消息。
 *
 * 为什么值得做：现在所有输入都走 `adb shell input`，那条路对中文必抛 NPE
 * （实测 `input text 中文` → java NPE），而且每次起一个子进程要 30–50ms。
 * scrcpy 的控制通道支持 SET_CLIPBOARD，实测设置页能粘进 `abc中文测试abc`，
 * 所以中文输入的正解是「写剪贴板 → KEYCODE_PASTE」。
 *
 * SET_CLIPBOARD 报文（scrcpy 5.x）：
 *   type=9 (1B) | sequence (8B i64) | paste (1B bool) | length (4B i32) | text (utf8)
 */
function sendControl(buf) {
  const ctl = state.sockets?.[1];
  if (!ctl || ctl.destroyed) return false;
  try { ctl.write(buf); return true; } catch { return false; }
}

let clipSequence = 0;

/** 把文字写进设备剪贴板。返回是否发成功。 */
export function setClipboard(text) {
  const body = Buffer.from(String(text ?? ''), 'utf8');
  const buf = Buffer.alloc(1 + 8 + 1 + 4 + body.length);
  let off = 0;
  buf.writeUInt8(9, off); off += 1;              // TYPE_SET_CLIPBOARD
  clipSequence += 1;
  buf.writeBigInt64BE(BigInt(clipSequence), off); off += 8;
  buf.writeUInt8(1, off); off += 1;              // paste = true（让设备侧标记为可粘贴）
  buf.writeInt32BE(body.length, off); off += 4;
  body.copy(buf, off);
  return sendControl(buf);
}

async function frameHash() {
  // 必须刷新 SF id：转屏后旧 id 失效，两次 screencap 都失败会让 before/after 都为 null，
  // 于是 changed 变 null、调用方看到 ok=true —— **校验被静默关闭**（监督复核指出的高危项）。
  await refreshSfId();
  if (!state.sfId) return null;
  const capOnce = async () => {
    const r = await adb(['exec-out', 'screencap', '-p', '-d', String(state.sfId)], 20000);
    return r.ok && r.out ? r.out : null;
  };
  let buf = await capOnce();
  if (!buf) { await refreshSfId(); buf = await capOnce(); }   // 卡在转屏瞬间时重试一次
  if (!buf) return null;
  const { createHash } = await import('node:crypto');
  return createHash('sha1').update(buf, 'utf8').digest('hex');
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
  // 三种坐标写法，优先级从高到低：
  //   nx/ny（0..1）  —— 最稳，永远对
  //   x/y            —— **按"上一次截图里的像素"理解**，自动放大到显示坐标
  //   都没给         —— (0,0)
  //
  // 为什么要换算 x/y：截图默认是 540 宽，而显示是 720x1280。
  // 实测照图片像素直接传会系统性偏 33%（点放大镜画面零变化）。
  const imgW = state.lastShotImgWidth || state.width;
  const scale = imgW > 0 ? state.width / imgW : 1;
  const toX = () => (a.nx !== undefined && a.nx !== null)
    ? Math.round(Number(a.nx) * state.width)
    : Math.round((Number(a.x) || 0) * scale);
  const toY = () => (a.ny !== undefined && a.ny !== null)
    ? Math.round(Number(a.ny) * state.height)
    : Math.round((Number(a.y) || 0) * scale);

  if (kind === 'tap') cmd = `input -d ${d} tap ${toX()} ${toY()}`;
  else if (kind === 'swipe') cmd = `input -d ${d} swipe ${toX()} ${Math.round((Number(a.y1)||0)*scale)} ${Math.round((Number(a.x2)||0)*scale)} ${Math.round((Number(a.y2)||0)*scale)} ${Number(a.ms) || 300}`;
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
  else if (kind === 'paste') {
    // 两种用法，行为不同：
    //  带 text  → 发 SET_CLIPBOARD(paste=1)，**server 自己会粘一次**，不能再补 keyevent，
    //             否则内容会粘两遍（复核实测：ZQ中文 → ZQ中文ZQ中文）。
    //  不带 text → 发 KEYCODE_PASTE，粘设备剪贴板里现有的内容。
    //
    // 注意：剪贴板是系统全局的，写它就是覆盖用户自己的剪贴板内容。
    if (a.text !== undefined && a.text !== null && String(a.text) !== '') {
      if (!setClipboard(String(a.text))) {
        return { ok: false, hint: '写剪贴板失败（控制通道没连上）。可以改用 kind:"text"（仅 ASCII）。' };
      }
      await sleep(300);   // SET_CLIPBOARD 已经连带粘贴，等它生效即可
      cmd = null;         // 不再补 keyevent
    } else {
      cmd = `input -d ${d} keyevent 279`;   // KEYCODE_PASTE：粘现有剪贴板
    }
  }
  else return { ok: false, hint: `不认识的输入类型：${kind}` };

  const verify = a.verify !== false;
  const before = verify ? await frameHash() : null;
  // SET_CLIPBOARD 那条路 cmd 是 null（server 已经自己粘过，不能再发 keyevent）
  const out = cmd ? await shell(cmd) : '（SET_CLIPBOARD 已连带粘贴）';
  if (!verify) return { ok: true, displayId: d, out: out.trim(), changed: null };

  await sleep(Number(a.settleMs) || 500);
  let after = await frameHash();
  let changed = before && after ? before !== after : null;

  // 只查一次会误报。实测：给虚拟屏发 KEYCODE_BACK 退掉设置页，
  // 画面确实变了（随后截是纯黑），但 500ms 那个时间点还没变完，
  // 于是返回 changed:false —— AI 会以为没生效、重复操作，造成双击这类事故。
  // 所以没变的时候再轮询几次，任一次变了就算生效。
  if (changed === false) {
    for (let i = 0; i < 4 && changed === false; i += 1) {
      await sleep(400);
      const again = await frameHash();
      if (before && again && again !== before) {
        after = again;
        changed = true;
      }
    }
  }

  return {
    ok: changed !== false,          // 轮询完还是没变，才算这次操作大概率没生效
    displayId: d,
    changed,
    hint: changed === false
      ? '画面在 2 秒内一直没有变化，这一下可能真的没生效（坐标偏了 / 控件不可点 / 界面还没加载完）。建议重新截一张图确认位置，不要盲目重复点同一坐标。'
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

  // **截图前先刷新 SF id**：转屏会让 SurfaceFlinger 重建虚拟屏并换新 id，
  // 拿旧 id 去 screencap 会报 "Display Id is not valid"（或静默截到别的屏）。
  await refreshSfId();
  if (!state.sfId) return { ok: false, hint: '没拿到这块屏的 SurfaceFlinger id，无法截图。' };

  // 只截一次：以前先用 exec-out 算哈希、再 screencap 存文件，同一帧截了两次，
  // 复杂画面每张多花约 0.5 秒。现在截一次、哈希从本地文件算。
  const stamp = Date.now();
  const local = `${dir}/vd-${stamp}.png`;
  const remotePng = `/sdcard/dsh-vd-${stamp}.png`;
  const cap = await shell(`screencap -p -d ${state.sfId} ${remotePng}`);
  if (/Failed|invalid/i.test(cap)) {
    // 可能刚好卡在转屏瞬间：强制重新解析（不沿用旧值）再试一次
    const fresh = await resolveScrcpySfId();
    if (fresh) state.sfId = fresh;
    const cap2 = await shell(`screencap -p -d ${state.sfId} ${remotePng}`);
    if (/Failed|invalid/i.test(cap2)) {
      return {
        ok: false,
        hint: `截图失败：${cap2}\n当前缓存的 SF id=${state.sfId}，重新解析${fresh ? '得到 ' + fresh : '失败（没有 scrcpy 屏，或同时存在多块分不清）'}。`
          + '\n可能虚拟屏已被销毁。可以先 vdisplay_status 确认，再 vdisplay_start 重建。',
      };
    }
  }

  const pull = await adb(['pull', remotePng, local], 60000);
  await shell(`rm -f ${remotePng}`);
  if (!pull.ok) return { ok: false, hint: `拉取失败：${pull.err}` };

  const { readFile: readBin } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const pngBytes = await readBin(local);
  const hash = createHash('sha1').update(pngBytes).digest('hex');

  // 从 PNG 的 IHDR 读真实像素尺寸（宽高在字节 16..24，大端 32 位）。
  // 为什么必须做：游戏强制横屏后这块屏会变成 1280x720，
  // 如果坐标换算还按 720x1280 算，nx/ny 和 x/y 全都会错。
  try {
    if (pngBytes.length > 24 && pngBytes.readUInt32BE(12) === 0x49484452 /* 'IHDR' */) {
      const w = pngBytes.readUInt32BE(16);
      const h = pngBytes.readUInt32BE(20);
      if (w > 0 && h > 0 && (w !== state.width || h !== state.height)) {
        state.width = w;
        state.height = h;
        state.lastShotHash = null;    // 尺寸变了，旧的去重基准作废
        state.lastShotPath = null;
        state.lastShotImgWidth = 0;   // 旧的图片宽度也作废，否则坐标换算倍率会错
      }
    }
  } catch { /* 读不出来就沿用旧值 */ }
  if (hash === state.lastShotHash && state.lastShotPath && state.lastShotPath !== local) {
    // 和上一张完全一样：删掉刚截的，复用上次那张，省一次模型看图
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(local);
      return { ok: true, path: state.lastShotPath, displayId: state.displayId, unchanged: true, hint: '画面和上次截图完全一样，同一张图可直接复用，不用再看一次。' };
    } catch { /* 删不掉就继续用新的 */ }
  }

  // 转成 540 宽 JPEG。**必须用本地 proot 的 ffmpeg**：设备上没有 ffmpeg
  // （实测 `adb shell ffmpeg` → inaccessible or not found）。
  let finalPath = local;
  // 记录**实际**产出的图片宽度：转码失败会退回原始 PNG（720 宽），
  // 这时如果还按 540 报，坐标换算的倍率就错了，33% 偏移会重新出现
  // （复核实测：PATH 去掉 ffmpeg 后返回 720 宽 PNG 却声明 imageWidth 540）。
  let finalImgWidth = state.width;
  if (format === 'jpeg') {
    const jpg = local.replace(/\.png$/, '.jpg');
    const targetW = Math.max(240, Math.min(1080, Number(width) || 540));
    const conv = await new Promise((res) => {
      execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', local, '-vf', `scale=${targetW}:-1`, '-q:v', '4', jpg],
        (e) => res(!e));
    });
    if (conv) {
      try {
        const { access } = await import('node:fs/promises');
        await access(jpg);
        finalPath = jpg;
        finalImgWidth = targetW;
      } catch { finalPath = local; finalImgWidth = state.width; }
    } else {
      finalPath = local;
      finalImgWidth = state.width;   // 退回 PNG，宽度就是显示宽度
    }
  }
  state.lastShotHash = hash;
  state.lastShotPath = finalPath;
  state.lastShotImgWidth = finalImgWidth;
  return {
    ok: true, path: finalPath, displayId: state.displayId, unchanged: false,
    // **一定要带尺寸**：之前完全不返回，调用方只能猜坐标系。
    // 注意分清两个尺寸：imageWidth/imageHeight 是**你正在看的这张图**的像素，
    // width/height 是显示的逻辑像素。点 x/y 时按图片像素给就行（插件会自动换算）。
    width: state.width, height: state.height,
    imageWidth: state.lastShotImgWidth || state.width,
    imageHeight: Math.round(state.height * ((state.lastShotImgWidth || state.width) / state.width)),
    hint: `这张图是 ${state.lastShotImgWidth || state.width} 宽，显示逻辑尺寸 ${state.width}x${state.height}。`
      + '点 x/y 按图片里的像素给即可（插件自动换算），或者直接用 nx/ny（0..1）。',
  };
}

/** 主屏截图（只读，不打扰）。 */
export async function mainShot(dir = '/tmp') {
  await mkdir(dir, { recursive: true });
  const remote = `/sdcard/dsh-main-${Date.now()}.png`;
  await shell(`screencap -p ${remote}`);
  const local = join(dir, `main-${Date.now()}.png`);
  // 这里以前写成了 remotePng（未定义），导致这个工具 100% 抛 ReferenceError，
  // 而且报错前已经在设备上留了一个 1.7MB 的 PNG。
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
