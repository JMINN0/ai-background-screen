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
 * [69..71]   session 包头：0x80 = bit63 置位，表示这是 session 包
 * [72]       低 1 位 = client_resized
 * [73..76]   宽（u32 BE）
 * [77..80]   高（u32 BE）
 * [81..]     视频包
 * ```
 *
 * 每个视频包：
 *
 * ```
 * [0..7]    u64 BE：高 3 位是 flag，低 61 位是 PTS（微秒）
 *              bit63 = session 包（尺寸变化/编码器重启时重发，本层已跳过）
 *              bit62 = config 包（SPS/PPS），这种包 PTS 是 0
 *              bit61 = 关键帧
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

/*
 * 留多少包。
 *
 * **不能太小。** 关键帧间隔实测约 10 秒（25fps 就是 250 帧），第一版留 120 个包，
 * 关键帧很快被挤出去，之后所有解码都报「无输出」——因为没有 SPS/PPS 就解不了。
 * 留 400（约 16 秒）能保证绝大多数时候缓冲里至少有一个关键帧。
 *
 * 内存代价：每帧平均 9KB × 400 ≈ 3.6MB，可以接受。
 */
const PACKET_KEEP = 400;

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

    /*
     * **标志位在 u64 的高 3 位，低 61 位才是 PTS（微秒）。**
     *   位 63 = session 包（这层已经跳过了，媒体包里不会出现）
     *   位 62 = config 包（SPS/PPS），PTS 被清零
     *   位 61 = 关键帧
     * 我第一版把 63 当 config、62 当 key，分类全错位 —— 碰巧因为包顺序没变还能解出画面，
     * 但那是运气，不是正确。
     */
    const cfg = (rawPts & (1n << 62n)) !== 0n;
    const key = (rawPts & (1n << 61n)) !== 0n;
    const pts = Number(rawPts & ((1n << 61n) - 1n));
    const data = st.buf.subarray(12, 12 + size);

    if (cfg) {
      // SPS/PPS：解码前必须先喂给解码器
      st.config = Buffer.from(data);
      // 常驻解码器在跑的话，参数集随时更新
      feedDecoder(st, st.config, true);
    } else {
      st.frames += 1;
      if (st.firstPts === null) st.firstPts = pts;
      st.lastPts = pts;
      // **同时记到达时刻。** scrcpy 的 PTS 高位被 flag 占了（位 63/62/61 都见过被置位），
      // 用 PTS 算帧率会得出几十万秒这种荒谬结果，所以帧率按墙钟算。
      const pkt = { pts, key, at: Date.now(), data: Buffer.from(data) };
      st.packets.push(pkt);
      if (st.packets.length > PACKET_KEEP) st.packets.shift();
      // 喂常驻解码器（没起就不做事）
      feedDecoder(st, pkt, false);
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
    hasKeyframe: st.packets.some((p) => p.key),
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

/* ============================================================
 * 常驻解码器
 * ============================================================
 *
 * ## 为什么要有它
 *
 * `grabJpeg()` 每次都从关键帧开始把整个 GOP 解一遍，实测 244ms —— 比 screencap
 * 的 143ms 还慢。原因是结构性的：H.264 的帧间依赖逼你从头解。
 *
 * 常驻解码器让 ffmpeg 一直在跑，把新包持续喂进去，它持续吐 JPEG。拿「最新一帧」
 * 就变成读内存，不再有解码等待。
 *
 * **实测（对同一份 96 帧的流）**：
 *   一次性解整条流：96 帧 428ms → 4.5ms/帧
 *   所以 25fps 常驻的 CPU 约 11% 一个核。
 *
 * ## 为什么要等关键帧
 *
 * ffmpeg 中途接上去的时候，手上全是 P 帧，它没有 SPS/PPS 也没有参考帧，
 * 会报 `non-existing PPS 0 referenced` 然后一帧都出不来。
 * 所以启动后要**先扔掉所有 P 帧，等到下一个关键帧才开始喂**。
 *
 * 所以启动时会用 `h264(st)`（config + 最近关键帧起的全部包）自举，让解码器立刻能工作。
 * 自举喂进去的历史帧**按帧数跳过**，不进传感器环（时间闸不可靠，会泄漏）。
 *
 * 想更快拿到画面就得让服务端重发 IDR —— 往控制通道发一个 0x11 字节
 * （TYPE_RESET_VIDEO），那需要控制 socket 配合，后面再做。
 */

/** 起一个常驻解码器，挂在 st 上。重复调用会先停掉旧的。 */
export async function startDecoder(st, o = {}) {
  if (!st) return { ok: false, hint: '没有解析状态' };
  if (st.decoder) return { ok: true, reused: true };

  const { spawn } = await import('node:child_process');
  /*
   * 常驻解码器现在只出 **32x32 灰度**（每帧 1024 字节、7.6ms），
   * 用来算画面变化量 —— 这是「免费的时间信号」：25Hz 盯着，但不花图片 token。
   *
   * 全尺寸 JPEG 仍走按需解码（`grabJpeg`），因为：
   *   ① 双输出（split + 两个 -map 到 pipe:1/pipe:3）实测两边都是 0 字节，不通
   *   ② 灰度流很便宜，没必要为了省一次解码而承担管道帧序对齐的风险
   *
   * **`-fflags nobuffer -flags low_delay` 绝对不能加。**
   * 实测加上之后 ffmpeg 静默不出任何输出（既没报错也没帧），去掉就正常。
   * 这个坑害我以为是解码器写错了，查了很久。
   */
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'h264', '-i', 'pipe:0',
    '-an', '-sn', '-dn',
    '-vf', 'scale=32:32:flags=area,format=gray',
    /*
     * **`-fps_mode passthrough` 必须有。**
     *
     * 默认 rawvideo 输出会按恒定帧率**补帧/复制帧**，于是连续两帧内容一模一样，
     * 灰度差恒为 0 —— 传感器看起来永远"静止"。实测就是这个现象：帧数在涨
     * （21.6fps）、环也满了，但 mad 全是 0，滑动时也不变。
     *
     * passthrough 表示「解码出多少就吐多少，不补不丢」。
     */
    '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-pix_fmt', 'gray',
    'pipe:1',
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  const dec = {
    proc,
    latestAt: 0,           // 最近一帧灰度的到达时间
    frames: 0,             // 解出多少张
    needKeyframe: true,    // 还没等到关键帧
    // **必须在初始化里就赋 0。** 只在自举成功时赋值的话，自举失败（h264(st) 为 null）
    // 就一直是 undefined，`Date.now() >= undefined` 恒为 false → pushSensor 永不调用，
    // 传感器永久空。而 motion() 把「空」翻译成 stable:true，故障看起来跟静止一模一样。
    skipSensorUntil: 0,
    stderr: '',
    closed: false,
    bytesIn: 0,
    startedAt: Date.now(),
  };
  st.decoder = dec;

  // ---- stdout：每 1024 字节一帧 32x32 灰度 ----
  const THUMB_BYTES = 32 * 32;
  let acc = Buffer.alloc(0);
  proc.stdout.on('data', (d) => {
    acc = acc.length ? Buffer.concat([acc, d]) : d;
    while (acc.length >= THUMB_BYTES) {
      const buf = Buffer.from(acc.subarray(0, THUMB_BYTES));
      acc = acc.subarray(THUMB_BYTES);
      dec.frames += 1;
      dec.latestAt = Date.now();
      // 自举帧按数量跳过（见上面说明），跳完才开始记传感器
      if (dec.skipFrames > 0) { dec.skipFrames -= 1; } else pushSensor(st, buf, dec);
    }
    // 这里原来有一行 `if (acc.length > THUMB_BYTES*4) acc = Buffer.alloc(0)`。
    // 它是死代码（while 退出时 acc 必然 < 1024），而且**万一触发就会丢掉
    // 非 1024 整数倍的前缀，从此永久错位**。删掉。
  });

  proc.stderr.on('data', (d) => {
    dec.stderr = (dec.stderr + d).slice(-2000);
  });
  proc.on('close', () => { dec.closed = true; });
  proc.on('error', (e) => { dec.closed = true; dec.stderr += ` spawn: ${e?.message || e}`; });
  proc.stdin.on('error', () => { /* ffmpeg 退出后 write 会 EPIPE，忽略 */ });

  /*
   * **自举：用缓冲里已有的数据把解码器喂起来。**
   *
   * 只靠「等下一个关键帧」是不行的 —— 实测等了 24 秒都没等到，因为 scrcpy 的
   * 关键帧主要在**流开始时**发，解码器启动时那个 IDR 早被消费进 packets 了。
   *
   * 所以启动时直接把 `config + 从最近关键帧开始的包` 灌进去，解码器立刻就能工作。
   */
  const bst = h264(st);
  if (bst && bst.length) {
    try {
      dec.bytesIn += bst.length;
      proc.stdin.write(bst);
      dec.needKeyframe = false;      // 自举数据里已经含有关键帧
      dec.bootstrapped = true;
      /*
       * **按帧数跳，不用时间闸。**
       *
       * 原来给 600ms 消化窗口：实测 dec.frames 到 258 时 sensorFrames 已经 17，
       * 也就是 241 帧在窗口内解完、剩 17 帧漏到窗口外被当成实时帧记下。
       * 泄漏量随 GOP 长度和 CPU 快慢漂移，不可控。
       *
       * 改成：自举喂了多少帧，就让解码器跳过多少帧 —— `-fps_mode passthrough`
       * 保证出帧数与入帧数 1:1，所以这个计数是准的。
       */
      dec.skipFrames = st.packets.length;
    } catch { /* 起不来就退回等待模式 */ }
  }

  return { ok: true, bootstrapped: Boolean(dec.bootstrapped) };
}

/** 停掉常驻解码器。 */
export function stopDecoder(st) {
  if (!st || !st.decoder) return { ok: true, stopped: false };
  const dec = st.decoder;
  st.decoder = null;
  try { dec.proc.stdin.end(); } catch { /* ignore */ }
  try { dec.proc.kill('SIGKILL'); } catch { /* ignore */ }
  return { ok: true, stopped: true, frames: dec.frames };
}

/**
 * 取最新一张 JPEG。
 *
 * 返回的是**内存里的 Buffer**，不落盘 —— 调用方需要文件时自己写。
 * 这样拿一帧只有内存拷贝成本，实测远低于 1ms。
 */
export function latestJpeg(st) {
  // 常驻解码器现在只出灰度（用来算变化量），不出 JPEG。
  // 全尺寸帧统一走 grabJpeg 的按需解码 —— 返回 null 让调用方回退。
  return null;
}

/** 常驻解码器状态 */
export function decoderStats(st) {
  const dec = st && st.decoder;
  if (!dec) return { running: false };
  const sens = st.sensor || [];
  return {
    running: !dec.closed,
    frames: dec.frames,
    needKeyframe: dec.needKeyframe,
    hasFrame: sens.length > 0,
    sensorFrames: sens.length,
    lastMad: sens.length ? sens[sens.length - 1].mad : null,
    // **ageMs 说明不了传感器新鲜度** —— 它用的是解码器活着的时间。
    // 真正的传感器新鲜度看 sensorAgeMs。
    ageMs: dec.latestAt ? Date.now() - dec.latestAt : null,
    sensorAgeMs: sens.length ? Date.now() - sens[sens.length - 1].at : null,
    // 两路帧计数应该 1:1；2x/3x 就是解码器在重复吐帧
    decoderFrames: dec.frames,
    streamFrames: st.frames,
    skipLeft: dec.skipFrames || 0,
    uptimeMs: Date.now() - dec.startedAt,
    stderr: dec.stderr ? dec.stderr.slice(-300) : '',
  };
}

/**
 * 把解析出的包喂给常驻解码器。由 push() 内部调用，不需要外部调。
 *
 * 关键规则：
 *   · config 包（SPS/PPS）**永远先写**，否则解码器没有参数集
 *   · 还没等到关键帧之前，所有 P 帧都扔掉（喂了也解不出）
 *   · 关键帧到达时，先写 config 再写它，然后才进入正常喂流
 */
/*
 * 传感器环：每来一帧 32x32 灰度，算它和上一帧的平均绝对差（MAD），
 * 顺带算一个粗略的「变化都在哪儿」的包围盒。
 *
 * 这是整个「免费时间信号」的地基：25Hz 盯着屏幕，但一个 token 都不花。
 * 后面所有决策（要不要截图、截哪儿、截几张）都从这里来。
 *
 * 内存：每帧存 1024 字节灰度 + 几个数字，100 帧约 110KB。
 */
export const SENSOR_KEEP = 100;      // 约 4 秒 @25fps

function pushSensor(st, gray, dec) {
  if (!st) return;
  if (!st.sensor) st.sensor = [];
  const prev = st.sensor.length ? st.sensor[st.sensor.length - 1] : null;

  // 顺手把亮度统计出来：全 0 = 黑屏（FLAG_SECURE），min==max = 纯色（卡住）
  let sum = 0, min = 255, max = 0;
  for (let k = 0; k < 1024; k += 1) {
    const v = gray[k];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = Math.round((sum / 1024) * 10) / 10;

  let mad = 0;
  let bbox = null;
  if (prev) {
    let sum = 0;
    let minX = 32, minY = 32, maxX = -1, maxY = -1;
    // 判定「这个像素变了」的阈值：32x32 上 8 灰阶差已经很明显
    const TH = 8;
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const i = y * 32 + x;
        const d = Math.abs(gray[i] - prev.gray[i]);
        sum += d;
        if (d >= TH) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    mad = sum / 1024;
    if (maxX >= 0) bbox = { minX, minY, maxX, maxY };
  }

  st.sensor.push({ at: Date.now(), mad, bbox, mean, min, max, gray });
  if (st.sensor.length > SENSOR_KEEP) st.sensor.shift();
  if (dec) dec.lastMad = mad;
}

/**
 * 最近的变化曲线（给决策用）。
 *
 * 返回的是数值，**不含任何图片** —— 用它决定要不要花 token，本身就是免费的。
 */
export function motion(st, { recent = 25 } = {}) {
  const sens = (st && st.sensor) || [];
  /*
   * **传感器空 ≠ 出错。**
   *
   * scrcpy 只在画面变化时发帧。屏幕一直静止的时候一个包都没有，传感器环自然空。
   * 这时候正确的结论是「没有任何变化」，而不是「探测失败」—— 后者会让调用方
   * 白白回退到昂贵路径。
   */
  if (!sens.length) {
    /*
     * **空要分两种情况，不能一律当"稳定"。**
     *
     *   · 解码器没在跑 → 没数据是正常的（没开这项能力）
     *   · 解码器在跑但传感器空 → **可能坏了**（比如自举失败导致 pushSensor 从不被调用）
     *
     * 原来两种情况都返回 stable:true，于是"传感器坏了"看起来跟"画面静止"一模一样 ——
     * 这种故障最难查。现在用 degraded 标出来。
     */
    const dec = st && st.decoder;
    const running = Boolean(dec && !dec.closed);
    return {
      ok: !(running && dec.frames > 0),
      frames: 0,
      windowFrames: 0,
      peakMad: 0, avgMad: 0, tailMad: 0,
      stable: true,
      changing: false,
      spanMs: 0, fps: null,
      lastBbox: null,
      degraded: running && dec.frames > 0,   // 解码器出过帧但传感器收不到 = 坏了
      hint: running
        ? `解码器已解 ${dec.frames} 帧但传感器是空的 —— 传感器链路可能坏了（看 degraded）`
        : '传感器还没有任何帧（解码器没在跑，或画面一直静止）',
    };
  }
  const win = sens.slice(-recent);
  const mads = win.map((s) => s.mad).filter((v, i) => i > 0 || win.length > 1);
  const peak = mads.length ? Math.max(...mads) : 0;
  const avg = mads.length ? mads.reduce((a, b) => a + b, 0) / mads.length : 0;
  // 用后 1/4 的平均值判断「稳没稳」
  const tail = win.slice(-Math.max(2, Math.ceil(win.length / 4)));
  const tailMad = tail.reduce((a, s) => a + s.mad, 0) / Math.max(1, tail.length);
  return {
    ok: true,
    frames: sens.length,
    windowFrames: win.length,
    peakMad: Math.round(peak * 100) / 100,
    avgMad: Math.round(avg * 100) / 100,
    tailMad: Math.round(tailMad * 100) / 100,
    stable: tailMad < 0.5,
    changing: tailMad >= 0.5,
    spanMs: win.length > 1 ? win[win.length - 1].at - win[0].at : 0,
    /*
     * **帧率必须用 ≥1 秒的窗口算。**
     *
     * socket 的 data 事件是批量到达的（64KB ≈ 64 帧，同一批时间戳只差 0-1ms）。
     * 用 25 帧的跨度算，一碰到批量边界 span 就塌成 173ms → 得出 138fps；
     * 下个窗口正常 → 19-21fps。69/138/21.8/19.2 全是这么来的。
     */
    fps: (() => {
      if (sens.length < 2) return 0;
      const last = sens[sens.length - 1].at;
      // 从最后往前找到第一个 ≥1000ms 之前的帧
      let i = sens.length - 1;
      while (i > 0 && last - sens[i].at < 1000) i -= 1;
      const span = last - sens[i].at;
      if (span < 900 || i === sens.length - 1) return null;   // 窗口不够 1 秒就不给数
      return Math.round(((sens.length - 1 - i) / (span / 1000)) * 10) / 10;
    })(),
    lastBbox: win.length ? win[win.length - 1].bbox : null,
    // 最后一次的亮度：全 0 = 黑屏（FLAG_SECURE），min==max = 纯色（卡住）
    lastMean: win.length ? win[win.length - 1].mean : null,
    lastMin: win.length ? win[win.length - 1].min : null,
    lastMax: win.length ? win[win.length - 1].max : null,
    blackScreen: win.length ? win[win.length - 1].max === 0 : null,
  };
}

export function feedDecoder(st, pkt, isConfig) {
  const dec = st && st.decoder;
  if (!dec || dec.closed) return;
  const sin = dec.proc.stdin;
  if (!sin || sin.destroyed) return;

  const write = (buf) => {
    if (!buf || !buf.length) return;
    dec.bytesIn += buf.length;
    try { sin.write(buf); } catch { /* ffmpeg 走了就忽略 */ }
  };

  if (isConfig) {
    // 配置包随时可以写，解码器会更新参数集
    write(pkt);
    return;
  }

  if (dec.needKeyframe) {
    if (!pkt.key) return;                 // 还没到关键帧，扔掉
    if (st.config) write(st.config);      // 先给 SPS/PPS
    dec.needKeyframe = false;
  }
  write(pkt.data);
}
