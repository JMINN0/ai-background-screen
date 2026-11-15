#!/usr/bin/env node
/**
 * run-baseline.mjs — 靶场自动跑分器。
 *
 * 为什么需要它：靶场测的是"操作方式像不像人"，所以跑一遍必须真的做一遍操作
 * （点按钮、填表单、滑动、悬停）。手动点没法复现、没法对比、没法回归。
 * 这个脚本用 CDP 驱动浏览器完成一整套标准动作，然后把各靶场的分数拉回来。
 *
 * 用法：
 *   node run-baseline.mjs            # 跑全部
 *   node run-baseline.mjs strict     # 只跑某个
 *
 * 前提：虚拟屏已起 + 浏览器已投上去（见 README），靶场服务在 3081。
 */

import * as cdp from '../../web/src/cdp.js';

const BASE = process.env.RISK_BASE || 'http://127.0.0.1:3081';
const only = process.argv[2] || '';

const log = (...a) => console.log(...a);

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 激活标签页 —— 这一步是必须的，不是可选优化。
 *
 * 实测踩到的坑：标签页在后台时 `document.visibilityState === 'hidden'`，
 * Chrome 会**拒绝** `Input.dispatchTouchEvent`（超时 20 秒），而 `evaluate`
 * 照常工作（20ms）。所以表现为"元素找到了但点不动"，很容易误判成元素定位失败。
 * 激活后 visibilityState 变 visible、hasFocus 变 true，触摸立刻正常（286ms）。
 */
async function wakeTab(targetId) {
  const { send } = await import('../../web/src/cdp.js');
  try {
    await send(targetId, 'Target.activateTarget', { targetId });
    await sleep(700);
    return true;
  } catch {
    return false;
  }
}

/** 找到（或打开）靶场页面 */
async function openRange(path) {
  const url = BASE + path;
  const tabs = await cdp.listAllTabs();
  const hit = tabs.find((t) => t.url && t.url.startsWith(url));
  if (hit) {
    await cdp.navigate(hit.targetId, url + (path.includes('?') ? '&' : '?') + 'v=' + Date.now());
    await sleep(400);
    await wakeTab(hit.targetId);
    return hit.targetId;
  }
  const r = await cdp.openTab(url);
  if (!r.ok) throw new Error('开标签失败: ' + (r.reason || r.error || '?'));
  await sleep(500);
  const t2 = await cdp.listAllTabs();
  const mine = t2.find((t) => t.url && t.url.startsWith(url));
  if (!mine) throw new Error('开完找不到标签');
  await wakeTab(mine.targetId);
  return mine.targetId;
}

/**
 * 做一整套"像人"的动作。
 *
 * **必须用触摸，不能用鼠标。** 第一版用了 pointerAction('hover') + scroll，结果 probe
 * 靶场报出 `device.touch-never-fired` 和 `input.no-pointer-events` 两条 —— 那不是
 * 能力退化，是我自己的测试方法在测鼠标。手机站上真人不会用鼠标，用鼠标本身就是一个
 * 机器特征。所以这里全部走 tapTouch（CDP dispatchTouchEvent）。
 */
async function doHumanRound(tid, label) {
  const started = Date.now();
  const steps = [];

  // 先问页面：有哪些可点的东西。不同靶场元素完全不同，写死 #btn-clear 会一个都点不到
  // （实测踩过：probe 页没有 strict 页的按钮，结果 0 次点击 → 靶场报 touch-never-fired）。
  let targets = [];
  try {
    const raw = await cdp.evaluate(tid, `
      const els = Array.from(document.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit]'));
      return JSON.stringify(els.slice(0, 20).map((e, i) => ({
        i,
        id: e.id || '',
        tag: e.tagName,
        text: (e.innerText || e.value || '').trim().slice(0, 20),
        rect: e.getBoundingClientRect().toJSON(),
      })));
    `);
    targets = JSON.parse(raw);
  } catch { targets = []; }

  // 1. 触摸点几个真实存在的目标
  let tapped = 0;
  for (const t of targets) {
    if (tapped >= 6) break;
    if (t.rect.width < 4 || t.rect.height < 4) continue;    // 跳过不可见的
    try {
      const sel = t.id ? ('#' + t.id) : null;
      const r = await cdp.tapTouch(tid, sel ? { selector: sel } : { text: t.text, x: t.rect.x + t.rect.width / 2, y: t.rect.y + t.rect.height / 2 });
      if (r && r.ok) { steps.push('touch:' + (t.id || t.text || t.tag)); tapped += 1; }
    } catch { /* 下一个 */ }
    await sleep(140 + Math.random() * 240);
  }

  // 2. 触摸滑动（连续 touchmove 序列）
  try {
    await cdp.scroll(tid, { deltaY: 260 + Math.floor(Math.random() * 160) });
    steps.push('scroll');
    await sleep(200);
  } catch { steps.push('scroll-fail'); }

  // 3. 填输入框（keydown/keypress/keyup）
  let inputs = [];
  try {
    inputs = JSON.parse(await cdp.evaluate(tid, `
      return JSON.stringify([...document.querySelectorAll('input[type=text], input[type=search], input:not([type]), textarea')]
        .slice(0, 3).map((e, i) => e.id ? '#' + e.id : null).filter(Boolean));
    `));
  } catch { inputs = []; }
  for (const sel of inputs) {
    try {
      const r = await cdp.fill(tid, { selector: sel, text: 'u' + Math.floor(Math.random() * 9000 + 1000) });
      if (r && r.ok !== false) steps.push('fill:' + sel);
    } catch { /* 跳过 */ }
    await sleep(180 + Math.random() * 220);
  }

  return { steps, ms: Date.now() - started };
}

/** 跑 strict 靶场：做动作 → 调 StrictDetect.run() → 拿分 */
async function runStrict() {
  const tid = await openRange('/strict');
  await sleep(800);
  const round = await doHumanRound(tid, 'strict');
  await sleep(600);

  const raw = await cdp.evaluate(tid, `
    if (!window.StrictDetect || typeof window.StrictDetect.run !== 'function') {
      return JSON.stringify({ error: 'no StrictDetect', keys: Object.keys(window).filter(k => /detect|Detect|strict|Strict/.test(k)) });
    }
    return JSON.stringify(window.StrictDetect.run());
  `);
  let res;
  try { res = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { res = { error: String(raw).slice(0, 200) }; }
  return { range: 'strict', round, result: res };
}

/** 跑 probe 靶场：它自己会上报，等一会儿再拉 */
async function runProbe() {
  const tid = await openRange('/probe');
  await sleep(1000);
  const round = await doHumanRound(tid, 'probe');
  await sleep(2500);   // 等页面自动 POST
  // 也主动跑一次，确保数据完整
  try {
    const raw = await cdp.evaluate(tid, `
      if (!window.EnvProbe || typeof window.EnvProbe.run !== 'function') {
        return JSON.stringify({ error: 'no EnvProbe', keys: Object.keys(window).filter(k => /probe|Probe/.test(k)) });
      }
      return JSON.stringify(window.EnvProbe.run());
    `);
    const res = typeof raw === 'string' && raw !== 'null' ? JSON.parse(raw) : null;
    return { range: 'probe', round, result: res };
  } catch (e) {
    return { range: 'probe', round, result: null, error: String(e).slice(0, 150) };
  }
}

/** 跑 video 靶场 */
async function runVideo() {
  const tid = await openRange('/video');
  await sleep(1000);
  const round = await doHumanRound(tid, 'video');
  await sleep(1500);
  try {
    const raw = await cdp.evaluate(tid, `
      if (!window.VideoDetect || typeof window.VideoDetect.run !== 'function') {
        return JSON.stringify({ error: 'no VideoDetect', keys: Object.keys(window).filter(k => /video|Video/.test(k)) });
      }
      return JSON.stringify(window.VideoDetect.run());
    `);
    const res = typeof raw === 'string' && raw !== 'null' ? JSON.parse(raw) : null;
    return { range: 'video', round, result: res };
  } catch (e) {
    return { range: 'video', round, result: null, error: String(e).slice(0, 150) };
  }
}

/** 跑 net 靶场：发一次请求，服务端算分 */
async function runNet() {
  const tid = await openRange('/net');
  await sleep(1200);
  try {
    // evaluate 里是同步 IIFE，用 XHR 同步请求（靶场是本机，阻塞一下没关系）
    const raw = await cdp.evaluate(tid, `
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/net', false);
      xhr.send(null);
      return xhr.responseText;
    `);
    const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { range: 'net', round: null, result: res };
  } catch (e) {
    return { range: 'net', round: null, result: null, error: String(e).slice(0, 150) };
  }
}

/** 从结果里抽出关键分数（各靶场结构不同，做容错） */
function summarize(r) {
  const res = r.result;
  if (!res) return { range: r.range, score: null, note: r.error || '无结果' };
  if (r.range === 'strict') {
    const fails = (res.signals || res.checks || []).filter((s) => !s.pass && !s.hit);
    return {
      range: 'strict',
      score: res.score ?? res.percent ?? null,
      level: res.level,
      total: (res.signals || res.checks || []).length,
      failed: fails.length,
      failedIds: fails.map((s) => s.id).slice(0, 8),
    };
  }
  if (r.range === 'probe') {
    const hits = (res.signals || []).filter((s) => s.hit);
    return { range: 'probe', score: res.exposure ?? null, hits: hits.length, hitIds: hits.map((s) => s.id) };
  }
  if (r.range === 'video') {
    return { range: 'video', score: res.risk ?? res.score ?? null, level: res.level, count: (res.checks || []).length };
  }
  if (r.range === 'net') {
    return { range: 'net', score: res.risk ?? res.score ?? null, signals: (res.signals || []).length };
  }
  return { range: r.range, score: null };
}

async function main() {
  const ens = await cdp.ensure();
  if (!ens || ens.ok === false) {
    log('❌ 没法连上浏览器：', ens?.reason || ens?.error || '未知');
    process.exit(1);
  }
  log('✅ 浏览器已连上\n');

  const jobs = [
    ['strict', runStrict],
    ['probe', runProbe],
    ['video', runVideo],
    ['net', runNet],
  ].filter(([name]) => !only || only === name);

  const out = [];
  for (const [name, fn] of jobs) {
    log(`── 跑 ${name} …`);
    try {
      const r = await fn();
      const s = summarize(r);
      out.push({ ...s, round: r.round });
      log(`   ${JSON.stringify(s)}`);
      if (r.round) log(`   动作: ${r.round.steps.join(' → ')}（${r.round.ms}ms）`);
    } catch (e) {
      log(`   ❌ ${String(e?.message || e).slice(0, 150)}`);
      out.push({ range: name, score: null, error: String(e?.message || e).slice(0, 150) });
    }
    log('');
  }

  log('══ 汇总 ══');
  for (const r of out) {
    const score = r.score === null || r.score === undefined ? '—' : r.score;
    log(`  ${String(r.range).padEnd(8)} 分数/暴露 ${String(score).padStart(5)}   ${r.failed !== undefined ? `失败 ${r.failed}/${r.total}` : ''}${r.hits !== undefined ? `命中 ${r.hits}` : ''}`);
    if (r.failedIds?.length) log(`           失败项: ${r.failedIds.join(', ')}`);
    if (r.hitIds?.length) log(`           命中项: ${r.hitIds.join(', ')}`);
  }

  // 存一份基线，方便以后对比
  const { writeFile } = await import('node:fs/promises');
  const file = new URL('./baseline.json', import.meta.url).pathname;
  await writeFile(file, JSON.stringify({ at: new Date().toISOString(), results: out }, null, 2));
  log(`\n已写入基线 ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
