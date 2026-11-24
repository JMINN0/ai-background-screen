/**
 * 常驻取帧服务（ImageReader）的 Node 侧管理 —— **多实例版**。
 *
 * ## 为什么需要
 *
 * `screencap` 每帧要 141ms 的 Surface 回读，加起来 227-243ms/帧 = 2.5fps，
 * 这是 screencap 的工作方式决定的，改不了。`ImageReader` 从合成器直接拿 buffer，
 * 实测 76fps，快 30 倍。
 *
 * ## 为什么是多实例
 *
 * 上一版是**单例**：模块级 `state` 只有一个，`start()` 第一件事是 `await stop()` ——
 * 于是「开第二块屏」会把「第一块屏的推流」停掉，第一个悬浮窗因 `/status` 说
 * running:false 而自己关掉。**多窗口因此永远只剩一个。**
 *
 * 现在按 displayId 分组：
 *
 *   servers: Map<displayId, {port, size, proc, startedAt}>
 *
 * Java 侧本来就接受 `--display=N --port=P` 参数，**一个 displayId 一个 app_process 进程**，
 * 天然可以并存。端口从 38820 往上分配，跳过已占用的。
 *
 * ## 兼容
 *
 * `stop()` / `info()` 不传 displayId 时作用于「全部」/「活动的那一个」，
 * 老调用方不用改。
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { adbTarget } from './target.js';

const run = promisify(execFile);

const REMOTE_DIR = '/data/local/tmp/dshframe';
const REMOTE_DEX = REMOTE_DIR + '/frame.dex';
const BASE_PORT = 38820;
const MAX_PORT = 38840;          // 最多 20 块屏，够了

/**
 * displayId → 实例。
 *
 * 用 Map 而不是对象：displayId 是数字，Map 的键类型稳定，
 * 而且能保证 `for (const [id, v] of servers)` 的插入顺序（级联顺序靠它）。
 */
const servers = new Map();

/** 当前「活动」的 displayId（最后一次 start 的那个），给不带参数的调用用。 */
let activeDisplayId = null;

function pkgRoot() {
  try { return join(dirname(fileURLToPath(import.meta.url)), '..'); }
  catch { return process.cwd(); }
}

/** 找编译好的 dex。没有就返回 null（调用方降级）。 */
function findDex() {
  const root = pkgRoot();
  /* **npm 包里没有 framesrv/ 源码目录**，所以优先找打进 assets 的预编译 dex。
   * 2026-11-22 发现：0.1.0/0.1.1 发到 npm 后，陌生人装下来走不到建屏这一步 —— 
   * framesrv.js 只找 ../framesrv/build/*.dex，而包的 files 里没有 framesrv/。
   * 现在 assets/framesrv.dex 是随包发布的构建产物，源码目录仍然保留给本地开发。
   */
  for (const rel of ['../assets/framesrv.dex', '../framesrv/build/classes.dex', '../framesrv/classes.dex']) {
    const p = join(root, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 推 dex 到设备（内容一样就跳过）。多个实例共用同一个 dex 文件。 */
async function pushDex(target) {
  const local = findDex();
  if (!local) return { ok: false, why: '没找到 framesrv/build/classes.dex（先编译 framesrv）' };
  try {
    await run('adb', ['-s', target, 'shell', `mkdir -p ${REMOTE_DIR}`], { timeout: 8000 });
    const r = await run('adb', ['-s', target, 'push', local, REMOTE_DEX], { timeout: 20000 });
    const out = String(r.stdout || '') + String(r.stderr || '');
    if (/error|failed/i.test(out) && !/1 file pushed/.test(out)) {
      return { ok: false, why: 'push 失败: ' + out.slice(0, 80) };
    }
    await run('adb', ['-s', target, 'shell', `chmod 644 ${REMOTE_DEX}`], { timeout: 8000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: 'push 异常: ' + String(e?.message || e).slice(0, 80) };
  }
}

/** 探活：/status 能通就算活着。 */
/**
 * 探测某个端口上的 framesrv 是不是**属于指定这块屏**。
 *
 * @param {number} port
 * @param {number} [expectDisplayId] 传了就校验；不传只看活着
 *
 * 2026-11-22 对抗审查 P0-2：原来只 parse JSON 就当成功，
 * 端口碰撞时会把**别人的** server 当成本屏的 —— 两块屏共用一个 framesrv，
 * 用户看到别人的画面，而自检全绿。现在 /status 带 displayId，能核对。
 */
async function probe(port, expectDisplayId) {
  try {
    const { request } = await import('node:http');
    return await new Promise((resolve) => {
      const req = request({
        host: '127.0.0.1', port, path: '/status', method: 'GET', timeout: 700,
      }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try {
            const info = JSON.parse(body);
            /* 带了期望的 displayId 就必须对上，否则这是别人的 server */
            if (expectDisplayId != null && info && info.displayId != null
                && Number(info.displayId) !== Number(expectDisplayId)) {
              resolve({ ok: false, wrongDisplay: true, info });
              return;
            }
            resolve({ ok: true, info });
          } catch { resolve({ ok: false }); }
        });
      });
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      req.end();
    });
  } catch { return { ok: false }; }
}

/**
 * 分配端口。**同一块屏必须永远拿到同一个端口。**
 *
 * 2026-11-22 实机踩到：原来这里是「从 BASE_PORT 往上找第一个空的」，
 * 完全不看 displayId。结果 framesrv 死掉重建、或者进程重启后，
 * 同一块屏拿到的是**另一个端口**，而悬浮窗是绑死旧端口的
 * （OverlayService 里 `port` 是 final 字段），于是重试一万次也连不上 ——
 * 用户看到「黑屏之后再也回不来」。
 *
 * 现在：端口由 displayId 确定性地推导（displayId % 20），
 * 同一块屏重开多少次都是同一个端口，悬浮窗的重试才真的有意义。
 * 撞车时往后找下一个空的 —— 20 个端口够 20 块屏。
 */
function allocPort(displayId) {
  const used = new Set();
  for (const s of servers.values()) used.add(s.port);
  const span = MAX_PORT - BASE_PORT;
  const id = Number(displayId) || 0;
  // ① 优先用这块屏的「固定位置」，稳定优先
  const preferred = BASE_PORT + (((id % span) + span) % span);
  if (!used.has(preferred)) return preferred;
  // ② 固定位置被别的屏占了，往后找下一个空的
  for (let i = 1; i < span; i++) {
    const p = BASE_PORT + ((id % span) + i) % span;
    if (!used.has(p)) return p;
  }
  return 0;
}

/**
 * 查这块屏**当前**的尺寸。
 *
 * **必须用 `app W x H`，不能用 `real W x H`。**
 * `dumpsys display` 里 `real` 是自然尺寸（= DisplayDeviceInfo），旋转后**不变**；
 * `app` 才是应用实际在用的尺寸，跟随旋转。
 *
 * 用 real 的后果：屏已经是横向时启动取帧服务，会把 720×1592 传进去，
 * 第一帧方向就是错的（有尺寸看门狗会自愈，但开头那段是歪的）。
 *
 * 优先 app，取不到退 real，都没有才用调用方给的兜底值。
 */
async function realSize(target, displayId, fallbackW, fallbackH) {
  /* **三条路依次试，任何一条拿到都行 —— 以前只有一条，拿不到就用传入值。**
   *
   * 2026-11-24 踩到：`grep "Display <id>:"` 在 dumpsys display 里根本不匹配
   * （实际格式是 `mDisplayId=956`），于是永远走兜底，而调用方传进来的
   * width 是**推流输出宽度 360**，不是源屏宽度 720 ——
   * 结果镜像按 360x1592 建，画面被水平压扁一半，浮窗变成细长条。
   *
   * 现在改成：dumpsys display 的 mDisplayId 段 → DisplayDeviceInfo → wm size。
   */
  const grab = async (cmd) => {
    try {
      const r = await run('adb', ['-s', target, 'shell', cmd], { timeout: 8000 });
      return String(r.stdout || '');
    } catch { return ''; }
  };

  // ① dumpsys display：找 mDisplayId=<id> 段里的 real/app W x H
  const d1 = await grab(
    `dumpsys display 2>/dev/null | grep -A14 "mDisplayId=${displayId}" | grep -oE "(app|real) [0-9]+ x [0-9]+"`
  );
  let m = d1.match(/app (\d+) x (\d+)/) || d1.match(/real (\d+) x (\d+)/);
  if (m && sanity(Number(m[1]), Number(m[2]))) return { w: Number(m[1]), h: Number(m[2]) };

  // ② DisplayDeviceInfo 那一行：... 720 x 1592 ...
  const d2 = await grab(
    `dumpsys display 2>/dev/null | grep -A3 "mDisplayId=${displayId}" | grep -oE "[0-9]{3,4} x [0-9]{3,4}"`
  );
  m = d2.match(/(\d+) x (\d+)/);
  if (m && sanity(Number(m[1]), Number(m[2]))) return { w: Number(m[1]), h: Number(m[2]) };

  // ③ 主屏兜底（虚拟屏通常是主屏的缩小版，尺寸不同但比例一致）
  const d3 = await grab('wm size 2>/dev/null');
  m = d3.match(/(\d+)x(\d+)/);
  if (m && sanity(Number(m[1]), Number(m[2]))) {
    // 用传入值的高度、主屏的比例推算宽度更稳
    const ratio = (fallbackW && fallbackH) ? (fallbackW / fallbackH) : (Number(m[1]) / Number(m[2]));
    const h = Number(fallbackH) || Number(m[2]);
    const w = Math.round(h * ratio);
    if (sanity(w, h)) return { w, h };
  }

  return { w: fallbackW, h: fallbackH };
}

/** 尺寸合理性：宽高都要在 200..4096，且比例在 1:4 到 4:1 之间。 */
function sanity(w, h) {
  if (!w || !h) return false;
  if (w < 200 || h < 200 || w > 4096 || h > 4096) return false;
  const a = w / h;
  return a > 0.25 && a < 4;
}

/**
 * 为一块屏启动取帧服务。
 *
 * @param {{displayId:number, width?:number, height?:number, port?:number, mirror?:string}} opt
 * @returns {Promise<{ok:boolean, port?:number, reused?:boolean, why?:string, fps?:number}>}
 */
export async function start({ displayId, width, height, port, mirror } = {}) {
  if (!displayId) return { ok: false, why: '缺 displayId' };

  // 已经在跑这块屏 → 复用（探活确认）
  const cur = servers.get(displayId);
  if (cur) {
    const p = await probe(cur.port, displayId);   // 校验这块 server 真的是这块屏的
    if (p.ok) {
      activeDisplayId = displayId;
      return { ok: true, port: cur.port, reused: true, fps: p.info?.fps || 0 };
    }
    // 死了 → 清掉重来
    servers.delete(displayId);
  }

  const target = await adbTarget();
  const pushed = await pushDex(target);
  if (!pushed.ok) return pushed;

  const real = await realSize(target, displayId, width || 720, height || 1592);
  const size = `${real.w}x${real.h}`;

  const usePort = port || allocPort(displayId);   // 按屏推导，保证重建后端口不变
  if (!usePort) return { ok: false, why: `端口用完了（${BASE_PORT}-${MAX_PORT}）` };

  // mirror 参数：把这块屏镜像到 dsh-frames 虚拟屏（悬浮窗读它）
  // 不传就让 Java 侧自己建默认的镜像屏
  const mirrorArg = mirror ? ` --mirror=${mirror}` : '';
  const cmd = `CLASSPATH=${REMOTE_DEX} app_process / com.dsh.framesrv.Main`
    + ` --display=${displayId} --port=${usePort} --width=400 --size=${size}${mirrorArg}`;

  try {
    const child = spawn('adb', ['-s', target, 'shell', cmd], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    servers.set(displayId, {
      port: usePort, displayId, size, proc: child, startedAt: Date.now(),
    });
  } catch (e) {
    return { ok: false, why: '启动失败: ' + String(e?.message || e).slice(0, 80) };
  }

  // 等端口起来（最多 8 秒）
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const p = await probe(usePort, displayId);   // 同上：防连到别人的 server
    if (p.ok) {
      activeDisplayId = displayId;
      return { ok: true, port: usePort, fps: p.info?.fps || 0, reused: false };
    }
  }
  // 起不来就清掉，别留死记录
  servers.delete(displayId);
  return { ok: false, why: '启动后 8 秒内端口没起来（看 logcat: app_process 可能崩了）' };
}

/** 请一个实例自己退出。 */
async function quit(port) {
  try {
    const { request } = await import('node:http');
    await new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/quit', timeout: 500 }, (res) => {
        res.resume(); res.on('end', resolve);
      });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end();
    });
  } catch { /* ignore */ }
}

/**
 * 停取帧服务。
 * @param {number} [displayId] 只停这一块；省略 = 全停。
 */
/**
 * **杀掉不在账本里的 framesrv 孤儿进程。**
 *
 * 2026-11-23 实测踩到：看门狗重起 3 次，攒出 3 个 framesrv 全挤在同一端口
 * （38820），只有第一个能绑上，其余空转占内存。
 * 根因是 stop 的账本泄漏（已修），但还要有兜底 ——
 * 任何不在账本里的 framesrv 都该被清掉。
 *
 * @param {boolean} dryRun true 只报告不杀
 * @returns {{ok:boolean, orphans:number[], killed:number[]}}
 */
export async function cleanupOrphans(dryRun = false) {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const target = await adbTarget();
    const r = await run('adb', ['-s', target, 'shell',
      "ps -A -o PID,ARGS 2>/dev/null | grep 'app_process.*framesrv.Main' | grep -v grep"],
      { timeout: 8000 }).catch(() => ({ stdout: '' }));
    const lines = String(r.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const ledgerPorts = new Set([...servers.values()].map((x) => x.port));
    const orphans = [];
    for (const ln of lines) {
      const m = ln.match(/^(\d+)\s+.*--port=(\d+)/);
      if (!m) continue;
      const pid = Number(m[1]);
      const port = Number(m[2]);
      if (!ledgerPorts.has(port)) orphans.push({ pid, port });
    }
    const killed = [];
    if (!dryRun) {
      for (const o of orphans) {
        try {
          await run('adb', ['-s', target, 'shell', `kill -9 ${o.pid}`], { timeout: 6000 });
          killed.push(o.pid);
        } catch { /* 单个失败不影响其它 */ }
      }
    }
    return { ok: true, orphans: orphans.map((o) => o.pid), killed };
  } catch (e) {
    return { ok: false, hint: String(e?.message || e).slice(0, 80) };
  }
}

export async function stop(displayId) {
  if (displayId != null) {
    const s = servers.get(displayId);
    if (s) {
      /* **必须先清账本，再尝试优雅退出。**
       *
       * 2026-11-23 实测抓到的严重 bug：原来是 `await quit(s.port)` 之后再
       * `servers.delete()`。而 quit 是 HTTP 请求 —— 进程已经被 kill -9 时它抛异常，
       * `delete` 就永远不执行，内存里一直记着这个端口被占用。
       * 于是下一次 allocPort 发现「首选端口被占」，漂移到下一个空端口，
       * 而看门狗检查的还是公式算出来的老端口 → 永远对不上 → 每 10 秒重起一次，
       * **实测攒出 3 个 framesrv 全挤在同一端口**。
       */
      servers.delete(displayId);
      try { await quit(s.port); } catch { /* 进程已死，退不出来是正常的 */ }
      try { s.proc?.kill?.(); } catch { /* ignore */ }
    }
    if (activeDisplayId === displayId) activeDisplayId = firstKey();
    return { ok: true, stopped: displayId ? 1 : 0 };
  }
  // 全停
  const ports = [...servers.values()].map((s) => s.port);
  for (const p of ports) await quit(p);
  for (const s of servers.values()) { try { s.proc?.kill?.(); } catch { /* ignore */ } }
  servers.clear();
  activeDisplayId = null;
  return { ok: true, stopped: ports.length };
}

function firstKey() {
  for (const k of servers.keys()) return k;
  return null;
}

/**
 * 状态。
 * @param {number} [displayId] 查这一块；省略 = 返回活动那块 + 全部列表。
 */
export async function info(displayId) {
  if (displayId != null) {
    const s = servers.get(displayId);
    if (!s) return { running: false, displayId };
    const p = await probe(s.port, displayId);
    if (!p.ok) {
      servers.delete(displayId);
      return { running: false, displayId };
    }
    return { running: true, port: s.port, displayId, size: s.size, ...(p.info || {}) };
  }
  // 无参：活动那块（兼容老调用）+ 全部
  const all = [];
  for (const [id, s] of servers) {
    const p = await probe(s.port, id);
    all.push({ displayId: id, port: s.port, size: s.size, running: p.ok, ...(p.ok ? (p.info || {}) : {}) });
  }
  const act = activeDisplayId != null ? all.find((x) => x.displayId === activeDisplayId) : all[0];
  return {
    running: !!(act && act.running),
    port: act?.port || 0,
    displayId: act?.displayId ?? null,
    size: act?.size || '',
    count: all.length,
    servers: all,
  };
}

/** 把点击位置发给 framesrv，下一帧会画十字。 */
export async function markTap(nx, ny, displayId) {
  // **端口优先用进程内状态，没有就回退到 stream.json。**
  // 实机踩到：模块状态是进程内的，换一个 Node 进程调 input 时 port 是 0
  // → 标记发不出去 → 用户看不到点击位置。
  let port = 0;
  const want = displayId != null ? displayId : activeDisplayId;
  const s = want != null ? servers.get(want) : null;
  if (s) port = s.port;
  if (!port && servers.size === 1) port = [...servers.values()][0].port;
  if (!port) {
    try {
      const { readFile } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const raw = await readFile(join(homedir(), '.dsh', 'plugin-screen', 'stream.json'), 'utf8');
      const j = JSON.parse(raw);
      if (j && j.port && (j.backend === 'imagereader')) port = Number(j.port);
    } catch { /* 读不到就算了 */ }
  }
  if (!port) return;
  try {
    const { request } = await import('node:http');
    const x = Math.max(0, Math.min(1, Number(nx)));
    const y = Math.max(0, Math.min(1, Number(ny)));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    await new Promise((resolve) => {
      const req = request({
        host: '127.0.0.1', port,
        path: `/mark?nx=${x.toFixed(4)}&ny=${y.toFixed(4)}`,
        method: 'GET', timeout: 600,
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end();
    });
  } catch { /* 画不上就算了 */ }
}

/** 活动实例的端口（兼容老调用）。 */
export function currentPort() {
  const s = activeDisplayId != null ? servers.get(activeDisplayId) : null;
  if (s) return s.port;
  if (servers.size === 1) return [...servers.values()][0].port;
  return 0;
}

/** 是否有实例在跑（兼容老调用）。 */
export function isRunning() { return servers.size > 0; }

/** 所有实例（诊断用）。 */
export function listServers() {
  return [...servers.entries()].map(([id, s]) => ({ displayId: id, port: s.port, size: s.size }));
}

/** 指定/活动实例的端口。 */
export function portOf(displayId) {
  const s = displayId != null ? servers.get(displayId) : (activeDisplayId != null ? servers.get(activeDisplayId) : null);
  return s ? s.port : 0;
}

/** 设活动屏（screen_use 切屏时调）。 */
export function setActive(displayId) {
  if (servers.has(displayId)) { activeDisplayId = displayId; return true; }
  return false;
}
