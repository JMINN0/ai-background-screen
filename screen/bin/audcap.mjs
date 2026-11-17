#!/usr/bin/env node
/**
 * audcap.mjs —— 抓手机正在播放的音频（无 root、不弹授权、不静音）
 *
 * ## 实测过的参数（2026-11-17）
 *
 * ```
 * audio=true audio_source=playback audio_dup=true audio_codec=raw raw_stream=true
 * video=false control=false
 * ```
 *
 * 效果：音频 socket 连上就是裸 PCM（48kHz / 2ch / s16le），零头部。
 * 实测 184 KB/s（理论 192），非零 75.3%，mean_volume -5.4dB。
 *
 * ## 两个坑（都踩过）
 *
 * ① **不加 `raw_stream=true` 时有 64 字节设备名头**（`00 4e 58 38 30 39 4a` = "\0NX809J"）。
 *    按 12 字节跳会落在填充里，读成静音。
 *
 * ② **没有声音在播时，抓到的就是静音**，不是失败。
 *    必须先确认有声音源（`dumpsys audio` 有 started player，或视频在播）。
 *
 * ## 用法
 *
 * ```bash
 * node bin/audcap.mjs --seconds 10 --out /tmp/cap.wav
 * node bin/audcap.mjs --seconds 10 --out /tmp/cap.wav --play "file:///sdcard/Download/x.mp4"
 * ```
 */

import { execSync, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const seconds = Number(arg('seconds', 10));
const outPath = arg('out', '/tmp/cap.wav');
const raws = arg('raw', '');          // 只存裸 PCM 的路径（可选）
const target = process.env.ADB_TARGET || '127.0.0.1:5555';
const port = Number(arg('port', 0)) || (28500 + Math.floor(Math.random() * 300));
const scid = (1 + Math.floor(Math.random() * 0x7ffffffe)).toString(16).padStart(8, '0');

const adb = (...a) => execSync(`adb -s ${target} ${a.join(' ')}`, { stdio: 'pipe' }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  // 前置：确认有声音在播
  const audioDump = adb('shell', 'dumpsys audio');
  if (!/started/i.test(audioDump)) {
    console.warn('⚠️ dumpsys audio 里没看到 started player —— 可能没有声音在播。');
    console.warn('   没有声音源时抓到的是全零 PCM，不是抓取失败。');
  }

  adb('forward', `tcp:${port}`, `localabstract:scrcpy_${scid}`);

  const cmd = `CLASSPATH=/data/local/tmp/dshvd/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 5.0.1 `
    + `log_level=info tunnel_forward=true audio=true audio_source=playback audio_dup=true `
    + `audio_codec=raw raw_stream=true video=false control=false scid=${scid}`;

  const srv = spawn('adb', ['-s', target, 'shell', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });

  await sleep(4000);
  const fail = log.split('\n').find((l) => /ERROR|Could not capture|SecurityException/i.test(l));
  if (fail) {
    console.error('server 报错：', fail.trim());
    console.error('（"Could not capture audio playback" = 权限或 AudioPolicy 注册失败）');
  }

  const sock = createConnection({ host: '127.0.0.1', port });
  const chunks = [];
  sock.on('data', (b) => chunks.push(b));
  sock.on('error', (e) => console.error('socket:', e.message));

  await sleep(seconds * 1000);
  const pcm = Buffer.concat(chunks);
  sock.destroy();
  srv.kill();
  try { adb('forward', '--remove', `tcp:${port}`); } catch { /* ignore */ }

  const rate = pcm.length / seconds;
  console.log(`收到 ${pcm.length} 字节 / ${seconds} 秒 = ${(rate / 1024).toFixed(0)} KB/s`);
  console.log(`  期望约 192 KB/s（48kHz × 2ch × 16bit）`);

  if (pcm.length < 1000) {
    console.error('数据太少，链路可能没通。');
    process.exit(1);
  }

  // 统计非零
  const n = Math.min(pcm.length, 200000);
  let nz = 0;
  for (let i = 0; i < n; i += 2) {
    if (pcm[i] !== 0 || pcm[i + 1] !== 0) nz++;
  }
  const pct = (100 * nz) / (n / 2);
  console.log(`  非零采样 ${pct.toFixed(1)}% → ${pct > 10 ? '✅ 有声音' : '⚠️ 静音（可能没有声音源在播）'}`);

  if (raws) { writeFileSync(raws, pcm); console.log(`  裸 PCM → ${raws}`); }

  // 写 WAV（48k stereo 16bit）
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);          // PCM
  header.writeUInt16LE(2, 22);          // 2ch
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(48000 * 2 * 2, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(outPath, Buffer.concat([header, pcm]));
  console.log(`  WAV → ${outPath}`);
  console.log('');
  console.log('下一步：');
  console.log(`  ffmpeg -y -i ${outPath} -ar 16000 -ac 1 /tmp/16k.wav`);
  console.log('  node bin/asr.mjs /tmp/16k.wav --lang zh');
};

main().catch((e) => { console.error(e.message); process.exit(1); });
