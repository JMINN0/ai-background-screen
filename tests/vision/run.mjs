#!/usr/bin/env node
/**
 * run.mjs — 视觉难度跑分器。
 *
 * 分工：这个脚本负责「布场景 + 抓图 + 记录 ground truth」，
 * 判分（看图对照答案）由模型本人做 —— 脚本没法替它"看"。
 *
 * 每关产出：
 *   /tmp/vision/<case>-<seed>/
 *     single.png    单帧（默认 420 宽，180 token）
 *     native.png    原生分辨率（给 OCR 用）
 *     grid.png      九格连拍（默认，646 token）
 *     truth.json    正确答案
 *
 * 用法：node run.mjs [case ...]
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

/** 取当前有效的 scrcpy 虚拟屏 SF id —— 每次都要重新取，转屏/重建都会变。 */
async function currentSfId() {
  const r = await adbExec(['shell', "dumpsys SurfaceFlinger --display-id 2>/dev/null"]);
  const ids = String(r.out || '').match(/[0-9]{15,}/g) || [];
  return ids.length ? ids[ids.length - 1] : null;
}

/** 抓虚拟屏原生图 */
async function captureNative(sfId, dest) {
  const r = await new Promise((resolve) => {
    const p = spawn(ADB, ['-s', TARGET, 'exec-out', `screencap -p -d ${sfId}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const bufs = [];
    p.stdout.on('data', (d) => bufs.push(d));
    p.stderr.on('data', () => {});
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      const b = Buffer.concat(bufs);
      resolve(code === 0 && b.length > 200 ? b : null);
    });
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(null); }, 25000);
  });
  if (!r) return false;
  const { writeFile: wf } = await import('node:fs/promises');
  await wf(dest, r);
  return true;
}

/** 用 ffmpeg 缩放/拼图 */
function ffmpeg(args) {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-y', '-loglevel', 'error', ...args], { timeout: 60000 }, (err, so, se) => {
      resolve({ ok: !err, err: String(se || err?.message || '') });
    });
  });
}

async function runCase(name, params) {
  const qs = new URLSearchParams({ case: name, ...params }).toString();
  const url = `${BASE}/?${qs}`;
  const dir = join(OUT, `${name}-${params.seed || 1}`);
  await mkdir(dir, { recursive: true });

  // 开页 + 激活（不激活的话触摸/某些渲染会被节流）
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
  await sleep(1200);

  // 读 ground truth（被测 AI 拿不到，只有这里读）
  const truthRaw = await cdp.evaluate(tid, 'return JSON.stringify(window.TRUTH)');
  const truth = JSON.parse(truthRaw);
  await writeFile(join(dir, 'truth.json'), JSON.stringify(truth, null, 2));

  // 尺寸
  const dims = JSON.parse(await cdp.evaluate(tid, 'return JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})'));

  const sfId = await currentSfId();
  if (!sfId) throw new Error('拿不到 SF id');

  // 1. 原生图（OCR 与放大都用它）
  const native = join(dir, 'native.png');
  if (!(await captureNative(sfId, native))) throw new Error('抓原生图失败');

  // 2. 单帧 420 宽（默认交付尺寸，180 token）
  const single = join(dir, 'single.png');
  await ffmpeg(['-i', native, '-vf', 'scale=420:-2', single]);

  // 3. 九格连拍（看运动用，646 token）
  const tmpDir = join(dir, 'frames');
  await mkdir(tmpDir, { recursive: true });
  const frames = [];
  for (let i = 0; i < 9; i += 1) {
    const f = join(tmpDir, `f${String(i + 1).padStart(2, '0')}.png`);
    if (await captureNative(sfId, f)) frames.push(f);
    await sleep(300);
  }
  let grid = null;
  if (frames.length === 9) {
    grid = join(dir, 'grid.png');
    const r = await ffmpeg([
      '-framerate', '1', '-start_number', '1',
      '-i', join(tmpDir, 'f%02d.png'),
      '-vf', 'scale=262:-2:force_original_aspect_ratio=decrease,tile=3x3',
      '-frames:v', '1', grid,
    ]);
    if (!r.ok) grid = null;
  }

  return { case: name, params, dir, truth, dims, native, single, grid, frameCount: frames.length };
}

async function main() {
  const ens = await cdp.ensure();
  if (!ens || ens.ok === false) { console.error('浏览器连不上:', ens?.reason || ens?.error); process.exit(1); }

  const wanted = process.argv.slice(2);
  // 默认跑这五个场景：结构、对比度、运动、小字、噪点
  // 难度档：easy（默认，全部通过）/ extreme（推到头，找崩点）
  const TIER = process.env.VISION_TIER || 'easy';
  const PLANS = {
    easy: [
      ['stack', { n: '5', seed: '1' }],
      ['stack', { n: '8', seed: '3' }],
      ['contrast', { contrast: '0.15', seed: '2' }],
      ['contrast', { contrast: '0.35', seed: '4' }],
      ['motion', { count: '4', seed: '2', speed: '300' }],
      ['motion', { count: '6', seed: '5', speed: '700' }],
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
      console.log(`ok  →  ${r.dir}  (真值: ${JSON.stringify(r.truth.answer)})`);
    } catch (e) {
      console.log(`失败: ${String(e?.message || e).slice(0, 120)}`);
      runs.push({ case: name, params, error: String(e?.message || e).slice(0, 200) });
    }
  }

  await writeFile(join(OUT, 'runs.json'), JSON.stringify(runs, null, 2));
  console.log(`\n共 ${runs.length} 组，已写入 ${join(OUT, 'runs.json')}`);
  console.log('下一步：逐组读 native/single/grid，对照 truth.json 判分。');
}

main().catch((e) => { console.error(e); process.exit(1); });
