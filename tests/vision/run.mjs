#!/usr/bin/env node
/**
 * run.mjs — 视觉难度跑分器 v2。
 *
 * v1 有两个缺陷，v2 修掉：
 *   ① 运动场景画了拖尾 —— 拖尾把方向编码进了单帧，比真实运动简单
 *   ② 九格里每格带浏览器地址栏 —— 每格约 1/6 是壳，结构和运动结果被高估
 *
 * v2 的抓图设计：**同一场景两条抓法**
 *   cdp.png    Page.captureScreenshot —— 只有渲染内容，无浏览器壳
 *   raw.png    screencap 虚拟屏 —— 带浏览器壳，这是生产环境的真实样子
 * 两条对比可以直接量化"浏览器壳浪费了多少识别能力"，这本身是个有用的数。
 *
 * 分工不变：脚本布场景 + 抓图 + 记真值，判分由模型本人看图做。
 *
 * 用法：
 *   node run.mjs                     # easy 档
 *   VISION_TIER=extreme node run.mjs # 极端档，找崩点
 */

import * as cdp from '../../web/src/cdp.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';

const BASE = process.env.VISION_BASE || 'http://127.0.0.1:3091';
const OUT = '/tmp/vision';
const ADB = process.env.ADB_BIN || 'adb';
const TARGET = process.env.ADB_TARGET || '127.0.0.1:5555';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adbExec(args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(ADB, ['-s', TARGET, ...args], { timeout, maxBuffer: 40 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout, err: String(stderr || err?.message || '') });
    });
  });
}

/** 取当前有效的 scrcpy 虚拟屏 SF id —— 每次重新取，转屏/重建都会变 */
async function currentSfId() {
  const r = await adbExec(['shell', 'dumpsys SurfaceFlinger --display-id 2>/dev/null']);
  const ids = String(r.out || '').match(/[0-9]{15,}/g) || [];
  return ids.length ? ids[ids.length - 1] : null;
}

/** 抓虚拟屏（带浏览器壳，生产真实样子） */
function captureRaw(sfId, dest) {
  return new Promise((resolve) => {
    const p = spawn(ADB, ['-s', TARGET, 'exec-out', `screencap -p -d ${sfId}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const bufs = [];
    p.stdout.on('data', (d) => bufs.push(d));
    p.stderr.on('data', () => {});
    p.on('error', () => resolve(false));
    p.on('close', async (code) => {
      const b = Buffer.concat(bufs);
      if (code !== 0 || b.length < 200) return resolve(false);
      const { writeFile: wf } = await import('node:fs/promises');
      await wf(dest, b);
      resolve(true);
    });
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(false); }, 25000);
  });
}

function ffmpeg(args) {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-y', '-loglevel', 'error', ...args], { timeout: 60000 }, (err, so, se) => {
      resolve({ ok: !err, err: String(se || err?.message || '') });
    });
  });
}

/** 把一组帧拼成 3x3；统一用内容尺寸，不带壳 */
async function tile(frames, dest, cellW = 262) {
  if (frames.length !== 9) return { ok: false, err: `帧数 ${frames.length} != 9` };
  const r = await ffmpeg([
    '-framerate', '1', '-start_number', '1',
    '-i', frames[0].replace(/f\d+\.png$/, 'f%02d.png'),
    '-vf', `scale=${cellW}:-2:force_original_aspect_ratio=decrease,tile=3x3`,
    '-frames:v', '1', dest,
  ]);
  return r;
}

async function runCase(name, params) {
  const qs = new URLSearchParams({ case: name, ...params }).toString();
  const url = `${BASE}/?${qs}`;
  const dir = join(OUT, `${name}-${params.seed || 1}`);
  await mkdir(dir, { recursive: true });

  // 开页 + 激活
  const tabs = await cdp.listAllTabs();
  const hit = tabs.find((t) => t.url && t.url.startsWith(BASE));
  let tid;
  if (hit) {
    await cdp.navigate(hit.targetId, url);
    tid = hit.targetId;
  } else {
    const r = await cdp.openTab(url);
    if (!r.ok) throw new Error('开标签失败');
    await sleep(400);
    const t2 = (await cdp.listAllTabs()).find((t) => t.url && t.url.startsWith(BASE));
    if (!t2) throw new Error('找不到标签');
    tid = t2.targetId;
  }
  const { send } = await import('../../web/src/cdp.js');
  await send(tid, 'Target.activateTarget', { targetId: tid }).catch(() => {});
  await sleep(1000);

  // ground truth（只有这里读，被测 AI 拿不到）
  const truth = JSON.parse(await cdp.evaluate(tid, 'return JSON.stringify(window.TRUTH)'));
  await writeFile(join(dir, 'truth.json'), JSON.stringify(truth, null, 2));

  const dims = JSON.parse(await cdp.evaluate(tid, 'return JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})'));

  // ① CDP 截图：只有渲染内容
  const cdpShot = await cdp.screenshot(tid, dir);
  const cdpPng = cdpShot.path;

  // ② screencap：带浏览器壳（生产真实样子）
  const sfId = await currentSfId();
  if (!sfId) throw new Error('拿不到 SF id');
  const rawPng = join(dir, 'raw.png');
  const rawOk = await captureRaw(sfId, rawPng);

  // ③ 从 CDP 内容图派生：单帧 420 宽（180 token 交付尺寸）
  const single = join(dir, 'single.png');
  await ffmpeg(['-i', cdpPng, '-vf', 'scale=420:-2', single]);

  // ④ 九格连拍：两条路径各拼一张，对比壳的影响
  const framesDir = join(dir, 'frames');
  await mkdir(framesDir, { recursive: true });
  const frames = [];
  for (let i = 0; i < 9; i += 1) {
    try {
      const s = await cdp.screenshot(tid, framesDir);
      const dst = join(framesDir, `f${String(i + 1).padStart(2, '0')}.png`);
      await ffmpeg(['-i', s.path, dst]);
      frames.push(dst);
    } catch { /* 跳过 */ }
    await sleep(280);
  }
  let grid = null;
  if (frames.length === 9) {
    grid = join(dir, 'grid.png');
    const r = await ffmpeg([
      '-framerate', '1', '-start_number', '1',
      '-i', join(framesDir, 'f%02d.png'),
      '-vf', 'scale=262:-2:force_original_aspect_ratio=decrease,tile=3x3',
      '-frames:v', '1', grid,
    ]);
    if (!r.ok) grid = null;
  }

  // 尺寸信息（算 token 用）
  const { execFileSync } = await import('node:child_process');
  const dim = (p) => {
    try {
      const o = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0', p], { timeout: 10000 }).toString().trim();
      const [w, h] = o.split(',').map(Number);
      return { w, h, tokens: Math.ceil(w / 42) * Math.ceil(h / 42) };
    } catch { return null; }
  };

  return {
    case: name, params, dir, truth, dims,
    files: { cdp: cdpPng, raw: rawOk ? rawPng : null, single, grid },
    sizes: { cdp: dim(cdpPng), raw: rawOk ? dim(rawPng) : null, single: dim(single), grid: grid ? dim(grid) : null },
    frameCount: frames.length,
  };
}

async function main() {
  const ens = await cdp.ensure();
  if (!ens || ens.ok === false) { console.error('浏览器连不上:', ens?.reason || ens?.error); process.exit(1); }

  const wanted = process.argv.slice(2);
  const TIER = process.env.VISION_TIER || 'easy';
  const PLANS = {
    easy: [
      ['stack', { n: '5', seed: '1' }],
      ['stack', { n: '8', seed: '3' }],
      ['contrast', { contrast: '0.15', seed: '2' }],
      ['contrast', { contrast: '0.35', seed: '4' }],
      ['motion', { count: '4', seed: '2', speed: '300', notrail: '1' }],
      ['motion', { count: '6', seed: '5', speed: '700', notrail: '1' }],
      ['hud', { font: '22', seed: '6' }],
      ['hud', { font: '12', seed: '7' }],
      ['noise', { font: '20', seed: '8' }],
    ],
    extreme: [
      ['hud', { font: '8', seed: '11' }],
      ['hud', { font: '6', seed: '12' }],
      ['contrast', { contrast: '0.06', seed: '13' }],
      ['contrast', { contrast: '0.03', seed: '14' }],
      ['stack', { n: '16', seed: '15' }],
      ['stack', { n: '24', seed: '16' }],
      ['motion', { count: '6', seed: '17', speed: '1400', notrail: '1' }],
    ],
  };
  const plan = (PLANS[TIER] || PLANS.easy).filter(([c]) => !wanted.length || wanted.includes(c));

  const runs = [];
  for (const [name, params] of plan) {
    process.stdout.write(`── ${name} ${JSON.stringify(params)} … `);
    try {
      const r = await runCase(name, params);
      runs.push(r);
      const sz = r.sizes;
      console.log(`ok  真值=${JSON.stringify(r.truth.answer)}`);
      console.log(`        内容图 ${sz.cdp?.w}x${sz.cdp?.h}(${sz.cdp?.tokens}tok)  虚拟屏 ${sz.raw?.w}x${sz.raw?.h}(${sz.raw?.tokens}tok)  单帧420=${sz.single?.tokens}tok  九格=${sz.grid?.tokens ?? '—'}tok`);
    } catch (e) {
      console.log(`失败: ${String(e?.message || e).slice(0, 120)}`);
      runs.push({ case: name, params, error: String(e?.message || e).slice(0, 200) });
    }
  }

  await writeFile(join(OUT, 'runs.json'), JSON.stringify(runs, null, 2));
  console.log(`\n共 ${runs.length} 组 → ${join(OUT, 'runs.json')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
