#!/usr/bin/env node
/**
 * vdisplayd —— 虚拟屏守护进程。
 *
 * 为什么必须有它：虚拟屏跟"建它的那个进程"同生共死（scrcpy server 一断，
 * DisplayManager 就把屏销毁）。CLI 每次调用都是新进程，进程一退屏就没了，
 * 所以 `vdisplay shot` 这种一次性命令根本没法工作。
 *
 * 做法：常驻一个进程，把屏握在手里，CLI 通过回环 HTTP 发命令进来。
 * 这套东西不依赖 DSH，任何 agent（Claude Code / opencode / Codex）用 bash
 * 调 CLI 就能用。
 *
 * 发现机制：把 {pid, port} 写到 $DSH_HOME/plugin-screen/cli-daemon.json，
 * CLI 读这个文件找到守护进程。
 */


import('./../src/stream.js').then(m => m.reconcileStreamState()).catch(() => {});
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, unlink, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import * as vd from '../src/vd.js';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const STATE_DIR = join(DSH_HOME, 'plugin-screen');
const STATE_FILE = join(STATE_DIR, 'cli-daemon.json');

// 没屏、也没人调命令时，闲置这么久就自己退掉，不留垃圾进程
const IDLE_EXIT_MS = 10 * 60 * 1000;

let lastActive = Date.now();
let server = null;

async function writeState(port) {
  await mkdir(STATE_DIR, { recursive: true });
  // 原子写：先写临时文件再 rename。直接 writeFile 会留一个"读得到半截 JSON"的窗口，
  // CLI 那边解析失败会当成"没守护进程"而再拉一个 —— 冷启动并发时会雪崩。
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }, null, 2));
  await rename(tmp, STATE_FILE);
}

/**
 * 清状态文件。**只删自己写的那一份**。
 *
 * 不加这个校验的话，两个实例并存时（冷启动竞态真的会发生），
 * 先退出的那个会把另一个的 state 删掉，对方就变成"活着但隐身"的幽灵进程。
 */
async function clearState() {
  try {
    const cur = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    if (cur?.pid && cur.pid !== process.pid) return;   // 不是自己的，别动
  } catch { /* 文件不存在或读不了，那就删 */ }
  try { await unlink(STATE_FILE); } catch { /* 没有就算了 */ }
}

/** 命令分发。每个 action 都是 vd.js 里的一个函数。 */
let mutexTail = Promise.resolve();   // 全局互斥链，串行化有副作用的命令

/** **有写操作正在跑。** tick 的看门狗阶段要跳过 —— 一次 start 要跑 60 秒，
 *  期间 framesrv 还没监听是正常的，不能判死（否则重复 spawn 出两个 framesrv）。
 *  必须是模块作用域的：ACTIONS 里的 start 要用它。 */
let opBusy = 0;
/** 上次起推流成功的时刻。**必须模块作用域** —— ACTIONS.start 里要赋值，
 *  写在 startIdleWatch 内部的话，模块级赋值会抛 ReferenceError 被 catch 吞掉，
 *  60 秒宽限期永远读到 0 = 从来没生效（2026-11-22 复核抓到的同型复发）。 */
let lastStreamStartAt = 0;

/**
 * **拿全局互斥锁跑一段代码 —— tick 里的自动重建也必须走这里。**
 *
 * 2026-11-22 独立复核抓到的 P0：tick 的「屏空了自动重建」直接调 `T.start()`，
 * 既没取 `mutexTail` 也没 `opBusy++`。`ticking` 只能挡住「tick 撞 tick」，
 * 挡不住「tick 重建」撞「客户端 POST /cmd {action:start}」。
 *
 * 后果和之前那些一样：两个 start 并发 → 都看到 displayId 为空 → 各建一块屏
 * → `resolveScrcpySfId()` 分不清哪块是哪块 → 所有截图报歧义。
 * 这正是 mutex 存在的理由，tick 不该绕过它。
 *
 * @param {Function} fn 要执行的异步函数
 * @param {number} waitMs 最多等多久拿锁
 * @returns {{ok:boolean, value?:any, error?:string, timeout?:boolean}}
 */
async function withLock(fn, waitMs = 90_000) {
  const prev = mutexTail;
  let release;
  let acquired = false;
  mutexTail = new Promise((r) => { release = r; });
  try {
    let timer = null;
    const timeoutP = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), waitMs);
      if (timer.unref) timer.unref();
    });
    const got = await Promise.race([prev.then(() => 'ok'), timeoutP]);
    if (timer) clearTimeout(timer);
    if (got === 'timeout') {
      // 超时不破坏互斥：release 挂到前一个 tail 上，链条按原顺序继续
      Promise.resolve(prev).finally(release);
      return { ok: false, timeout: true, error: '等锁超时（' + Math.round(waitMs / 1000) + ' 秒）' };
    }
    acquired = true;
    const value = await fn();
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  } finally {
    if (acquired) release();
  }
}

const ACTIONS = {
  async start(args) {
    /*
     * **三条入口走同一个函数。**
     *
     * 2026-11-22 的教训：daemon 原来自己拼 vd.start() + streamStart，
     * 和插件工具的 T.start() 是两份代码 —— 于是插件能自检、CLI 不能；
     * 插件报「已创建并开始创建悬浮窗」、CLI 只说「已就绪」。
     * 凡是「同一条产品逻辑写两遍」，迟早会漂移，而且用户会先发现。
     *
     * 现在直接调 T.start()：建屏、自动推流、投屏、逐项自检全在里面，
     * 三个入口拿到的是同一份结果、同一段文案。
     */
    const T = await import("../src/tools.js");
    /* **opBusy 必须 try/finally 包住。**
     * 2026-11-22 复核抓到一个泄漏：T.start 一抛异常，opBusy 就永久 >0，
     * 看门狗从此永久跳过判断 —— 而且没有任何日志。
     */
    opBusy++;
    let r;
    try {
      /* **套超时，防止 opBusy 永久卡住。**
       *
       * 2026-11-22 复核指出：T.start 里全是 adb 调用，adbd 卡死或设备过热降频时
       * 可能挂很久；而 opBusy 在 finally 里减 —— 只要 Promise 不 settle，
       * opBusy 就永久 >0，看门狗从此永久跳过所有判断，而且没有任何日志。
       *
       * 5 分钟是宽松上限：正常建屏 60-120 秒，留 2.5 倍余量。
       * 超时不取消底层操作（那会留下半成品），只让调用方拿到明确结果，
       * 让 opBusy 能复位。
       */
      const START_TIMEOUT_MS = 5 * 60 * 1000;
      let stTimer = null;
      const stTimeout = new Promise((resolve) => {
        stTimer = setTimeout(() => resolve(null), START_TIMEOUT_MS);
        if (stTimer.unref) stTimer.unref();
      });
      r = await Promise.race([T.start(args || {}), stTimeout]);
      if (stTimer) clearTimeout(stTimer);
      if (r === null) {
        r = { text: '建屏超时（超过 ' + Math.round(START_TIMEOUT_MS / 1000) + ' 秒还没返回）。'
          + '底层操作可能还在跑，稍后用 status 确认；如果一直这样，重启 daemon。' };
        console.error('[vdisplayd] start 超时');
      }
    } finally {
      opBusy--;
    }
    /* 记下「刚起过推流」。**必须是模块作用域变量** ——
     * 写在 startIdleWatch 内部的话，这里赋值会抛 ReferenceError 被吞掉，
     * 60 秒宽限期永远读到 0 = 从来没生效（同型 bug 第三次）。 */
    if (r && (r.ok || r.text)) lastStreamStartAt = Date.now();
    return r;
  },
  async stop(args) {
    /*
     * **停屏必须连带关掉那块屏的推流和浮窗。**
     *
     * 2026-11-22 实机踩到：CLI/MCP 停屏走的是这里，只调 vd.stop()，
     * 而 tools.js 的 stop() 才有关浮窗的逻辑 —— 于是停掉屏之后，
     * 那块屏的悬浮窗还开着，一直去连一个已经没人监听的端口，
     * 日志里每 3 秒一条 ConnectException，直到用户自己重启 App。
     * 多建几次屏就会攒一堆僵尸窗口。
     *
     * 现在和 tools.js 的清理顺序一致：先关这块屏的浮窗，再停 framesrv，最后销毁屏。
     */
    let streamStopped = false;
    try {
      const T = await import('../src/tools.js');
      // 只关这块屏的窗口，不要全关 —— 用户可能同时开着别的屏
      const disp = vd.getActive?.()?.displayId;
      const stopPort = disp != null ? (T.screenPorts?.get?.(Number(disp)) || 0) : 0;
      try { await T.overlayStop(stopPort || undefined); } catch { /* 窗口可能本来就不在 */ }
      const fsrv = await import('../src/framesrv.js');
      /* **必须传 displayId，否则是全停。**
       * 2026-11-22 对抗审查抓到：`fsrv.stop()` 不传参 = 停掉所有 framesrv
       * （framesrv.js:250 的行为），多屏时「停一块」会把别块屏的推流一起停掉。
       */
      await fsrv.stop(disp != null ? Number(disp) : undefined);
      streamStopped = true;
    } catch { /* 推流本来就没起来就算了 */ }
    const r = await vd.stop({ forceStopApps: args?.forceStopApps === true });
    return { ...r, streamStopped };
  },
  async status() {
    return vd.status();
  },
  async launch(args) {
    const pkg = String(args?.pkg || '').trim();
    if (!/^[a-z][\w.]*$/i.test(pkg)) return { hint: 'pkg 看起来不是合法包名。' };
    return vd.launch(pkg, args?.activity ? String(args.activity).trim() : '');
  },
  async shot(args) {
    const region = args?.region && typeof args.region === 'object' ? args.region : null;
    const frames = Number(args?.frames) || 0;

    // frames > 1 走九格连拍（自适应采样）。以前 daemon 只有单帧，导致命令行用不了这个能力。
    if (frames > 1) {
      const st = await vd.status();
      if (!st.running) return { ok: false, hint: '虚拟屏没在运行，先 start。' };
      const tl = await import('../src/timeline.js');
      return tl.capture({
        sfId: st.sfId,
        frames,
        intervalMs: Number(args?.intervalMs) || 300,
        cellWidth: Number(args?.width) || 262,
        dir: args?.dir || '/tmp',
        crop: 'none',
      });
    }

    return vd.shot(args?.dir || '/tmp', {
      width: Math.min(Math.max(Number(args?.width) || 540, 240), 1080),
      format: args?.format === 'png' ? 'png' : 'jpeg',
      cropPx: 0,
      region,
    });
  },
  async mainShot(args) {
    return vd.mainShot(args?.dir || '/tmp');
  },
  /**
   * 读屏文字。这里加一份是为了 CLI 和 HTTP 也能用 OCR，
   * 顺便让"OCR 到底通不通"可以用真实入口验证 —— 只测模块不算。
   */
  async text(args) {
    const st = await vd.status();
    if (!st.running) return { ok: false, hint: '虚拟屏没在运行，先 start。' };
    const shot = await vd.shot(args?.dir || '/tmp', {
      width: Math.min(1080, Math.max(360, st.width || 720)),
      format: 'png',
    });
    if (!shot.ok) return { ok: false, hint: shot.hint };
    const ocr = await import('../src/ocr.js');
    const r = await ocr.recognize(shot.path, {
      minConf: args?.minConf === undefined ? 0.45 : Number(args.minConf),
      maxLines: Number(args?.maxLines) || 80,
      hash: args?.fresh === true ? null : shot.hash,
    });
    if (!r.ok) return { ok: false, hint: r.hint };
    return { ok: true, ...r, imageWidth: shot.imageWidth || st.width, imageHeight: shot.imageHeight || st.height, path: shot.path };
  },

  /* ===== 多屏池（pool.js） ===== */
  async poolCreate(args) {
    const pool = await import('../src/pool.js');
    const r = await pool.create(args || {});
    if (!r?.ok) return r;
    /*
     * **多屏必须每屏一套推流和浮窗。**
     *
     * 和 start 同一个毛病：插件工具 screen_new 会连带推流，但 daemon 这条只建屏。
     * 用户要求「开多少个就带多少个悬浮窗起来」，从 CLI/MCP 建池屏时一个窗口都没有。
     * 窗口位置由 streamStart 自己按池里第几块屏错开（见 newScreen 的注释）。
     */
    if (args?.overlay === false) return { ...r, stream: { ok: false, detail: '按参数未起浮窗' } };
    let castPkg = '';
    try {
      const T = await import('../src/tools.js');
      /* poolCreate 也要占 opBusy —— 它内部的 streamStart 要等 8 秒端口，
       * tick 每 10 秒一次正好能插进来判死，导致重复 framesrv。 */
      opBusy++;
      let auto;
      try {
        auto = await T.streamStart({ displayId: r.displayId, sfId: r.sfId, overlay: true });
      } finally { opBusy--; }
      lastStreamStartAt = Date.now();
      const txt = String(auto?.text || '');

      /* **池屏也要投个 App，否则浮窗里是黑的。**
       *
       * 2026-11-22 复核抓到：newScreen/poolCreate 只起推流不投屏，
       * 「开多少个就带多少个悬浮窗」满足了，但每个窗里都是空的，要等 AI 自己
       * vdisplay_launch 才有画面 —— 而用户看到的第一眼就是几个黑框。
       * 和 start() 一样挑一个不会打断用户的 App。
       */
      try {
        if (args?.pkg) {
          const lr = await T.launch({ pkg: String(args.pkg), activity: args?.activity });
          castPkg = String(args.pkg);
          void lr;
        } else {
          const pick = await T.pickHomeLike();
          if (pick) { await T.launch({ pkg: pick }); castPkg = pick; }
        }
      } catch { /* 投不上就算了，屏本身是好的 */ }

      return {
        ...r,
        castPkg,
        stream: { ok: /悬浮窗已浮起/.test(txt), detail: txt.split('\n')[0] || '' },
      };
    } catch (e) {
      return { ...r, stream: { ok: false, detail: String(e?.message || e).slice(0, 120) } };
    }
  },
  async poolList() {
    const pool = await import('../src/pool.js');
    return pool.list();
  },
  async poolUse(args) {
    const pool = await import('../src/pool.js');
    return pool.use(String(args?.screenId || ''));
  },
  async poolDestroy(args) {
    const pool = await import('../src/pool.js');
    return pool.destroy(String(args?.screenId || ''), args || {});
  },
  /*
   * **通用工具转发 —— 一次恢复 MCP 里那 19 个「广告了但调不了」的工具。**
   *
   * 2026-11-22：MCP 向宿主列 37 个工具，但 ACTION_MAP 只映射了 17 个，
   * 另外 19 个（视觉/等待/探测类）只活在插件层，daemon 没有对应 action，
   * 一调就报「这个 MCP server 没暴露」——超过一半是坏的。
   *
   * 当时靠「不列出没映射的」止血，但代价是 MCP 只有 18 个工具可用。
   * 正解是让 daemon 能按名字转发到 tools.js 的对应函数：
   *   POST /cmd {"action":"runTool","args":{"tool":"vdisplay_find","args":{...}}}
   *
   * 白名单而不是任意调用 —— 只允许 tool-spec 里真实存在的工具名，
   * 而且只允许 tools.js 里有同名实现的，避免被当成任意代码执行入口。
   */
  async runTool(args) {
    const tool = String(args?.tool || '').trim();
    if (!tool) return { hint: '缺 tool 参数（工具名）' };

    const T = await import('../src/tools.js');
    const SPEC = await import('../src/tool-spec.js');

    // ① 这个名字必须是 tool-spec 里真实声明过的工具
    let known = false;
    for (const k of Object.keys(SPEC)) {
      if (!k.endsWith('Spec') || typeof SPEC[k] !== 'function') continue;
      try { if (SPEC[k]()?.name === tool) { known = true; break; } } catch { /* skip */ }
    }
    if (!known) return { hint: `不认识的工具「${tool}」（不在 tool-spec 里）` };

    // ② 工具名 → tools.js 导出函数名
    const MAP = {
      vdisplay_find: 'findText',
      screen_keepalive: 'keepAlive',
      vdisplay_probe: 'probeScreen',
      screen_risk: 'riskCheck',
      vdisplay_diff: 'screenDiff',
      screen_modes: 'modes',
    };
    const bare = tool.replace(/^vdisplay_|^screen_/, '');
    const guess = bare.split('_').map((x, i) => (i === 0 ? x : x[0].toUpperCase() + x.slice(1))).join('');
    const fnName = MAP[tool] || guess;
    const fn = T[fnName];
    if (typeof fn !== 'function') return { hint: `工具「${tool}」没有可执行实现（找不到 ${fnName}）` };

    // ③ 执行。tools.js 的函数普遍返回 {text} 或 {ok,text}
    try {
      const r = await fn(args?.args || {});
      return { ok: true, result: r };
    } catch (e) {
      return { hint: '执行失败：' + String(e?.message || e).slice(0, 200) };
    }
  },
  /* ===== 租约 ===== */
  async claimApp(args) {
    const lease = await import('../src/lease.js');
    const pool = await import('../src/pool.js');
    const info = pool.info();
    if (!info.active) return { ok: false, code: 'E_NO_SCREEN', hint: '还没有活动屏，先 poolCreate' };
    return lease.claim({
      pkg: String(args?.pkg || ''),
      screenId: args?.screenId ? String(args.screenId) : info.active,
      owner: String(args?.owner || 'unknown'),
      mode: args?.mode, priority: args?.priority,
      preemptible: args?.preemptible,
      nonPreemptibleReason: args?.nonPreemptibleReason,
      onConflict: args?.onConflict || 'fail',
      ttlMs: args?.ttlSec ? Number(args.ttlSec) * 1000 : undefined,
    });
  },
  async releaseApp(args) {
    const lease = await import('../src/lease.js');
    if (args?.leaseId) return lease.release(String(args.leaseId));
    return lease.releaseAll(String(args?.owner || 'unknown'));
  },
  async leasesList() {
    const lease = await import('../src/lease.js');
    return lease.list();
  },

  async checkApp(args) {
    // 占用检测：主屏谁在用、自家屏上有没有、有没有外来屏
    const occ = await import('../src/occupancy.js');
    const pool = await import('../src/pool.js');
    const info = pool.info();
    const ourScreens = new Map(info.screens.map((s) => [Number(s.displayId), s.screenId]));
    return occ.checkApp(String(args?.pkg || ''), { ourScreens });
  },

  async poolInfo() {
    const pool = await import('../src/pool.js');
    return pool.info();
  },

  async apps() {
    // 投屏前查包名。之前没有任何工具能给包名，模型只能猜。
    const r = await vd.adb(['shell', 'pm list packages -3 2>/dev/null']);
    if (!r.ok) return { ok: false, hint: r.err || 'adb 不可用' };
    const pkgs = String(r.out || '').split('\n')
      .map((x) => x.trim().replace(/^package:/, '')).filter(Boolean).sort();
    return { ok: true, count: pkgs.length, packages: pkgs };
  },

  async focusedApp() {
    return { app: await vd.focusedApp() };
  },
  async mainFocus() {
    return { app: await vd.mainFocus() };
  },
  async input(args) {
    const kind = String(args?.kind || '');
    /* multitouch 也要在名单里 —— 2026-11-23 审查抓到漏了它，MCP 路径直接拒 */
    if (!['tap', 'swipe', 'hold', 'multitouch', 'text', 'key', 'paste'].includes(kind)) {
      return { hint: `不认识的输入类型「${kind}」。可选：tap / swipe / hold / text / key / paste` };
    }
    return vd.input(kind, args);
  },
};

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handle(req, res) {
  lastActive = Date.now();

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, pid: process.pid });
  }
  if (req.method !== 'POST' || req.url !== '/cmd') {
    return send(res, 404, { error: 'not found' });
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'body 不是合法 JSON' }); }

  const fn = ACTIONS[payload.action];
  if (!fn) {
    return send(res, 400, { error: `不认识的 action「${payload.action}」`, available: Object.keys(ACTIONS) });
  }

  /*
   * **有副作用的命令必须串行。**
   *
   * 为什么：vd.js 的 state 是模块级单例，而 start() 从「判空」到「写 displayId」
   * 中间有好几段 await（推 jar、spawn server、等 socket）。两个 MCP 客户端同时
   * 发 start，两边都看到 displayId 为空，就会各建一块屏 —— 而设备上有多块 scrcpy
   * 屏时 resolveScrcpySfId() 会分不清，之后所有截图都报歧义。
   *
   * 只读命令（status/focusedApp/mainFocus）不加锁，保持并发。
   */
  const MUTATING = new Set(['start', 'stop', 'launch', 'input', 'shot', 'mainShot', 'text',
  // 池操作会切换全局活动上下文，必须串行，否则两个请求会互相切走
  'poolCreate', 'poolUse', 'poolDestroy',
  // 租约也改全局状态（可能撤销别人的），必须串行
  'claimApp', 'releaseApp']);
  const run = async () => {
    try {
      const out = await fn(payload.args || {});
      return send(res, 200, { ok: true, result: out });
    } catch (e) {
      return send(res, 500, { ok: false, error: e?.message || String(e) });
    }
  };

  if (!MUTATING.has(payload.action)) return run();

    /* single-flight：一把全局锁，后来的排队。
     *
     * **但排队必须有上限。** 2026-11-22 用户报「你也会说卡住了」，根因就在这：
     * 一次 start 要跑十几个 adb 调用（推 jar、spawn、等 socket、投 App、六项自检），
     * 正常也要 60-120 秒；期间所有其他写操作（input/shot/launch/stop）全在这里死等，
     * 而 `await prev` 没有超时 —— 前一个卡住就全卡住。
     *
     * 表现：AI 调一个 input 等两分钟不返回，看起来就是「工具挂了」。
     *
     * 现在给排队本身设上限：等太久就明确返回「前面有操作在跑，稍后重试」，
     * 而不是无声挂着。宁可让调用方知道要重试，也不要让它以为死了。
     */
    const prev = mutexTail;
    let release;
    let acquired = false;
    mutexTail = new Promise((r) => { release = r; });
    try {
      const LOCK_WAIT_MS = 90_000;
      let timer = null;
      const timeoutP = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), LOCK_WAIT_MS);
        if (timer.unref) timer.unref();
      });
      const got = await Promise.race([prev.then(() => 'ok'), timeoutP]);
      if (timer) clearTimeout(timer);
      if (got === 'timeout') {
        /* **超时不能 release —— 那会让互斥锁在 90 秒后失效。**
         *
         * 2026-11-22 审计抓到：原来超时分支会走到 finally 里的 release()，
         * 于是 mutexTail 立刻 resolve，后面的请求不再等前一个、直接并发 ——
         * 等于「锁超过 90 秒就自动失效」。两个 start 并发建两块屏，
         * 正是这段代码注释里最怕的场景（多屏时 SF id 分不清、截图全废）。
         *
         * 正确做法：把 release 挂到前一个 tail 上，链条按原顺序继续，
         * 后面的请求仍然排在 A 后面，只是**这一次**放弃等待。
         */
        Promise.resolve(prev).finally(release);
        return send(res, 503, {
          ok: false,
          error: '前面还有操作在执行（可能正在建屏/自检），' + Math.round(LOCK_WAIT_MS / 1000)
            + ' 秒内没轮到。稍后重试；长时间这样用 status 看是不是卡在建屏。',
        });
      }
      acquired = true;
      return await run();
    } finally {
      if (acquired) release();   // 只有真拿到锁才在这里放
    }
}

async function shutdown(reason) {
  /*
   * **退出前把所有东西收干净。**
   *
   * 2026-11-22 复核抓到：原来这里只 `vd.stop()` 当前活动屏，而：
   *   · 池里的其它屏（pool.destroyAll）从来没被调用过 —— 全库零调用点，
   *     文件注释自己写着「daemon 退出时用」；
   *   · framesrv 的 app_process 不停，继续编码（index.js 注释自己记了约 10.3% 核）；
   *   · 悬浮窗不停，继续从活着的 framesrv 拿帧。
   * 结果：daemon 空闲自杀或收到 SIGTERM 之后，虚拟屏、推流、浮窗全都还在，
   * 用户看到一个没人管的窗口，CPU 和电量继续烧。
   *
   * 顺序很重要：先关窗口（用户先看不到），再停推流，最后销毁屏。
   * 每一步独立 try —— 一步失败不能把后面的都跳过。
   */
  // ① 先关所有悬浮窗：用户最先感知到的就是屏幕上的窗口
  try {
    const T = await import('../src/tools.js');
    await T.overlayStop('all');
  } catch { /* 浮窗服务本来就没起 */ }

  // ② 停掉 framesrv：它是最耗 CPU 的那个
  try {
    const fsrv = await import('../src/framesrv.js');
    await fsrv.stop();
  } catch { /* 没起来就算了 */ }

  // ③ 停推流服务（Node 侧）
  try {
    const st = await import('../src/stream.js');
    await st.stop();
  } catch { /* ignore */ }

  // ④ 销毁池里所有屏
  try {
    const pool = await import('../src/pool.js');
    await pool.destroyAll();
  } catch { /* ignore */ }

  // ⑤ 最后销毁活动屏
  try { await vd.stop({ forceStopApps: false }); } catch { /* 尽力而为 */ }

  // vd.stop() 正常会恢复 HWC，但它可能因为 adb 不通而失败；
  // 这里同步再兜一次，保证全局属性不留残。
  try { vd.restoreHwcSync(); } catch { /* ignore */ }
  await clearState();
  if (server) { try { server.close(); } catch { /* ignore */ } }
  process.exit(0);
}

function startIdleWatch() {
  /*
   * **所有周期性检查合并成一个 10 秒 tick。**
   *
   * 2026-11-22 对抗审查：原来有 4 个独立定时器（30s 空闲 / 5s 风控 / 10s 对账 /
   * 15s 看门狗），每一个都自己跑一次 `vd.status()` —— 而 status() 内部是一次
   * `dumpsys display` + `dumpsys window` + `dumpsys window displays`。
   * 合计约 1.0–1.3 个 adb shell/秒 常驻空转，和 AI 自己的 input/shot 抢同一条 adb 通路，
   * 而 daemon 空闲要 10 分钟才退出，等于一直在抢。
   *
   * 合并后每个 tick 只查一次 status，其余判断全部复用它的结果：
   *   · 空闲退出   —— 用 st.running
   *   · 运行时对账 —— 用 st.allDisplays（**不再额外 dumpsys**）
   *   · 推流看门狗 —— 一次本地 HTTP，很便宜
   *   · 风控同步   —— 每两个 tick 做一次（20 秒，比原来 5 秒还宽松）
   *
   * adb 调用从约 1.2 次/秒 降到约 0.2 次/秒。
   */
  /* **这两个 streak 变量原来用了但从来没声明过 —— ESM 严格模式下第一次赋值
   * 就抛 ReferenceError，被 tick 末尾的 `catch {}` 静默吞掉。
   *
   * 后果（2026-11-22 独立审计抓到，我核实属实）：
   *   · mHasContent 检测一次都没执行过
   *   · 推流看门狗一次都没执行过
   *   · tick 后面的风控同步也从来没到过
   * 也就是说「改了没效果」，而且没有任何日志 —— 因为异常被空 catch 吃了。
   */
  let streamFailStreak = 0;   // 推流连续几次没在听
  let tickNo = 0;
  /** **tick 防重入。**
   * 一次重建要 60 秒，而 setInterval 每 10 秒触发 —— 期间会叠加 5-6 个 tick，
   * 它们互相看不到对方在重建，会重复 fsrv.stop + streamStart，造出两个 framesrv。 */
  let ticking = false;
  setInterval(async () => {
    if (ticking) return;   // 上一轮还没跑完，别叠加
    ticking = true;
    tickNo++;
    /* **边缘状态清理必须无条件执行** —— 不能等「有屏在跑」才做。
     * 2026-11-22 实测发现：原来它在 tick 末尾，而 tick 在没有屏时
     * 会在 !st.running 那里提前 return，于是过期的边缘状态永远留着。 */
    try { await vd.settleIfIdle(8000); } catch { /* 光效失败不影响守护进程 */ }
    try {
      const st = await vd.status().catch(() => null);
      if (!st) return;

      // ① 空闲退出：屏没在跑且确实没人用的时间够长
      if (!st.running) {
        /* **running=false 但还留着 displayId 是脏状态，要清掉。**
         *
         * 2026-11-22 实机：scrcpy 服务自己死了之后 status() 报 running:false，
         * 但 state.displayId 还留着旧值 —— 下一次建屏会以为「屏还在」而去复用
         * 一块根本用不了的屏。清掉才会走「重新建」。
         */
        if (st.displayId) {
          console.error("[vdisplayd] 状态脏了：running=false 但 displayId=" + st.displayId + " 还在，清理");
          try { await vd.markLost(); } catch { /* 尽力而为 */ }
        }
        if (Date.now() - lastActive >= IDLE_EXIT_MS) {
          await shutdown('idle');
          return;
        }
        streamFailStreak = 0;
        return;
      }
      if (!st.displayId) return;

      /* ② 运行时对账 —— **直接用 status 里已有的 allDisplays，不再查一次。**
       * 这是本次合并省下的最大一笔。 */
      const ids = Array.isArray(st.allDisplays) ? st.allDisplays.map(String) : null;
      const dispAlive = ids ? ids.includes(String(st.displayId)) : true;   // 查不到就不敢断言
      if (!dispAlive) {
        console.error('[vdisplayd] 对账：display ' + st.displayId + ' 已不存在，修正内部状态');
        try { await vd.markLost(); } catch { /* 尽力而为 */ }
        streamFailStreak = 0;
        return;
      }

      /* **③ 内容检测：已整段删除（2026-11-23）。**
       *
       * 这里原来有个看门狗：「屏空了就自动重建」。它的判据是 `mHasContent`，
       * 后来发现对虚拟屏**恒为 false**，于是改成「mHasContent=false 且帧<12KB」。
       *
       * 但 2026-11-23 的独立稳定性审查指出，这个"修复"比原来更危险：
       *   · `mHasContent` 恒 false，所以双条件实际坍缩成只看「JPEG < 12KB」，
       *     而 12KB 这个阈值没有任何实测依据；
       *   · 这个字段的实测记录自相矛盾（一份说 31 分钟一直是 true，
       *     另一份说五块屏全是 false）—— **证据本身不可信**；
       *   · 误判后果比它想解决的"黑屏"更重：重建走 T.start({}) 会触发
       *     pickHomeLike + am force-stop，**把用户屏上的 App 换成设置/时钟**；
       *     而 markLost 只清状态不 stop，旧屏和 forward 全部泄漏，每 100 秒一块。
       *
       * 结论：这个机制的收益（修一个未被证实的黑屏）远小于风险（拆好屏+换App+泄漏）。
       * 按产品意图第六节「宁可少一个功能，不能多一个会自己坏的机制」——删。
       *
       * 如果以后真要修黑屏，先做对照实验把「黑屏时 mHasContent / 帧大小 到底是多少」
       * 量出来，再决定判据。不要用猜的数字。
       */


      /* ③.4 **处理浮窗红色按钮的「停止请求」。**
       *
       * 2026-11-23 审查抓到：那个红条一直是假的 —— framesrv 的 /quit
       * 只退取帧进程，虚拟屏和 App 属于 scrcpy server，跟它没父子关系，
       * 所以「关闭并停后台屏」实际只关了窗，屏继续在后台占 75-185MB。
       *
       * 浮窗是独立 APK，不知道 displayId 也没法调 adb，只能写请求文件；
       * 真停屏在这里做。
       */
      try {
        const reqPort = await vd.takeStopRequest();
        if (reqPort) {
          const T = await import('../src/tools.js');
          let targetDisp = null;
          try {
            for (const [disp, pt] of (T.screenPorts || new Map())) {
              if (Number(pt) === Number(reqPort)) { targetDisp = Number(disp); break; }
            }
          } catch { /* ignore */ }
          console.error('[vdisplayd] 收到停止请求 port=' + reqPort + ' displayId=' + (targetDisp ?? '?'));
          if (targetDisp) {
            try { await T.overlayStop(reqPort); } catch { /* 窗口可能已经没了 */ }
            try { const f = await import('../src/framesrv.js'); await f.stop(targetDisp); } catch { /* ignore */ }
            try {
              const fsMod = await import('../src/framesrv.js');
              void fsMod;
            } catch { /* ignore */ }
            /* **只能停这一块，不能再 vd.stop()。**
             *
             * 2026-11-23 稳定性审查抓到：pool.destroy() 内部会把活动上下文
             * 切成「剩下那块」（pool.js:137-145），之后再无条件 vd.stop()
             * 停的是**另一块屏** —— 用户按一次红条，死两块屏。
             *
             * 所以：在池里就只 destroy；不在池里（插件单独建的）才直接 vd.stop()。
             * 两者互斥。
             */
            let destroyedInPool = false;
            try {
              const poolMod = await import('../src/pool.js');
              const pi = poolMod.info ? poolMod.info() : null;
              const match = (pi?.screens || []).find((x) => Number(x.displayId) === Number(targetDisp));
              if (match && poolMod.destroy) {
                await poolMod.destroy(match.screenId);
                destroyedInPool = true;
              }
            } catch { /* 不在池里 */ }
            if (!destroyedInPool) {
              try { await vd.stop({ forceStopApps: false }); } catch { /* ignore */ }
            }
            console.error('[vdisplayd] 停止请求已执行（屏已销毁）');
          }
        }
      } catch { /* 处理失败不影响 tick */ }


      // ④ 推流看门狗：本地 HTTP，不花 adb
      const n = Number(st.displayId) || 0;
      /* **端口要从账本读，不能用公式算。**
       *
       * 2026-11-23 实测抓到的严重 bug：这里原来硬算 `38820 + id%20`，
       * 但实际端口可能因为碰撞漂移（allocPort 的兜底分支）。
       * 一旦漂移，看门狗检查 A 端口、进程在 B 端口 →
       * 永远判「没在听」→ 每 10 秒重起一次 → 实测攒出 3 个 framesrv
       * 全挤在同一个端口，画面全黑。
       *
       * 账本（T.screenPorts / framesrv 的 servers）才是真相。
       */
      let port = 0;
      try {
        const Tmod = await import('../src/tools.js');
        port = Tmod.screenPorts?.get?.(Number(st.displayId)) || 0;
      } catch { /* ignore */ }
      if (!port) {
        // 账本里没有（换进程了/刚启动），才退回公式
        port = 38820 + (((Number(st.displayId) % 20) + 20) % 20);
      }
      let up = false;
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/status', { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const j = await r.json().catch(() => null);
          // 端口碰撞时可能连到别人的 server，必须核对 displayId
          up = !(j && j.displayId != null && String(j.displayId) !== String(st.displayId));
        }
      } catch { up = false; }

      if (up) {
        streamFailStreak = 0;
      } else if (streamFailStreak >= 3) {
        console.error('[vdisplayd] 推流连续 3 次拉不起来（port ' + port + '），停止重试');
      } else {
        /* **启动宽限期：刚起过推流就别急着判死。**
         *
         * 2026-11-22 实测：tick 在 daemon 起来 6 秒后就跑，那时
         * T.start 里的 framesrv 可能还没开始监听 —— tick 判「没在听」
         * → 停旧的（进程刚起停不掉）→ 再起一个用了下一个空端口
         * → 同一块屏两个 framesrv（实测 38829 + 38830 并存）。
         * 60 秒宽限足够覆盖「推 jar + spawn + 等端口」。
         */
        /* **有写操作在跑时跳过看门狗。**
         *
         * 2026-11-22 实测：一次 start 要 60 秒（推 jar、spawn、等端口、投 App、
         * 六项自检），tick 每 10 秒跑一次 —— 会在 framesrv 还没监听时判「没在听」，
         * 于是重复 spawn，同一块屏两个 framesrv（实测 38833 + 38834 并存）。
         * 宽限期设在 T.start 之后没用，因为问题就发生在 T.start 期间。
         */
        if (opBusy > 0) {
          return;   // 建屏/自检正在进行，别插嘴
        }
        if (lastStreamStartAt && Date.now() - lastStreamStartAt < 60_000) {
          return;   // 刚起过，再等等
        }
        streamFailStreak++;
        console.error('[vdisplayd] 推流没在听（port ' + port + '），第 ' + streamFailStreak + ' 次重起');
        try {
          const T = await import('../src/tools.js');
            /* **重起前先杀掉这块屏的旧 framesrv。**
             *
             * 2026-11-22 实测踩到：看门狗判断「推流没在听」就直接 streamStart，
             * 但旧进程可能还活着占着端口 —— 新起的拿不到 38820+id%20，
             * 于是漂移到下一个空端口，结果**同一块屏跑两个 framesrv**
             * （实测 PID 1999 @38825 和 2022 @38826 并存）。
             * 两个进程抢同一块 Surface，浪费内存还可能导致帧错乱。
             *
             * 所以要按 displayId 精确停掉旧的，再起新的。fsrv.stop(id) 只停这一块。
             */
            try {
              const fsrv = await import('../src/framesrv.js');
              await fsrv.stop(Number(st.displayId));
            } catch { /* 本来就没起就算了 */ }

          await T.streamStart({ displayId: st.displayId, fps: 2, width: 360 });
        } catch (e) {
          console.error('[vdisplayd] 重起推流失败：' + String(e?.message || e).slice(0, 80));
        }
      }

      /* **不再自动清「孤儿」framesrv。**
       *
       * 2026-11-23 我自己加过一条定时清理，然后意识到它很危险：
       * 判据是「端口不在账本里就杀」，但端口本来就会因为碰撞漂移
       * （实测 38827 → 38828），于是**正在工作的进程会被当成孤儿杀掉**。
       * 用一个会误杀的兜底去防一个已经修好的泄漏，不划算。
       *
       * 真正的修复是 framesrv.stop() 先清账本再 quit（已修），
       * 账本泄漏没了，孤儿自然不产生。
       * cleanupOrphans() 函数保留着，只在人工诊断时调（dryRun=true 先看）。
       */

      // ④ 风控同步：每两个 tick（20 秒）一次就够了，原来 5 秒太频繁
      if (tickNo % 2 === 0) {
        try { await vd.syncRiskLevel(); } catch { /* 同步失败不影响守护进程 */ }
      }

    } catch (e) {
      /* **不能空吞异常。**
       *
       * 2026-11-22：就是这里的 `catch {}` 让「变量没声明」这个致命错误
       * 藏了一整天 —— tick 每次都抛 ReferenceError，每次都被吃掉，
       * 表现得像「代码改了但没生效」，没有任何日志可查。
       * 定时器确实不该崩，但**必须把错误说出来**。
       */
      console.error('[vdisplayd] tick 出错（看门狗可能没在跑）:', e?.message || String(e));
    } finally {
      /* **必须复位。** tick 里有很多 return（没屏、对账失败、opBusy 忙…），
       * 不复位的话第一次 return 之后就永久跳过所有后续 tick，
       * 表现就是「看门狗跑了一次就再也不跑了」—— 和之前那些静默失效一个样。 */
      ticking = false;
    }
  }, 10_000).unref?.();
}

/**
 * 启动时对账：清理上一次运行留下的残留。
 *
 * 为什么需要：守护进程被 SIGKILL 或被系统 OOM 杀掉时，`process.on('exit')`
 * **不会执行**，于是 `debug.sf.enable_hwc_vds` 会留在 1 —— 那是全局 SurfaceFlinger
 * 属性，整台设备的合成策略都被改变，直到手机重启才恢复。实测确认过这个残留。
 *
 * 判据：属性是 1，但设备上**已经没有任何 scrcpy 虚拟屏** → 说明是上次没清掉的，
 * 不是正在使用中的。这个判据不会误杀"用户自己开着 HWC"的情况，因为那种情况下
 * 属性是 1 且通常也没有我们的虚拟屏……所以只有在我们自己写过状态文件时才做。
 */
async function reconcileLeftovers() {
  try {
    const hwc = String(await vd.shell('getprop debug.sf.enable_hwc_vds')).trim();
    if (hwc !== '1') return;

    const n = String(await vd.shell(
      'dumpsys display 2>/dev/null | grep -c \'DisplayDeviceInfo{"scrcpy"\'',
    )).trim();
    if (Number(n) > 0) return;   // 还有虚拟屏在用，别动

    // 不再 setprop：HWC 属性我们从没设过（2026-11-24 删除，见 vd.js start() 说明）
    console.error('[vdisplayd] 对账：清掉了上次异常退出残留的 debug.sf.enable_hwc_vds=1');
  } catch { /* 对账失败不能拖垮启动 */ }
}

async function main() {
  // 已有实例就直接报错退出，避免两个守护进程抢同一台设备的虚拟屏
  try {
    const old = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    if (old?.pid && old.pid !== process.pid) {
      try {
        process.kill(old.pid, 0);
        console.error(`[vdisplayd] 已经有守护进程在跑（pid ${old.pid}, port ${old.port}），不重复启动。`);
        process.exit(0);
      } catch { /* 旧进程已经死了，继续 */ }
    }
  } catch { /* 没有状态文件，正常 */ }

  await reconcileLeftovers();

  server = createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: e?.message || String(e) }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  await writeState(port);
  console.log(`[vdisplayd] listening on 127.0.0.1:${port} (pid ${process.pid})`);

  startIdleWatch();

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => { shutdown(sig).catch(() => process.exit(0)); });
  }

  // 最后一道保险：不管从哪条路退出，都同步把 HWC 属性恢复原值。
  // 这个属性是全局的 —— 留着 1 会一直影响整台设备的合成策略，直到重启手机。
  // 注意 SIGKILL 抓不到，那种情况下只能靠下次 vd.start() 重新对账。
  process.on('exit', () => {
    try { vd.restoreHwcSync(); } catch { /* 退出中，尽力而为 */ }
  });
  process.on('uncaughtException', (e) => {
    console.error('[vdisplayd] uncaught:', e?.message || e);
  });
}

main().catch(async (e) => {
  console.error('[vdisplayd] 启动失败:', e?.message || e);
  await clearState();
  process.exit(1);
});
