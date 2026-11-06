/**
 * stream.js — 把虚拟屏的画面以 JPEG 帧的形式，通过本机回环 HTTP 交给原生插件。
 *
 * 为什么不用文件、也不用桥接协议搬帧：
 * - 文件：用户明确说截图占空间。
 * - 桥接协议：只收 JSON 文本帧、每次 ≤32 KiB、限 4 Hz，MJPEG 流塞不进去。
 * 所以走 127.0.0.1 回环：插件取帧（内存）→ 原生侧 fetch → base64 → 面板 image。
 *
 * 实测成本（同一颗 SoC，360x640@2fps）：screencap 133 ms/帧 + ffmpeg 转码 14 ms/帧 ≈ 0.30 核。
 * 帧率才是成本主轴，分辨率不是——screencap 的固定开销约 60 ms（binder/内核拷贝）。
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { adbTarget } from './target.js';

const ADB = process.env.ADB_BIN || 'adb';
const STATE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugin-screen');
const STATE_FILE = join(STATE_DIR, 'stream.json');

const st = {
  server: null,
  port: 0,
  timer: null,
  latest: null,
  busy: false,
  running: false,
  startedAt: 0,
  fps: 2,
  width: 360,
  sfId: null,
  displayId: null,
  focusedApp: '',
  frames: 0,
  errors: 0,
  quality: 7,
};

function runCollect(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('close', (code) => resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString() }));
    p.on('error', (e) => resolve({ code: -1, out: Buffer.alloc(0), err: String(e.message) }));
  });
}

/**
 * 用 ffmpeg 把 PNG 转成缩放后的 JPEG（走管道，不落盘）。
 *
 * q 越小质量越好、体积越大。实测 360 宽 q7 在彩色桌面上会到 27 KB，
 * base64 后 36 KB —— **超过桥接每次 32 KiB 的硬限，连续 5 次会把插件降级**。
 * 所以调用方要按体积自适应降 q 或缩宽度。
 */
function pngToJpeg(png, width, q = 7) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'png_pipe', '-i', 'pipe:0',
      '-vf', `scale=${width}:-1:flags=bilinear`,
      '-f', 'mjpeg', '-q:v', String(q), 'pipe:1',
    ]);
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 && out.length ? Buffer.concat(out) : null));
    p.stdin.on('error', () => {});
    p.stdin.end(png);
  });
}

// base64 占 4/3，还要留 JSON 开销，所以 JPEG 必须 ≤ 22000 字节（与胶囊端 FRAME_MAX 保持一致，否则落在中间区间会出现 stream 认为合格、胶囊每帧丢弃的黑屏）
const JPEG_BUDGET = 22000;

async function captureAndConvert() {
  // 目标地址现取：adb 插件的 adbd 端口会变，硬编码 5555 会静默抓不到帧。
  const target = await adbTarget();
  const r = await runCollect(ADB, ['-s', target, 'exec-out', 'screencap', '-p', '-d', st.sfId]);
  if (r.code !== 0 || r.out.length === 0) { st.errors += 1; return null; }

  // 自适应：ffmpeg 的 -q:v 是**数字越大质量越差、文件越小**（2 最好 31 最差）。
  // 之前按 7→4→2 写反了，越调越大，帧反而超标 —— 这里往大的方向调。
  let last = null;
  for (const q of [7, 12, 18, 24]) {
    const jpg = await pngToJpeg(r.out, st.width, q);
    if (!jpg) continue;
    last = jpg;
    if (jpg.length <= JPEG_BUDGET) { st.quality = q; return jpg; }
  }
  // 降质量还不够就缩宽度
  const narrower = Math.max(200, Math.round(st.width * 0.7));
  const small = await pngToJpeg(r.out, narrower, 18);
  if (small && (!last || small.length < last.length)) { st.quality = 18; return small; }
  return last;
}

async function tick() {
  if (!st.running || st.busy) return;
  st.busy = true;
  try {
    const jpg = await captureAndConvert();
    if (jpg) { st.latest = jpg; st.frames += 1; }
  } finally { st.busy = false; }
}

export function setFocusedApp(app) {
  st.focusedApp = String(app || '').slice(0, 200);
  writeState();
}

async function writeState() {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify({
      port: st.port, running: st.running, startedAt: st.startedAt,
      fps: st.fps, width: st.width, displayId: st.displayId,
      focusedApp: st.focusedApp || '',   // 胶囊靠这个显示"AI 在操作 XX"，以前压根没写
    }));
  } catch { /* 写不进去不影响推帧 */ }
}

function startServer() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/status') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({
          running: st.running, displayId: st.displayId, fps: st.fps, width: st.width,
          frames: st.frames, errors: st.errors, focusedApp: st.focusedApp,
        }));
        return;
      }
      if (url.pathname === '/frame.jpg') {
        if (!st.latest) { res.writeHead(503); res.end('no frame yet'); return; }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
        res.end(st.latest);
        return;
      }
      res.writeHead(404); res.end('not found');
    });
    srv.listen(0, '127.0.0.1', () => {
      st.port = srv.address().port;
      st.server = srv;
      resolve(st.port);
    });
  });
}

/**
 * 开始推帧。sfId 是 SurfaceFlinger 的 64 位 id（不是 displayId）。
 * fps 默认 2、宽度默认 360——实测这是"长时间看"的推荐档（约 0.30 核、29 KB/s）。
 */
export async function start({ sfId, displayId, fps = 2, width = 360, focusedApp = '' } = {}) {
  if (!sfId) return { ok: false, hint: '缺 SurfaceFlinger id，先 vdisplay_start 建屏。' };
  if (st.running && st.sfId === sfId) {
    // 复用时要更新 App 名：以前直接 return，换 App 后胶囊永远显示推流开始时的那个
    if (focusedApp && focusedApp !== st.focusedApp) { st.focusedApp = String(focusedApp).slice(0, 200); writeState(); }
    return { ok: true, port: st.port, reused: true, focusedApp: st.focusedApp };
  }

  st.sfId = sfId;
  st.displayId = displayId || null;
  st.fps = Math.min(Math.max(Number(fps) || 2, 1), 4);   // 上限 4fps：桥接协议就是 4Hz
  st.width = Math.min(Math.max(Number(width) || 360, 240), 720);
  st.focusedApp = focusedApp;
  st.latest = null;
  st.frames = 0;
  st.errors = 0;

  if (!st.server) await startServer();
  st.running = true;
  st.startedAt = Date.now();

  const interval = Math.round(1000 / st.fps);
  // 换 sfId 时必须先清掉旧定时器：否则两个 tick 叠在一起，抓帧频率翻倍、CPU 也翻倍。
  if (st.timer) { clearInterval(st.timer); st.timer = null; }
  st.timer = setInterval(tick, interval);
  tick();
  await writeState();

  return { ok: true, port: st.port, fps: st.fps, width: st.width };
}

export async function stop() {
  st.running = false;
  if (st.timer) { clearInterval(st.timer); st.timer = null; }
  st.latest = null;
  await writeState();
  return { ok: true };
}

/** 收工：连 HTTP 服务一起关，并删掉状态文件（原生插件就看不到"在操作"了）。 */
export async function shutdown() {
  await stop();
  if (st.server) { st.server.close(); st.server = null; }
  st.port = 0;
  try { await rm(STATE_FILE, { force: true }); } catch {}
  return { ok: true };
}

export function info() {
  return {
    running: st.running, port: st.port, fps: st.fps, width: st.width,
    displayId: st.displayId, frames: st.frames, errors: st.errors,
    bytesPerFrame: st.latest?.length || 0,
  };
}
