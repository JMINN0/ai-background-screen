/**
 * tactics.js —— 风控等级 → 操作手段（第一阶段：只做参数映射，不做拦截）。
 *
 * 为什么要有这一层：`human.js` 早就会算落点散布、overshoot、思考停顿，
 * 但 `vd.input()` 从来不传参数，于是一律走默认值 —— 等级只是显示给用户看的一句
 * 「L2」，对真正注入的事件没有任何影响。这里把「等级」翻成注入参数，
 * 让 L0 和 L4 的操作在事件层面真的不一样。
 *
 * 参数含义：
 *   intervalMs  [min,max] 动作前后等待区间，随机取
 *   useThink    用 human.js 的 thinkDelay()（对数正态，中位 1.6 秒），与 intervalMs 二选一
 *   size        落点散布的目标尺寸（px），0 = 精确中心
 *   overshoot   产生 overshoot（冲过头再回来）的概率
 *   jitter      坐标抖动像素
 *
 * ⚠️ 随机的代价：L2..L4 每次操作前要额外等 0.5~9 秒（thinkDelay 的分布）。
 * 这是有意的 —— 让 AI 拿不到「免等待」的快路径。不想要的场景请显式传 level 之外的开关。
 */

import { thinkDelay } from './human.js';

/** 等级 → 操作参数。数值来自 human.js 里对真人操作的建模。 */
export const TACTICS = {
  L0: { intervalMs: [0, 0],           size: 0,  overshoot: 0,   jitter: 0.6 },
  L1: { intervalMs: [150, 500],       size: 48, overshoot: 0,   jitter: 0.6 },
  /* **size 从 96 降到 48**：审查用 20 万次模拟实测，
   * size=96 时 47.6% 的点击落在按钮中心 12px 之外（会点歪），
   * size=48 时 91.2% 落在 12px 内。而且 size 同时控制按下期间
   * 的微移（clamp 到 ±size/3），96 会给到 ±32px，
   * 某些列表会判成 short drag（变拖动而不是点击）。 */
  L2: { intervalMs: [0, 0], useThink: true, size: 48, overshoot: 0.3, jitter: 1.2 },
    /* 风控越高越谨慎：散布更小，越不容易点歪。L3=32 */
  L3: { intervalMs: [0, 0], useThink: true, size: 32, overshoot: 0.15, jitter: 0.8 },
    L4: { intervalMs: [0, 0], useThink: true, size: 32, overshoot: 0.15, jitter: 0.8 },
  L5: { intervalMs: [0, 0],           size: 0,  overshoot: 0,   jitter: 0.6 },
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 规整等级写法：'2' / 'l2' / ' L2 ' → 'L2'；认不出返回 ''。 */
function normLevel(level) {
  const s = String(level == null ? '' : level).trim().toUpperCase();
  return /^L[0-5]$/.test(s) ? s : '';
}

/**
 * 某等级对应的操作参数。
 *
 * 未知等级（含 AI 给的 '?'「未评估」）一律按 L3 处理：它和 L2 参数相同，
 * 但语义上是「保守」，将来 L3 要加拦截时改这里就够了，不会漏掉未评估的场景。
 *
 * @returns {{level:string, intervalMs:[number,number], useThink:boolean,
 *            size:number, overshoot:number, jitter:number}}
 */
export function planFor(level) {
  const lv = normLevel(level) || 'L3';
  const t = TACTICS[lv] || TACTICS.L3;
  const iv = Array.isArray(t.intervalMs) ? t.intervalMs : [0, 0];
  const lo = Math.max(0, num(iv[0], 0));
  const hi = Math.max(lo, num(iv[1], 0));
  return {
    level: lv,
    intervalMs: [lo, hi],
    useThink: t.useThink === true,
    /* 0 必须原样保留 —— 注入层靠它判断「走原来的精确中心」。 */
    size: Math.max(0, num(t.size, 0)),
    overshoot: clamp01(num(t.overshoot, 0)),
    jitter: Math.max(0, num(t.jitter, 0)),
  };
}

/** 按等级等一会儿。注入前调用，让 AI 没有「免等待」的操作路径。 */
export async function waitFor(level) {
  const p = planFor(level);
  let ms = 0;
  if (p.useThink) {
    ms = thinkDelay(1600);
  } else if (p.intervalMs[1] > 0) {
    const [lo, hi] = p.intervalMs;
    ms = lo + Math.random() * (hi - lo);
  }
  ms = Math.round(ms);
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  return ms;
}
