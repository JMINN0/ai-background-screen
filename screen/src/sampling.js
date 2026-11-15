/**
 * sampling.js — 按「画面变化量」决定留哪一帧，不是按固定间隔。
 *
 * 为什么需要这一层（对抗竞品分析指出了我们的真实短板）：
 *
 *   老做法是每 300ms 抓一帧，跟内容速度完全无关。后果可以量化：
 *     · 静止画面 → 抓 9 张一模一样的图，白花 2.2 秒抓帧 + 全部 token
 *     · 快动作   → 300ms 一格，中间十几帧的变化全丢
 *   dsh-video-storyboard 从 0.6.0 起就是"真切点分段 + 按累积变化量补采样点"，
 *   我们这一项本来落后，这个模块就是补这块。
 *
 * 做法：以 minGapMs 快抓，每帧先缩到 32×32 灰度跟「上一个留下的帧」比，
 * 累积变化够了才留下当一格。比的是 32×32（3KB）而不是 720×1592（几 MB），
 * 一次比较约 40ms，比"白抓一张图再拼进网格"便宜得多。
 *
 * 两个必须处理的边界：
 *   ① 画面一直不动 → 不能等到超时只留 1 帧就交差，要补"相同帧"把网格填满，
 *      否则模型看到 1 格会以为"只有一瞬间"，实际是"这段时间都一样"。
 *   ② 画面一直在动 → 不能无限抓，有 budgetMs 上限，超了就用手上的帧。
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';

const THUMB = 32;          // 缩略图边长，比较用

/*
 * 阈值是**量出来的**，不是拍的：
 *   同一帧对比      → 0.00000
 *   动画页相邻帧    → 0.0132 / 0.0142（几个黄点在暗背景上移动）
 * 所以静止和运动的分界落在 0 到 0.013 之间。
 *
 * 第一版把 DIFF_KEEP 定成 0.055，比运动信号高 4 倍，结果**动画页被判成静止**
 * （只留 1 帧就收工）—— 这是典型"阈值凭感觉定"的翻车。
 * 取 0.005：留 2.6 倍余量给压缩噪声，同时能抓住 0.013 级的真实运动。
 *
 * 注意：这个尺度下"整屏换页"会是 0.1~0.3，远高于阈值；而"单个小图标闪烁"
 * 可能只有 0.001~0.002，会被当成静止 —— 这是有意的取舍，那种变化不值得占一格。
 */
const DIFF_KEEP = 0.005;
const DIFF_MAX = 0.08;     // 超过这个值说明画面整体换了，必须留下

function spawnCollect(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

/** 把一张图缩成 32×32 灰度，返回 Buffer（1024 字节）或 null */
async function thumb(path) {
  const buf = await spawnCollect('ffmpeg', [
    '-v', 'error', '-i', path,
    '-vf', `scale=${THUMB}:${THUMB}:force_original_aspect_ratio=disable,format=gray`,
    '-frames:v', '1', '-f', 'rawvideo', '-',
  ]);
  return buf && buf.length >= THUMB * THUMB ? buf.subarray(0, THUMB * THUMB) : null;
}

/** 两张缩略图的平均绝对差（0..1） */
function diffRatio(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length * 255);
}

/**
 * 自适应抓帧。
 *
 * @param {object} o
 * @param {(dest:string)=>Promise<boolean>} o.grab  抓一帧到 dest，返回是否成功
 * @param {string} o.dir        工作目录
 * @param {number} o.need       需要几帧（会被填满，用重复帧补）
 * @param {number} [o.minGapMs=100] 两次抓帧之间最短间隔
 * @param {number} [o.maxGapMs=300] 画面一直不变时，最多等这么久就再试一次
 * @param {number} [o.budgetMs=6000] 总时间上限
 * @returns {Promise<{frames:string[], changes:number[], skipped:number, stopReason:string}>}
 */
export async function captureFramesAdaptive({
  grab, dir, need, minGapMs = 100, maxGapMs = 300, budgetMs = 6000,
}) {
  const t0 = Date.now();
  const frames = [];          // 留下的帧路径
  const changes = [];         // 每帧相对上一帧的变化量（0..1）
  const thumbs = [];          // 对应缩略图
  let skipped = 0;            // 因为"没怎么变"被丢掉的帧数
  let stopReason = 'filled';
  let seq = 0;

  while (frames.length < need) {
    if (Date.now() - t0 > budgetMs) { stopReason = 'budget'; break; }

    const dest = join(dir, `s${String(seq + 1).padStart(3, '0')}.png`);
    seq += 1;
    const ok = await grab(dest);
    if (!ok) {
      stopReason = 'grab-failed';
      break;
    }
    const th = await thumb(dest);

    if (frames.length === 0) {
      // 第一帧无条件留下 —— 没有参照物
      frames.push(dest);
      thumbs.push(th);
      changes.push(0);
      await new Promise((r) => setTimeout(r, minGapMs));
      continue;
    }

    const d = diffRatio(thumbs[thumbs.length - 1], th);
    if (d >= DIFF_KEEP || d >= DIFF_MAX) {
      frames.push(dest);
      thumbs.push(th);
      changes.push(Math.round(d * 1000) / 1000);
      await new Promise((r) => setTimeout(r, minGapMs));
    } else {
      // 没怎么变 → 丢掉这张，不占格子
      skipped += 1;
      try { await rm(dest, { force: true }); } catch { /* 删不掉不影响 */ }
      // 但也不能一直干等：太久没变化就再抓一次（万一刚好在变化的间歇）
      await new Promise((r) => setTimeout(r, Math.max(minGapMs, Math.min(maxGapMs, 220))));
      // 连续很多次都没变化，说明真的静止 —— 不用再耗预算，直接补满
      // **按时间判定静止，不按跳过次数。**
      // 按次数的话：每轮 抓帧250 + 缩略40 + 等待220 ≈ 510ms，18 次要 9 秒，
      // 比老的固定间隔（2.2 秒）还慢 —— 实测就是这么翻车的（6.2s 才判定 static）。
      // 静止画面只要 1.2 秒还没出现第二帧，就足以确定它不动了，直接补满收工。
      const elapsed = Date.now() - t0;
      if (frames.length < 2 && elapsed > 1200) {
        stopReason = 'static';
        break;
      }
      // 已经有多帧但连续很多次没变化，也收工（画面进入了静止段）
      if (frames.length >= 2 && skipped >= Math.max(4, need)) {
        stopReason = 'static-tail';
        break;
      }
    }
  }

  // 帧不够就补重复（静止画面正常如此），让网格填满而不是留空格
  if (frames.length === 0) return { frames, changes, skipped, stopReason: 'none' };
  const filled = frames.slice();
  const filledChanges = changes.slice();
  while (filled.length < need) {
    filled.push(frames[frames.length - 1]);
    filledChanges.push(0);
  }
  if (stopReason === 'filled' && skipped > 0) stopReason = 'adaptive';

  return {
    frames: filled,
    changes: filledChanges,
    skipped,
    stopReason,
    elapsedMs: Date.now() - t0,
    distinct: frames.length,
  };
}

export const _internal = { thumb, diffRatio, THUMB, DIFF_KEEP };
