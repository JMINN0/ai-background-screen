/**
 * ocr.js — 屏幕文字识别（RapidOCR / PP-OCRv4，纯 CPU，不依赖 PyTorch）。
 *
 * 为什么必须做这一层：实测盲测证明，把截图缩到九格（每格 262 宽）后，原图 26px 的
 * 中文只剩 5-9px，**大模型完全读不出数字，而且会编造**。所以数字和文字不能靠模型看图，
 * 必须 OCR 成文本交给它 —— 这样既准又省 vision token（文本几乎不计图 token）。
 *
 * 实测对比（720×1592 真实截图）：
 *   Tesseract chi_sim : 4.29s，46 行，大量乱码
 *   RapidOCR          : 1.60s，96 个文本框，置信度 0.74-1.00，带坐标
 *   → 选 RapidOCR，且 det_limit_side_len 从 736 降到 320 后提速 2.5 倍，质量几乎不变
 *
 * **实现方式**：RapidOCR 是 Python 包，而本插件跑在 Node 里，所以这里起一个 Python
 * 常驻子进程（src/ocr_helper.py），用 stdin/stdout 上的 JSON 行通信。常驻是关键 ——
 * 模型加载要 3-5 秒，每次重载就没法用了。
 *
 * 依赖：pip install rapidocr-onnxruntime（模型 15MB）
 * 没装的话本模块返回 ok:false 而不是崩掉 —— OCR 是增强能力，不该让整个插件挂。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER = join(__dirname, 'ocr_helper.py');

const state = {
  child: null,
  ready: false,
  error: null,
  buf: '',
  nextId: 1,
  pending: new Map(),   // id -> {resolve, timer}
  lastHash: null,
  lastResult: null,
  startedAt: 0,
};

function finishPending(err) {
  for (const [, p] of state.pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, hint: err });
  }
  state.pending.clear();
}

/** 起（或重启）Python 常驻进程。 */
function spawnHelper() {
  if (state.child) return state.child;
  state.error = null;
  state.ready = false;
  state.buf = '';

  let child;
  try {
    child = spawn('python3', [HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    state.error = String(e?.message || e);
    return null;
  }
  state.child = child;
  state.startedAt = Date.now();

  child.stdout.on('data', (d) => {
    state.buf += d.toString();
    let idx;
    while ((idx = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, idx).trim();
      state.buf = state.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.ready === true) { state.ready = true; continue; }
      if (msg.ready === false) { state.error = msg.error || '模型加载失败'; continue; }

      const p = state.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        state.pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  });

  child.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s && !state.error) state.error = s.slice(0, 200);
  });

  child.on('exit', (code) => {
    state.child = null;
    state.ready = false;
    finishPending(`OCR 进程退出（code ${code}）`);
  });

  child.on('error', (e) => {
    state.child = null;
    state.ready = false;
    state.error = String(e?.message || e);
    finishPending(state.error);
  });

  return child;
}

/** 等进程报 ready（最多等 timeoutMs） */
function waitReady(timeoutMs = 20000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (state.ready) return resolve(true);
      if (state.error) return resolve(false);
      if (!state.child) return resolve(false);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 150);
    };
    tick();
  });
}

/** 引擎状态（不触发加载） */
export function available() {
  return { ready: state.ready, running: !!state.child, error: state.error };
}

/** 预热：提前把模型加载好，让第一次 vdisplay_text 不用等 3-5 秒 */
export async function warm() {
  spawnHelper();
  const ok = await waitReady();
  return { ok, error: state.error };
}

/**
 * 识别一张图。
 *
 * @param {string} imagePath 本地 PNG 路径
 * @param {object} [o]
 * @param {number} [o.minConf=0.45] 置信度下限
 * @param {number} [o.maxLines=80]  最多返回几行
 * @param {string} [o.hash]         截图哈希；一样就复用上次结果，省 1.6 秒
 */
export async function recognize(imagePath, o = {}) {
  const minConf = Number(o.minConf) || 0.45;
  const maxLines = Math.max(1, Math.min(200, Number(o.maxLines) || 80));
  const hash = o.hash || null;

  if (hash && state.lastHash === hash && state.lastResult) {
    return { ...state.lastResult, cached: true, elapsedMs: 0 };
  }

  if (!spawnHelper()) {
    return { ok: false, hint: `起 OCR 进程失败：${state.error}` };
  }
  const ready = await waitReady();
  if (!ready) {
    return {
      ok: false,
      hint: state.error
        ? `OCR 不可用：${state.error}`
        : 'OCR 进程启动超时。装一下依赖：pip install rapidocr-onnxruntime',
    };
  }

  const id = state.nextId++;
  const t0 = Date.now();
  const resp = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      resolve({ ok: false, hint: 'OCR 超时（20 秒）' });
    }, 20000);
    state.pending.set(id, { resolve, timer });
    try {
      state.child.stdin.write(JSON.stringify({ id, image: imagePath, minConf, maxLines }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      state.pending.delete(id);
      resolve({ ok: false, hint: `写不进 OCR 进程：${String(e?.message || e)}` });
    }
  });

  if (!resp.ok) return resp;

  const result = {
    ok: true,
    lines: resp.lines || [],
    count: resp.count || 0,
    total: resp.total || resp.count || 0,
    elapsedMs: resp.elapsedMs || (Date.now() - t0),
    cached: false,
  };
  if (hash) { state.lastHash = hash; state.lastResult = result; }
  return result;
}

/** 收工：关掉 Python 进程。插件卸载或引擎退出时调用。 */
export function shutdown() {
  if (state.child) {
    try { state.child.stdin.end(); } catch {}
    try { state.child.kill('SIGTERM'); } catch {}
    state.child = null;
  }
  state.ready = false;
  finishPending('已关闭');
}
