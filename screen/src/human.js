/**
 * 拟人化输入：用 `input motionevent` 编排接近真人的触摸事件。
 *
 * 为什么不用 `input tap`（2026-11-12 实测）：
 *   tap 只产生 DOWN+UP 两个事件，没有 MOVE，压力恒定，时长固定。
 *   风控靶场能直接判定「click-without-mousedown」「零轨迹」。
 *
 * 为什么用批量（同样实测）：
 *   单个事件分次调 adb，每次 55-199ms（adb 往返 + JVM 启动）；
 *   一条 adb shell 里用 `;` 串起来 **4 个事件只要 105ms，平均 26ms/个**。
 *   26ms/事件 正好落进真人点击的采样节奏里，所以能编排出看起来自然的序列。
 *
 * 真人的特征（本模块据此建模）：
 *   · 落点不会每次一样        → 截断高斯，σ = 目标尺寸的 15~25%
 *   · 按下时间不会一样        → 对数正态，中位 ~90ms
 *   · 手指是移动的不是瞬移的  → 最小加加速度轨迹 + 横向抖动 + 偶尔 overshoot
 *   · 压力先升后稳            → --axis PRESSURE 沿轨迹变化
 *   · 动作之间有"思考"时间    → 对数正态，中位 1.2~2.5s
 *
 * 做不到的（如实记录，不要吹）：
 *   · `isTrusted` 永远是 false —— 这是内核层标记，只有真实手指或 uinput 设备才是 true
 *   · `sendevent` 写真实触摸屏被 SELinux 禁止（实测 Permission denied）
 *   · `/dev/uinput` 需要 root（实测写入失败）
 *   所以「和真人无法区分」做不到，只能做到「行为分布像人」。
 */

/** 高斯随机数（Box-Muller）。 */
function gauss(mean = 0, sd = 1) {
  let u = 0; let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 对数正态：真人的反应时间/点击间隔是这种分布，不是均匀分布。 */
function lognorm(median, sigma = 0.5) {
  return Math.exp(Math.log(median) + sigma * gauss(0, 1));
}

/** 截断到区间内。 */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 最小加加速度（minimum jerk）轨迹 —— 人手运动的经典模型。
 *
 * 和纯贝塞尔的关键区别：它同时约束了位置和速度剖面，
 * 起步慢、中段快、末端减速，而贝塞尔只保证曲线形状好看。
 *
 * @param {number} n 采样点数
 * @returns {number[]} 每个采样点的归一化进度 0..1
 */
function minJerk(n) {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    out.push(10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5);
  }
  return out;
}

/**
 * 生成一次点击的完整事件序列（不含时序 sleep，时序由调用方插入）。
 *
 * @param {number} x 目标中心 x
 * @param {number} y 目标中心 y
 * @param {object} o
 * @param {number} [o.size=100] 目标大致尺寸（像素），决定落点散布
 * @param {number} [o.jitterPx] 手抖幅度，默认按 size 的 2%
 * @param {number} [o.moves] MOVE 事件数量，默认随机 1~3
 * @returns {{events: Array<{action: string, x: number, y: number, pressure: number}>, holdMs: number}}
 */
export function buildTap(x, y, o = {}) {
  const size = o.size || 100;
  // 落点散布：真人不会每次点正中，σ 取目标的 15~25%
  const sigma = size * (0.15 + Math.random() * 0.1);
  let cx = clamp(x + gauss(0, sigma / 2), x - size / 2, x + size / 2);
  let cy = clamp(y + gauss(0, sigma / 2), y - size / 2, y + size / 2);

  // 系统偏差：右手用户整体偏右下（有研究支持，差 2~5px 量级）
  if (Math.random() < 0.7) {
    cx += 1 + Math.random() * 3;
    cy += 1 + Math.random() * 3;
  }

  const moves = o.moves ?? (1 + Math.floor(Math.random() * 3));
  const jitterPx = o.jitterPx ?? Math.max(1, size * 0.02);
  const events = [];

  // DOWN —— 真人按下瞬间压力就起来了，但不是满值
  let px = cx;
  let py = cy;
  events.push({ action: 'DOWN', x: Math.round(px), y: Math.round(py), pressure: 0.25 + Math.random() * 0.2 });

  // 按下期间的微移：手指不是完全静止的
  for (let i = 0; i < moves; i += 1) {
    px = clamp(px + gauss(0, jitterPx), cx - size / 3, cx + size / 3);
    py = clamp(py + gauss(0, jitterPx), cy - size / 3, cy + size / 3);
    // 压力先升后稳
    const p = 0.45 + (i / Math.max(1, moves)) * 0.3 + Math.random() * 0.1;
    events.push({ action: 'MOVE', x: Math.round(px), y: Math.round(py), pressure: clamp(p, 0.3, 0.95) });
  }

  // UP —— 抬手压力回落
  events.push({ action: 'UP', x: Math.round(px), y: Math.round(py), pressure: 0.1 + Math.random() * 0.15 });

  // 按下总时长：真人 60~140ms，用对数正态
  const holdMs = clamp(lognorm(95, 0.35), 55, 180);
  return { events, holdMs };
}

/**
 * 生成一次滑动的完整事件序列。
 *
 * @param {number} x1 起点 x
 * @param {number} y1 起点 y
 * @param {number} x2 终点 x
 * @param {number} y2 终点 y
 * @param {object} o
 * @param {number} [o.points=40] 采样点数量
 * @param {number} [o.overshoot=0.3] 产生 overshoot 的概率
 * @returns {{events: Array, durationMs: number}}
 */
export function buildSwipe(x1, y1, x2, y2, o = {}) {
  const points = o.points ?? (30 + Math.floor(Math.random() * 50));
  const curve = minJerk(points);

  // 轨迹整体加一个横向弯曲（真人不会走直线），弯曲方向随机。
  //
  // **幅度必须跟路径长度成比例**（2026-11-12 实测）：原来写死 gauss(0, 12) 像素，
  // 对 60px 的短移动够用，对 200px 的移动就几乎是一条直线 ——
  // 靶场算出来的直线度会在 0.92~0.99 之间飘，一半的点击直接判失败。
  // 改成路径长度的 12%~30%，直线度稳定落在 0.7~0.85。
  const pathLen = Math.hypot(x2 - x1, y2 - y1) || 1;
  const bendMag = pathLen * (0.20 + Math.random() * 0.16);
  const bend = (Math.random() < 0.5 ? -1 : 1) * bendMag;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;   // 法向量
  const ny = dx / len;

  const events = [];
  let ox = 0;
  let oy = 0;

  // overshoot：真人经常冲过头一点再往回拉
  const willOvershoot = Math.random() < (o.overshoot ?? 0.3);
  if (willOvershoot) {
    const over = 5 + Math.random() * 10;
    ox = (dx / len) * over;
    oy = (dy / len) * over;
  }

  events.push({
    action: 'DOWN',
    x: Math.round(x1 + gauss(0, 3)),
    y: Math.round(y1 + gauss(0, 3)),
    pressure: 0.3 + Math.random() * 0.2,
  });

  for (let i = 0; i < points; i += 1) {
    const t = curve[i];
    // 横向弯曲在中间最大
    const bow = Math.sin(Math.PI * t) * bend;
    const jx = gauss(0, 1.5);
    const jy = gauss(0, 1.5);
    const px = x1 + dx * t + nx * bow + ox * (t > 0.85 ? (1 - t) / 0.15 : 1) + jx;
    const py = y1 + dy * t + ny * bow + oy * (t > 0.85 ? (1 - t) / 0.15 : 1) + jy;
    events.push({
      action: 'MOVE',
      x: Math.round(px),
      y: Math.round(py),
      pressure: clamp(0.4 + Math.sin(Math.PI * t) * 0.35 + gauss(0, 0.05), 0.25, 0.95),
    });
  }

  events.push({
    action: 'UP',
    x: Math.round(x2 + gauss(0, 2)),
    y: Math.round(y2 + gauss(0, 2)),
    pressure: 0.1 + Math.random() * 0.15,
  });

  // 真人滑动时长与距离相关：大致 200~800ms
  const durationMs = clamp(lognorm(320 + len * 0.35, 0.3), 180, 1200);
  return { events, durationMs };
}

/**
 * 把事件序列编成一条 adb shell 命令。
 *
 * 用 `;` 串在**同一次 adb shell 调用**里 —— 实测 4 个事件 105ms，
 * 比逐个调 adb（每次 55~199ms）快一个数量级，而且这样事件间隔才可能像真人。
 */
export function toShellCommand(events, opts = {}) {
  const displayArg = opts.displayId != null ? `-d ${Number(opts.displayId)} ` : '';
  return events.map((e) => {
    const parts = [`input ${displayArg}motionevent ${e.action} ${e.x} ${e.y}`];
    if (e.pressure != null && e.pressure > 0) {
      parts[0] += ` --axis PRESSURE,${e.pressure.toFixed(2)}`;
    }
    return parts[0];
  }).join('; ');
}

/** 一段随机"思考"时间（毫秒），真人操作前会有停顿。 */
export function thinkDelay(median = 1600) {
  return Math.round(clamp(lognorm(median, 0.5), 300, 9000));
}

/**
 * 鼠标移动之间的延迟 —— **双峰分布**，不是均匀也不是单一对数正态。
 *
 * 为什么要双峰（2026-11-12 实测）：浏览器把 mousemove 对齐到渲染帧（60fps = 16.7ms），
 * 所以实际测到的间隔全是 16.7 的整数倍：`[100, 83, 117, 66, 100, 67, ...]`。
 * 如果延迟都挤在 55ms 附近，量化后只剩 4-7 帧可选，变异系数被压在 0.20 左右，
 * 风控直接判「太规律像机器」（阈值 > 0.25）。
 *
 * 真人不会匀速移动：有一段快速逼近，也会在中途停顿一下再修正。
 * 所以这里用双峰——大部分是快速移动，小部分是明显停顿：
 *   65% 概率：20~45ms（连续移动）
 *   35% 概率：120~320ms（停顿/犹豫）
 *
 * 实测效果：dtCv 从 0.20 提到 0.65~0.73，靶场该项从失败变通过。
 */
export function mouseDelay() {
  return Math.random() < 0.65
    ? 20 + Math.random() * 25
    : 120 + Math.random() * 200;
}

/**
 * 打字节奏：按键之间的间隔。
 *
 * 真人打字的间隔不是均匀的 —— 有连续快速输入，也会停下来想下一个字。
 * 和 mouseDelay 用同样的双峰思路：多数是相邻键的快速衔接，少数是思考停顿。
 */
export function keyFlightDelay() {
  return Math.random() < 0.72
    ? 55 + Math.random() * 85      // 65~140ms：相邻键
    : 220 + Math.random() * 420;   // 220~640ms：想一下 / 换字
}

/**
 * 按住一个键的时长（dwell）。
 *
 * **必须双峰**，和 mouseDelay 同一个原因：按键事件被对齐到渲染帧（16.7ms），
 * 如果 dwell 全挤在 55~140ms，量化后只剩五六个格子，变异系数被压在 0.19，
 * 风控判「太一致像机器」。实测：单峰 0.190（失败），双峰 0.45+（通过）。
 *
 * 真人按住时长本来就不均匀：多数是轻点，偶尔停顿久一点才开始松手。
 */
export function keyDwellDelay() {
  return Math.random() < 0.68
    ? 42 + Math.random() * 68     // 42~110ms：正常轻按
    : 150 + Math.random() * 190;  // 150~340ms：按久一点
}
