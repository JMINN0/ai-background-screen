/**
 * 环境指纹探针 —— 把"页面能读到、能用来判断你不是真人真机"的信号全列出来。
 *
 * 这跟 detect.js / strict.js 不一样：那两个是"行为像不像人"，
 * 这一个问的是"环境像不像一台真手机被真人操作"。
 *
 * 为什么需要它：真实平台（微信、银行、游戏）判断风险时，
 * 往往不看行为，先看环境。豆包被微信判"登录环境异常"、被银行判"屏幕共享"，
 * 都不是因为行为不像人，是因为设备状态不对。
 *
 * 所以先搞清楚：从页面这一层，到底能读到哪些"我不在真机上"的证据。
 *
 * 注意：这里只统计"页面层可观测"的信号。
 * 系统层的信号（MotionEvent.getDeviceId、非默认 displayId、FLAG_SECURE）
 * 页面根本读不到，那些才是真正致命的，但这个检测器测不了 —— 如实写在报告里。
 */
(function () {
  'use strict';

  const P = {
    moves: [],     // 鼠标/触摸移动样本
    downs: [],
    ups: [],
    keys: [],
    pointers: [],  // pointer 事件（能拿到 pointerType / pressure / width）
    touchEvents: [], // 原生 touch 事件
  };

  function attach() {
    window.addEventListener('mousemove', (e) => {
      P.moves.push({
        x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, t: e.timeStamp,
        trusted: e.isTrusted,
      });
    }, true);

    window.addEventListener('mousedown', (e) => {
      P.downs.push({ x: e.clientX, y: e.clientY, t: e.timeStamp, trusted: e.isTrusted });
    }, true);
    window.addEventListener('mouseup', (e) => {
      P.ups.push({ x: e.clientX, y: e.clientY, t: e.timeStamp, trusted: e.isTrusted });
    }, true);

    window.addEventListener('keydown', (e) => {
      if (!e.repeat) P.keys.push({ key: e.key, code: e.code, t: e.timeStamp, trusted: e.isTrusted });
    }, true);

    // pointer 事件能拿到 mousemove 拿不到的东西：pointerType / pressure / 接触面积
    window.addEventListener('pointermove', (e) => {
      let co = 1;
      try { co = e.getCoalescedEvents ? e.getCoalescedEvents().length : 1; } catch { co = -1; }
      P.pointers.push({
        type: e.pointerType,
        id: e.pointerId,
        pressure: e.pressure,
        width: e.width,
        height: e.height,
        coalesced: co,
        isPrimary: e.isPrimary,
        trusted: e.isTrusted,
        t: e.timeStamp,
      });
    }, true);

    ['touchstart', 'touchmove', 'touchend'].forEach((type) => {
      window.addEventListener(type, (e) => {
        const t0 = e.touches[0] || e.changedTouches[0];
        P.touchEvents.push({
          type,
          points: e.touches.length,
          radiusX: t0 ? t0.radiusX : null,
          radiusY: t0 ? t0.radiusY : null,
          force: t0 ? t0.force : null,
          trusted: e.isTrusted,
          t: e.timeStamp,
        });
      }, { capture: true, passive: true });
    });
  }

  /** 探查 CDP 是否连着：DataDome 公开的那一招。 */
  function cdpProbe() {
    let hit = false;
    let msg = '';
    try {
      const err = new Error();
      let frames = 0;
      Object.defineProperty(err, 'stack', {
        configurable: true,
        get() { hit = true; frames += 1; return ''; },
      });
      // 触发 stack 读取
      void err.stack;
      msg = hit ? `stack getter 被触发 ${frames} 次` : '没触发';
    } catch (e) {
      msg = '探测失败：' + e.message;
    }
    return { hit, msg };
  }

  function run() {
    const signals = [];
    const raw = {};
    const add = (id, severity, hit, detail) => {
      signals.push({ id, severity, hit: Boolean(hit), detail });
      if (hit) raw[id] = detail;
    };

    // ===== 1. 自动化标记 =====
    const wd = typeof navigator.webdriver;
    raw.webdriver = navigator.webdriver;
    add('automation.webdriver', 'high', navigator.webdriver === true,
      `navigator.webdriver = ${String(navigator.webdriver)}（${wd}）`);

    // webdriver 是否被"打过补丁"：正常应该在 Navigator.prototype 上，不在实例上
    const ownProps = Object.getOwnPropertyNames(navigator);
    const patched = ownProps.includes('webdriver');
    add('automation.webdriver-patched', 'high', patched,
      patched ? 'webdriver 被定义在 navigator 实例上（打补丁的痕迹，比原样更可疑）'
        : 'webdriver 没有被打过补丁');

    // ===== 2. CDP 副作用 =====
    const cdp = cdpProbe();
    add('automation.cdp-stack-probe', 'high', cdp.hit,
      `Error.stack 探针：${cdp.msg}`);

    // ===== 3. 触摸能力 =====
    raw.maxTouchPoints = navigator.maxTouchPoints;
    raw.ontouchstart = ('ontouchstart' in window);
    const touchCapable = navigator.maxTouchPoints > 0 || ('ontouchstart' in window);
    add('device.touch-support', 'high', !touchCapable,
      touchCapable ? `支持触摸（maxTouchPoints=${navigator.maxTouchPoints}）`
        : '不支持触摸，像桌面浏览器');
    // 支持触摸但整个会话一次 touch 事件都没有 —— 手机站上真人几乎不可能
    if (touchCapable) {
      add('device.touch-never-fired', 'high', P.touchEvents.length === 0,
        P.touchEvents.length === 0
          ? '声明支持触摸，但整个会话零个 touch 事件（我们发的是 mouse 事件）'
          : `收到 ${P.touchEvents.length} 个 touch 事件`);
    }

    // ===== 4. 屏幕几何 =====
    raw.screen = { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight, dpr: devicePixelRatio };
    raw.window = { iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight };
    const screenMismatch = Math.abs(screen.width - (screen.availWidth || 0)) > 0;
    raw.screenMismatch = screenMismatch;

    // screenX 恒为 0：无头/虚拟环境特征
    if (P.moves.length >= 5) {
      const zero = P.moves.filter((m) => m.sx === 0 && m.sy === 0).length;
      const ratio = zero / P.moves.length;
      add('device.screen-origin-zero', 'high', ratio > 0.9,
        `${(ratio * 100).toFixed(0)}% 的移动事件 screenX/screenY 都是 0`);
      raw.screenOriginZeroRatio = ratio;
    }

    // ===== 5. 输入事件物理属性 =====
    if (P.pointers.length) {
      raw.pointerType = P.pointers[0].type;
      const types = [...new Set(P.pointers.map((p) => p.type))];
      add('input.pointer-type', 'mid', types.includes('mouse') && touchCapable,
        `pointerType = ${types.join('/')}（触摸设备上真人会产生 touch）`);

      // 压力：真实触摸会变化，注入的鼠标事件恒为 0 或 0.5
      const pressures = P.pointers.map((p) => p.pressure);
      const uniqP = new Set(pressures.map((p) => Math.round(p * 100) / 100)).size;
      raw.pressureValues = [...new Set(pressures)].slice(0, 6);
      add('input.pressure-flat', 'high', uniqP <= 1,
        `压力取值只有 ${uniqP} 种：${raw.pressureValues.join(', ')}`);

      // 接触面积：真实手指 width/height 是变化的，鼠标恒为 1 或 0
      const widths = new Set(P.pointers.map((p) => p.width)).size;
      add('input.contact-size-flat', 'mid', widths <= 1,
        `接触面积取值只有 ${widths} 种（真实手指会变化）`);

      // pointerId：真实触摸每个手指都有独立 id
      const ids = [...new Set(P.pointers.map((p) => p.id))];
      raw.pointerIds = ids.slice(0, 8);
      add('input.pointer-id', 'mid', ids.length <= 1,
        `pointerId 只有 ${ids.length} 种：${ids.join(',')}`);

      // 合并事件：真实触摸屏会把多个硬件采样合并成一个事件
      const co = P.pointers.map((p) => p.coalesced);
      const maxCo = Math.max(...co);
      raw.maxCoalesced = maxCo;
      add('input.coalesced', 'mid', maxCo <= 1,
        `合并采样最多 ${maxCo} 个（真实触摸屏通常 >1）`);
    } else {
      add('input.no-pointer-events', 'mid', true, '整个会话没有任何 pointer 事件');
    }

    // ===== 6. 键盘 =====
    if (P.keys.length >= 3) {
      const needShift = P.keys.filter((k) => /^[A-Z!@#$%^&*()_+{}|:"<>?~]$/.test(k.key));
      const shiftKeys = P.keys.filter((k) => k.key === 'Shift');
      add('input.shift-coherence', 'high', needShift.length > 0 && shiftKeys.length === 0,
        `${needShift.length} 个大写/符号键，Shift 按下 ${shiftKeys.length} 次`);
    }

    // ===== 7. 行为的时间分布 =====
    if (P.moves.length >= 5) {
      const dts = [];
      for (let i = 1; i < P.moves.length; i += 1) {
        const d = P.moves[i].t - P.moves[i - 1].t;
        if (d > 0) dts.push(d);
      }
      if (dts.length >= 3) {
        const m = dts.reduce((a, b) => a + b, 0) / dts.length;
        const sd = Math.sqrt(dts.reduce((s, x) => s + (x - m) ** 2, 0) / (dts.length - 1));
        const cvv = m ? sd / m : 0;
        raw.moveDtCv = cvv;
        add('behavior.dt-cv', 'high', cvv < 0.3,
          `移动间隔变异系数 ${cvv.toFixed(3)}（真人 0.4+）`);

        // 同帧批量注入
        const byT = {};
        P.moves.forEach((x) => { byT[x.t] = (byT[x.t] || 0) + 1; });
        const sameFrame = Math.max(...Object.values(byT));
        raw.sameFrameBatch = sameFrame;
        add('behavior.same-frame', 'high', sameFrame > 2,
          `同一帧出现 ${sameFrame} 个移动事件`);
      }
    }

    // ===== 8. 会话整体 =====
    raw.eventCounts = {
      moves: P.moves.length, downs: P.downs.length, ups: P.ups.length,
      keys: P.keys.length, pointers: P.pointers.length, touch: P.touchEvents.length,
    };
    // 有按下没抬起
    const dangling = P.downs.length - P.ups.length;
    add('behavior.dangling-press', 'high', dangling > 0,
      `${dangling} 次按下没有对应的抬起`);

    // ===== 计分 =====
    const SEV_W = { high: 12, mid: 6, low: 3 };
    const exposure = Math.min(100, signals.filter((s) => s.hit)
      .reduce((a, s) => a + (SEV_W[s.severity] || 3), 0));

    let verdict;
    if (exposure >= 45) verdict = { level: 'bot', label: '明显是自动化环境', action: '拦截/二次验证' };
    else if (exposure >= 20) verdict = { level: 'sus', label: '有可检测的自动化痕迹', action: '加验证码/限流' };
    else verdict = { level: 'ok', label: '环境上没有明显破绽', action: '放行' };

    return {
      exposure,
      verdict,
      signals,
      raw,
      note: '本探针只覆盖页面层可观测信号。'
        + '系统层信号（MotionEvent.getDeviceId=0、非默认 displayId、FLAG_SECURE）'
        + '页面读不到，但真实平台能读到，且无 root 改不了。',
    };
  }

  window.EnvProbe = {
    run,
    reset() {
      P.moves = []; P.downs = []; P.ups = []; P.keys = []; P.pointers = []; P.touchEvents = [];
    },
    raw: P,
  };

  attach();
})();
