#!/usr/bin/env node
/**
 * asr.mjs —— 把 wav 转成文字（本地 SenseVoice，不联网）
 *
 * 用法：node bin/asr.mjs <wav路径>
 *
 * ## 状态：**没跑通，原因已定位**【实测】
 *
 * 模型能加载、能推理，但输出是空字符串（`'.'`）。
 * 查 model.int8.onnx 的 metadata：
 *
 * ```
 *   lfr_window_size   = 7
 *   lfr_window_shift  = 6
 *   model_type        = sense_voice_ctc
 *   lang_zh / lang_en / lang_yue / lang_auto ...
 * ```
 *
 * **缺 `neg_mean` / `inv_stddev`（CMVN 统计量）。**
 * 没有 CMVN，fbank 特征不做归一化，模型输出的就是垃圾/空。
 *
 * ## 怎么修（下次）
 *
 * 1. 换一份带 CMVN metadata 的 sherpa-onnx 官方 SenseVoice 导出
 *    （从 k2-fsa/sherpa-onnx 的 release 里下 sense-voice 模型包）
 * 2. 或者手动做 fbank + CMVN（复杂，80 维 kaldi fbank、25ms/10ms、
 *    preemphasis 0.97、7 帧堆叠 stride 6，一处不对就是乱码）
 * 3. 或者改用 whisper.cpp（`whisper-cli -m ggml-base.bin -l zh -f x.wav`）
 *
 * 音频侧是通的：`ffmpeg -i video -vn -ar 16000 -ac 1 a.wav` 能抽出正常 wav
 * （实测峰值 -22.5dB、98.3% 非零采样），问题只在转写这一步。
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const wav = process.argv[2];
if (!wav || !existsSync(wav)) {
  console.error('用法：node bin/asr.mjs <wav路径>');
  process.exit(1);
}
const model = `${process.env.HOME}/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx/model.int8.onnx`;
const tokens = `${process.env.HOME}/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx/tokens.txt`;
const py = `
import wave, numpy as np, sherpa_onnx, sys
with wave.open(${JSON.stringify(wav)}) as w:
    sr = w.getframerate()
    d = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=${JSON.stringify(model)}, tokens=${JSON.stringify(tokens)},
    num_threads=4, use_itn=True, language='')
s = rec.create_stream(); s.accept_waveform(sr, d); rec.decode_stream(s)
txt = s.result.text
print(txt if txt.strip(' .') else '')
if not txt.strip(' .'):
    print('[空] 模型缺 CMVN 统计量，见文件头注释', file=sys.stderr)
`;
try {
  const out = execFileSync('python3', ['-c', py], { encoding: 'utf-8' });
  console.log(out.trim() || '(空)');
} catch (e) {
  console.error('转写失败：', e.message);
  process.exit(1);
}
