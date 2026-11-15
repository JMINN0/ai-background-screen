/**
 * timeline.js — 连续抓 N 帧，拼成一张网格图返回。
 *
 * 为什么需要这个：`vdisplay_shot` 只给单帧，AI 无法判断"往哪飞""在变快还是变慢"
 * "刚才发生了什么"。要判断运动，至少需要 2 帧；要判断轨迹，需要 6-9 帧。
 *
 * 为什么自己拼而不是发 N 张图：每张图有最低计费（544×544 ≈ 169 token），
 * 9 张分开送 = 1521 token，拼成一张 3×3 = 209 token，差 7 倍。
 *
 * 实测成本（720×1280 虚拟屏，3×3 九格）：
 *   抓帧 9 × 240ms ≈ 2.2s
 *   拼图 ffmpeg ~150ms
 *   出图 786×441 ≈ 209 token
 *
 * 重要局限（写在这里免得以后忘）：
 *   格子缩到 262×147 时，原图 26px 的字会变成 5.3px —— **读不出数字，只能看结构**。
 *   实测盲测确认：HUD 数值在九格里是彩色糊块，硬读会编。
 *   要读数值请用 vdisplay_shot（单帧）或单独裁剪。
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { adb, shell } from './vd.js';
import { adbTarget } from './target.js';

const ADB = process.env.ADB_BIN || 'adb';

function run(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => finish({ ok: false, err: String(e?.message || e) }));
    p.on('close', (code) => finish({
      ok: code === 0,
      code,
      out: Buffer.concat(out),
      err: Buffer.concat(err).toString().slice(-500),
    }));
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} finish({ ok: false, err: 'timeout' }); }, timeoutMs);
  });
}

/** 抓一帧到本地文件，返回是否成功。exec-out 直接流回，不在手机上留文件。 */
async function grabOne(target, sfId, dest) {
  const r = await new Promise((resolve) => {
    const p = spawn(ADB, ['-s', target, 'exec-out', `screencap -p -d ${sfId}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', () => {});
    p.on('error', () => finish(null));
    p.on('close', (code) => {
      const buf = Buffer.concat(out);
      finish(code === 0 && buf.length > 100 ? buf : null);
    });
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} finish(null); }, 20000);
  });
  if (!r) return false;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(dest, r);
  return true;
}

/**
 * 抓一组帧并拼成网格。
 *
 * @param {object} o
 * @param {string} o.sfId        SurfaceFlinger 的 64 位 display id
 * @param {number} [o.frames=9]  抓几帧（会被规整成能拼成矩形格的数量）
 * @param {number} [o.intervalMs=300] 两帧之间的间隔
 * @param {number} [o.cellWidth=262]  每格宽度
 * @param {string} [o.dir='/tmp']     输出目录
 * @returns {{ok:boolean, path?:string, cells?:number, cols?:number, rows?:number,
 *            cellW?:number, cellH?:number, captured?:number, elapsedMs?:number, hint?:string}}
 */
export async function capture({ sfId, frames = 9, intervalMs = 300, cellWidth = 262, dir = '/tmp' } = {}) {
  if (!sfId) return { ok: false, hint: '缺 SurfaceFlinger id，先 vdisplay_start 建屏。' };

  // 规整成矩形：优先 1/2/4/6/9/12/16
  const legal = [1, 2, 4, 6, 9, 12, 16];
  const n = legal.reduce((a, b) => (Math.abs(b - frames) < Math.abs(a - frames) ? b : a), 9);
  const cols = n <= 2 ? n : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const actual = cols * rows;

  const stamp = Date.now();
  const work = join(dir, `vd-timeline-${stamp}`);
  try { await mkdir(work, { recursive: true }); } catch {
    return { ok: false, hint: `建不了目录 ${work}` };
  }

  const target = await adbTarget();
  const t0 = Date.now();
  let captured = 0;
  const files = [];

  for (let i = 0; i < actual; i += 1) {
    const f = join(work, `f${String(i + 1).padStart(2, '0')}.png`);
    // 第一帧不等；之后按 interval 间隔
    if (i > 0 && intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
    const ok = await grabOne(target, sfId, f);
    if (ok) { captured += 1; files.push(f); }
  }

  if (captured === 0) {
    await rm(work, { recursive: true, force: true });
    return { ok: false, hint: '一帧都没抓到。查 vdisplay_status 确认屏还在。' };
  }

  // 用第一帧的真实尺寸算格子高（横竖屏会变）
  let cellH = Math.round(cellWidth * 16 / 9);
  try {
    const b = await readFile(files[0]);
    if (b.length > 24 && b.readUInt32BE(12) === 0x49484452) {
      const w = b.readUInt32BE(16);
      const h = b.readUInt32BE(20);
      if (w > 0 && h > 0) cellH = Math.max(60, Math.round(cellWidth * h / w));
    }
  } catch { /* 用默认比例 */ }

  const out = join(dir, `vd-timeline-${stamp}.png`);

  // ffmpeg 拼图：用 filenames 序列 + tile
  const pattern = join(work, 'f%02d.png');
  const vf = `scale=${cellWidth}:${cellH}:force_original_aspect_ratio=decrease,`
    + `pad=${cellWidth}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=0x121214,tile=${cols}x${rows}`;
  const r = await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', '1', '-start_number', '1',
    '-i', pattern,
    '-vf', vf,
    '-frames:v', '1',
    out,
  ], 60000);

  await rm(work, { recursive: true, force: true });
  await shell(`rm -f /sdcard/vd-timeline-*.png`).catch(() => {});

  if (!r.ok) return { ok: false, hint: `拼图失败：${r.err || r.code}` };

  return {
    ok: true,
    path: out,
    cells: actual,
    captured,
    cols,
    rows,
    cellW: cellWidth,
    cellH,
    canvasW: cellWidth * cols,
    canvasH: cellH * rows,
    elapsedMs: Date.now() - t0,
    intervalMs,
  };
}
