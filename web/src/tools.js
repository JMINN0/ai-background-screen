/**
 * tools.js — 六个工具的 execute。
 *
 * 全部返回 { text }。任何失败都返回"原因 + 下一步"，不抛异常（工具报错会打断整轮对话）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as cdp from './cdp.js';
import { adbTarget } from './target.js';

const pexec = promisify(execFile);
const ADB = process.env.ADB_BIN || 'adb';
// 浏览器改成运行时可选，默认 Edge（用户平时用的那个）
import { currentBrowser, selectBrowser, listBrowsers } from './browser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 拉起浏览器。会占前台 1-2 秒。
 *
 * 硬前置：**只有调用方明确传 allowForeground:true 才执行**。用户可能刚主动关掉浏览器，
 * 擅自唤醒会打断他；默认拒绝，返回一句可执行的提示。这里再守一道，避免以后有人
 * 直接调 launchBrowser() 绕过 ensure() 的门。
 */
async function launchBrowser({ allowForeground = false } = {}) {
  if (allowForeground !== true) {
    return { ok: false, refused: true, hint: '未传 allowForeground:true，按规则不主动拉起浏览器。' };
  }
  const target = await adbTarget();
  await pexec(ADB, ['-s', target, 'shell', 'monkey', '-p', currentBrowser().pkg,
    '-c', 'android.intent.category.LAUNCHER', '1'], { timeout: 20000 }).catch(() => {});
  for (let i = 0; i < 12; i += 1) {
    await sleep(700);
    const r = await cdp.ensure();
    if (r.ok) return r;
  }
  return { ok: false, hint: '拉起后仍然连不上，可能被系统回收了。' };
}

export async function ensure(args) {
  let r = await cdp.ensure();
  let launched = false;

  if (!r.ok && args?.allowForeground === true) {
    launched = true;
    r = await launchBrowser({ allowForeground: true });
  }

  if (!r.ok) {
    return {
      text: `通道不可用。\n\n${r.hint}\n\n`
        + '本插件默认**不主动启动浏览器**：用户可能刚刚主动关掉了它，擅自唤醒会打断用户。\n'
        + '只有用户明确要求"可以拉起浏览器"时，才传 allowForeground:true。',
    };
  }
  return {
    text: `通道就绪：${r.browser}（端口 ${r.port}）`
      + (launched ? '\n浏览器刚被我拉起，前台占用了约 1-2 秒，现在已就绪。' : ''),
  };
}

export async function open(args) {
  const url = String(args?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { text: '需要完整的 http(s) 地址。' };

  let ch = await cdp.ensure();
  if (!ch.ok) return { text: `通道不可用：${ch.hint}` };

  const r = await cdp.openTab(url, { reuse: args?.reuse !== false });
  if (!r.ok) return { text: `打开失败：${r.hint}` };

  const page = await cdp.readPage(r.targetId).catch(() => null);
  return {
    text: `targetId: ${r.targetId}\n${r.reused ? '（复用了本插件自己的标签）' : '（新建标签，已打标记）'}`
      + `\nURL: ${page?.url || url}\n标题: ${page?.title || '(空)'}`,
  };
}

export async function read(args) {
  const targetId = String(args?.targetId || '').trim();
  if (!targetId) return { text: '缺少 targetId（先用 web_open 打开页面）。' };
  const max = Math.min(Math.max(Number(args?.maxChars) || 4000, 200), 20000);

  const ch = await cdp.ensure();
  if (!ch.ok) return { text: `通道不可用：${ch.hint}` };

  const r = await cdp.evaluate(targetId, `
    return JSON.stringify({
      url: location.href, title: document.title,
      text: (document.body?.innerText || '').slice(0, ${max}),
      len: (document.body?.innerText || '').length
    });
  `).then(JSON.parse).catch((e) => ({ error: e.message }));

  if (r.error) return { text: `读取失败：${r.error}` };
  return { text: `URL: ${r.url}\n标题: ${r.title}\n正文(${r.len} 字符，取前 ${max}):\n---\n${r.text}` };
}

export async function click(args) {
  const targetId = String(args?.targetId || '');
  const selector = String(args?.selector || '');
  const text = String(args?.text || '');
  if (!targetId || (!selector && !text)) return { text: '需要 targetId，以及 selector 或 text 之一。' };

  const ch = await cdp.ensure();
  if (!ch.ok) return { text: `通道不可用：${ch.hint}` };

  const r = await cdp.click(targetId, { selector, text }).catch((e) => ({ ok: false, reason: e.message }));
  return { text: r.ok ? `已点击 ${selector || `「${text}」`}（<${r.tag}> ${r.text || ''}）` : `点击失败：${r.reason}` };
}

export async function fill(args) {
  const targetId = String(args?.targetId || '');
  const selector = String(args?.selector || '');
  const text = String(args?.text ?? '');
  if (!targetId || !selector) return { text: '需要 targetId 和 selector。' };

  const ch = await cdp.ensure();
  if (!ch.ok) return { text: `通道不可用：${ch.hint}` };

  const r = await cdp.fill(targetId, selector, text).catch((e) => ({ ok: false, reason: e.message }));
  if (!r.ok) return { text: `填写失败：${r.reason}` };
  return { text: `已填入 ${selector}，回读值：「${r.value}」（${r.len} 字符）` };
}

export async function shot(args) {
  const targetId = String(args?.targetId || '');
  if (!targetId) return { text: '缺少 targetId。' };
  const dir = String(args?.dir || '/tmp');

  const ch = await cdp.ensure();
  if (!ch.ok) return { text: `通道不可用：${ch.hint}` };

  const r = await cdp.screenshot(targetId, dir).catch((e) => ({ error: e.message }));
  if (r.error) return { text: `截图失败：${r.error}` };
  return { text: `已保存：${r.path}（${r.bytes} 字节）` };
}

/** 列出浏览器里所有标签（包括用户自己的），供选择和接管。 */
export async function tabs() {
  const ch = await cdp.ensure();
  if (!ch.ok) return { text: `通道不可用：${ch.hint}` };

  const list = await cdp.listAllTabs().catch((e) => ({ error: e.message }));
  if (list.error) return { text: `读取标签失败：${list.error}` };
  if (!list.length) return { text: '浏览器里没有打开的页面标签。' };

  const lines = [`共 ${list.length} 个标签（${ch.browser}）：`, ''];
  list.forEach((t, i) => {
    const who = t.mine ? '插件开的' : (t.adopted ? '已接管' : '你自己的');
    lines.push(`${i + 1}. [${who}] ${t.title || '(无标题)'}`);
    lines.push(`   ${t.url}`);
    lines.push(`   targetId: ${t.targetId}`);
  });
  lines.push('');
  lines.push('要用其中一个：web_attach { targetId: "..." }。接管不会改地址、不会刷新。');
  return { text: lines.join('\n') };
}

/** 接管一个已有标签（典型场景：用户已经登录好的页面）。 */
export async function attach(args) {
  const targetId = String(args?.targetId || '').trim();
  if (!targetId) return { text: '需要 targetId。先跑 web_tabs 看当前有哪些标签。' };

  const ch = await cdp.ensure();
  if (!ch.ok) return { text: `通道不可用：${ch.hint}` };

  const r = await cdp.attachTab(targetId, { wake: args?.wake === true })
    .catch((e) => ({ ok: false, hint: e.message }));
  if (!r.ok) return { text: r.hint };

  const head = `已接管标签：${r.title || '(无标题)'}\n${r.url}`;

  if (r.frozen) {
    return {
      text: head + '\n\n'
        + '⚠️ 但这个标签被浏览器休眠了，现在驱动不了它。\n'
        + '标签多、浏览器又退到后台时很常见——它在标签列表里照样显示，但对 CDP 完全无响应。\n\n'
        + '要唤醒它，带 wake:true 重新调用：\n'
        + `  web_attach { targetId: "${targetId}", wake: true }\n`
        + '唤醒是激活那个标签并等它自己恢复（约 5~7 秒），页面状态不会丢；\n'
        + '实在不醒才会重新加载（那一步会丢滚动位置和未提交的表单）。\n'
        + '或者最简单的：请用户在浏览器里点一下那个标签，它立刻就好了。',
    };
  }

  const note = r.woke
    ? (r.reloaded
      ? '（这个标签原本休眠，已重新加载唤醒——滚动位置和未提交的表单可能丢了）\n'
      : '（这个标签原本休眠，已激活唤醒，页面状态没有动）\n')
    : '';

  return {
    text: head + '\n' + note + '\n'
      + '现在可以用 web_read / web_click / web_fill 操作它。\n'
      + '没有改地址、没有刷新、没有重新登录。\n'
      + '注意：这是用户的标签，web_close 关它需要先征得用户同意。',
  };
}

/** 关闭本插件标签，或关闭指定的某一个（用户的标签需 confirm）。 */
export async function close(args) {
  const targetId = String(args?.targetId || '').trim();

  // 关指定的一个
  if (targetId) {
    const ch = await cdp.ensure();
    if (!ch.ok) return { text: `通道不可用：${ch.hint}` };
    const r = await cdp.closeTab(targetId, { confirm: args?.confirm === true })
      .catch((e) => ({ ok: false, hint: e.message }));
    if (!r.ok) return { text: r.hint };
    return { text: `已关闭标签：${r.title || targetId}${r.userOwned ? '（用户自己的标签，已确认）' : ''}` };
  }

  // 关本插件开的所有标签 + 清理端口转发
  const tabsClosed = await cdp.closeOwnTabs().catch((e) => ({ ok: false, reason: e.message }));
  const rel = await cdp.release().catch((e) => ({ ok: false, reason: e.message }));
  const lines = [`关闭本插件标签：${tabsClosed.closed ?? 0} 个（你原有的标签一个没动）`];
  lines.push(rel.removed ? `已移除端口转发 ${rel.removed}` : '端口转发无需清理');
  if (tabsClosed.reason) lines.push(`说明：${tabsClosed.reason}`);
  return { text: lines.join('\n') };
}

/** 查看/切换要操作的浏览器。 */
export async function browser(args) {
  const want = args?.select;
  if (want) {
    const b = selectBrowser(want);
    if (b?.error) return { text: b.error };
    return { text: `已切换到 ${b.name}（${b.pkg}）。\n注意：Chromium 系浏览器共用同一个 devtools socket，同时只允许一个在跑，切换前先关掉另一个。` };
  }
  const list = listBrowsers();
  const cur = currentBrowser();
  return {
    text: [
      `当前浏览器：${cur.name}（${cur.pkg}）`,
      '',
      '可切换的：',
      ...list.map((b) => `  ${b.current ? '▶' : ' '} ${b.key.padEnd(7)} ${b.name}（${b.pkg}）`),
      '',
      '切换方式：传 select:"chrome" / "edge" / "nubia"。默认是 Edge。',
    ].join('\n'),
  };
}
