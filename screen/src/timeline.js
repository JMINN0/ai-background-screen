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
import { adb, shell, focusedApp } from './vd.js';
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
 * 问浏览器「页面内容真实占据多高」，用来裁掉浏览器外壳。
 *
 * 为什么需要：Edge/Chrome 在虚拟屏上都带地址栏和导航栏，实测 720x1592 的截图里
 * 内容只有 1372 高（壳 220px = 13%）。这些像素照样按 token 计费，九格里也一样浪费。
 *
 * 为什么不用硬编码：壳的高度随浏览器版本、DPI、是否全屏变化。`Page.getLayoutMetrics`
 * 返回的 `layoutViewport.clientHeight` 是权威值，浏览器自己算的。
 *
 * 拿不到（没开 CDP、不是浏览器、报错）就返回 null，调用方按原图处理 —— 不能因为
 * 这个增强失败就把截图也搞坏。
 */
/**
 * 问浏览器「页面内容真实占据多高」，用来裁掉浏览器外壳。
 *
 * **三条必须同时满足才返回结果，任何一条不满足就返回 null（不裁）：**
 *
 * ① 虚拟屏前台必须真的是浏览器。**这是致命的一条** —— 不校验的话，用户在虚拟屏上
 *    开着游戏/微信、而 Edge 只是把某个本机页面挂在后台，照样会按 220px 去裁，
 *    把普通 App 的底部静默切掉。对抗审查给的两张 720x1372 产出图就是这个 bug，
 *    源图是全黑的、根本没有浏览器。
 *
 * ② 用 `cssLayoutViewport` 而不是 `layoutViewport`。后者协议里标了 deprecated：
 *    "Can be in DP or in CSS pixels depending on the enable-use-zoom-for-dsf flag"。
 *    这台机器上 layoutViewport=1372（设备像素）、cssLayoutViewport=686（CSS 像素）、
 *    dpr=2，今天恰好对；但那个 flag 一变，同一个值会从 1372 变成 686，
 *    cropPx 从 220 变成 906，直接切掉一半内容。
 *    用 `css.clientHeight * fullW / css.clientWidth` 换算，跟 DPR、pinch、
 *    zoom-for-dsf 开关全部无关。
 *
 * ③ 挑当前可见的那个标签，不按 URL 白名单挑。按 `127.0.0.1:3xxx` 匹配的话，
 *    虚拟屏上开真实网站时永远匹配不到，crop 会静默失效、还拿不到那 13%。
 *
 * @param {number} fullW 整屏截图的宽度（设备像素），用来把 CSS 高度换算成设备像素
 * @returns {Promise<{height:number, url:string, browser:string}|null>}
 */
export async function contentHeight(fullW = 0) {
  try {
    const cdp = await import('../../web/src/cdp.js');
    const ens = await cdp.ensure();
    if (!ens || ens.ok === false) return null;

    const { send } = await cdp;
    // 挑可见标签：visibilityState === 'visible' 且不是 devtools/扩展页
    const tabs = await cdp.listAllTabs();
    let target = null;
    for (const t of tabs) {
      if (!t.url || !/^https?:|^file:/.test(t.url)) continue;
      try {
        const v = await cdp.evaluate(t.targetId, "return document.visibilityState");
        if (v === 'visible') { target = t; break; }
      } catch { /* 这个标签取不到，试下一个 */ }
    }
    if (!target) return null;

    const m = await send(target.targetId, 'Page.getLayoutMetrics', {});
    const res = m?.result ?? m;
    const css = res?.cssLayoutViewport;
    if (!css || !(css.clientWidth > 0) || !(css.clientHeight > 0)) return null;

    // 换算成设备像素：不管 css 用的是 DP 还是 CSS px，比例都是对的
    const ratio = fullW > 0 ? fullW / css.clientWidth : 1;
    const height = Math.round(css.clientHeight * ratio);
    if (height < 200) return null;

    return { height, url: target.url, browser: ens.browser || '' };
  } catch {
    return null;
  }
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
export async function capture({ sfId, frames = 9, intervalMs = 300, cellWidth = 262, dir = '/tmp', crop = 'none' } = {}) {
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

  /*
   * **按变化采样，不是按固定间隔。**
   *
   * 老做法是每 intervalMs 抓一帧，跟内容速度无关：
   *   · 静止画面 → 抓 N 张一样的图，白花 2 秒 + 全部 token
   *   · 快动作   → 300ms 一格，中间十几帧的变化全丢
   * dsh-video-storyboard 从 0.6.0 起就是按"累积画面变化量"补采样点，
   * 我们这一项本来是落后的（对抗分析指出），这里补上。
   *
   * 做法：以 minGapMs 为最小间隔快抓，每帧先缩到 32x32 灰度跟上一帧比，
   * 累积变化超过阈值才留下来当一格；够数就停，超时也停。
   * 32x32 的比较成本约 40ms，换掉的是"白抓一张 720x1592 存盘再拼进图"。
   */
  const { captureFramesAdaptive } = await import('./sampling.js');
  const sampled = await captureFramesAdaptive({
    grab: async (dest) => grabOne(target, sfId, dest),
    dir: work,
    need: actual,
    minGapMs: 0,   // 只留变化的帧，所以不用人为间隔，抓得越快越好（实测 gap=0 比 80ms 快 0.6 秒）
    maxGapMs: intervalMs,
    budgetMs: Math.min(6000, 500 + actual * (intervalMs + 260)),
  });
  captured = sampled.frames.length;
  files.push(...sampled.frames);



  if (captured === 0) {
    await rm(work, { recursive: true, force: true });
    return { ok: false, hint: '一帧都没抓到。查 vdisplay_status 确认屏还在。' };
  }

  // 用第一帧的真实尺寸算格子高（横竖屏会变）。
  // **crop=content 时必须先算出裁剪量再算格子高** —— 否则内容被裁了、格子还是按原高度算，
  // 结果只是把内容缩小塞进原来的格子，token 一分不省（第一版就犯了这个错）。
  let cellH = Math.round(cellWidth * 16 / 9);
  let fullW = 0;
  let fullH = 0;
  try {
    const b = await readFile(files[0]);
    if (b.length > 24 && b.readUInt32BE(12) === 0x49484452) {
      fullW = b.readUInt32BE(16);
      fullH = b.readUInt32BE(20);
    }
  } catch { /* 用默认比例 */ }

  let cropPx = 0;
  let cropNote = '';
  if (crop === 'content' && fullH > 200) {
    // **必须验前台是不是浏览器**：不验的话虚拟屏上开着游戏/微信时，
    // 会按浏览器壳的高度把 App 底部切掉（对抗审查给出的致命 bug）。
    const BROWSE_RE = /emmx|chrome|browser|quark|ucmobile|sogou|baidu\.searchbox|firefox/i;
    let focus = '';
    try { focus = await focusedApp(); } catch { focus = ''; }
    if (!BROWSE_RE.test(String(focus || ''))) {
      cropNote = `前台是「${focus || '未知'}」，不是浏览器，未裁剪`;
    } else {
      const ch = await contentHeight(fullW);
      if (ch && ch.height > 200 && ch.height < fullH - 20) {
        // 偶数化：奇数高度会让某些编码器报 "height not divisible by 2"
        const rawCrop = fullH - ch.height;
        cropPx = rawCrop % 2 ? rawCrop + 1 : rawCrop;
      }
    }
  }

  const effH = fullH > 0 ? fullH - cropPx : 0;
  if (fullW > 0 && effH > 0) {
    cellH = Math.max(60, Math.round(cellWidth * effH / fullW));
  }

  const out = join(dir, `vd-timeline-${stamp}.png`);

  // ffmpeg 拼图：用 filenames 序列 + tile
  // 采样器产出的是 s001..sNNN，而且可能含重复帧（静止画面用重复帧填满网格），
  // 所以不能靠 ffmpeg 的通配符读，先按顺序复制成 f01..fNN 再拼。
  const { copyFile } = await import('node:fs/promises');
  const seqFiles = [];
  for (let k = 0; k < files.length; k += 1) {
    const dst = join(work, `f${String(k + 1).padStart(2, '0')}.png`);
    try { await copyFile(files[k], dst); seqFiles.push(dst); } catch { /* 跳过 */ }
  }
  if (seqFiles.length < cols * rows) {
    await rm(work, { recursive: true, force: true });
    return { ok: false, hint: `只凑到 ${seqFiles.length} 帧（需要 ${cols * rows}）。` };
  }

  const pattern = join(work, 'f%02d.png');
  const pre = cropPx > 0 ? `crop=iw:ih-${cropPx}:0:0,` : '';
  const vf = `${pre}scale=${cellWidth}:${cellH}:force_original_aspect_ratio=decrease,`
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
    croppedPx: cropPx,
    cropNote,
  };
}
