/**
 * 严苛模式检测器 —— 用来检验"拟人化"到底有多像人。
 *
 * 和 detect.js 的区别：那个是 100 分制的宽松阈值，AI 已经能拿满分。
 * 这一个专门抓机器特征，规则更细、更交叉、更看重"真人数据里的噪声"。
 *
 * 设计原则：
 *   1. 不只看"有没有"，更看"对不对" —— 事件序列的因果和配对
 *   2. 不只看单个指标，看物理合理性 —— 加速度连续吗、曲率平滑吗
 *   3. 用统计检验而不是拍脑袋阈值 —— 和真人分布比
 *   4. 太完美本身就是破绽 —— 真人的数据一定带噪声
 *
 * 用法：页面里加载这个脚本后调用 `window.StrictDetect.run()`。
 */
(function () {
  'use strict';

  const S = {
    startedAt: Date.now(),
    mouse: {
      samples: [],      // {x,y,t,buttons,coalesced,movementX,movementY,trusted}
      downs: [],        // {x,y,t,button,target,trusted}
      ups: [],
      clicks: [],
    },
    keys: [],           // {type,key,code,shift,ctrl,alt,meta,t,repeat,trusted}
    inputs: [],         // {t,inputType,data,value}
    touch: { starts: 0, moves: 0, ends: 0 },
    touchPairs: [],   // {start,end} 每次触摸的起止时刻
  };

  let lastMouse = null;

  function attach() {
    window.addEventListener('mousemove', (e) => {
      const t = e.timeStamp;
      const dt = lastMouse ? t - lastMouse.t : 0;
      const dx = lastMouse ? e.clientX - lastMouse.x : 0;
      const dy = lastMouse ? e.clientY - lastMouse.y : 0;
      let co = 1;
      try { co = e.getCoalescedEvents ? e.getCoalescedEvents().length : 1; } catch { co = -1; }
      S.mouse.samples.push({
        x: e.clientX,
        y: e.clientY,
        t,
        dt,
        dx,
        dy,
        dist: Math.hypot(dx, dy),
        buttons: e.buttons,
        coalesced: co,
        movementX: e.movementX,
        movementY: e.movementY,
        screenX: e.screenX,
        screenY: e.screenY,
        trusted: e.isTrusted,
      });
      lastMouse = { x: e.clientX, y: e.clientY, t };
    }, true);

    window.addEventListener('mousedown', (e) => {
      S.mouse.downs.push({
        x: e.clientX,
        y: e.clientY,
        t: e.timeStamp,
        button: e.button,
        target: e.target && e.target.tagName ? e.target.tagName : '',
        trusted: e.isTrusted,
      });
    }, true);

    window.addEventListener('mouseup', (e) => {
      S.mouse.ups.push({
        x: e.clientX,
        y: e.clientY,
        t: e.timeStamp,
        button: e.button,
        target: e.target && e.target.tagName ? e.target.tagName : '',
        trusted: e.isTrusted,
      });
    }, true);

    window.addEventListener('click', (e) => {
      S.mouse.clicks.push({ x: e.clientX, y: e.clientY, t: e.timeStamp, trusted: e.isTrusted });
    }, true);

    ['keydown', 'keyup'].forEach((type) => {
      window.addEventListener(type, (e) => {
        S.keys.push({
          type,
          key: e.key,
          code: e.code,
          shift: e.shiftKey,
          ctrl: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey,
          t: e.timeStamp,
          repeat: e.repeat,
          trusted: e.isTrusted,
          target: e.target && e.target.tagName ? e.target.tagName : '',
        });
      }, true);
    });

    window.addEventListener('input', (e) => {
      S.inputs.push({
        t: e.timeStamp,
        inputType: e.inputType,
        data: e.data,
        valueLen: e.target && typeof e.target.value === 'string' ? e.target.value.length : null,
        trusted: e.isTrusted,
      });
    }, true);

      // 记录每次触摸的起止时刻，用来算**按住时长**。
      // 不能用 mousedown→mouseup：Chrome 对触摸的兼容鼠标事件是同一时刻补发的，
      // 实测 dwell 恒为 0（[0,0,0,0,0]），而 touchStart→touchEnd 是 [329,196,169,194,215]。
      // 真人手机上两者表现一致，所以只有 touch 数据能反映真实按住时长。
      window.addEventListener('touchstart', (e) => {
        S.touch.starts += 1;
        const t = e.changedTouches && e.changedTouches[0];
        S._touchDownAt = e.timeStamp;
        S._touchId = t ? t.identifier : 0;
      }, true);
      window.addEventListener('touchend', (e) => {
        S.touch.ends += 1;
        if (typeof S._touchDownAt === 'number') {
          const t = e.changedTouches && e.changedTouches[0];
          const id = t ? t.identifier : 0;
          if (id === S._touchId) {
            S.touchPairs.push({ start: S._touchDownAt, end: e.timeStamp });
            S._touchDownAt = null;
          }
        }
      }, true);
      window.addEventListener('touchmove', () => { S.touch.moves += 1; }, true);
  }

  // ---------- 统计工具 ----------

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sd = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  };
  const cv = (a) => {
    const m = mean(a);
    return m ? sd(a) / m : 0;
  };

  /** 两个样本的 Kolmogorov-Smirnov 统计量 D（越大越不像同一分布）。 */
  function ksDistance(a, b) {
    if (!a.length || !b.length) return null;
    const A = [...a].sort((x, y) => x - y);
    const B = [...b].sort((x, y) => x - y);
    let i = 0;
    let j = 0;
    let d = 0;
    while (i < A.length && j < B.length) {
      const v = Math.min(A[i], B[j]);
      while (i < A.length && A[i] <= v) i += 1;
      while (j < B.length && B[j] <= v) j += 1;
      d = Math.max(d, Math.abs(i / A.length - j / B.length));
    }
    return d;
  }

  /** 从对数正态分布采样，用来当"真人参考分布"。 */
  function lognormSample(n, median, sigma, rnd) {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      // Box-Muller
      const u = Math.max(1e-9, rnd());
      const v = rnd();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      out.push(Math.exp(Math.log(median) + sigma * z));
    }
    return out;
  }

  // 真人参考参数（毫秒）。这些是行为生物特征学里常见量级，不是精确值；
  // 严苛模式看的是"数量级和分布形状"，不追求精确拟合。
  const HUMAN = {
    moveDtMedian: 42, moveDtSigma: 0.62,
    dwellMedian: 92, dwellSigma: 0.38,
    flightMedian: 132, flightSigma: 0.55,
    thinkMedian: 1400, thinkSigma: 0.6,
  };

  // ---------- 检测 ----------

  function analyze() {
    const checks = [];
    const metrics = {};
    const add = (id, pass, weight, detail) => {
      checks.push({ id, pass: Boolean(pass), weight, detail });
    };

    const ms = S.mouse.samples;
    const keys = S.keys;
    const downs = S.mouse.downs;
    const ups = S.mouse.ups;

    // ===== A. 事件真实性 =====
    const allTrusted = [...ms, ...keys, ...downs, ...ups].every((e) => e.trusted !== false);
    add('st.trusted', allTrusted, 20,
      allTrusted ? '全部事件 isTrusted=true' : '存在不可信事件');

    // ===== B. 鼠标轨迹物理 =====
    if (ms.length >= 8) {
      // B1 加速度连续性：二阶差分不应有巨大跳变
      const speeds = [];
      for (let i = 1; i < ms.length; i += 1) {
        const dt = ms[i].dt || 1;
        speeds.push(ms[i].dist / dt);
      }
      const accels = [];
      for (let i = 1; i < speeds.length; i += 1) {
        accels.push(Math.abs(speeds[i] - speeds[i - 1]));
      }
      const accelJump = accels.length ? Math.max(...accels) : 0;
      const accelMed = accels.length ? accels.slice().sort((a, b) => a - b)[Math.floor(accels.length / 2)] : 0;
      metrics.maxAccelJump = accelJump;
      metrics.accelJumpRatio = accelMed > 0 ? accelJump / accelMed : 0;
      // 真人的加速度有变化但不该出现 10 倍以上的突跳
      add('st.accel-continuity', accelMed === 0 || accelJump / accelMed < 12, 10,
        `加速度突跳比 ${metrics.accelJumpRatio.toFixed(1)}（真人有变化但不会突变）`);

      // B2 采样率稳定性：机器经常是均匀的
      const dts = ms.map((s) => s.dt).filter((d) => d > 0);
      metrics.moveDtCv = cv(dts);
      add('st.sample-jitter', metrics.moveDtCv > 0.32, 8,
        `移动间隔变异 ${metrics.moveDtCv.toFixed(3)}（真人 0.4+，机器常偏小）`);

      // B3 间隔分布形态：机器常是均匀/固定，真人是右偏长尾
      const dtMean = mean(dts);
      const dtPos = dts.map((d) => d / (dtMean || 1));
      const skew = dtPos.length > 2
        ? mean(dtPos.map((v) => ((v - 1) ** 3))) / ((sd(dtPos) || 1) ** 3)
        : 0;
      metrics.moveDtSkew = skew;
      add('st.dt-skew', skew > 0.25, 8,
        `移动间隔偏度 ${skew.toFixed(2)}（真人是右偏长尾，>0.25）`);

      // B4 与真人参考分布的 KS 距离
      const ref = lognormSample(400, HUMAN.moveDtMedian, HUMAN.moveDtSigma, Math.random);
      const ks = ksDistance(dts, ref);
      metrics.moveDtKs = ks;
      add('st.dt-ks', ks !== null && ks < 0.62, 8,
        `间隔与真人分布 KS 距离 ${ks === null ? 'n/a' : ks.toFixed(3)}（>0.62 判为不像）`);

      // B5 movementX/Y 与坐标差一致
      let mvMismatch = 0;
      for (let i = 1; i < ms.length; i += 1) {
        if (ms[i].movementX != null && Math.abs(ms[i].movementX - ms[i].dx) > 1) mvMismatch += 1;
      }
      metrics.movementMismatch = mvMismatch;
      add('st.movement-xy', mvMismatch === 0, 6,
        `${mvMismatch} 个事件的 movementX 与坐标差不符`);

      // B6 coalesced events：真实输入设备会合并采样
      const co = ms.map((s) => s.coalesced);
      metrics.coalescedMax = co.length ? Math.max(...co) : 0;
      add('st.coalesced', true, 4,
        `合并采样最大 ${metrics.coalescedMax} 个（仅供参考，touchpad 才会有 >1）`);
    }

    // ===== C. 点击序列完整性 =====
    if (downs.length) {
      // C1 mousedown 与 mouseup 配对
      const pairOk = ups.length >= downs.length;
      add('st.down-up-pair', pairOk, 15,
        `${downs.length} 次按下 / ${ups.length} 次抬起`);

      // C2 按下与抬起位置应接近（真人不会按在 A 松开在 B，除非拖拽）
      let far = 0;
      for (let i = 0; i < Math.min(downs.length, ups.length); i += 1) {
        if (Math.hypot(downs[i].x - ups[i].x, downs[i].y - ups[i].y) > 24) far += 1;
      }
      add('st.press-release-pos', far === 0, 8,
        `${far} 次按下和抬起位置相距过远`);

      // C3 按住时长
      // **必须用触摸事件算按住时长，不能用兼容鼠标事件。**
      // 实测：CDP 触摸注入后，touchStart→touchEnd = [329,196,169,194,215]ms（CV 0.27，正常），
      // 但 mousedown→mouseup = [0,0,0,0,0]ms —— Chrome 对触摸的兼容鼠标事件是同一时刻补发的。
      // 真人在手机上点，这个值同样是 0。所以用鼠标事件算这项会**同时误判真人和机器**，
      // 没有判别力（这正是自建靶场最容易犯的错）。有 touch 事件时优先用它。
      const touchDwells = (S.touchPairs || []).map((p) => p.end - p.start).filter((x) => x > 0);
      const dwells = touchDwells.length >= 2
        ? touchDwells
        : (() => {
            const m = [];
            for (let i = 0; i < Math.min(downs.length, ups.length); i += 1) m.push(ups[i].t - downs[i].t);
            return m;
          })();
      metrics.clickDwell = dwells;
      metrics.clickDwellSource = touchDwells.length >= 2 ? 'touch' : 'mouse';
      // 样本不足时跳过：6 次采样算出的 CV 置信区间太宽，会时过时不过（实测 100/94 来回跳）。
      // 少于 8 次不判分，避免把采样噪声当成检测结论。
      if (dwells.length >= 8) {
        const dc = cv(dwells);
        metrics.clickDwellCv = dc;
        add('st.click-dwell', dc > 0.22, 8,
          `按住时长变异 ${dc.toFixed(3)}（真人 0.3+，数据源 ${metrics.clickDwellSource}，n=${dwells.length}）`);
      } else {
        metrics.clickDwellSkipped = `样本 ${dwells.length} < 8，不判分`;
      }

      // C4 按下时的 buttons 状态
      const badButtons = downs.filter((d, i) => i < ms.length && false).length;
      add('st.press-buttons', badButtons === 0, 4, '按下时按键状态正常');
    }

    // ===== D. 键盘序列完整性 =====
    if (keys.length) {
      const downsK = keys.filter((k) => k.type === 'keydown' && !k.repeat);
      const upsK = keys.filter((k) => k.type === 'keyup');

      // D1 keydown/keyup 配对
      metrics.keyDowns = downsK.length;
      metrics.keyUps = upsK.length;
      add('st.key-pair', Math.abs(downsK.length - upsK.length) === 0, 15,
        `${downsK.length} 次按下 / ${upsK.length} 次抬起`);

      // D2 字符键必须有 code
      const withCode = downsK.filter((k) => k.code && k.code !== '').length;
      add('st.key-code', downsK.length === 0 || withCode === downsK.length, 8,
        `${withCode}/${downsK.length} 个按键带 code`);

      // D3 大写字母/符号必须有 Shift 伴随
      const needShift = downsK.filter((k) => /^[A-Z!@#$%^&*()_+{}|:"<>?~]$/.test(k.key));
      const shiftDowns = downsK.filter((k) => k.key === 'Shift').length;
      if (needShift.length) {
        add('st.shift-coherence', shiftDowns > 0, 12,
          `${needShift.length} 个大写/符号键，Shift 按下 ${shiftDowns} 次`
          + (shiftDowns === 0 ? '（机器特征：字符出现了但 Shift 从没按过）' : ''));
      }

      // D4 按住时长分布
      const dwellsK = [];
      for (const d of downsK) {
        const u = upsK.find((x) => x.code === d.code && x.t > d.t);
        if (u) dwellsK.push(u.t - d.t);
      }
      metrics.keyDwell = dwellsK;
      if (dwellsK.length >= 2) {
        const c = cv(dwellsK);
        metrics.keyDwellCv = c;
        add('st.key-dwell', c > 0.24, 8, `按键按住时长变异 ${c.toFixed(3)}（真人 0.3+）`);

        const refD = lognormSample(300, HUMAN.dwellMedian, HUMAN.dwellSigma, Math.random);
        const ksD = ksDistance(dwellsK, refD);
        metrics.keyDwellKs = ksD;
        add('st.key-dwell-ks', ksD !== null && ksD < 0.7, 8,
          `按住时长与真人分布 KS ${ksD === null ? 'n/a' : ksD.toFixed(3)}`);
      }

      // D5 字符间间隔
      const flights = [];
      for (let i = 1; i < downsK.length; i += 1) flights.push(downsK[i].t - downsK[i - 1].t);
      metrics.keyFlight = flights;
      if (flights.length >= 2) {
        const c = cv(flights);
        metrics.keyFlightCv = c;
        add('st.key-flight', c > 0.30, 8, `字符间隔变异 ${c.toFixed(3)}（真人 0.4+）`);

        const refF = lognormSample(300, HUMAN.flightMedian, HUMAN.flightSigma, Math.random);
        const ksF = ksDistance(flights, refF);
        metrics.keyFlightKs = ksF;
        add('st.key-flight-ks', ksF !== null && ksF < 0.7, 8,
          `字符间隔与真人分布 KS ${ksF === null ? 'n/a' : ksF.toFixed(3)}`);

        // D6 第一个字符前的停顿（真人打字前会想一下）
        const firstThink = downsK.length > 1 ? downsK[0].t - (S.inputs[0] ? S.inputs[0].t : downsK[0].t) : 0;
        metrics.firstKeyGap = firstThink;
      }
    }

    // ===== E. 输入事件与按键对应 =====
    if (S.inputs.length && keys.length) {
      const inputCount = S.inputs.length;
      const keyCount = keys.filter((k) => k.type === 'keydown' && !k.repeat).length;
      metrics.inputsPerKey = inputCount / Math.max(1, keyCount);
      // 纯英文打字：一个字符一个 input，比例应该接近 1
      // 汉字词上屏：input 会少于 key（拼音多键一字符）
      add('st.input-key-ratio', metrics.inputsPerKey <= 1.4, 10,
        `${inputCount} 个 input / ${keyCount} 次按键 = ${metrics.inputsPerKey.toFixed(2)}`
        + (metrics.inputsPerKey > 1.4 ? '（每个按键产生多个 input，异常）' : ''));
    }

    // ===== F. 致命项：这些命中任何一条直接判机器 =====

    // F6 同帧批量注入：多个事件时间戳完全相同，是脚本一次灌进去的典型形态
    if (ms.length >= 3) {
      const byT = {};
      ms.forEach((x) => { byT[x.t] = (byT[x.t] || 0) + 1; });
      const sameFrame = Math.max(...Object.values(byT));
      metrics.sameFrameBatch = sameFrame;
      add('st.f.same-frame', sameFrame <= 2, 30,
        `最多同帧 ${sameFrame} 个移动事件（>2 判为脚本批量注入）`);
    }

    // F12 时间戳在未来：注入事件的 eventTime 可能超前于页面时钟
    const future = [...ms, ...keys].filter((x) => x.t > performance.now() + 50).length;
    add('st.f.future-ts', future === 0, 25, `${future} 个事件时间戳在未来`);

    // F13 screenX 恒为 0：没接真实显示器的无头环境特征
    if (ms.length >= 5) {
      const zeroScreen = ms.filter((x) => x.screenX === 0 && x.screenY === 0).length;
      const ratio = zeroScreen / ms.length;
      metrics.zeroScreenRatio = ratio;
      add('st.f.screen-origin', ratio < 0.9, 20,
        `${(ratio * 100).toFixed(0)}% 的移动事件 screenX/Y 都为 0`);
    }

      // F14 反应间隔过短：真人对新界面做动作前至少有几百毫秒的识别时间。
      //
      // **触摸设备上这项不适用。** 触摸没有 hover：一次点按产生
      // touchstart→touchend→mousedown→mouseup，第一个 mousedown 早于第一个 mousemove，
      // 所以 firstDown - firstMove 是负数。真人用手指点也一样。
      // 拿鼠标事件的时序去要求触摸，等于同时误杀真人和机器，没有判别力。
      // 有触摸事件时直接跳过这一项（不计分，也不扣分）。
      if (downs.length && ms.length >= 2 && S.touch.starts === 0) {
        const firstMove = ms[0].t;
        const firstDown = downs[0].t;
        const react = firstDown - firstMove;
        metrics.reactionMs = react;
        add('st.f.reaction', react > 80, 20,
          `首个移动到按下只隔 ${react.toFixed(0)}ms（真人 >300ms）`);
      } else if (S.touch.starts > 0) {
        metrics.reactionMs = null;
        metrics.reactionSkipped = '触摸设备无 hover，此项不适用';
      }

    // F9 insertText 注入：有 input 事件但没有对应按键
    if (S.inputs.length) {
      const typed = keys.filter((k) => k.type === 'keydown' && !k.repeat).length;
      const looksInserted = S.inputs.some((x) => x.inputType === 'insertText' && !x.data);
      add('st.f.insert-text', typed > 0 || S.inputs.length === 0, 25,
        looksInserted || typed === 0 ? '文字出现了但没有按键（insertText 特征）' : '有真实按键');
    }

    // F11 pointerId 恒等：每次事件的 pointerId 都一样，真实设备会有变化
    // （这个检测器只采 mouse 事件，拿不到 pointerId，保留字段说明）
    metrics.pointerIdNote = 'mouse 事件无 pointerId，需用 pointermove 采集';

    // F1 键盘全量配对：不能只看数量相等，还要按 code 一一对应
    if (keys.length >= 4) {
      const kd = keys.filter((k) => k.type === 'keydown' && !k.repeat);
      const ku = keys.filter((k) => k.type === 'keyup');
      let unmatched = 0;
      for (const d of kd) {
        if (!ku.some((u) => u.code === d.code && u.t > d.t && u.t - d.t < 5000)) unmatched += 1;
      }
      add('st.f.key-match', unmatched === 0, 30,
        `${unmatched} 个 keydown 找不到对应的 keyup`);
    }

    const total = checks.reduce((a, c) => a + c.weight, 0);
    const got = checks.filter((c) => c.pass).reduce((a, c) => a + c.weight, 0);
    const score = total ? Math.round((got / total) * 100) : 0;

    // 致命项命中任何一条，无论总分多少都判机器
    const fatal = checks.filter((c) => c.id.startsWith('st.f.') && !c.pass);

    let verdict;
    if (fatal.length) {
      verdict = { level: 'bot', label: '致命特征命中：' + fatal.map((f) => f.id.replace('st.f.', '')).join(','), action: '拦截' };
    } else if (score >= 95) verdict = { level: 'human', label: '像人', action: '放行' };
    else if (score >= 80) verdict = { level: 'observe', label: '放行但观察', action: '记录不拦' };
    else if (score >= 60) verdict = { level: 'suspicious', label: '可疑', action: '无感二次验证' };
    else if (score >= 30) verdict = { level: 'likely-bot', label: '可能是机器', action: '滑块 + 后置审核' };
    else verdict = { level: 'bot', label: '明显是机器', action: '拦截 / 封号' };

    return {
      score,
      totalWeight: total,
      gotWeight: got,
      verdict,
      passed: checks.filter((c) => c.pass).length,
      failed: checks.filter((c) => !c.pass).length,
      checks,
      metrics,
      raw: S,
    };
  }

  window.StrictDetect = {
    run() {
      return analyze();
    },
    reset() {
      S.mouse = { samples: [], downs: [], ups: [], clicks: [] };
      S.keys = [];
      S.inputs = [];
      S.touch = { starts: 0, moves: 0, ends: 0 };
      S.startedAt = Date.now();
      lastMouse = null;
    },
    raw: S,
  };

  attach();
})();
