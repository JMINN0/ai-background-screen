# 视频识别：绕开虚拟屏的「满血」路线（实测成功）

> **结论先说：微信/App 缓存的视频文件可以 `adb pull` 出来，用 ffmpeg 直接读 —— 
> 画面、音频、字幕全都有，完全不需要虚拟屏，没有 MediaCodec 冻结问题。**

测于 2026-11-17。设备：红魔 NX809J / Android 16 / 无 root / adb uid 2000。

## 一、怎么发现的

之前的思路一直是「**让视频在虚拟屏上播放，然后抓帧**」，
但 MediaCodec 输出到虚拟屏只出第一帧就冻住，四条修法全失败。

子代理指出：**画面走 SurfaceFlinger/合成器，声音走 AudioFlinger 混音，两条独立通路**；
而且「**绕开屏幕去拿文件，比修虚拟屏便宜一个数量级**」。

顺着这条找，发现 `/sdcard/Android/data/<pkg>/` 对 shell（uid 2000）是**可读的**。

## 二、实测：微信视频缓存

```bash
# 目录（16MB / 42 个文件）
/sdcard/Android/data/com.tencent.mm/cache/ThumbVideoCache/CdnDownload/Cache/appbrand0/

# 文件后缀是 .res，但头部是标准 MP4
$ dd if=xxx.res bs=1 count=32 | od -A n -c
  00 00 00 1c 66 74 79 70 69 73 6f 6d  →  "ftypisom"
```

`ffprobe` 完全认：

```
codec_name=hevc          # 视频 HEVC
width=720  height=1280
codec_name=aac           # 音频 AAC
duration=18.367052
format_name=mov,mp4,m4a,3gp,3g2,mj2
```

## 三、能做什么（全部实测通过）

```bash
adb pull /sdcard/Android/data/com.tencent.mm/cache/.../xxx.res /tmp/v.res

# 抽帧（真实画面，不是缩略图）
ffmpeg -i /tmp/v.res -vf "fps=1" -frames:v 3 -y f%02d.jpg
# → 3 张 720×1280 JPEG，亮度 113-124

# 抽音频（喂 ASR）
ffmpeg -i /tmp/v.res -vn -ar 16000 -ac 1 -y a.wav
# → 10.1 秒 16kHz 单声道 wav
```

**抽出来的帧里能看到**：人物手拿切开的橙子、「朴朴超市」水印、
**烧录的中文字幕「请大数据把朴朴这个爱媛果冻橙 分享给所有爱吃橙子的姐妹!」**、
底部免责声明。

## 四、这意味着什么

| 之前的路 | 这条路 |
|---|---|
| 视频必须在虚拟屏播放 | **不用播放** |
| MediaCodec 冻住 → 只出首帧 | **ffmpeg 直接解，任意帧** |
| 实时看 N 秒才能处理 | **秒级处理完** |
| 无音频 | **有音频，能转写** |
| 挑帧受 60fps 流限制 | **按需抽任意时间点** |

**「视频识别」这个需求，对缓存内容完全解决了。**

## 五、适用范围（要分清）

✅ **能拿到的**：
- 微信聊天视频、视频号、小程序视频（`ThumbVideoCache`）
- B站离线缓存（`download/` 目录，本机是空的，但结构在）
- 任何下载类 App 存在 `/sdcard/Android/data/<pkg>/` 的媒体
- `/sdcard/DCIM`、`Pictures/WeiXin` 等共享存储里的（MediaStore 能查路径）

❌ **拿不到的**：
- 纯在线流（YouTube 这类不落盘的）
- 正在直播的
- DRM 加密内容
- `/data/data/<pkg>/` 私有目录（无 root 读不到）

## 六、下一步该做的

1. **做成工具** —— `vdisplay_video_probe` / `vdisplay_video_frames`：
   给定 App 包名，找最近的缓存视频，抽帧 + 抽音频
2. **接 ASR** —— 本地 SenseVoice（`~/.dsh/speech-to-text/sensevoice/`，228MB）
   或 `pip install sherpa-onnx`，把 wav 转文字
3. **硬字幕 OCR** —— 抽出来的帧里有烧录字幕，OCR 能直接读

## 七、一个必须注意的坑

**不要 force-stop 用户正在用的 App**（这条已经踩过，杀了用户正在看的 B站）。
读缓存文件是只读操作，不需要停 App，安全。
