#!/usr/bin/env node
/**
 * mcp-server.mjs — 把后台屏的 11 个工具暴露成 MCP server，让别的 agent 宿主能调。
 *
 * 为什么手写而不用 SDK：宿主里只装了 `@modelcontextprotocol/client` 和 `core`，
 * **没有 server 端包**。而 MCP 的 stdio 传输本质上就是「stdin/stdout 上跑换行分隔的
 * JSON-RPC 2.0」，一个 initialize + 一个 tools/list + 一个 tools/call 就够用了。
 * 零依赖意味着不用改 package.json、不用担心 Node 版本、坏了自己能读。
 *
 * ## 用法（Claude Desktop / Cursor 等）
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "background-screen": {
 *       "command": "node",
 *       "args": ["/root/workspace/dsh-go-second-screen/screen/bin/mcp-server.mjs"]
 *     }
 *   }
 * }
 * ```
 *
 * ## 前置条件
 *
 *  - adb 已连上（默认 127.0.0.1:5555，可用 ADB_TARGET 覆盖）
 *  - OCR 要 `pip install rapidocr-onnxruntime`，没装的话 vdisplay_text 会返回明确错误
 *
 * ## 和 DSH 插件的关系
 *
 * 这层不重复实现任何逻辑，只做协议转换：把 MCP 的 tools/call 转成对 tools.js
 * 里同名函数的调用。所以工具行为和 DSH 里完全一致，不存在两套实现漂移。
 */

import { createInterface } from 'node:readline';

// tools.js 里的执行体。注意：这些函数返回 `{ text }`，要转成 MCP 的 content 数组。
let T = null;
let SPECS = null;

async function loadTools() {
  if (T) return;
  T = await import('../src/tools.js');
  SPECS = await import('../src/tool-spec.js');
}

/** tool-spec 里的 spec 函数名 → 执行体名 */
const EXEC_MAP = {
  vdisplay_start: 'start',
  vdisplay_stop: 'stop',
  vdisplay_status: 'status',
  vdisplay_launch: 'launch',
  vdisplay_shot: 'shot',
  vdisplay_text: 'text',
  vdisplay_input: 'input',
  vdisplay_stream: 'streamStart',
  vdisplay_stream_stop: 'streamStop',
  screen_shot_main: 'mainShot',
  vdisplay_apps: 'apps',
  screen_modes: 'modes',
};

/**
 * 把 tool-spec.js 的 parameters 转成 MCP 的 inputSchema。
 *
 * 两者格式接近但不完全一样：
 *   tool-spec：{ type: 'integer', description: '...' }
 *   MCP：      { type: 'integer', description: '...' }  —— 一样
 * 差异在于 required 字段：tool-spec 用 `required: true` 写在字段里，MCP 要顶层数组。
 */
function toInputSchema(params) {
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(params || {})) {
    const { required: req, ...rest } = v;
    properties[k] = rest;
    if (req) required.push(k);
  }
  const schema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

/**
 * MCP 下**不该暴露**的工具。
 *
 * vdisplay_stream / vdisplay_stream_stop：它们的消费者是 DSH Go 的「AI 画面」胶囊
 * （原生插件去回环端口拉 MJPEG），别的宿主没有这个组件，暴露了只会让模型白调一次。
 */
const HIDDEN = new Set(['vdisplay_stream', 'vdisplay_stream_stop']);

/** 收集所有工具定义 */
function listTools() {
  const out = [];
  for (const key of Object.keys(SPECS)) {
    if (!key.endsWith('Spec') || typeof SPECS[key] !== 'function') continue;
    let spec;
    try { spec = SPECS[key](); } catch { continue; }
    if (!spec?.name) continue;
    if (HIDDEN.has(spec.name)) continue;
    out.push({
      name: spec.name,
      description: String(spec.description || '').slice(0, 4000),
      inputSchema: toInputSchema(spec.parameters),
    });
  }
  return out;
}

/** 执行一个工具，返回 MCP 的 content 数组 */
/*
 * **所有调用都走 daemon，不直接调 tools.js。**
 *
 * 为什么：tools.js 的每个函数都依赖 vd.js 里的模块级 state（displayId、sfId、
 * scrcpy 的 socket）。这个进程是新起的，state 是空的 —— 直接调 tools.text()
 * 只会得到「虚拟屏没在运行」，即使另一处已经起好了屏。实测第一次接 MCP 就是这么翻车的。
 *
 * daemon 才是持有状态的地方（dashboard bin/vdisplayd.mjs），它已经覆盖了
 * start/stop/status/launch/shot/text/input/mainShot。MCP 只做协议转换。
 */

/** 读 daemon 的端口（它会写一个 json 文件） */
async function daemonPort() {
  const { readFile } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const explicit = process.env.VD_DAEMON_FILE;   // 允许显式指定，方便在 PC 上跑
  if (explicit) { try { const j = JSON.parse(await readFile(explicit, 'utf8')); if (Number(j?.port) > 0) return j.port; } catch { /* 继续试默认路径 */ } }
  // 实际路径是 <DSH_HOME>/plugin-screen/cli-daemon.json（实测），
  // 之前写成了 dsh-go/vdisplay/ —— 找不到端口，MCP 就静默返回空。
  const cands = [
    join(home, 'plugin-screen', 'cli-daemon.json'),
    join(home, 'dsh-go', 'vdisplay', 'cli-daemon.json'),
    '/tmp/dsh-vd-daemon.json',
  ];
  for (const f of cands) {
    try {
      const j = JSON.parse(await readFile(f, 'utf8'));
      if (Number(j?.port) > 0) return j.port;
    } catch { /* 试下一个 */ }
  }
  return null;
}

/** 调 daemon 的 /cmd */
async function callDaemon(action, args) {
  const port = await daemonPort();
  if (!port) return { ok: false, hint: 'daemon 没在跑。先在设备上执行一次 `vdisplay start` 或 `vdisplay status` 把它拉起来。' };
  try {
    const fetch = globalThis.fetch;
    const r = await fetch(`http://127.0.0.1:${port}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, args: args || {} }),
      signal: AbortSignal.timeout(120000),
    });
    const j = await r.json();
    if (!j.ok) return { ok: false, hint: j.error || 'daemon 返回失败' };
    return { ok: true, result: j.result };
  } catch (e) {
    return { ok: false, hint: `连 daemon 失败：${String(e?.message || e).slice(0, 200)}` };
  }
}

/** MCP 工具名 → daemon action */
const ACTION_MAP = {
  vdisplay_start: 'start',
  vdisplay_stop: 'stop',
  vdisplay_status: 'status',
  vdisplay_launch: 'launch',
  vdisplay_shot: 'shot',
  vdisplay_text: 'text',
  vdisplay_input: 'input',
  screen_shot_main: 'mainShot',
  vdisplay_apps: 'apps',
  // 多屏池
  screen_pool: 'poolInfo',
  screen_new: 'poolCreate',
  screen_use: 'poolUse',
  screen_close: 'poolDestroy',
};

/**
 * 把截图变成 MCP 的 image content。
 *
 * **这是 MCP 和 DSH 插件最大的区别**：DSH 那边工具返回的是本地路径，模型自己
 * read_image 打开；但 MCP 客户端可能跑在另一台电脑上，手机 /tmp 下的路径对它
 * 毫无意义。所以必须把字节读出来、base64 塞进 content。
 *
 * 两个坑：
 *   ① mime 要按 magic bytes 判，不能信路径后缀 —— vd.shot 可能返回 .png 而实际是 jpeg。
 *   ② 图上限制：超过 1.5MB 直接拒绝并建议改 width/region，别让一个巨型 base64
 *      撑爆 JSON-RPC 帧（客户端多半会截断或崩）。
 */
async function imageContent(path) {
  if (!path) return null;
  const { readFile, stat } = await import('node:fs/promises');
  try {
    const st = await stat(path);
    if (st.size > 1.5 * 1024 * 1024) {
      return {
        type: 'text',
        text: `图太大（${Math.round(st.size / 1024)}KB），MCP 传输会撑爆。请把 width 调小，或用 region 只截一块。路径：${path}`,
      };
    }
    const b = await readFile(path);
    // magic bytes 判 mime
    let mime = 'image/jpeg';
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) mime = 'image/png';
    else if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) mime = 'image/jpeg';
    else if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
    return { type: 'image', data: b.toString('base64'), mimeType: mime };
  } catch {
    return null;
  }
}

async function callTool(name, args) {
  // modes 是纯静态说明，不依赖状态
  if (name === 'screen_modes') {
    await loadTools();
    const r = await T.modes();
    return { content: [{ type: 'text', text: String(r?.text ?? r).slice(0, 20000) }] };
  }

  const action = ACTION_MAP[name];
  if (!action) {
    return {
      content: [{ type: 'text', text: `这个 MCP server 没暴露「${name}」。推流（vdisplay_stream）依赖 DSH 插件进程内的状态，MCP 下不可用。` }],
      isError: true,
    };
  }

  const r = await callDaemon(action, args);
  if (!r.ok) {
    return { content: [{ type: 'text', text: r.hint }], isError: true };
  }
  // daemon 返回的是结构化对象；转成可读文本
  const res = r.result;
  let text;
  if (res && typeof res === 'object') {
    if (Array.isArray(res.packages)) {
      // apps 的返回：{ok, count, packages[]}
      text = `第三方 App 共 ${res.count} 个（用包名调 vdisplay_launch）：\n`
        + res.packages.map((p) => `  ${p}`).join('\n');
    } else if (res.text) text = res.text;
    else if (typeof res.ok === 'boolean' && res.ok === false) text = `失败：${res.hint || '未知原因'}`;
    else if (Array.isArray(res.lines)) {
      const W = res.imageWidth || 720; const H = res.imageHeight || 1600;
      const pl = [`识别到 ${res.count} 行（${res.cached ? '缓存命中' : (res.elapsedMs + 'ms')}）`];
      for (const ln of res.lines) {
        const nx = ((ln.x + ln.w / 2) / W).toFixed(3);
        const ny = ((ln.y + ln.h / 2) / H).toFixed(3);
        pl.push(`  [${ln.conf}] ${ln.text}  nx=${nx} ny=${ny}`);
      }
      text = pl.join('\n');
    } else if (res.path) {
      // **截图要真的把图给出去**，光给路径对远端客户端没用。
      const img = await imageContent(res.path);
      if (img && img.type === 'image') {
        const note = res.unchanged
          ? '（这张和上次画面完全一样 —— MCP 这边仍然重发，因为客户端可能没有上一张）'
          : '';
        return {
          content: [
            img,
            { type: 'text', text: `图 ${res.imageWidth || '?'}px，屏 ${res.width}x${res.height}${note}` },
          ],
        };
      }
      text = (img && img.text) || (`图片路径：${res.path}`);
    } else {
      text = JSON.stringify(res, null, 2).slice(0, 20000);
    }
  } else {
    text = String(res);
  }
  return { content: [{ type: 'text', text: String(text).slice(0, 100000) }] };
}

/* ---------------- JSON-RPC over stdio ---------------- */

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const PROTOCOL_VERSION = '2024-11-05';

async function handle(msg) {
  const { id, method, params } = msg;

  // 通知（没有 id）不需要回复
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      await loadTools();
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'background-screen', version: '0.1.0' },
          instructions: [
            '这是一台 Android 手机的「后台屏」：一块用户看不见的虚拟屏，AI 可以在上面跑任意 App。',
            '',
            '典型顺序：vdisplay_start → vdisplay_launch → vdisplay_text（读屏）→ vdisplay_input（点按）。',
            '',
            '省 token 的要点：',
            '  · 读文字数字用 vdisplay_text —— 0 图片 token，带 nx/ny 坐标可直接点。',
            '  · 看整体布局用 vdisplay_shot（width=420 约 230 token）。',
            '  · 看不清某块用 region 只截那一块，比调大 width 更清晰也更便宜。',
            '  · 看「在不在动、往哪动」用 frames=9，单帧结构上做不到。',
            '',
            '注意：九格拼图里的小字读不出来（26px 缩到 5px），不要把数值希望放在那上面。',
          ].join('\n'),
        },
      });
      return;

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;   // 通知，不回复

    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;

    case 'tools/list':
      await loadTools();
      send({ jsonrpc: '2.0', id, result: { tools: listTools() } });
      return;

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      // 支持取消：MCP 允许客户端发 notifications/cancelled，这里最简实现是执行完再判
      const result = await callTool(name, args);
      send({ jsonrpc: '2.0', id, result });
      return;
    }

    case 'resources/list':
      send({ jsonrpc: '2.0', id, result: { resources: [] } });
      return;

    case 'prompts/list':
      send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      return;

    default:
      if (!isNotification) sendError(id, -32601, `不支持的方法：${method}`);
  }
}

async function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  // **stdin 关了不能立刻 exit。**
  // 实测踩过：用 printf 管道喂两条消息，第一条 initialize 同步返回了，
  // 第二条 tools/call 要等 OCR 1.4 秒 —— 但管道一结束 stdin 就 EOF，
  // 原来的 process.exit(0) 直接把还没跑完的请求杀掉了，客户端只看到一条回复。
  // 现在记录在途请求数，全部跑完才退出。
  let inflight = 0;
  let stdinClosed = false;

  const maybeExit = () => {
    if (stdinClosed && inflight === 0) process.exit(0);
  };

  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      sendError(null, -32700, 'JSON 解析失败');
      continue;
    }
    inflight += 1;
    handle(msg)
      .catch((e) => {
        if (msg?.id !== undefined && msg?.id !== null) {
          sendError(msg.id, -32603, `内部错误：${String(e?.message || e).slice(0, 300)}`);
        }
      })
      .finally(() => {
        inflight -= 1;
        maybeExit();
      });
  }

  stdinClosed = true;
  maybeExit();
}

main().catch((e) => {
  process.stderr.write(`mcp-server 启动失败: ${e?.message || e}\n`);
  process.exit(1);
});
