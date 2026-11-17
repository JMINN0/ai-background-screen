#!/usr/bin/env node
/**
 * aim.mjs —— 把「我点在哪」和「目标在哪」画出来，让自己看得见偏移
 *
 * ## 为什么需要它
 *
 * 盲点会点空，而点空之后没有任何反馈 —— 你只看到「没反应」，分不清是
 * 坐标错了、按钮不可点、还是根本没送达。
 *
 * 这个工具做三件事：
 *   ① 在截图上用**红色十字**标出实际点击的位置
 *   ② 用**绿色框**标出 OCR 找到的目标（如果给了 --text）
 *   ③ 点击后测量画面变化的 bbox，算出**偏移量**
 *
 * 于是偏差从「猜」变成「看」。
 *
 * ## 用法
 *
 * ```bash
 * # 点 OCR 找到的「WLAN」，并把点击点/目标框/偏移都画出来
 * node bin/aim.mjs --text WLAN
 *
 * # 点指定归一化坐标
 * node bin/aim.mjs --nx 0.5 --ny 0.5
 *
 * # 只看不点（干跑，不触发任何按钮）
 * node bin/aim.mjs --text WLAN --dry
 *
 * # 自己起 App 再瞄（虚拟屏跟进程同生共死，所以要在同一个进程里）
 * node bin/aim.mjs --pkg com.android.settings/.Settings --text WLAN
 * ```
 *
 * 产物：`/tmp/aim-<时间>.png` —— 直接用 read_image 看。
 */

import * as vd from '../src/vd.js';
import * as T from '../src/tools.js';
import { spawnSync, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

const targetText = arg('text', '');
let nx = Number(arg('nx', ''));
let ny = Number(arg('ny', ''));
const dry = flag('dry');
const pkg = arg('pkg', '');
const waitMs = Number(arg('wait', '5000'));
const outDir = arg('out', '/tmp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p = (s) => console.log('  ' + s);

// 从虚拟屏截一张原始 PNG（用 SFID，这是唯一能拿到虚拟屏画面的方式）
function capRaw(sfid) {
  const r = spawnSync('adb', ['-s', process.env.ADB_TARGET || '127.0.0.1:5555',
    'exec-out', `screencap -p -d ${sfid}`], { maxBuffer: 64 << 20 });
  return r.stdout;
}

const main = async () => {
  const v = await vd.start({ orientation: 'landscape', maxFps: 30 });
  const { displayId: did, sfId, width: W, height: H } = v;
  p(`虚拟屏 ${did}  ${W}x${H}`);

  // ⓪ 启动目标 App（虚拟屏跟进程同生共死，所以必须在本进程里起）
  if (pkg) {
    const act = arg('activity', '');
    const target = act ? `${pkg}/${act}` : pkg;
    await vd.shell(`am start --display ${did} -n ${target}`).catch(() => {});
    p(`已启动 ${target}，等 ${waitMs}ms`);
    await sleep(waitMs);
  }

  // ① 找目标
  let box = null;
  if (targetText) {
    const t = await T.text({ maxLines: 60 });
    for (const line of String(t.text).split('\n')) {
      if (line.includes(targetText)) {
        const m = line.match(/nx=([\d.]+)\s+ny=([\d.]+)/);
        const bx = line.match(/\((\s*\d+),\s*(\d+)\)\s+(\d+)x(\d+)/);
        if (m) {
          nx = Number(m[1]);
          ny = Number(m[2]);
          if (bx) box = { x: +bx[1], y: +bx[2], w: +bx[3], h: +bx[4] };
          p(`OCR 找到「${targetText}」→ nx=${nx} ny=${ny}` + (box ? `  框 (${box.x},${box.y}) ${box.w}x${box.h}` : ''));
          break;
        }
      }
    }
    if (!Number.isFinite(nx)) {
      p(`❌ OCR 没找到「${targetText}」`);
      p('页面上识别到的文字：');
      for (const line of String(t.text).split('\n').slice(3, 18)) {
        const m = line.match(/nx=([\d.]+)\s+ny=([\d.]+)/);
        if (m) p('    ' + line.trim().slice(-50));
      }
      process.exit(1);
    }
  }
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    p('需要 --text 或 --nx/--ny');
    process.exit(1);
  }

  const px = Math.round(nx * W);
  const py = Math.round(ny * H);
  p(`点击点 (${px}, ${py})  ← 归一化 (${nx}, ${ny})`);

  // ② 点击前截图
  const before = capRaw(sfId);
  writeFileSync(`${outDir}/aim-before.png`, before);

  if (dry) {
    p('干跑模式：不点击');
  } else {
    // ③ 点击 + 采样变化
    const watch = vd.watchFrames(2000, 40);
    await sleep(80);
    await vd.input('tap', { nx, ny, verify: false });
    const tl = await watch;
    p(`点击后：${tl.totalFrames} 帧变化，${tl.bursts.length} 段`);
    for (const b of tl.bursts) p(`  ${b.startMs}ms→${b.endMs}ms (${b.endMs - b.startMs}ms)`);
    await sleep(600);
  }

  // ④ 点击后截图
  const after = capRaw(sfId);
  writeFileSync(`${outDir}/aim-after.png`, after);

  // ⑤ 画标注
  const py3 = `
import sys
from PIL import Image, ImageDraw, ImageFont
import numpy as np

W,H = ${W},${H}
px,py = ${px},${py}
box = ${box ? JSON.stringify(box) : 'None'}
out = "${outDir}/aim-annotated.png"

def draw_marks(img, label):
    im = img.convert("RGB")
    d = ImageDraw.Draw(im)
    # 红色十字 = 我点的位置
    r = max(18, int(min(W,H)*0.03))
    d.ellipse([px-r, py-r, px+r, py+r], outline=(255,40,40), width=5)
    d.line([px-r*2, py, px+r*2, py], fill=(255,40,40), width=3)
    d.line([px, py-r*2, px, py+r*2], fill=(255,40,40), width=3)
    # 绿色框 = OCR 找到的目标
    if box:
        d.rectangle([box["x"], box["y"], box["x"]+box["w"], box["y"]+box["h"]], outline=(40,255,40), width=4)
        cx, cy = box["x"]+box["w"]//2, box["y"]+box["h"]//2
        d.ellipse([cx-6,cy-6,cx+6,cy+6], fill=(40,255,40))
        off = (px-cx, py-cy)
        d.text((8, 8), f"{label} click=({px},{py}) target=({cx},{cy}) offset={off[0]},{off[1]}", fill=(255,255,0))
    else:
        d.text((8, 8), f"{label} click=({px},{py})", fill=(255,255,0))
    return im

a = Image.open("${outDir}/aim-before.png")
b = Image.open("${outDir}/aim-after.png")
ia = draw_marks(a, "BEFORE")
ib = draw_marks(b, "AFTER")

# 上下拼起来
canvas = Image.new("RGB", (W, H*2+10), (30,30,30))
canvas.paste(ia, (0,0))
canvas.paste(ib, (0,H+10))
canvas.save(out)

# 算实际变化 bbox（用 after 和 before 的差）
na = np.array(a.convert("L"), dtype=float)
nb = np.array(b.convert("L"), dtype=float)
diff = np.abs(na-nb)
mask = diff > 18
print(f"  变化的像素 {mask.sum()} 个 ({100*mask.sum()/mask.size:.2f}%)")
pct = 100*mask.sum()/mask.size
if mask.sum() > 100:
    ys, xs = np.where(mask)
    bx0,bx1,by0,by1 = xs.min(), xs.max(), ys.min(), ys.max()
    cxn, cyn = int((bx0+bx1)/2), int((by0+by1)/2)
    print(f"  变化区域 bbox=({bx0},{by0})-({bx1},{by1}) 质心≈({cxn},{cyn})")
    # **区分局部变化和全局变化**
    if pct > 25:
        print(f"  → 全局变化（{pct:.1f}% 像素）—— 页面跳转了，点击**生效**")
        print("     导航类变化没法用来算偏移（全屏都在动），但跳转本身就是成功证据")
    else:
        print(f"  → 局部变化（{pct:.1f}% 像素）—— 可以用来校准偏移")
        if box:
            tcx, tcy = box["x"]+box["w"]//2, box["y"]+box["h"]//2
            print(f"     变化质心 vs 目标中心: ({cxn-tcx:+d}, {cyn-tcy:+d})")
        print(f"     变化质心 vs 我的点击点: ({cxn-px:+d}, {cyn-py:+d})")
        dx, dy = cxn-px, cyn-py
        if abs(dx) > 8 or abs(dy) > 8:
            print(f"     ⚠️ 偏移较大，建议下次点击补偿 ({-dx:+d}, {-dy:+d})")
        else:
            print(f"     ✅ 偏移很小（{dx:+d},{dy:+d}），坐标可信")
else:
    print("  ⚠️ 几乎没有变化：可能点空了 / 按钮无视觉反馈（开关类）/ 或者异步还没渲染完")
    print("     下一步：换 --dry 看瞄准是否正确，或加长等待再截")

print(f"  标注图: {out}")
`;
  try {
    writeFileSync(`${outDir}/aim-draw.py`, py3);
    const r = execSync(`python3 ${outDir}/aim-draw.py`, { encoding: 'utf-8' });
    process.stdout.write(r);
  } catch (e) {
    p('画图失败：' + (e.message || '').slice(0, 300));
  }

  if (!dry) await vd.stop();
  process.exit(0);
};

main().catch((e) => { console.error(e.message); process.exit(1); });
