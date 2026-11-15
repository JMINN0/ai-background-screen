/**
 * lease.js — App 占用的凭证。多屏 / 多 AI 场景下防止互相抢。
 *
 * ## 为什么需要
 *
 * 有了多屏池和占用检测之后，还缺一环：**检测到了冲突，但没人拦。**
 * 两个 AI 都可能看到「这个 App 在别人屏上」，然后各自决定「我抢一下」，
 * 结果互相拆台。
 *
 * 租约就是那张凭证：想用某个 App 就先 claim，别人 claim 时会失败并知道是谁拿着。
 *
 * ## 设计取舍（都是被实测逼出来的）
 *
 * **① 默认不抢占。** `onConflict` 默认 `'fail'`。设计文档的原话：
 * 「默认抢占会变成 AI 互抢常态，默认失败才逼出『先查再决定』」。
 *
 * **② 宽限期只有 5 秒，因为 AI 一轮往返 6-9 秒。**
 * 所以「体面退场」在物理上不可能 —— victim 收到撤销通知时，它这一轮已经在跑了。
 * 能保证的只有「它下次调用会收到 E_LEASE_REVOKED，不会继续误操作」。
 * 任何要求 AI 在宽限期内收尾的实现都是错的。
 *
 * **③ 抢占 = 转移租约，不是杀进程。**
 * App 任务留在原屏，新持有者接手那块屏。UI 状态、滚动位置都还在。
 * force-stop 只在租约到期且没人接的时候才考虑。
 *
 * **④ 不持久化。** 租约绑在屏的 socket 和进程上，daemon 一死全作废。
 * 写盘只会造出「账本说有人持有、实际没人」的假象。
 */

import { LEVEL, checkApp, canTouch } from './occupancy.js';
import * as pool from './pool.js';

/** leaseId → lease */
const leases = new Map();
let nextId = 1;

/** 抢占宽限期（毫秒）。见文件头注释②，不能设得太长。 */
export const GRACE_MS = 5000;

/** 默认租约时长（毫秒）。10 分钟，够一轮长任务。 */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * @typedef {object} Lease
 * @property {string} leaseId
 * @property {string} pkg
 * @property {string} screenId
 * @property {string} owner        会话标识
 * @property {'exclusive'|'readonly'} mode
 * @property {'user'|'agent'|'subagent'} priority
 * @property {number} expiresAt
 * @property {boolean} preemptible
 * @property {string|null} nonPreemptibleReason
 * @property {number} createdAt
 */

function now() { return Date.now(); }

/** 清掉过期的租约 */
function reap() {
  const t = now();
  for (const [id, l] of leases) {
    if (l.expiresAt <= t) leases.delete(id);
  }
}

/** 找某个 pkg 现在有效的 exclusive 租约 */
function findExclusive(pkg) {
  reap();
  for (const l of leases.values()) {
    if (l.pkg === pkg && l.mode === 'exclusive') return l;
  }
  return null;
}

/**
 * 申请占用一个 App。
 *
 * @param {object} o
 * @param {string} o.pkg
 * @param {string} o.screenId   想在哪块屏上用它
 * @param {string} [o.owner]    会话标识（拿不到就写 'unknown'）
 * @param {'exclusive'|'readonly'} [o.mode='exclusive']
 * @param {'user'|'agent'|'subagent'} [o.priority='agent']
 * @param {boolean} [o.preemptible=true]
 * @param {string} [o.nonPreemptibleReason]  登录/支付/发送中由 AI 自报
 * @param {'fail'|'wait'|'preempt'} [o.onConflict='fail']
 * @param {number} [o.ttlMs]
 * @returns {Promise<object>}
 */
export async function claim(o = {}) {
  const pkg = String(o.pkg || '').trim();
  const screenId = String(o.screenId || '').trim();
  if (!pkg) return { ok: false, code: 'E_BAD_ARG', hint: '需要 pkg' };

  // 屏必须在池里
  const info = pool.info();
  const screen = info.screens.find((s) => s.screenId === screenId);
  if (!screen) {
    return {
      ok: false,
      code: 'E_NO_SCREEN',
      hint: `没有这块屏「${screenId}」。现有：${info.screens.map((s) => s.screenId).join(', ') || '（空）'}`,
      next: { action: 'create_screen' },
    };
  }

  // 系统层先查一遍：用户正在看的东西绝不动
  const ourScreens = new Map(info.screens.map((s) => [Number(s.displayId), s.screenId]));
  const occ = await checkApp(pkg, { ourScreens });
  if (!occ.ok) return { ok: false, code: 'E_PROBE_FAILED', hint: occ.hint };

  const touch = canTouch(occ.level);
  if (!touch.ok) {
    return {
      ok: false,
      code: 'E_PROTECTED',
      hint: `不能占用「${pkg}」：${touch.reason}`,
      occupancy: { level: occ.level, levelName: occ.levelName },
      next: { action: 'handoff_to_user' },
    };
  }

  // 已有租约？
  const held = findExclusive(pkg);
  // **同屏不同 owner 也算冲突。** 第一版只拦了「屏不同」的情况，
  // 于是同一块屏上 B 会话申请同一个 App 会直接建一个新租约 —— 结果三个租约都指向
  // 同一个 pkg+screen，谁也没被拦住，租约形同虚设。
  const sameOwner = held && held.owner === (o.owner || 'unknown');
  if (held && !sameOwner) {
    // 别人拿着
    if (o.onConflict === 'preempt') {
      const p = canPreempt(held, o);
      if (!p.ok) {
        return {
          ok: false,
          code: 'E_NOT_PREEMPTIBLE',
          hint: p.reason,
          holder: publicLease(held),
          next: { action: 'wait' },
        };
      }
      // 撤销旧的，给新的
      const revoked = revoke(held.leaseId, `被 ${o.owner || 'unknown'} 抢占`);
      const l = grant({ ...o, pkg, screenId });
      return {
        ok: true,
        lease: publicLease(l),
        preempted: publicLease(held),
        revokedOk: revoked.ok,
        note: `已接管。原持有者 ${held.owner} 会在下次调用时收到撤销通知 —— `
          + `宽限期只有 ${GRACE_MS / 1000} 秒，比一轮往返短，所以它这一轮可能已经跑完了。`,
      };
    }
    if (o.onConflict === 'wait') {
      const waitMs = Math.max(0, held.expiresAt - now());
      return {
        ok: false,
        code: 'E_APP_BUSY',
        hint: `「${pkg}」正被 ${held.owner} 占着，最多还要 ${Math.ceil(waitMs / 1000)} 秒。`,
        holder: publicLease(held),
        retryAfterMs: waitMs,
        next: { action: 'wait' },
      };
    }
    // 默认 fail
    return {
      ok: false,
      code: 'E_APP_BUSY',
      hint: `「${pkg}」正被 ${held.owner} 占着（${held.screenId}）。`
        + `想抢就把 onConflict 设成 'preempt'，想等就设成 'wait'。`,
      holder: publicLease(held),
      next: { action: 'preempt', alternatives: ['wait', 'use_other_app'] },
    };
  }

  // 同一个 owner 重复申请 → 幂等返回，不新建
  if (sameOwner) {
    return { ok: true, lease: publicLease(held), reused: true };
  }

  const l = grant({ ...o, pkg, screenId });
  return { ok: true, lease: publicLease(l) };
}

/** 给租约。内部用，不做校验。 */
function grant(o) {
  const l = {
    leaseId: `ls-${nextId++}`,
    pkg: String(o.pkg),
    screenId: String(o.screenId),
    owner: String(o.owner || 'unknown'),
    mode: o.mode === 'readonly' ? 'readonly' : 'exclusive',
    priority: ['user', 'agent', 'subagent'].includes(o.priority) ? o.priority : 'agent',
    expiresAt: now() + (Number(o.ttlMs) || DEFAULT_TTL_MS),
    preemptible: o.preemptible !== false,
    nonPreemptibleReason: o.nonPreemptibleReason ? String(o.nonPreemptibleReason).slice(0, 200) : null,
    createdAt: now(),
  };
  leases.set(l.leaseId, l);
  return l;
}

/**
 * 能不能抢这个租约。
 *
 * 规则：user 级能抢 agent/subagent；agent 只能抢 subagent；
 * 声明了 nonPreemptible 的一律不抢（登录、支付、发送中）。
 */
function canPreempt(held, req) {
  if (!held.preemptible) {
    return {
      ok: false,
      reason: `原持有者声明了不可抢${held.nonPreemptibleReason ? `（${held.nonPreemptibleReason}）` : ''}`,
    };
  }
  const rank = { user: 3, agent: 2, subagent: 1 };
  const mine = rank[req.priority] || 2;
  const theirs = rank[held.priority] || 2;
  if (mine < theirs) {
    return { ok: false, reason: `优先级不够（你是 ${req.priority}，对方是 ${held.priority}）` };
  }
  return { ok: true };
}

/** 撤销一个租约。返回原租约信息，让调用方能通知 victim。 */
export function revoke(leaseId, reason = '') {
  const l = leases.get(String(leaseId));
  if (!l) return { ok: false, code: 'E_NO_LEASE', hint: `没有租约 ${leaseId}` };
  leases.delete(String(leaseId));
  return { ok: true, revoked: publicLease(l), reason };
}

/** 主动释放（AI 干完了自己放） */
export function release(leaseId) {
  return revoke(leaseId, '主动释放');
}

/** 释放某个会话持有的全部租约（会话结束时用） */
export function releaseAll(owner, hint = '会话结束') {
  const n = [];
  for (const [id, l] of leases) {
    if (l.owner === owner) { leases.delete(id); n.push(id); }
  }
  return { ok: true, released: n, hint };
}

/**
 * 校验：这次操作有没有权限。
 *
 * 调用方（比如 vdisplay_input）在做有副作用的事之前调它。
 *
 * @param {string} pkg
 * @param {string} screenId
 * @param {string} owner
 * @returns {{ok:boolean, code?:string, hint?:string}}
 */
export function check(pkg, screenId, owner) {
  reap();
  const held = findExclusive(pkg);
  if (!held) return { ok: true, hint: '没有租约，随便用' };   // 没人占就允许
  if (held.screenId !== screenId) {
    return {
      ok: false,
      code: 'E_WRONG_SCREEN',
      hint: `「${pkg}」的租约绑在 ${held.screenId} 上，你现在在 ${screenId}。`
        + `要么切到那块屏，要么先 claim。`,
    };
  }
  if (held.owner !== owner) {
    return {
      ok: false,
      code: 'E_NOT_OWNER',
      hint: `「${pkg}」在 ${held.screenId} 上被 ${held.owner} 占着（你自称 ${owner}）。`,
    };
  }
  return { ok: true };
}

/** 对外可见的租约（不暴露内部字段） */
function publicLease(l) {
  return {
    leaseId: l.leaseId,
    pkg: l.pkg,
    screenId: l.screenId,
    owner: l.owner,
    mode: l.mode,
    priority: l.priority,
    preemptible: l.preemptible,
    nonPreemptibleReason: l.nonPreemptibleReason,
    remainingSec: Math.max(0, Math.round((l.expiresAt - now()) / 1000)),
  };
}

/** 列出所有有效租约 */
export function list() {
  reap();
  return { ok: true, count: leases.size, leases: [...leases.values()].map(publicLease) };
}

/** 给 AI 看的可读说明 */
export function describeList() {
  const r = list();
  if (!r.count) return '当前没有任何租约。想占某个 App 用 screen_claim_app。';
  const lines = [`共 ${r.count} 个租约：`];
  for (const l of r.leases) {
    lines.push(`  ${l.leaseId}  ${l.pkg}  →  ${l.screenId}  由 ${l.owner} 占用，`
      + `还剩 ${l.remainingSec} 秒${l.preemptible ? '' : '（不可抢）'}`);
  }
  return lines.join('\n');
}

/** 测试用：清空 */
export function _reset() { leases.clear(); nextId = 1; }
