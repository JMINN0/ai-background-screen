#!/usr/bin/env node
/**
 * vidgrab —— 从 App 缓存里直接取视频，绕开虚拟屏。
 *
 * ## 为什么存在
 *
 * 视频画面在虚拟屏上抓不到（MediaCodec 只出首帧，四条修法全失败）。
 * 但 `/sdcard/Android/data/<包名>/` 对 shell 可读，App 缓存的视频往往是**标准 MP4**
 * （微信的 `.res` 后缀是骗人的，头部是 `ftypisom`）。
 *
 * 所以：**pull 出来用 ffmpeg 直接读** —— 不用播放、没有 MediaCodec、秒级、有音频。
 *
 * ## 用法
 *
 *   node bin/vidgrab.mjs find                          # 列出候选
 *   node bin/vidgrab.mjs find com.tencent.mm           # 指定包名
 *   node bin/vidgrab.mjs grab <路径> --out /tmp/x     # pull + 抽帧 + 抽音频
 *   node bin/vidgrab.mjs grab <路径> --frames 6       # 抽 6 帧
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const ADB = process.env.ADB_BIN || 'adb';
const TARGET = process.env.ADB_TARGET || '127.0.0.1:5555';

const adb = (args, opts = {}) => execFileSync(ADB, ['-s', TARGET, ...args], {
  encoding: 'buffer', maxBuffer: 64 << 20, ...opts,
}).toString();

/** 这些包名的缓存里最可能有视频 */
const KNOWN = {
  'com.tencent.mm': ['cache/ThumbVideoCache', 'cache/wxacache'],
  'tv.danmaku.bili': ['download', 'cache'],
};

/** 媒体文件头（不看后缀，看内容） */
function sniff(buf) {
  if (buf.length < 12) return null;
  // MP4/MOV: 4 字节 size + "ftyp"
  if (buf.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'mkv';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'AVI ') return 'avi';
  if (buf[0] === 0x47) return 'ts';
  return null;
}

function cmdFind(pkgFilter) {
  const pkgs = pkgFilter ? [pkgFilter] : Object.keys(KNOWN);
  const found = [];
  for (const pkg of pkgs) {
    const roots = KNOWN[pkg] || ['.'];
    for (const rel of roots) {
      const base = `/sdcard/Android/data/${pkg}/${rel}`;
      let list;
      try {
        list = adb(['shell', `find '${base}' -type f -size +200k 2>/dev/null | head -30`]).trim();
      } catch { continue; }
      if (!list) continue;
      for (const p of list.split('\n').filter(Boolean)) {
        // 只读头部 12 字节判断是不是媒体
        let head;
        try {
          head = execFileSync(ADB, ['-s', TARGET, 'shell', `dd if='${p}' bs=1 count=12 2>/dev/null`], { maxBuffer: 1 << 16 });
        } catch { continue; }
        const kind = sniff(head);
        if (!kind) continue;
        let size = 0;
        try { size = Number(adb(['shell', `stat -c%s '${p}' 2>/dev/null`]).trim()) || 0; } catch {}
        found.push({ pkg, path: p, kind, size });
      }
    }
  }
  if (!found.length) {
    console.log('没找到缓存的视频。');
    console.log('已知位置：' + Object.entries(KNOWN).map(([k, v]) => `${k} → ${v.join('/')}`).join('；'));
    console.log('别的 App：先 `adb shell ls /sdcard/Android/data/` 找它的目录，再指定包名。');
    return;
  }
  console.log(`找到 ${found.length} 个候选（按大小排序）：`);
  for (const f of found.sort((a, b) => b.size - a.size)) {
    console.log(`  ${(f.size / 1048576).toFixed(1)}MB  ${f.kind}  ${f.pkg}  ${f.path}`);
  }
}

function cmdGrab(remote, opts) {
  if (!existsSync('/tmp')) mkdirSync('/tmp');
  const outDir = opts.out || '/tmp/vidgrab';
  mkdirSync(outDir, { recursive: true });
  const local = `${outDir}/${basename(remote)}`;
  console.log(`pull ${remote}`);
  adb(['pull', remote, local]);
  // 补一个 .mp4 后缀，ffmpeg 靠内容嗅探也能认，但有些工具认后缀
  const asMp4 = local.endsWith('.mp4') ? local : `${local}.mp4`;
  if (!local.endsWith('.mp4')) {
    try { execFileSync('cp', [local, asMp4]); } catch {}
  }
  // 探一下元信息
  try {
    const meta = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration,size:stream=codec_name,codec_type,width,height',
      '-of', 'default=noprint_wrappers=1', asMp4], { encoding: 'utf-8' });
    console.log('--- 元信息 ---');
    console.log(meta.trim().split('\n').map((l) => `  ${l}`).join('\n'));
  } catch (e) {
    console.log('ffprobe 读不了，可能不是标准容器');
  }
  const n = Number(opts.frames) || 4;
  const fpsExp = `fps=${n}/max(1\\,floor(metadata:format=duration))`;
  console.log(`--- 抽 ${n} 帧 ---`);
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-i', asMp4,
      '-vf', `fps=${n}/10`, '-frames:v', String(n), '-y', `${outDir}/f%02d.jpg`]);
  } catch {}
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-i', asMp4, '-vn', '-ar', '16000', '-ac', '1',
      '-y', `${outDir}/audio.wav`]);
  } catch {}
  console.log(`产物在 ${outDir}`);
  console.log('  f01.jpg... 抽出来的画面（可直接读）');
  console.log('  audio.wav  16kHz 单声道，可喂 ASR');
}

// ---- 入口 ----
const [, , sub, ...rest] = process.argv;
const opts = {};
const pos = [];
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === '--out') { opts.out = rest[i + 1]; i += 1; }
  else if (rest[i] === '--frames') { opts.frames = rest[i + 1]; i += 1; }
  else pos.push(rest[i]);
}
if (sub === 'find') cmdFind(pos[0]);
else if (sub === 'grab' && pos[0]) cmdGrab(pos[0], opts);
else {
  console.log('用法：');
  console.log('  node bin/vidgrab.mjs find [包名]');
  console.log('  node bin/vidgrab.mjs grab <远程路径> [--out 目录] [--frames 4]');
  process.exit(1);
}
