/**
 * ui-tree.js — 读虚拟屏上 App 的**控件树**，代替截图+OCR 硬猜。
 *
 * ## 为什么加这个
 *
 * 2026-11-25 用户提到 CLI-Anything（港大 HKUDS，58k star），它的核心主张是
 * 「用**结构化命令**替代脆弱的 GUI 像素操控」。
 *
 * 那条批评对我们成立：现在点一个按钮要 截图(140ms) + OCR(2s) ≈ 2.1 秒，
 * 而且 OCR 会认错字、认不出图标。但安卓上没有 CLI 可生成 —— App 是闭源的。
 *
 * **等价物是控件树。** 实测本机能拿到：
 *
 *   adb shell dumpsys activity top
 *     → ACTIVITY com.android.settings/.Settings ... displayId=970(type=VIRTUAL)
 *       View Hierarchy:
 *         android.widget.TextView{fdfb6c V.ED..... ........ 48,0-638,62 #7f0b017b app:id/xxx}
 *
 * 关键：**输出带 displayId，可以按虚拟屏过滤**，而且**不需要无障碍权限**
 * （`uiautomator dump` 在这台机器上静默失败，这条路能走）。
 *
 * 所以定位是「主路径」而不是补充：
 *   能读树 → 走树（毫秒级、精确）
 *   读不到（游戏/Flutter 自绘）→ 降级到截图+OCR
 *
 * ## 格式
 *
 * ```
 * <缩进><类名>{<hash> <标志位> <状态> <left,top-right,bottom> <#id> <app:id/名字>}<[标题]>
 * ```
 * 例：
 * `android.widget.TextView{fdfb6c V.ED..... ........ 48,0-638,62 #7f0b017b app:id/title}`
 *
 * 标志位第 1 个字符是可见性：V=visible / I=invisible / G=gone（回收）。
 */

/** 一行一个控件：`类名{hash 标志 状态 边界 id...}` */
const RE_VIEW = /^(\s*)([\w.$]+)\{([0-9a-f]+)\s+(\S+)\s+(\S+)\s+(-?\d+),(-?\d+)-(-?\d+),(-?\d+)(.*)\}$/;

/** 从 `#7f0b017b app:id/title` 里抠出 id 短名 */
function shortId(rest) {
  if (!rest) return '';
  const m = rest.match(/(?:app|android):id\/([\w.]+)/);
  if (m) return m[1];
  const m2 = rest.match(/#([0-9a-f]+)/);
  return m2 ? '#' + m2[1] : '';
}

/**
 * 解析 `dumpsys activity top` 的输出。
 *
 * @param {string} raw dumpsys 原始文本
 * @param {number} displayId 只取这块屏的 activity
 * @returns {{activity:string, pkg:string, elements:Array, count:number}}
 */
export function parseTopDump(raw, displayId) {
  const out = { activity: '', pkg: '', elements: [], count: 0 };
  if (!raw) return out;

  const lines = String(raw).split('\n');
  let inTarget = false;
  let inHierarchy = false;
  let depthBase = -1;
  let idx = 0;

  for (const line of lines) {
    /* ACTIVITY 行：找到目标屏的那个 activity */
    const am = line.match(/\bACTIVITY\s+([\w.$]+\/[\w.$]+).*displayId=(\d+)/);
    if (am) {
      const thisDisp = Number(am[2]);
      inTarget = (displayId == null) || (thisDisp === Number(displayId));
      inHierarchy = false;
      if (inTarget) {
        out.activity = am[1];
        out.pkg = am[1].split('/')[0];
      }
      continue;
    }
    /* 下一个 ACTIVITY 之前的 View Hierarchy 段 */
    if (!inTarget) continue;
    if (/View Hierarchy:/.test(line)) { inHierarchy = true; depthBase = -1; continue; }
    if (!inHierarchy) continue;
    if (/^\s*(Local Activity|ViewRoot|Looper)/.test(line)) { inHierarchy = false; continue; }

    const m = line.match(RE_VIEW);
    if (!m) continue;
    const [, indent, cls, hash, flags, status, x1, y1, x2, y2, rest] = m;

    /* 用第一行的缩进当基准，算层级（每 2 空格一层） */
    if (depthBase < 0) depthBase = indent.length;
    const depth = Math.max(0, Math.round((indent.length - depthBase) / 2));

    const vis = flags.charAt(0);              // V / I / G
    const l = Number(x1), t = Number(y1), r = Number(x2), b = Number(y2);
    const w = r - l, h = b - t;

    out.elements.push({
      i: idx++,                                // 顺序号，方便按「第几个」点
      depth,
      cls: cls.split('.').pop(),               // 短类名，省 token
      full: cls,
      vis,                                     // V 可见 / I 不可见 / G 已回收
      clickable: status.includes('C'),         // 状态位里有 C = clickable
      focusable: status.includes('F'),
      id: shortId(rest),
      title: (rest.match(/\[([^\]]*)\]/) || [])[1] || '',
      x: l, y: t, w, h,
      cx: w > 0 ? Math.round((l + w / 2)) : l, // 中心点，直接可点
      cy: h > 0 ? Math.round((t + h / 2)) : t,
    });
  }

  /* 只留可见 + 有面积的，不然一堆 0x0 的占位把列表撑爆 */
  out.count = out.elements.length;
  out.elements = out.elements.filter((e) => e.vis === 'V' && e.w > 0 && e.h > 0);
  return out;
}

/**
 * 把控件列表渲染成给 AI 看的紧凑文本。
 *
 * 为什么不返回 JSON：一屏几十上百个控件，JSON 光括号就吃掉大量 token。
 * 每行一个，字段固定，AI 扫一眼就能挑。
 *
 * @param {Array} elements
 * @param {{limit?:number, onlyClickable?:boolean}} [opts]
 */
export function renderElements(elements, opts = {}) {
  const limit = opts.limit || 60;
  let list = elements;
  if (opts.onlyClickable) list = list.filter((e) => e.clickable);
  const shown = list.slice(0, limit);

  const lines = shown.map((e) => {
    const marks = [];
    if (e.clickable) marks.push('可点');
    if (e.focusable) marks.push('可聚焦');
    const tag = marks.length ? ' [' + marks.join(',') + ']' : '';
    const idPart = e.id ? ' #' + e.id : '';
    const titlePart = e.title ? ' "' + String(e.title).replace(/\s+/g, ' ').slice(0, 24) + '"' : '';
    return `${String(e.i).padStart(3)} ${'  '.repeat(Math.min(e.depth, 6))}${e.cls}${idPart}${titlePart}${tag} (${e.cx},${e.cy}) ${e.w}x${e.h}`;
  });

  if (list.length > limit) {
    lines.push(`… 还有 ${list.length - limit} 个没列出（用 onlyClickable 过滤或调 limit）`);
  }
  return { text: lines.join('\n'), shown: shown.length, total: list.length };
}
