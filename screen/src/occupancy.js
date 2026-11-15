/**
 * occupancy.js — 查「某个 App 现在被谁占着」。
 *
 * ## 核心认知
 *
 * **Android 不记录「谁在用 App」，只记录「task 在哪块屏」。**
 * 所以占用检测分两层：
 *
 *   事实层（系统可查）：某包在哪些 display 上有 task、哪个有焦点、pid 多少
 *   归属层（自己记账）：这块屏是哪个会话的
 *
 * 只查系统 → 不知是谁；只记账 → 会撒谎（App 崩了、用户按返回了）。
 * **两层必须每次对账。**
 *
 * ## 查询方式（U1 实测可行，32ms）
 *
 *   dumpsys activity activities | grep 'Display #'
 *
 * 能读到 display 编号、taskId、包名、可见性、焦点。
 *
 * ## 一个有用的推论
 *
 * 私有虚拟屏用户看不见，**所以出现在 scrcpy 屏上的 task 100% 是 AI 的**。
 * 这让「自家屏 vs 用户屏」的区分变得很简单：主屏（display 0）上的才是用户的。
 */

import { adb } from './vd.js';

/**
 * 解析 dumpsys activity activities 的 Display 分组。
 *
 * 输出格式（实测）：
 *   Display #0 (activities from top to bottom):
 *     * Task{4626b03 #24685 type=standard I=io.github... U=0 visible=true ...}
 *   Display #210 (activities from top to bottom):
 *     * Task{ad74e9e #24742 type=standard A=1000:com.android.settings.root ...}
 *
 * @param {string} out dumpsys 输出
 * @returns {Map<number, Array<{taskId:number, pkg:string, visible:boolean}>>}
 */
export function parseDisplays(out) {
  const result = new Map();
  let currentDisplay = null;

  for (const raw of String(out || '').split('\n')) {
    const line = raw.trim();

    const dm = line.match(/^Display #(-?\d+) \(/);
    if (dm) {
      currentDisplay = Number(dm[1]);
      if (!result.has(currentDisplay)) result.set(currentDisplay, []);
      continue;
    }
    if (currentDisplay === null) continue;

    // Task 行里拿 taskId 和包名。包名有两种写法：
    //   A=1000:com.android.settings.root   （带 uid 前缀）
    //   I=io.github.ccch1mneyyy.dsh_app/.LauncherInk
    if (!/^\* Task\{/.test(line)) continue;
    const tid = line.match(/#(\d+)/);
    const pkgA = line.match(/\bA=\d+:([a-zA-Z0-9_.]+)/);
    const pkgI = line.match(/\bI=([a-zA-Z0-9_.]+)\//);
    const pkg = pkgA ? pkgA[1] : (pkgI ? pkgI[1] : null);
    if (!tid || !pkg) continue;
    const visible = /visible=true/.test(line);
    result.get(currentDisplay).push({ taskId: Number(tid[1]), pkg, visible });
  }
  return result;
}

/**
 * 包名匹配。
 *
 * **不能精确比对。** 实测系统报的是 `com.android.settings.root`（带进程后缀），
 * 而调用方查的是 `com.android.settings` —— 精确匹配结果永远是 FREE，等于整个
 * 占用检测失效。同理还有 `com.tencent.mm:push` 这类带 `:` 的进程名。
 *
 * 规则：完全相等，或者是「pkg + .」/「pkg + :」开头的子包/进程。
 */
export function pkgMatches(query, actual) {
  if (!query || !actual) return false;
  if (query === actual) return true;
  return actual.startsWith(query + '.') || actual.startsWith(query + ':');
}

/** 占用等级。数值越大越「不能碰」。 */
export const LEVEL = {
  FREE: 0,          // 哪都没有
  SOFT: 1,          // 只有进程，没 task
  USER_BG: 2,       // 主屏有 task 但不在前台
  USER_ACTIVE: 3,   // 主屏前台就是它
  AI_HELD: 4,       // 在我们自己的屏上
  ORPHAN: 5,        // 在我们自己的屏上但池里没记账
  FOREIGN: 6,       // 外来屏（不是我们建的）
};

const LEVEL_NAME = Object.fromEntries(Object.entries(LEVEL).map(([k, v]) => [v, k]));

/**
 * 查一个包现在的占用情况。
 *
 * @param {string} pkg
 * @param {object} [o]
 * @param {Map<number,string>} [o.ourScreens]  我们认得的所有屏：displayId → screenId
 * @returns {Promise<{ok:boolean, pkg:string, level:number, levelName:string,
 *                    onMain:boolean, mainVisible:boolean,
 *                    onOurScreens:Array<{displayId:number, screenId:string, visible:boolean}>,
 *                    foreignDisplays:number[], hint?:string}>}
 */
export async function checkApp(pkg, o = {}) {
  const r = await adb(['shell', 'dumpsys activity activities 2>/dev/null']);
  if (!r.ok) {
    return { ok: false, hint: `查占用失败：${r.err || 'adb 不可用'}`, pkg };
  }
  const byDisplay = parseDisplays(r.out);

  /*
   * **解析不出来必须报错，不能当成"没人用"。**
   *
   * 原来这里没有检查：dumpsys 输出格式变了、或者 adb 返回空，parseDisplays 返回
   * 空 Map，后面的循环一次都不执行，于是所有标志保持 false → level=FREE → canTouch 放行。
   * 也就是说**探测失败会被当成"这 App 没人占，随便用"**，这是最危险的失败方向。
   *
   * 加断言：一个 display 都没解析出来 = 探测失败，闭着嘴拒绝。
   */
  if (byDisplay.size === 0) {
    return {
      ok: false,
      pkg,
      code: 'E_PROBE_FAILED',
      hint: '占用探测失败：dumpsys activity activities 一个 display 都没解析出来。'
        + '可能是 adb 断了，或者这台机器的 dumpsys 格式和预期不同。'
        + '为了安全这里**不放行** —— 拿不到占用状态时不能假设没人用。',
    };
  }

  const ourScreens = o.ourScreens || new Map();
  const onOurScreens = [];
  const foreignDisplays = [];
  let onMain = false;
  let mainVisible = false;

  for (const [displayId, tasks] of byDisplay) {
    const hit = tasks.filter((t) => pkgMatches(pkg, t.pkg));
    if (!hit.length) continue;

    if (displayId === 0) {
      onMain = true;
      mainVisible = hit.some((t) => t.visible);
    } else if (ourScreens.has(displayId)) {
      onOurScreens.push({
        displayId,
        screenId: ourScreens.get(displayId),
        visible: hit.some((t) => t.visible),
      });
    } else {
      foreignDisplays.push(displayId);
    }
  }

  // 判定等级：取最严重的那个
  let level = LEVEL.FREE;
  if (foreignDisplays.length) level = Math.max(level, LEVEL.FOREIGN);
  if (onOurScreens.length) level = Math.max(level, LEVEL.AI_HELD);
  if (onMain) level = Math.max(level, mainVisible ? LEVEL.USER_ACTIVE : LEVEL.USER_BG);

  return {
    ok: true,
    pkg,
    level,
    levelName: LEVEL_NAME[level],
    onMain,
    mainVisible,
    onOurScreens,
    foreignDisplays,
  };
}

/**
 * 这个占用等级能不能动。
 *
 * 规则很简单：**用户正在看的（USER_ACTIVE）和不是我们的屏（FOREIGN）绝对不碰。**
 */
export function canTouch(level) {
  if (level >= LEVEL.FOREIGN) return { ok: false, reason: '这块屏不是我们建的，不碰' };
  if (level === LEVEL.USER_ACTIVE) return { ok: false, reason: '用户正在主屏上看这个 App，不碰' };
  return { ok: true };
}

/**
 * 给 AI 看的可读说明。
 */
export function describe(res) {
  if (!res.ok) return res.hint || '查不到';
  const lines = [`「${res.pkg}」占用等级：${res.levelName}（${res.level}）`];

  if (res.onMain) {
    lines.push(`  · 用户主屏上有它的任务${res.mainVisible ? '（**正在前台**）' : '（在后台）'}`);
  }
  if (res.onOurScreens.length) {
    for (const s of res.onOurScreens) {
      lines.push(`  · 在我们建的 ${s.screenId}（display ${s.displayId}）上${s.visible ? '，可见' : ''}`);
    }
  }
  if (res.foreignDisplays.length) {
    lines.push(`  · 出现在外来屏 display ${res.foreignDisplays.join(', ')} 上 —— 不是我们建的，不碰`);
  }
  if (res.level === LEVEL.FREE) lines.push('  · 哪儿都没找到它');

  const t = canTouch(res.level);
  lines.push('');
  lines.push(t.ok ? '✅ 可以操作' : `❌ 不建议操作：${t.reason}`);
  return lines.join('\n');
}
