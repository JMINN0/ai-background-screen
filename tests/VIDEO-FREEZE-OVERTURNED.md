# 🔴 结论推翻：视频在虚拟屏上**没有**冻结

> 2026-11-17。这条推翻了 `VIDEO-COMPARISON.md` 里那个被判了四次的结论。

## 之前信的是什么

> 「视频（MediaCodec 输出的 Surface）在这台设备的虚拟屏上不刷新，只出第一帧。」

依据：scrcpy 视频流的帧计数停在 26-400 帧、`shot()` 帧去重返回同一路径、
试了 hwc:on / 软解 / 四个播放器 / 各种播放键全失败。

## 真相

**虚拟屏本身在正常渲染视频。冻的是 scrcpy 的 H.264 镜像路径。**

## 实测证据

```js
// 关键：screencap -d 要的是 SurfaceFlinger ID，不是逻辑 displayId
const SFID = r.sfId;   // 11529215048879975052（19 位大数）
spawnSync('adb', ['exec-out', `screencap -p -d ${SFID}`]);
```

0.4 秒间隔连拍 10 帧：

```
q1→q2: 2.26     亮度 102.6
q2→q3: 2.53     亮度 102.6
q3→q4: 2.70     亮度 102.7
q4→q5: 2.65     亮度 102.7
q5→q6: 2.75     亮度 102.6
q6→q7: 2.65     亮度 102.5
q7→q8: 2.61     亮度 102.6
q8→q9: 2.56     亮度 102.5
q9→q10: 2.62    亮度 102.6

平均差异 2.59，9 对连续帧全部在变
文件大小 151KB-167KB 波动（内容在变）
```

**静态 UI 的差异会是 0.00。** 2.59 说明画面在持续变化。

抽 q3 那一帧看，是 `testsrc2` 的标准测试图 —— 彩条 + 一条斜线 + 十字准星。
斜线在特定位置，说明那是特定帧。

## 为什么会误判四次

| 我之前的做法 | 为什么会得出"冻结" |
|---|---|
| 看 scrcpy 视频流的帧计数 | **冻的就是这条流**，用它判断等于用问题本身当证据 |
| `shot()` 帧去重返回同一路径 | shot 内部走 screencap，**但用的是逻辑 displayId 或缓存的旧 sfId** |
| 试各种播放器和播放键 | 播放器一直在正常播，只是我们没在用对的通道看 |

## 两个关键陷阱

### ① `screencap -d` 不认逻辑 displayId

```
$ adb shell screencap -p -d 354
Failed to take screenshot. Display Id '354' is not valid.

$ adb shell screencap -p -d 0
Failed to take screenshot. Display Id '0' is not valid.
```

**连主屏的 displayId=0 都不认。** 它要的是 SurfaceFlinger 的物理 display ID
（19 位大数，如 `11529215048879975052`）。

`vd.start()` 返回的 `r.sfId` 就是它。

### ② `screenrecord --display-id` 同样只认物理 ID

之前记的「screenrecord 录不了虚拟屏」也是这个原因，不是不支持。

## 现在能做到什么

| | 之前以为 | 实际 |
|---|---|---|
| 虚拟屏放视频 | ❌ 冻住 | ✅ **正常刷新** |
| 抓视频帧 | 只能 scrcpy 流（冻） | ✅ **`screencap -d <SFID>` 能抓，约 7fps** |
| 能用于「看视频内容」 | ❌ | ✅ **7fps 够读画面内容和字幕** |

`screencap` 单帧 143ms → 约 7fps。对「理解视频讲了什么」够用
（配 ASR 转写，画面上烧录的字幕也能 OCR）。

## 还没搞清的

**为什么 scrcpy 的 H.264 流会冻？** 虚拟屏在合成层是正常的，
说明问题在 scrcpy 的编码/镜像这一环。这条值得单独查 ——
如果能修好，就能拿回 60fps；修不好，7fps 的 screencap 也能用。

候选方向：
- scrcpy server 的视频 socket 在某些 display 上有 bug
- 编码器对 1592×720 这种非标准分辨率处理有问题
- 需要 `--max-fps` / `--video-codec` 换参数

## 教训

**判据必须独立于被测对象。** 我用「scrcpy 的流」判断「虚拟屏有没有刷新」，
而 scrcpy 的流本身就是坏的那一环 —— 这是循环论证，注定得出错误结论。
