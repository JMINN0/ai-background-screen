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
const ACTIONS = {
  async start(args) {
    const r = await vd.start({
      width: Number(args?.width) || 0,        // 0 = 自动按物理屏比例
      height: Number(args?.height) || 0,
      dpi: Number(args?.dpi) || 320,
      systemDecorations: args?.systemDecorations === true,
      orientation: args?.orientation,
      hwc: args?.hwc || 'auto',
    });
    return r;
  },
  async stop(args) {
    return vd.stop({ forceStopApps: args?.forceStopApps === true });
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
    return vd.shot(args?.dir || '/tmp', {
      width: Math.min(Math.max(Number(args?.width) || 540, 240), 1080),
      format: args?.format === 'png' ? 'png' : 'jpeg',
    });
  },
  async mainShot(args) {
    return vd.mainShot(args?.dir || '/tmp');
  },
  async focusedApp() {
    return { app: await vd.focusedApp() };
  },
  async mainFocus() {
    return { app: await vd.mainFocus() };
  },
  async input(args) {
    const kind = String(args?.kind || '');
    if (!['tap', 'swipe', 'text', 'key', 'paste'].includes(kind)) {
      return { hint: `不认识的输入类型「${kind}」。可选：tap / swipe / text / key / paste` };
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

  try {
    const out = await fn(payload.args || {});
    return send(res, 200, { ok: true, result: out });
  } catch (e) {
    return send(res, 500, { ok: false, error: e?.message || String(e) });
  }
}

async function shutdown(reason) {
  try { await vd.stop({ forceStopApps: false }); } catch { /* 尽力而为 */ }
  // vd.stop() 正常会恢复 HWC，但它可能因为 adb 不通而失败；
  // 这里同步再兜一次，保证全局属性不留残。
  try { vd.restoreHwcSync(); } catch { /* ignore */ }
  await clearState();
  if (server) { try { server.close(); } catch { /* ignore */ } }
  process.exit(0);
}

function startIdleWatch() {
  setInterval(async () => {
    const idle = Date.now() - lastActive;
    if (idle < IDLE_EXIT_MS) return;
    // 屏还开着就别退——用户可能正等着用
    const st = await vd.status().catch(() => null);
    if (st?.running) return;
    await shutdown('idle');
  }, 30_000).unref?.();
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

    await vd.shell('setprop debug.sf.enable_hwc_vds 0');
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
