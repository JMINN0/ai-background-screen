/**
 * pool.js — 多块后台屏的池化管理。
 *
 * ## 为什么需要
 *
 * `vd.js` 原来是模块级单例，一次只能一块屏。要让「每个会话/子代理一块屏」，
 * 就得有多块屏并存。实测两块 scrcpy 虚拟屏能同时存在（见
 * `tests/risk-sim/MULTI-SCREEN-FINDINGS.md` U8）。
 *
 * ## 屏身份怎么认
 *
 * 最大的障碍：所有 scrcpy 屏的名字都是 `"scrcpy"`（scrcpy 5.0.1 没有改名参数，
 * 见同一个文件的 U6）。所以没法按名字分。
 *
 * **解法是 dpi 金丝雀**：第 i 块屏用 `dpi = 320 + i`，之后从
 * `dumpsys display` 的 `density` 反查是哪一块。差 1 dpi 肉眼无感，
 * 但数值上是唯一的。U4 实测 density 可读，U8 实测 320/321 能区分。
 *
 * ## 设计取舍
 *
 * 不做完整的 broker（租约、抢占、优先级队列）—— 那是 2.5-4 天的活，设计在
 * `BROKER-DESIGN.md`。这里做的是**能真正用起来的最小版**：
 *
 *   · 建/销毁/列举屏
 *   · 每块屏有稳定的 screenId（`sd-1`、`sd-2`…），一次开机内不复用
 *   · 按 screenId 切换活动上下文，之后所有 vd.* 调用都作用在那块屏上
 *   · 屏没了能检测、能重建
 *
 * 抢占和租约留给下一层 —— 因为没有它们，多屏本身也是有用的（不同会话用不同屏，
 * 撞了就报错让人决定，比默默抢走好）。
 */

import * as vd from './vd.js';

/** screenId → 上下文。一次开机内 screenId 不复用。 */
const screens = new Map();
let nextId = 1;
/** dpi 金丝雀的下一个偏移。320 是基础值，每块屏 +1。 */
let nextDpiOffset = 0;

const BASE_DPI = 320;

/**
 * 建一块新屏。
 *
 * @param {object} [o]
 * @param {number} [o.width]  省略则按物理屏比例
 * @param {number} [o.height]
 * @param {string} [o.orientation] 'portrait' | 'landscape'
 * @param {boolean} [o.hwc]
 * @returns {Promise<{ok:boolean, screenId?:string, displayId?:number, dpi?:number, hint?:string}>}
 */
export async function create(o = {}) {
  // 切换到一个全新的空上下文来建屏，建完再把它存进池
  const ctx = vd.newContext();
  vd.setActive(ctx);

  const dpi = BASE_DPI + nextDpiOffset;
  const r = await vd.start({
    width: Number(o.width) || 0,
    height: Number(o.height) || 0,
    dpi,
    systemDecorations: false,
    orientation: o.orientation,
    hwc: o.hwc || 'auto',
  });

  if (!r.ok) {
    return { ok: false, hint: r.hint || '建屏失败' };
  }

  // 建屏过程中 dpi 可能被系统重算，以实际生效的为准
  const screenId = `sd-${nextId}`;
  nextId += 1;
  nextDpiOffset += 1;

  screens.set(screenId, {
    screenId,
    ctx,
    dpi,
    displayId: r.displayId,
    sfId: r.sfId,
    createdAt: Date.now(),
  });

  return { ok: true, screenId, displayId: r.displayId, dpi, requestedDpi: dpi };
}

/**
 * 切换当前活动屏。之后所有 vd.* 调用都作用在它上面。
 * @returns {{ok:boolean, hint?:string, displayId?:number}}
 */
export function use(screenId) {
  const s = screens.get(screenId);
  if (!s) {
    return {
      ok: false,
      hint: `没有这块屏「${screenId}」。现有的：${[...screens.keys()].join(', ') || '（空，先建一块）'}`,
    };
  }
  vd.setActive(s.ctx);
  return { ok: true, displayId: s.displayId };
}

/**
 * 销毁一块屏。
 *
 * 注意：**必须先把活动上下文切到它**，因为 vd.stop() 操作的是当前 state。
 */
export async function destroy(screenId, o = {}) {
  const s = screens.get(screenId);
  if (!s) return { ok: false, hint: `没有这块屏「${screenId}」` };

  /*
   * **先关这块屏自己的浮窗和推流。**
   *
   * 2026-11-22 实机：destroy 只 stop 掉 display，浮窗还开着，
   * 一直去连一个没人监听的端口 —— 多建几块屏再关就攒一堆僵尸窗口。
   * 只关这一块的（按 displayId 查端口），不要全关。
   */
  try {
    const T = await import('./tools.js');
    const dispId = s.ctx?.displayId;
    const p = dispId != null ? (T.screenPorts?.get?.(Number(dispId)) || 0) : 0;
    try { await T.overlayStop(p || undefined); } catch { /* 窗口本来就不在 */ }
  } catch { /* tools 加载失败不阻塞销毁 */ }

  /* **停 framesrv 也要按 displayId，否则是全停。**
   * 2026-11-22 对抗审查：池里销毁一块屏时如果不指定 displayId，
   * 会把其它池屏的推流一起停掉。 */
  try {
    const fsrv = await import('./framesrv.js');
    const dispId = s.ctx?.displayId;
    await fsrv.stop(dispId != null ? Number(dispId) : undefined);
  } catch { /* 推流本来就没起 */ }

  vd.setActive(s.ctx);
  try {
    await vd.stop({ forceStopApps: o.forceStopApps === true });
  } catch { /* 尽力而为 */ }
  screens.delete(screenId);

  // 活动上下文被销毁了，切到剩下的任意一块（或重置）
  const rest = [...screens.values()];
  vd.setActive(rest.length ? rest[0].ctx : vd.newContext());

  return { ok: true, screenId, remaining: screens.size };
}

/**
 * 列出池里所有屏，并**对账**：系统里还在不在。
 *
 * 为什么要对账：DisplayHost 是 uid 2000 普通进程，oom_adj 不占优，
 * 可能被 LMK 杀掉，屏跟着消失，而我们的账本还以为它在。
 */
export async function list() {
  const out = [];
  /* **查完必须还原活动屏。**
   *
   * 2026-11-23 审查抓到：list() 逐块 setActive() 去查状态，查完不还原 ——
   * 于是调一次 screen_pool（只读工具）就把活动屏切到列表最后一块，
   * 之后 vdisplay_launch / input / shot 全作用在错的屏上，且没有任何提示。
   */
  const prevActive = vd.getActive ? vd.getActive() : null;
  try {
  for (const [id, s] of screens) {
    let alive = false;
    let actualDpi = null;
    try {
      // 切到它再查，vd.status() 看的是当前 state
      vd.setActive(s.ctx);
      const st = await vd.status();
      alive = st.running === true;
      actualDpi = st.dpi ?? null;
    } catch { /* 查不到就当死了 */ }
    out.push({
      screenId: id,
      displayId: s.displayId,
      dpi: actualDpi ?? s.dpi,
      dpiCanary: s.dpi,
      alive,
      ageSec: Math.round((Date.now() - s.createdAt) / 1000),
    });
  }
  } finally {
    // 还原原活动屏（setActive 传 null 表示不切）
    try { if (prevActive) vd.setActive(prevActive); } catch { /* ignore */ }
  }
  return { ok: true, count: out.length, screens: out };
}

/**
 * 按 dpi 找回 screenId。
 *
 * 这是金丝雀方案的核心：拿到一块屏的 dpi，就能知道它是池里的哪一个。
 * 用于「重启 daemon 后认领已有的屏」这种场景。
 */
export function findByDpi(dpi) {
  for (const [id, s] of screens) {
    if (s.dpi === dpi) return id;
  }
  return null;
}

/** 池的概况（给 screen_pool 工具用） */
export function info() {
  const active = vd.getActive();
  let activeId = null;
  for (const [id, s] of screens) {
    if (s.ctx === active) { activeId = id; break; }
  }
  return {
    count: screens.size,
    active: activeId,
    screens: [...screens.entries()].map(([id, s]) => ({
      screenId: id,
      displayId: s.displayId,
      dpi: s.dpi,
    })),
  };
}

/** 销毁全部（daemon 退出时用） */
export async function destroyAll() {
  const ids = [...screens.keys()];
  for (const id of ids) {
    try { await destroy(id); } catch { /* 尽力而为 */ }
  }
  return { ok: true, destroyed: ids.length };
}
