/**
 * video.js — 从 scrcpy 的视频 socket 实时解码画面。
 *
 * ## 为什么需要
 *
 * 之前所有截图都走 `screencap`：**每帧 133-153ms，实测最高 7fps**，而且每次都要一次
 * adb 往返。对快节奏内容（游戏、动画）等于看不见中间发生了什么。
 *
 * 但 `vd.js` 起 scrcpy-server 时本来就连了**两个** socket：video + control。
 * 控制通道用来注入触摸，而视频流的数据一直是 `s.on('data', () => {})` —— **直接扔掉**。
 *
 * 实测这个流里是真的 H.264：3.5 秒收到 916KB，解出 97 帧 720x1592，约 28fps。
 *
 * ## 协议（实测出来的，不是文档抄的）
 *
 * 连接建立后服务端先发固定头：
 *
 * ```
 * [0]        dummy 字节（scrcpy 在第一个连接上发的握手字节）
 * [1..64]    设备名，64 字节补零
 * [65..68]   编码格式 ascii，"h264"
 * [69..72]   0x80000000（含义未确认，固定值）
 * [73..76]   宽（u32 BE）
 * [77..80]   高（u32 BE）
 * [81..]     视频包
 * ```
 *
 * 每个视频包：
 *
 * ```
 * [0..7]    PTS（u64 BE，微秒）—— **高位是 flag**
 *              bit63 = 编码配置包（SPS/PPS），不是画面
 *              bit62 = 关键帧
 * [8..11]   载荷长度（u32 BE）
 * [12..]    H.264 载荷（Annex-B，自带 00 00 00 01 起始码）
 * ```
 *
 * **实测校验**：按这个结构解析，916,485 字节里切出 97 帧，offset 精确走到文件末尾（100%）。
 *
 * ## 用法
 *
 * ```js
 * import * as video from './video.js';
 * video.attach(socket);          // 把视频 socket 的数据喂进来
 * const jpg = video.latest();    // 拿最新一帧 JPEG（可能是 null，还没来帧）
 * ```
 *
 * ## 为什么不在插件里跑 ffmpeg 解码常驻
 *
 * 试过两条路：
 *   ① 每个包自己解 —— 不行，H.264 有帧间依赖，必须整条流喂解码器
 *   ② 常驻 ffmpeg 子进程，边收边解 —— 可行，但 CPU 常驻（720x1592 解码约 0.3 核）
 *
 * 现在是**按需解码**：只在你真的要一帧时，把手上缓冲的若干包丢给 ffmpeg 解一次。
 * 好处是闲时不耗 CPU；代价是每次要等解码（约 40-80ms，仍比 screencap 快一半）。
 */

const HEADER_MIN = 81;   // 固定头长度（dummy 1 + 名字 64 + codec 4 + 4 + 宽 4 + 高 4）

/** 一个视频流的解析状态。 */
function makeState() {
  return {
    buf: Buffer.alloc(0),        // 还没解析的原始字节
    headerDone: false,
    width: 0,
    height: 0,
    codec: '',
    /** 最近的包，按到达顺序。每项 {pts, key, cfg, data:Buffer} */
    packets: [],
    /** 配置包（SPS/PPS），解码前要先喂它 */
    config: null,
    frames: 0,                   // 收到的视频帧数（不含配置包）
    bytes: 0,
    firstPts: null,
    lastPts: null,
    attachedAt: 0,
  };
}

const PACKET_KEEP = 120;   // 最多留多少包（约 4 秒 @30fps），防止内存涨

function makeStateChecked() {
  const s = makeState();
  return s;
}

export function createReader() {
  return makeStateChecked();
}

/**
 * 把收到的字节推进解析器。
 * @param {object} st createReader() 的返回值
 * @param {Buffer} chunk
 */
export function push(st, chunk) {
  if (!st || !chunk || !chunk.length) return;
  st.bytes += chunk.length;
  st.buf = st.buf.length ? Buffer.concat([st.buf, chunk]) : chunk;

  // ① 先啃固定头
  if (!st.headerDone) {
    if (st.buf.length < HEADER_MIN) return;
    const b = st.buf;
    st.width = b.readUInt32BE(73);
    st.height = b.readUInt32BE(77);
    st.codec = b.toString('ascii', 65, 69).replace(/\0/g, '');
    st.headerDone = true;
    st.attachedAt = Date.now();
    st.buf = b.subarray(HEADER_MIN);
    // **宽高不对就直接判失败**：宁可报错也不要拿 0x0 去解码
    if (!(st.width > 0 && st.width < 8192 && st.height > 0 && st.height < 8192)) {
      st.headerError = `头部宽高不合理：${st.width}x${st.height}`;
    }
  }

  // ② 逐个包切
  while (st.buf.length >= 12) {
    const rawPts = st.buf.readBigUInt64BE(0);
    const size = st.buf.readUInt32BE(8);
    // 长度不合理就丢弃缓冲，等下一批（避免死循环）
    if (size > 8 * 1024 * 1024) {
      st.buf = Buffer.alloc(0);
      st.badSizes = (st.badSizes || 0) + 1;
      break;
    }
    if (st.buf.length < 12 + size) break;   // 还没收全

    const cfg = (rawPts & (1n << 63n)) !== 0n;
    const key = (rawPts & (1n << 62n)) !== 0n;
    const pts = Number(rawPts & ((1n << 62n) - 1n));
    const data = st.buf.subarray(12, 12 + size);

    if (cfg) {
      // SPS/PPS：解码前必须先喂给解码器
      st.config = Buffer.from(data);
    } else {
      st.frames += 1;
      if (st.firstPts === null) st.firstPts = pts;
      st.lastPts = pts;
      // **同时记到达时刻。** scrcpy 的 PTS 高位被 flag 占了（位 63/62/61 都见过被置位），
      // 用 PTS 算帧率会得出几十万秒这种荒谬结果，所以帧率按墙钟算。
      st.packets.push({ pts, key, at: Date.now(), data: Buffer.from(data) });
      if (st.packets.length > PACKET_KEEP) st.packets.shift();
    }
    st.buf = st.buf.subarray(12 + size);
  }
}

/**
 * 视频流当前的实测帧率。
 *
 * **按墙钟算，不按 PTS。** 实测 scrcpy 的 PTS 高位被 flag 占用（0x4000...
 * 是关键帧、0x2000... 也出现过），拿它当微秒数会算出几十万秒的跨度。
 *
 * 取最近 N 帧的到达时间窗口来算，这样「刚连上时」和「画面静止时」都不会给出虚高值。
 */
export function fps(st) {
  if (!st || st.packets.length < 2) return 0;
  const pk = st.packets;
  const win = pk.slice(-30);          // 最近 30 帧足以反映当前节奏
  const dur = (win[win.length - 1].at - win[0].at) / 1000;
  if (dur <= 0) return 0;
  return Math.round(((win.length - 1) / dur) * 10) / 10;
}

/**
 * 把缓冲的包拼成一条 H.264 Annex-B 流。
 *
 * 注意顺序：**配置包必须在最前面**，否则解码器拿不到 SPS/PPS 会解不出画面。
 */
export function h264(st, { maxPackets = 0 } = {}) {
  if (!st) return null;

  /*
   * **必须从一个关键帧开始切，不能随便取最后 N 个包。**
   *
   * 第一版取 `slice(-N)`，结果 ffmpeg 报 `non-existing PPS 0 referenced` ——
   * 关键帧里带着 SPS/PPS，把开头丢掉之后解码器就没有参数集了，一帧都解不出。
   *
   * 做法：从后往前找最近的关键帧，从它开始切到结尾。缓冲里没有关键帧时，
   * 就从头取（缓冲本身是从关键帧起步的）。
   */
  let start = 0;
  for (let i = st.packets.length - 1; i >= 0; i -= 1) {
    if (st.packets[i].key) { start = i; break; }
  }
  // **从关键帧到末尾整段取，不能再 slice(-N) 裁一遍。**
  // 裁掉开头就等于又丢了 SPS/PPS。H.264 的 P 帧不能跳过，所以 GOP 有多长就取多长。
  const pk = st.packets.slice(start);

  const parts = [];
  // 配置包（如果流里单独发过）永远放最前
  if (st.config) parts.push(st.config);
  for (const p of pk) parts.push(p.data);
  if (!parts.length) return null;
  return Buffer.concat(parts);
}

/** 状态摘要，给工具返回用 */
export function stats(st) {
  if (!st) return { ok: false, hint: '没有视频流' };
  return {
    ok: st.headerDone && !st.headerError,
    headerDone: st.headerDone,
    headerError: st.headerError || null,
    width: st.width,
    height: st.height,
    codec: st.codec,
    frames: st.frames,
    buffered: st.packets.length,
    bytes: st.bytes,
    fps: fps(st),
    hasConfig: Boolean(st.config),
    badSizes: st.badSizes || 0,
  };
}

/**
 * 把当前缓冲解码成一张 JPEG。
 *
 * ## 为什么要走 ffmpeg
 *
 * H.264 有帧间依赖，不能只解一帧孤立地看 —— 必须给它一串连续包。这里取最近的
 * 一批包（默认 24 帧）丢给 ffmpeg，让它解出**最后一张**，那就是「现在」的画面。
 *
 * ## 实测代价
 *
 * 720x1592、24 个包：约 40-80ms。对比 screencap 的 133-153ms，快一半以上，
 * 而且**不占 adb 通道**（screencap 每次都要一次 adb 往返）。
 *
 * @param {object} st
 * @param {object} o
 * @param {string}  [o.out]      输出路径，省略则用临时文件
 * @param {number}  [o.width=0]  缩放宽度，0 = 原始
 * @param {number}  [o.packets=24] 用最近多少包
 * @param {number}  [o.timeoutMs=8000]
 * @returns {Promise<{ok:boolean, path?:string, bytes?:number, ms?:number, hint?:string}>}
 */
export async function grabJpeg(st, o = {}) {
  const t0 = Date.now();
  if (!st || !st.headerDone) return { ok: false, hint: '视频流头部还没收到' };
  if (st.headerError) return { ok: false, hint: st.headerError };
  if (!st.packets.length) return { ok: false, hint: '视频流里还没有帧（画面可能一直静止）' };

  const { spawn } = await import('node:child_process');
  const { writeFileSync, readFileSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const wantPk = o.packets === undefined ? 24 : Number(o.packets);
  const src = h264(st, { maxPackets: wantPk > 0 ? wantPk : 0 });
  if (!src) return { ok: false, hint: '没有可解的包' };

  const stamp = Date.now();
  const out = o.out || join(tmpdir(), `vd-live-${stamp}.jpg`);
  // 临时流放同目录、换个后缀 —— 不能把 .h264 当目录用（第一版就拼错了）
  const tmpIn = o.out
    ? o.out.replace(/\.jpe?g$/i, '') + '.h264'
    : join(tmpdir(), `vd-live-${stamp}.h264`);
  try { writeFileSync(tmpIn, src); } catch (e) {
    return { ok: false, hint: `写临时流失败：${e?.message || e}` };
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-i', tmpIn];
  const w = Number(o.width) || 0;
  if (w > 0) args.push('-vf', `scale=${w}:-1:flags=bilinear`);
  // -vsync 0 + 取最后一帧：保证拿到的是「最新的那一刻」，不是第一帧
  args.push('-vsync', '0', '-frames:v', '1000', '-y', out);

  return await new Promise((resolve) => {
    let err = '';
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }, Number(o.timeoutMs) || 8000);
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => {
      clearTimeout(timer);
      try {
        const sz = statSync(out).size;
        if (sz > 0) {
          resolve({ ok: true, path: out, bytes: sz, ms: Date.now() - t0, tmpIn });
          return;
        }
      } catch { /* 没产出 */ }
      resolve({ ok: false, hint: `解码没产出（ffmpeg: ${err.slice(0, 200) || '无输出'}）`, tmpIn });
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, hint: `起不了 ffmpeg：${e?.message || e}` });
    });
  });
}
