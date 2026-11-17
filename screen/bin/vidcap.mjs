#!/usr/bin/env node
/**
 * vidcap.mjs —— 从虚拟屏抓视频帧（绕开 scrcpy 视频流的冻结问题）
 *
 * ## 为什么需要它
 *
 * scrcpy 的 H.264 镜像流在播放视频时会冻住（只出第一帧），
 * 但**虚拟屏本身在正常渲染** —— 实测 `screencap -d <SFID>` 连拍 10 帧，
 * 连续 9 对差异 2.26-2.75（静态 UI 会是 0.00）。
 *
 * 所以抓帧不要走 scrcpy 流，走 screencap。
 *
 * ## 关键陷阱：screencap -d 要 SurfaceFlinger ID，不是逻辑 displayId
 *
 * ```
 * $ screencap -p -d 354
 * Failed to take screenshot. Display Id '354' is not valid.
 * $ screencap -p -d 0        # 连主屏的 0 都不认
 * Failed to take screenshot. Display Id '0' is not valid.
 * ```
 *
 * 要的是 19 位大数（如 11529215048879975052），也就是 vd.start() 返回的 `sfId`。
 *
 * ## 用法
 *
 * ```bash
 * node bin/vidcap.mjs --frames 10 --interval 400      # 抓 10 帧，间隔 400ms
 * node bin/vidcap.mjs --seconds 5 --fps 7             # 抓 5 秒，约 7fps
 * ```
 *
 * 产物在 `--out`（默认 /tmp/vidcap）：f01.png...，可直接读或 OCR。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as vd from '../src/vd.js';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const outDir = arg('out', '/tmp/vidcap');
const frames = Number(arg('frames', 0));
const interval = Number(arg('interval', 400));
const seconds = Number(arg('seconds', 0));
const n = frames || (seconds ? Math.round(seconds * 1000 / interval) : 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cap = (sfid) => spawnSync(
  'adb',
  ['-s', process.env.ADB_TARGET || '127.0.0.1:5555', 'exec-out', `screencap -p -d ${sfid}`],
  { maxBuffer: 64 << 20 },
).stdout;

const main = async () => {
  const r = await vd.start({ maxFps: 30 });
  const sfid = r.sfId;
  if (!sfid) {
    console.error('拿不到 SurfaceFlinger id，vidcap 无法工作。');
    process.exit(1);
  }
  console.log(`虚拟屏 displayId=${r.displayId}  SFID=${sfid}`);
  console.log(`抓 ${n} 帧，间隔 ${interval}ms → ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  const sizes = [];
  for (let i = 1; i <= n; i += 1) {
    const buf = cap(sfid);
    const p = `${outDir}/f${String(i).padStart(2, '0')}.png`;
    writeFileSync(p, buf);
    sizes.push(buf.length);
    console.log(`  f${String(i).padStart(2, '0')}.png  ${buf.length} 字节`);
    if (i < n) await sleep(interval);
  }
  const uniq = new Set(sizes).size;
  console.log('');
  console.log(`  不同大小 ${uniq}/${n} —— 变化越多说明画面在动得越厉害`);
  if (uniq === 1) console.log('  ⚠️ 全部一样大小，画面可能是静止的（也可能只是恰好同尺寸）');
};

main().catch((e) => { console.error(e.message); process.exit(1); });
