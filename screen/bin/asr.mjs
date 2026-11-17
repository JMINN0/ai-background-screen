#!/usr/bin/env node
/**
 * asr.mjs —— 把 wav 转成文字（本地 SenseVoice，不联网，0 成本）
 *
 * 用法：node bin/asr.mjs <wav路径> [--lang zh]
 *
 * ## 实测：五种语言全部正确
 *
 * ```
 * 中文: 开饭时间早上9点至下午5点。
 * 英文: The tribal chieftain called for the boy and presented him with 50 pieces of code
 * 日文: うちの中学は弁当制で持っていきない場合は50円の学校販売のパンを買う。
 * 韩文: 조금만 생각을 하면서 살면 훨씬 편할 거야.
 * 粤语: 呢几个字都表达唔到我想讲嘅意思。
 * ```
 *
 * ## 关键前提：模型必须带 CMVN 统计量
 *
 * `model.int8.onnx` 的 metadata 里必须有 `neg_mean` 和 `inv_stddev`（各 560 维）。
 * **没有这两个，模型能加载、能推理，但输出永远是空字符串。**
 *
 * 之前踩过：DSH 自带的那个模型（`~/.dsh/speech-to-text/sensevoice/`）缺 CMVN，
 * 转写一直返回 `'.'`，查了很久才发现。
 *
 * 正确模型从 sherpa-onnx release 下：
 * https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2
 * 解压后放到 `~/.dsh/speech-to-text/sensevoice-official/`。
 *
 * ## 用法示例（配合 vidgrab）
 *
 * ```bash
 * node bin/vidgrab.mjs grab <缓存视频路径>   # 产出 audio.wav
 * node bin/asr.mjs /tmp/vidgrab/audio.wav    # → 文字
 * ```
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const wav = process.argv[2];
if (!wav || !existsSync(wav)) {
  console.error('用法：node bin/asr.mjs <wav路径> [--lang zh|en|ja|ko|yue]');
  process.exit(1);
}
const langIdx = process.argv.indexOf('--lang');
const lang = langIdx > 0 ? process.argv[langIdx + 1] : '';

// 优先用官方模型（带 CMVN），回退到 DSH 自带的（可能缺 CMVN）
const candidates = [
  `${homedir()}/.dsh/speech-to-text/sensevoice-official`,
  `${homedir()}/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx`,
];
const dir = candidates.find((d) => existsSync(`${d}/model.int8.onnx`) || existsSync(`${d}/model.onnx`));
if (!dir) {
  console.error('找不到 SenseVoice 模型。');
  console.error('下载：https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2');
  console.error(`解压到 ${candidates[0]}/`);
  process.exit(1);
}
const model = existsSync(`${dir}/model.int8.onnx`) ? `${dir}/model.int8.onnx` : `${dir}/model.onnx`;

const py = `
import wave, numpy as np, sherpa_onnx, sys
rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=${JSON.stringify(model)}, tokens=${JSON.stringify(dir + '/tokens.txt')},
    num_threads=4, use_itn=True, language=${JSON.stringify(lang)})
with wave.open(${JSON.stringify(wav)}) as w:
    sr = w.getframerate()
    d = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
s = rec.create_stream(); s.accept_waveform(sr, d); rec.decode_stream(s)
print(s.result.text)
`;
try {
  const out = execFileSync('python3', ['-c', py], { encoding: 'utf-8', maxBuffer: 8 << 20 });
  const text = out.trim();
  console.log(text || '(没有识别到语音)');
} catch (e) {
  console.error('转写失败：', e.message);
  process.exit(1);
}
