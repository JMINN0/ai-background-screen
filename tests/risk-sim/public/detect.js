/**
 * detect.js —— 风控检测引擎（跑在浏览器里）。
 *
 * 目标：像真实风控那样，收集一切能区分"人"和"自动化"的信号，
 * 然后给一个 0~100 的人机评分，并逐项说明哪一条可疑。
 *
 * 只收集、不上报任何用户隐私数据：所有结果只发到本地这台机器。
 */

(function () {
  'use strict';

  const R = {
    startedAt: Date.now(),
    fingerprint: {},
    behavior: {
      mouse: { moves: 0, samples: [], clicks: [] },
      touch: { starts: 0, moves: 0, ends: 0, samples: [], pressure: [] },
      keyboard: { down: 0, up: 0, dwell: [], flight: [], lastUpAt: 0 },
      scroll: { events: 0, samples: [] },
      trusted: { total: 0, untrusted: [] },
    },
    cdp: {},
    checks: [],
  };

  // ---------- 工具 ----------

  const now = () => performance.now();

  function addCheck(id, category, weight, ok, detail) {
    R.checks.push({ id, category, weight, ok, detail });
  }

  /** 数值数组的变异系数：越小越"规律得像机器" */
  function cv(arr) {
    if (arr.length < 3) return null;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    if (mean === 0) return 0;
    const varr = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    return Math.sqrt(varr) / mean;
  }

  function entropyOf(str) {
    const m = {};
    for (const ch of str) m[ch] = (m[ch] || 0) + 1;
    let e = 0;
    for (const k in m) {
      const p = m[k] / str.length;
      e -= p * Math.log2(p);
    }
    return e;
  }

  // ---------- 一、静态指纹 ----------

  function collectFingerprint() {
    const n = navigator;
    const s = screen;

    R.fingerprint = {
      userAgent: n.userAgent,
      platform: n.platform || '',
      vendor: n.vendor || '',
      languages: (n.languages || []).join(','),
      language: n.language || '',
      // 这一条是自动化最经典的破绽
      webdriver: n.webdriver === true,
      hardwareConcurrency: n.hardwareConcurrency || 0,
      deviceMemory: n.deviceMemory || 0,
      maxTouchPoints: n.maxTouchPoints || 0,
      // headless 常见：plugins 为空、mimeTypes 为空
      pluginsLength: (n.plugins || []).length,
      mimeTypesLength: (n.mimeTypes || []).length,
      cookieEnabled: n.cookieEnabled,
      doNotTrack: n.doNotTrack,
      screen: {
        width: s.width, height: s.height,
        availWidth: s.availWidth, availHeight: s.availHeight,
        colorDepth: s.colorDepth, pixelDepth: s.pixelDepth,
        orientation: s.orientation?.type || '',
      },
      window: {
        outerWidth: window.outerWidth, outerHeight: window.outerHeight,
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        screenX: window.screenX, screenY: window.screenY,
        devicePixelRatio: window.devicePixelRatio,
      },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      timezoneOffset: new Date().getTimezoneOffset(),
      // WebRTC 可能泄漏真实内网 IP，很多风控拿它和上报 IP 比对
      webrtc: null,
    };

    // headless 的一个经典特征：outerWidth/outerHeight 为 0
    addCheck('fp.outer-size', 'fingerprint', 10,
      window.outerWidth > 0 && window.outerHeight > 0,
      `outerWidth=${window.outerWidth} outerHeight=${window.outerHeight}`);

    // 注意：手机浏览器的 navigator.plugins 本来就是 0，拿它当破绽会误杀。
    // 真风控只在桌面 UA 下才这么判。这里跟同一个逻辑。
    const isMobileUa = /Mobile|Android|iPhone/i.test(n.userAgent);
    addCheck('fp.plugins', 'fingerprint', 6,
      isMobileUa || (n.plugins || []).length > 0,
      isMobileUa ? `移动端 UA，plugins=0 属正常（实测 ${(n.plugins || []).length}）`
        : `桌面端 plugins 长度 ${(n.plugins || []).length}（应为非 0）`);

    addCheck('fp.touch', 'fingerprint', 4,
      (n.maxTouchPoints || 0) > 0,
      `maxTouchPoints=${n.maxTouchPoints}（移动端应 > 0）`);
  }

  // Canvas 指纹：不同 GPU/驱动渲染出的像素略有差异，风控拿它做设备标识
  function canvasFingerprint() {
    try {
      const c = document.createElement('canvas');
      c.width = 220; c.height = 60;
      const ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '15px "Arial"';
      ctx.fillStyle = '#f60';
      ctx.fillRect(10, 5, 120, 30);
      ctx.fillStyle = '#069';
      ctx.fillText('风控检测 Canvas 🎨', 12, 10);
      ctx.fillStyle = 'rgba(102,204,0,0.7)';
      ctx.fillText('abcdefg', 20, 32);
      return c.toDataURL().slice(-80);
    } catch (e) { return 'ERROR:' + e.message; }
  }

  function webglFingerprint() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return { supported: false };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        supported: true,
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        version: gl.getParameter(gl.VERSION),
      };
    } catch (e) { return { supported: false, error: e.message }; }
  }

  // 字体枚举：靠"同一段文字在不同字体下的宽度"推断装了哪些字体。
  // 无头环境 / 精简系统字体很少，是个明显特征。
  function fontFingerprint() {
    const BASE = ['monospace', 'sans-serif', 'serif'];
    const TEST = [
      'Arial', 'Helvetica', 'Times New Roman', 'Courier New', 'Georgia',
      'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Comic Sans MS',
      'Microsoft YaHei', 'SimSun', 'SimHei', 'PingFang SC', 'Noto Sans CJK SC',
    ];
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const measure = (font) => {
      ctx.font = `72px ${font}, monospace`;
      return ctx.measureText('mmmmmmmmmmlliWindQi').width;
    };
    const baseW = BASE.map(measure);
    const found = [];
    for (const f of TEST) {
      ctx.font = `72px "${f}", monospace`;
      const w = ctx.measureText('mmmmmmmmmmlliWindQi').width;
      if (Math.abs(w - baseW[0]) > 0.5) found.push(f);
    }
    return found;
  }

  // ---------- 二、行为采集 ----------

  function attachBehavior() {
    const B = R.behavior;

    // 鼠标：只采样，不阻塞
    let lastMove = null;
    window.addEventListener('mousemove', (e) => {
      B.trusted.total += 1;
      if (!e.isTrusted) B.trusted.untrusted.push('mousemove');
      if (B.mouse.moves < 400) {
        const t = now();
        const dt = lastMove ? t - lastMove.t : 0;
        const dx = lastMove ? e.clientX - lastMove.x : 0;
        const dy = lastMove ? e.clientY - lastMove.y : 0;
        B.mouse.samples.push({
          x: Math.round(e.clientX), y: Math.round(e.clientY),
          dt: Math.round(dt),
          dist: Math.round(Math.hypot(dx, dy) * 10) / 10,
        });
        B.mouse.moves += 1;
        lastMove = { x: e.clientX, y: e.clientY, t };
      }
    }, { passive: true, capture: true });

    window.addEventListener('mousedown', (e) => {
      B.trusted.total += 1;
      if (!e.isTrusted) B.trusted.untrusted.push('mousedown');
      B.mouse.clicks.push({ trusted: e.isTrusted, x: Math.round(e.clientX), y: Math.round(e.clientY), type: 'down' });
    }, { passive: true, capture: true });

    window.addEventListener('click', (e) => {
      B.trusted.total += 1;
      if (!e.isTrusted) B.trusted.untrusted.push('click');
      B.mouse.clicks.push({ trusted: e.isTrusted, x: Math.round(e.clientX), y: Math.round(e.clientY), type: 'click', target: e.target?.tagName });
    }, { passive: true, capture: true });

    // 触摸：移动端最关键。真实触摸有 pressure/radius，合成的没有
    window.addEventListener('touchstart', (e) => {
      B.trusted.total += 1;
      if (!e.isTrusted) B.trusted.untrusted.push('touchstart');
      B.touch.starts += 1;
      const t = e.touches[0];
      if (t && B.touch.samples.length < 300) {
        B.touch.samples.push({ x: Math.round(t.clientX), y: Math.round(t.clientY), t: Math.round(now()) });
        B.touch.pressure.push(t.force ?? t.radiusX ?? 0);
      }
    }, { passive: true, capture: true });

    window.addEventListener('touchmove', (e) => {
      B.trusted.total += 1;
      if (!e.isTrusted) B.trusted.untrusted.push('touchmove');
      B.touch.moves += 1;
      const t = e.touches[0];
      if (t && B.touch.samples.length < 300) {
        B.touch.samples.push({ x: Math.round(t.clientX), y: Math.round(t.clientY), t: Math.round(now()) });
        B.touch.pressure.push(t.force ?? t.radiusX ?? 0);
      }
    }, { passive: true, capture: true });

    window.addEventListener('touchend', (e) => {
      B.trusted.total += 1;
      if (!e.isTrusted) B.trusted.untrusted.push('touchend');
      B.touch.ends += 1;
    }, { passive: true, capture: true });

    // 键盘：人类有 keydown→keyup 的按住时长（dwell），且字符间有停顿（flight）
    window.addEventListener('keydown', (e) => {
      B.trusted.total += 1;
      if (!e.isTrusted) B.trusted.untrusted.push('keydown');
      if (e.repeat) return;
      B.keyboard.down += 1;
      B.keyboard._downAt = now();
    }, { passive: true, capture: true });

    window.addEventListener('keyup', (e) => {
      B.trusted.total += 1;
      if (!e.isTrusted) B.trusted.untrusted.push('keyup');
      B.keyboard.up += 1;
      const t = now();
      if (B.keyboard._downAt) {
        B.keyboard.dwell.push(Math.round(t - B.keyboard._downAt));
        B.keyboard._downAt = 0;
      }
      if (B.keyboard.lastUpAt) {
        B.keyboard.flight.push(Math.round(t - B.keyboard.lastUpAt));
      }
      B.keyboard.lastUpAt = t;
    }, { passive: true, capture: true });

    // 输入框里凭空出现文字，却没有任何 keydown —— insertText / 直接赋值 的铁证。
    // 真风控一定比对"键入次数"和"文字长度"。
    window.addEventListener('input', (e) => {
      const el = e.target;
      if (!el || !('value' in el)) return;
      B.input = B.input || { events: 0, maxLen: 0, fields: 0 };
      B.input.events += 1;
      const len = String(el.value || '').length;
      if (len > B.input.maxLen) B.input.maxLen = len;
    }, { passive: true, capture: true });

    window.addEventListener('scroll', () => {
      if (B.scroll.samples.length < 200) {
        B.scroll.samples.push({ y: Math.round(window.scrollY), t: Math.round(now()) });
      }
      B.scroll.events += 1;
    }, { passive: true });
  }

  // ---------- 三、CDP / 自动化痕迹 ----------

  function detectCdp() {
    // 1) webdriver 标志（最直白）
    R.cdp.webdriver = navigator.webdriver === true;

    // 2) CDP 开启 Runtime 后，console.debug 会被替换，
    //    常见检测法：给 console.debug 定义 getter，若被调用说明有调试器接管
    R.cdp.consoleDebugGetter = false;
    try {
      const noop = () => {};
      const obj = {};
      Object.defineProperty(obj, 'console', {
        get() {
          R.cdp.consoleDebugGetter = true;
          return { debug: noop, log: noop, warn: noop, error: noop };
        },
      });
      // 触发一次
      void obj.console;
    } catch { /* ignore */ }

    // 3) 错误栈里会不会暴露 CDP 注入的函数
    R.cdp.stackHasCdp = false;
    try {
      const err = new Error('probe');
      R.cdp.stackHasCdp = /\b(pptr|__puppeteer|__playwright|devtools)/i.test(err.stack || '');
    } catch { /* ignore */ }

    // 4) 定时器分辨率：无头环境有时更低
    R.cdp.timerNoise = [];
    let last = now();
    for (let i = 0; i < 5; i += 1) {
      const t = now();
      R.cdp.timerNoise.push(Math.round((t - last) * 1000) / 1000);
      last = t;
    }

    // 5) 权限/媒体设备：无头通常缺
    R.cdp.mediaDevices = !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices);
  }

  // ---------- 四、行为分析 ----------

  function analyzeBehavior() {
    const B = R.behavior;
    const out = {};

    // 鼠标轨迹平滑度：机器人常是直线 + 匀速
    if (B.mouse.samples.length >= 8) {
      const dists = B.mouse.samples.map((s) => s.dist).filter((d) => d > 0);
      const dts = B.mouse.samples.map((s) => s.dt).filter((d) => d > 0);
      out.mouseCv = cv(dists);
      out.mouseDtCv = cv(dts);

      // 直线度：起点到终点的直线距离 / 实际走过的路程。人类明显 < 1
      const first = B.mouse.samples[0];
      const last = B.mouse.samples[B.mouse.samples.length - 1];
      const straight = Math.hypot(last.x - first.x, last.y - first.y);
      const path = B.mouse.samples.reduce((a, s) => a + s.dist, 0);
      out.mouseStraightness = path > 0 ? Math.round((straight / path) * 1000) / 1000 : null;

      addCheck('bh.mouse-straight', 'behavior', 8,
        out.mouseStraightness === null || out.mouseStraightness < 0.95,
        `直线度 ${out.mouseStraightness}（越接近 1 越像机器人走直线）`);

      addCheck('bh.mouse-timing', 'behavior', 8,
        out.mouseDtCv === null || out.mouseDtCv > 0.25,
        `移动间隔变异系数 ${out.mouseDtCv?.toFixed(3)}（太规律像机器）`);
    } else {
      addCheck('bh.mouse-missing', 'behavior', 6, false,
        `鼠标移动采样只有 ${B.mouse.samples.length} 个，不足以判人`);
    }

    // 触摸：真实触摸会有持续 pressure 变化
    if (B.touch.samples.length >= 3) {
      const uniqPressure = new Set(B.touch.pressure.map((p) => Math.round(p * 1000) / 1000));
      out.touchPressureVariety = uniqPressure.size;
      addCheck('bh.touch-pressure', 'behavior', 6,
        uniqPressure.size > 1,
        `触摸压力取值只有 ${uniqPressure.size} 种（真实手指会连续变化）`);
    }

    // 键盘：dwell / flight 的变异系数
    if (B.keyboard.dwell.length >= 3) {
      out.dwellCv = cv(B.keyboard.dwell);
      addCheck('bh.dwell', 'behavior', 8,
        out.dwellCv === null || out.dwellCv > 0.2,
        `按键按住时长变异系数 ${out.dwellCv?.toFixed(3)}（太一致像机器）`);
    } else if (B.keyboard.down > 0) {
      addCheck('bh.dwell-missing', 'behavior', 5, false,
        `有 ${B.keyboard.down} 次按键但没采到 keyup，说明文字不是"敲"进去的`);
    }

    if (B.keyboard.flight.length >= 3) {
      out.flightCv = cv(B.keyboard.flight);
      addCheck('bh.flight', 'behavior', 6,
        out.flightCv === null || out.flightCv > 0.3,
        `字符间隔变异系数 ${out.flightCv?.toFixed(3)}`);
    }

    // 输入框有字但没按键 —— 机器人特征
    const inp = B.input || { events: 0, maxLen: 0 };
    const typedKeys = Math.max(B.keyboard.down, B.keyboard.up);
    if (inp.maxLen > 0) {
      out.inputMaxLen = inp.maxLen;
      out.typedKeys = typedKeys;
      addCheck('bh.input-without-keys', 'behavior', 18,
        typedKeys >= Math.min(inp.maxLen, 1) || typedKeys > 0,
        typedKeys === 0
          ? `输入框里出现了 ${inp.maxLen} 个字符，但**一次按键都没有**（insertText / 直接赋值）`
          : `输入 ${inp.maxLen} 字符，按键 ${typedKeys} 次`);
    }

    // 点击了但没有 mousedown/mouseup —— el.click() 的特征
    const clickEvents = B.mouse.clicks.filter((c) => c.type === 'click');
    const downEvents = B.mouse.clicks.filter((c) => c.type === 'down');
    if (clickEvents.length > 0) {
      out.clicksWithDown = `${downEvents.length}/${clickEvents.length}`;
      addCheck('bh.click-without-mousedown', 'behavior', 15,
        downEvents.length > 0,
        downEvents.length === 0
          ? `${clickEvents.length} 次 click 但**零次 mousedown**（JS 合成的 el.click()）`
          : `${clickEvents.length} 次 click 对应 ${downEvents.length} 次 mousedown`);
    }

    // 最关键的一条：isTrusted
    const untrusted = B.trusted.untrusted;
    out.untrustedEvents = untrusted.slice(0, 20);
    out.untrustedCount = untrusted.length;
    addCheck('bh.trusted', 'behavior', 20,
      untrusted.length === 0,
      untrusted.length === 0
        ? `共 ${B.trusted.total} 个事件全部 isTrusted=true`
        : `**${untrusted.length} 个事件 isTrusted=false**（典型：JS 合成点击）：${[...new Set(untrusted)].join(', ')}`);

    R.behaviorAnalysis = out;
  }

  // ---------- 评分 ----------

  function score() {
    const total = R.checks.reduce((a, c) => a + c.weight, 0);
    const got = R.checks.filter((c) => c.ok).reduce((a, c) => a + c.weight, 0);
    const pct = total > 0 ? Math.round((got / total) * 100) : 0;
    return {
      score: pct,
      passed: R.checks.filter((c) => c.ok).length,
      failed: R.checks.filter((c) => !c.ok).length,
      totalWeight: total,
      gotWeight: got,
    };
  }

  // ---------- 对外 ----------

  window.RiskDetect = {
    async run() {
      R.checks = [];          // 不重置的话同一页面跑两次会把检查项累加，权重翻倍
      R.startedAt = Date.now();
      collectFingerprint();
      detectCdp();

      R.fingerprint.canvas = canvasFingerprint();
      R.fingerprint.webgl = webglFingerprint();
      R.fingerprint.fonts = fontFingerprint();

      addCheck('fp.canvas', 'fingerprint', 3, !!R.fingerprint.canvas && !String(R.fingerprint.canvas).startsWith('ERROR'),
        'canvas 指纹能取到');
      addCheck('fp.webgl', 'fingerprint', 4, R.fingerprint.webgl?.supported === true,
        R.fingerprint.webgl?.supported ? `renderer: ${R.fingerprint.webgl.renderer}` : 'WebGL 不可用');

      addCheck('cdp.webdriver', 'cdp', 15, !R.cdp.webdriver,
        R.cdp.webdriver ? 'navigator.webdriver === true' : 'navigator.webdriver === false');
      addCheck('cdp.stack', 'cdp', 5, !R.cdp.stackHasCdp,
        R.cdp.stackHasCdp ? '错误栈里出现 CDP 注入痕迹' : '错误栈干净');
      addCheck('cdp.media', 'cdp', 3, R.cdp.mediaDevices,
        R.cdp.mediaDevices ? 'mediaDevices 可用' : 'mediaDevices 缺失');

      analyzeBehavior();
      R.elapsedMs = Date.now() - R.startedAt;
      R.summary = score();
      return R;
    },
    attachBehavior,
    raw: R,
  };

  // 先挂监听，页面交互过程中持续采集
  attachBehavior();
})();
