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
  const out = { activity: '', pkg: '', elements: [], count: 0, mixedFixed: false };
  if (!raw) return out;

  const lines = String(raw).split('\n');

  /* **先选出「应该显示哪一个 activity」，再只解析那一段。**
   *
   * 2026-11-26 实测抓到的 bug：一块屏上可能有**多个** ACTIVITY 段
   * （栈里停了 settings，前台是 calculator2）。旧代码按「屏」判定，
   * 两段都算命中 → 把两棵 View 树拼在一起。
   *
   * 后果很严重：activity 头写的是计算器，但元素里混了 settings 的，
   * 有 8 个 settings 元素的坐标落在计算器按钮矩形内 ——
   * AI 按 id 找「设置」，点到的是数字键。这个 bug 在主屏上同样存在。
   *
   * 修法：按 ACTIVITY 行切段，在每段正文里找 mResumed=true，选那一段；
   * 取不到再退回 Task 的 visible=true；都没有才用第一个。
   */
  const heads = [];
  for (let i = 0; i < lines.length; i += 1) {
    const am = lines[i].match(/\bACTIVITY\s+([\w.$]+\/[\w.$]+).*displayId=(\d+)/);
    if (am) heads.push({ pkg: am[1], disp: Number(am[2]), line: i, headText: lines[i] });
  }

  const segs = heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].line : lines.length;
    let resumed = null;
    for (const b of lines.slice(h.line, Math.min(end, h.line + 40))) {
      const rs = b.match(/mResumed=(true|false)\s+mStopped=(true|false)/);
      if (rs) { resumed = rs[1] === 'true'; break; }
    }
    const vis = h.headText.match(/visible=(\w+)/);
    return { ...h, resumed, visible: vis ? vis[1] === 'true' : null, end };
  });

  const onDisp = segs.filter((x) => displayId == null || x.disp === Number(displayId));
  const chosen = onDisp.find((x) => x.resumed === true)
    || onDisp.find((x) => x.visible === true)
    || onDisp[0];

  if (!chosen) return out;
  out.activity = chosen.pkg;
  out.pkg = chosen.pkg.split('/')[0];
  if (onDisp.length > 1) out.mixedFixed = true;   // 告诉调用方「这块屏上不止一个 activity」

  /* 只解析被选中那一段里的 View Hierarchy */
  let inHierarchy = false;
  let depthBase = -1;
  let idx = 0;
  /* **父偏移栈**：解析时按 depth 维护「当前这一层父容器的绝对左上角」。 */
  const parentStack = [{ depth: -1, x: 0, y: 0 }];
  let parentX = 0;
  let parentY = 0;

  for (let i = chosen.line; i < chosen.end; i += 1) {
    const line = lines[i];
    if (/View Hierarchy:/.test(line)) { inHierarchy = true; depthBase = -1; continue; }
    if (!inHierarchy) continue;
    if (/^\s*(Local Activity|ViewRoot|Looper)/.test(line)) { inHierarchy = false; continue; }

    const m = line.match(RE_VIEW);
    if (!m) continue;
    const [, indent, cls, hash, flags, status, x1, y1, x2, y2, rest] = m;

    if (depthBase < 0) depthBase = indent.length;
    const depth = Math.max(0, Math.round((indent.length - depthBase) / 2));

    const vis = flags.charAt(0);
    const l = Number(x1), t = Number(y1), r = Number(x2), b = Number(y2);
    const w = r - l, h = b - t;

    /* 按 depth 出栈：回到「比当前深度浅的那一层」 */
    while (parentStack.length > 1 && parentStack[parentStack.length - 1].depth >= depth) {
      parentStack.pop();
    }
    const top = parentStack[parentStack.length - 1];
    parentX = top.x;
    parentY = top.y;

    /* **累加父偏移。**
     * 2026-11-26 实测：dumpsys 给的坐标是**相对父容器**的。
     * 例：CalculatorDisplay 是 0,0-720,558，它挂在根 (360,796) 下，
     * 里面的 digit_7 是 27,235-194,418 —— 实际屏幕坐标要加上父层偏移。
     * 不累加的话，AI 按 (111,327) 点「7」，实际点到屏幕上方去了。
     */
    const absoluteX = l + parentX;
    const absoluteY = t + parentY;

    out.elements.push({
      i: idx++,
      depth,
      cls: cls.split('.').pop(),
      full: cls,
      vis,
      /* **clickable/focusable 在 flags 里，不在 status 里。**
       * 实测：Button 的 flags 是 `VFED..C..`（C = clickable），status 是 `........`。
       * 原来查 status.includes('C') 永远为假 → onlyClickable 过滤后一个不剩。 */
      clickable: flags.includes('C'),
      focusable: flags.includes('F'),
      id: shortId(rest),
      title: (rest.match(/\[([^\]]*)\]/) || [])[1] || '',
      x: absoluteX, y: absoluteY, w, h,
      cx: w > 0 ? Math.round((absoluteX + w / 2)) : absoluteX,
      cy: h > 0 ? Math.round((absoluteY + h / 2)) : absoluteY,
    });
    /* 这个控件成为下一层的父偏移 */
    parentStack.push({ depth, x: absoluteX, y: absoluteY });
  }

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
