# 🎉 音频采集打通：scrcpy playback + audio_dup 实测成功

> 2026-11-17。无 root，shell uid 2000。

## 结论

**能抓到手机正在播放的音频，而且是原始 PCM，不用录音、不用 mic、不静音。**

## 实测数据

```js
// scrcpy server 参数（audio only，无视频无控制）
audio=true audio_source=playback audio_dup=true audio_codec=raw
video=false control=false
```

在一个虚拟屏上播放本地有声视频（440Hz 正弦 + testsrc2 画面），然后抓音：

```
收到 1,137,985 字节 / 6 秒 = 189 KB/s
  期望：48000 Hz × 2ch × 16bit = 192 KB/s  ✅ 速率对
PCM 采样 568,960 个 = 5.9 秒 @48k stereo
非零采样 523,562 / 568,960 = 92.0%
RMS 17623，峰值 32767（满量程）
ffmpeg volumedetect: mean_volume -5.4 dB, max_volume 0.0 dB
```

**92% 非零 + -5.4dB = 真实音频。**

## 两个关键陷阱（都踩过）

### ① 音频 socket 的头是 64 字节设备名，不是 4 字节 codec id

第一帧头部：

```
00 4e 58 38 30 39 4a 00...  =  "\0NX809J"
```

这是 `\0` + 设备名 `NX809J` + 填充，**和 video socket 的 64 字节设备名头一样**。

我一开始按「4 字节 codec id + 12 字节包头」解析，跳过 12 字节就开始找非零，
结果落在设备名填充里，误判成「静音」。**正确做法：跳过 64 字节。**

### ② 没有声音源时，抓到的就是静音（不是失败）

第一次测没播放任何东西，收到 1.3MB 但非零只有 0.2%。
那是**全零 PCM**，不是抓失败 —— 音频管道是通的，只是没有声音。
**判据必须是「先确认有声音在播」，否则分不清「抓不到」和「没声音」。**

## 和视频的区别

| | 视频 | 音频 |
|---|---|---|
| socket | 第一个（或 video=true 时） | 第二个（video=false 时是第一个） |
| 头部 | 64 字节设备名 + 12 字节包记录 | 64 字节设备名 + 裸 PCM |
| 格式 | H.264 Annex-B | PCM 16bit LE / 48kHz / stereo |
| 有数据但静音 | 不会 | **会**（没有声音源时） |

## 现在能做到什么

| 能力 | 状态 |
|---|---|
| 抓正在播的声音 | ✅ **PCM 原始数据，92% 非零** |
| 不静音手机 | ✅ `audio_dup=true` |
| 不需要 mic | ✅ 走 AudioPolicy mix |
| 不需要 MediaProjection | ✅ 不需要用户授权弹窗 |
| 免费 | ✅ 无编码，直接 PCM |

配已经跑通的本地 SenseVoice ASR（`node bin/asr.mjs`），
**「AI 听懂手机上正在播的视频」这条链路完整了。**

## 还没验证的

- **真 App 会不会拒绝**（`setAllowedCapturePolicy(BY_NONE)`）—— B站/抖音/微信视频号都没测
- 长时间稳定性（只测了 6 秒）
- 边播边转的延迟

## 复现命令

```bash
# 参数
audio=true audio_source=playback audio_dup=true audio_codec=raw video=false control=false

# 拿到 PCM 后
python3 -c "
d=open('cap.raw','rb').read()[64:]   # **跳过 64 字节设备名**
n=(len(d)//4)*4
open('cap.pcm','wb').write(d[:n])
"
ffmpeg -f s16le -ar 48000 -ac 2 -i cap.pcm -ar 16000 -ac 1 cap.wav
node bin/asr.mjs cap.wav
```
