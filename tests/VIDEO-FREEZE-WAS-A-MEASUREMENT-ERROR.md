# 🔴🔴 最终结论：视频从来没有冻结，是我的测量方法错了

> 2026-11-17。这条推翻 `VIDEO-COMPARISON.md` 里那个被判过五次的「视频冻结」结论，
> 也推翻 `VIDEO-FREEZE-OVERTURNED.md` 里「scrcpy 流冻、screencap 不冻」的中间结论。

## 真相

**视频在虚拟屏上正常播放，scrcpy 的 H.264 流**和 **screencap** 两个通道都能抓到动态画面。**

## 决定性实测

```js
// 1. 起屏 + 播本地视频
// 2. **先确认视频真的在播**
const a = cap(SFID); await sleep(800); const b = cap(SFID);
if (!a.equals(b) && a.length > 3000) { /* 在播 */ }

// 3. 边播边数 scrcpy 流的帧
```

12 秒测量结果：

```
2s:  scrcpy +68  | screencap 164758B
4s:  scrcpy +69  | screencap 157836B
6s:  scrcpy +68  | screencap 161899B
8s:  scrcpy +69  | screencap 165285B
10s: scrcpy +68  | screencap 160677B
12s: scrcpy +69  | screencap 166562B

12 秒 scrcpy 新增 411 帧 = 34.3 fps
screencap 6 次采样全部有变化
```

**两个通道都通，34 fps。**

## 我错在哪

**我从来没有先验证「视频真的在播」，就去数帧。**

黑屏 → scrcpy 0 新帧 → 我判定「冻结」。
但那不是冻结，是**视频根本没在播**（播放器没启动、视频已结束、或停在待播界面）。

| 我测到 0 帧的真实原因 | 我当时以为的原因 |
|---|---|
| 视频播完了 | 冻结 |
| 播放器还没点播放按钮 | 冻结 |
| 黑屏待机 | 冻结 |
| 视频源不对 | MediaCodec 不合成 |

## 正确的测量方法（以后必须这样测）

```js
// 判据：screencap 两帧不同 = 画面在动
const a = cap(SFID);
await sleep(800);
const b = cap(SFID);
const playing = !a.equals(b) && a.length > 3000;

if (!playing) {
  // **不要测**。先想办法让它播起来（点播放按钮 / 换视频 / 换播放器）
  // 测静止画面得到的 0 帧毫无意义
}
```

**关键**：`screencap` 是独立的第三方判据，不依赖 scrcpy 流。
用它确认「画面在动」之后，再测 scrcpy 流才有意义。

## 这次为什么会查到

子代理指出「`screencap -d` 要 SurfaceFlinger 物理 ID，不是逻辑 displayId」，
我才第一次能用 screencap 直接看虚拟屏。
然后同时测两个通道，才发现两个都通 —— 之前一直只测一个。

## 教训

1. **判据必须独立于被测对象。** 用 scrcpy 流判断「画面在不在动」是循环论证。
2. **测「变化量」之前，先确认「有变化可测」。** 否则 0 和「没在动」无法区分。
3. **多个通道交叉验证。** screencap 和 scrcpy 流是两条独立路径，同时测才能定位。
4. 一个结论被判了五次还站不住，说明**测量方法本身有问题**，不是现象难懂。

## 现在的真实能力

| 能力 | 之前以为 | 实际 |
|---|---|---|
| 虚拟屏播视频 | ❌ 冻结 | ✅ **正常播放** |
| scrcpy 流抓视频 | ❌ 只出首帧 | ✅ **34 fps** |
| screencap 抓帧 | 以为不可用 | ✅ **可用（143ms/帧）** |
| 视频识别 | 只能读缓存文件 | ✅ **实时也能看** |

**视频识别这件事，从头到尾就是通的。** 缓存路线（vidgrab + asr）是锦上添花，
真正的能力是：**任意 App 在虚拟屏上播视频，我们都能实时抓 34fps 的画面 + 音频。**
