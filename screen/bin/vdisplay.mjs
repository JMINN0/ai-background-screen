#!/usr/bin/env node
/**
 * vdisplay —— 虚拟屏的 CLI 客户端。
 *
 * 它自己不建屏（那会被进程退出带走），只把命令发给常驻的 vdisplayd。
 * 守护进程没在跑就自动拉起来一个。
 *
 * 这样任何 agent 都能用：Claude Code、opencode、Codex、Cursor，只要能跑 bash：
 *
 *   vdisplay start
 *   vdisplay launch com.tencent.mm
 *   vdisplay shot --out /tmp/wx.jpg
 *   vdisplay input tap --nx 0.5 --ny 0.9
 *   vdisplay stop
 *
 * 加 --json 输出机器可读的完整结果。
 */

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const STATE_DIR = join(DSH_HOME, 'plugin-screen');
const STATE_FILE = join(STATE_DIR, 'cli-daemon.json');
const DAEMON = join(HERE, 'vdisplayd.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把 --key value / --flag / 位置参数解析开。 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i += 1; }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function readDaemon() {
  try {
    const j = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return Number(j?.port) > 0 ? j : null;
  } catch { return null; }
}

async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function ensureDaemon() {
  const st = await readDaemon();
  if (st && await ping(st.port)) return st;

  /* **daemon 的输出必须落到文件，不能 stdio:'ignore'。**
   *
   * 2026-11-23 稳定性审查抓到：这里原来是 stdio:'ignore'，
   * 而 vdisplayd.mjs 里有 13 处 console.error —— 全部写进 /dev/null。
   * 结果：用户报「画面乱跳」时一条日志都查不到，只能靠猜。
   * 2026-11-22 那条「catch 不许空吞、必须打日志」的修复，在 daemon 形态下等于没做。
   */
  let daemonLogPath = null;
  let stdioOut = 'ignore';
  try {
    const { mkdirSync, openSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const dir = join(DSH_HOME || join(homedir(), '.dsh'), 'plugin-screen');
    mkdirSync(dir, { recursive: true });
    daemonLogPath = join(dir, 'vdisplayd.log');
    stdioOut = openSync(daemonLogPath, 'a');
  } catch { /* 建不了就退回 ignore */ }
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: ['ignore', stdioOut, stdioOut],
    env: { ...process.env, DSH_HOME },
  });
  if (daemonLogPath) {
    try { console.error('[vdisplay] daemon 日志: ' + daemonLogPath); } catch { /* ignore */ }
  }
  child.unref();

  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    const s = await readDaemon();
    if (s && await ping(s.port)) return s;
  }
  throw new Error('守护进程拉不起来。手动跑一下 vdisplayd.mjs 看报什么错。');
}

/**
 * **只读命令不拉 daemon。**
 *
 * 2026-11-23 审查抓到：`call()` 一进来就 `ensureDaemon()`，**包括 status**。
 * 而 daemon 启动时会 `loadPersistedState()` **接管插件那块屏** ——
 * 于是用户/AI 随手跑一句 `vdisplay status` 查状态，
 * 就会凭空多一个 daemon 进程跟插件抢同一块屏：
 * 它自己的 tick 会判内容/判推流/自动重建，和插件进程互不设防。
 *
 * 现在：只读命令先看有没有活着的 daemon，有就用；没有就直接本地查，不起进程。
 */
const READONLY_ACTIONS = new Set(['status', 'modes', 'apps', 'leasesList', 'poolList']);

async function call(action, args = {}) {
  const isReadonly = READONLY_ACTIONS.has(action);
  let st = null;
  if (isReadonly) {
    // 只读：有活 daemon 就用它，没有就本地直接算 —— 绝不 spawn
    try {
      const saved = await readDaemon();
      if (saved && await ping(saved.port)) st = saved;
    } catch { /* ignore */ }
    if (!st) {
      // 本地直查，不依赖 daemon
      try {
        const vd = await import('../src/vd.js');
        if (action === 'status') {
          const s = await vd.status();
          return { ok: true, result: s };
        }
        if (action === 'modes') {
          const T = await import('../src/tools.js');
          return { ok: true, result: await T.modes() };
        }
        if (action === 'apps') {
          const T = await import('../src/tools.js');
          return { ok: true, result: await T.apps() };
        }
        if (action === 'poolList') {
          const pool = await import('../src/pool.js');
          return { ok: true, result: pool.info() };
        }
      } catch (e) {
        return { ok: false, hint: '本地查询失败：' + String(e?.message || e).slice(0, 120) };
      }
    }
  } else {
    st = await ensureDaemon();
  }
  if (!st) return { ok: false, hint: '没有活着的 daemon，且这条命令需要它。先跑一次会写状态的命令。' };

  const r = await fetch(`http://127.0.0.1:${st.port}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args }),
    signal: AbortSignal.timeout(180_000),
  }).catch((e) => { throw new Error(`连不上守护进程：${e.message}`); });

  const j = await r.json().catch(() => ({ ok: false, error: '守护进程返回的不是 JSON' }));
  if (!j.ok) throw new Error(j.error || '命令失败');
  return j.result;
}

const USAGE = `vdisplay —— 操作一块用户看不见的虚拟屏

用法：
  vdisplay start [--width 720] [--height 1280] [--dpi 320]
                 [--orientation landscape|portrait] [--hwc auto|on|off]
  vdisplay stop [--forceStopApps]
  vdisplay status
  vdisplay launch <包名> [Activity]
  vdisplay shot [--out 路径] [--width 540] [--format jpeg|png]
                 [--frames 9] [--interval 300]        九格连拍看运动
                 [--rx 0 --ry 1200 --rw 720 --rh 392] 只看一块并放大
  vdisplay text [--minconf 0.45] [--maxlines 80] [--fresh]
                读屏文字（OCR），带 nx/ny 坐标，0 图片 token
  vdisplay main-shot [--out 路径]
  vdisplay input tap   --x 100 --y 200     （或 --nx 0.5 --ny 0.5 归一化）
  vdisplay input swipe --x1 100 --y1 200 --x2 300 --y2 400 [--ms 400]
  vdisplay input text  --text "要输入的字"
  vdisplay input key   --key KEYCODE_BACK
  vdisplay input paste [--text "要粘的内容"]
  vdisplay daemon stop

通用参数：
  --json    输出完整 JSON，而不是给人看的文本

第一次调用会自动拉起守护进程，它会在闲置 10 分钟且没有虚拟屏时自己退出。
`;

function human(action, r) {
  if (!r || typeof r !== 'object') return String(r ?? '');
  const lines = [];

  switch (action) {
    case 'start':
      // daemon 的 start 现在直接转发 T.start()，返回 {text}：整段播报 + 自检都在里面。
      // 老格式（displayId/sfId/canHost 字段）保留兜底，万一哪条路还没统一。
      if (typeof r?.text === 'string' && r.text) return r.text;
      if (r.ok === false) return `建屏失败：${r.hint || '未知原因'}`;
      lines.push(`虚拟屏已就绪：displayId=${r.displayId}`);
      lines.push(`SurfaceFlinger id: ${r.sfId || '(未取到)'}`);
      lines.push(`能托管 App：${r.canHost ? '是' : '否'}`);
      lines.push(`硬件合成（HWC）：${r.hwc ? '已开启' : '未开启'}`);
      if (r.stream) {
        lines.push(r.stream.ok ? '推流：已开启 ✅ 悬浮窗已浮起' : `推流：没起来 ⚠️ ${r.stream.detail || ''}`);
      }
      return lines.join('\n');

    case 'launch':
      if (!r.displayId) return `投屏失败：${r.hint || '未知原因'}`;
      lines.push(`已投到虚拟屏 display=${r.displayId}`);
      if (r.landedOnVd !== undefined) lines.push(`落在虚拟屏上：${r.landedOnVd ? '是' : '否'}`);
      if (r.hint) lines.push(r.hint);
      return lines.join('\n');

    case 'text': {
      if (r.ok === false) return `识别失败：${r.hint || '未知原因'}`;
      const pl = [`识别到 ${r.count} 行（${r.cached ? '缓存命中 0ms' : (r.elapsedMs + 'ms')}）`];
      const W = r.imageWidth || 720; const H = r.imageHeight || 1600;
      for (const ln of (r.lines || [])) {
        const nx = ((ln.x + ln.w / 2) / W).toFixed(3);
        const ny = ((ln.y + ln.h / 2) / H).toFixed(3);
        pl.push(`  [${String(ln.conf).padEnd(4)}] ${ln.text}  nx=${nx} ny=${ny}`);
      }
      return pl.join('\n');
    }
    case 'shot':
    case 'mainShot':
      if (r.ok === false || !r.path) return `截图失败：${r.hint || r.error || '未知原因'}`;
      return `截图：${r.path}${r.width ? `（${r.width}px）` : ''}`
        + (r.copyError ? `\n⚠️ ${r.copyError}` : '');

    case 'status':
      if (!r.running) return '虚拟屏没有在运行。';
      lines.push(`虚拟屏在运行：displayId=${r.displayId}`);
      if (r.focusedApp) lines.push(`上面跑着：${r.focusedApp}`);
      if (r.mainFocus) lines.push(`主屏焦点：${r.mainFocus}`);
      return lines.join('\n');

    case 'stop':
      lines.push('虚拟屏已销毁。');
      if (r.stillRunning?.length) lines.push(`仍在后台运行：${r.stillRunning.join('、')}`);
      return lines.join('\n');

    case 'input':
      if (r.ok === false) return `输入失败：${r.hint || r.reason || '未知原因'}`;
      return r.hint || '已执行';

    default:
      return JSON.stringify(r, null, 2);
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const wantJson = flags.json === true;

  let cmd = positional[0];
  let sub = positional[1];

  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === 'daemon') {
    if (sub === 'stop') {
      const st = await readDaemon();
      if (!st) { console.error('守护进程没在跑。'); process.exit(1); }
      // 必须断言：state 文件被写坏成负数时，process.kill(-1) 会给**整个进程组**发信号。
      // 之前用 pkill 空模式杀掉用户 Shizuku 是同一种事故。
      if (!Number.isInteger(st.pid) || st.pid <= 1) {
        console.error(`状态文件里的 pid 不合法（${st.pid}），拒绝执行 kill。请删掉 ${STATE_FILE} 再试。`);
        process.exit(1);
      }
      try { process.kill(st.pid, 'SIGTERM'); } catch { /* 已经死了 */ }
      console.log(`已让守护进程（pid ${st.pid}）退出。`);
      return;
    }
    const st = await readDaemon();
    const alive = st ? await ping(st.port) : false;
    console.log(alive ? `守护进程在跑：pid ${st.pid}，端口 ${st.port}` : '守护进程没在跑。');
    return;
  }

  let action = cmd;
  let args = {};

  // 数字参数必须校验。以前 `Number(true)` = 1、`Number('abc')` = NaN，
  // 用户漏写一个值就会静默点错坐标或按默认尺寸建屏，没有任何提示。
  const num = (k) => {
    const v = flags[k];
    if (v === undefined) return undefined;
    if (v === true) { console.error(`参数 --${k} 缺少值。`); process.exit(1); }
    const n = Number(v);
    if (!Number.isFinite(n)) { console.error(`参数 --${k} 不是合法数字：「${v}」。`); process.exit(1); }
    return n;
  };
  const str = (k) => (flags[k] === undefined || flags[k] === true ? undefined : String(flags[k]));

  if (cmd === 'start') {
    args = {
      width: num('width'), height: num('height'), dpi: num('dpi'),
      orientation: str('orientation'), hwc: str('hwc'),
      systemDecorations: flags.systemDecorations === true,
    };
  } else if (cmd === 'stop') {
    args = { forceStopApps: flags.forceStopApps === true };
  } else if (cmd === 'launch') {
    if (!sub) { console.error('需要包名：vdisplay launch <pkg> [activity]'); process.exit(1); }
    args = { pkg: sub, activity: positional[2] };
  } else if (cmd === 'shot' || cmd === 'main-shot') {
    action = cmd === 'shot' ? 'shot' : 'mainShot';
    // region 用四个 flag 给：--rx --ry --rw --rh，四个都有才算有效局部
    const rx = num('rx'); const ry = num('ry'); const rw = num('rw'); const rh = num('rh');
    const region = (rx !== undefined && ry !== undefined && rw !== undefined && rh !== undefined)
      ? { x: rx, y: ry, w: rw, h: rh } : undefined;
    args = {
      out: str('out'), dir: str('out') ? dirname(str('out')) : undefined,
      width: num('width'), format: str('format'),
      frames: num('frames'),        // >1 走九格连拍
      intervalMs: num('interval'),  // 采样上限间隔
      region,
    };
  } else if (cmd === 'text') {
    // 读屏文字（OCR）。CLI 以前没这个命令，导致插件有、命令行没有。
    action = 'text';
    args = { minConf: num('minconf'), maxLines: num('maxlines'), fresh: flags.fresh === true };
  } else if (cmd === 'input') {
    if (!sub) { console.error('需要输入类型：tap / swipe / hold / text / key / paste'); process.exit(1); }
    action = 'input';
    args = {
      kind: sub,
      x: num('x'), y: num('y'), nx: num('nx'), ny: num('ny'),
      x1: num('x1'), y1: num('y1'), x2: num('x2'), y2: num('y2'),
      ms: num('ms'), text: str('text'), key: str('key'),
    };
  } else if (cmd === 'status') {
    action = 'status';
  } else {
    console.error(`不认识的命令「${cmd}」。跑 vdisplay help 看用法。`);
    process.exit(1);
  }

  // 截图输出路径：--out 指定的文件名要精确，不能只给目录
  if ((action === 'shot' || action === 'mainShot') && str('out')) {
    args.wantPath = str('out');
  }

  const result = await call(action, args);

  if (wantJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  // shot 支持精确输出路径：守护进程按 dir 存，这里再搬一次
  if ((action === 'shot' || action === 'mainShot') && str('out') && result?.path) {
    const { copyFile } = await import('node:fs/promises');
    try {
      await copyFile(result.path, str('out'));
      result.path = str('out');
    } catch (e) {
      // 以前这里静默吞掉，用户会去 --out 找文件却找不到。必须说出来。
      result.copyError = `拷贝到 ${str('out')} 失败：${e.message}（截图实际在 ${result.path}）`;
    }
  }

  process.stdout.write(`${human(action, result)}\n`);
}

main().catch((e) => {
  console.error(`出错了：${e?.message || e}`);
  process.exit(1);
});
