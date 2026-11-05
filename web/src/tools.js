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

export async function close() {
  const tabs = await cdp.closeOwnTabs().catch((e) => ({ ok: false, reason: e.message }));
  const rel = await cdp.release().catch((e) => ({ ok: false, reason: e.message }));
  const lines = [`关闭本插件标签：${tabs.closed ?? 0} 个（你原有的标签一个没动）`];
  lines.push(rel.removed ? `已移除端口转发 ${rel.removed}` : '端口转发无需清理');
  if (tabs.reason) lines.push(`说明：${tabs.reason}`);
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
