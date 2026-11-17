# 点击验证：什么信号可信，什么信号会骗你

> 2026-11-17。用户批评过我的验证方法（「点击可能已生效，只是弹窗几秒就消失」），
> 这是查完之后的结论。

## 结论

**点击一直是有效的。** 我之前的「没生效」判定来自三个错误信号源。

## 决定性证据

虚拟屏 1592×720，打开 Android 设置 → OCR 找到「WLAN」在 (0.128, 0.700) → tap。

之后再 OCR：

```
[0.99] WLAN                    ← 标题栏（说明进了 WLAN 页）
[0.99] WLAN                    ← 开关行
      更多设置
      要查看可用网络，请打开WLAN。
      为了提升位置信息的精确度，即使WLAN已关闭…
```

**这是 WLAN 设置页。点击 → 导航 → 成功。**

## 三个会骗人的信号

### ① `mCurrentFocus=null`

```
$ dumpsys window | grep mCurrentFocus
mCurrentFocus=null
```

看起来像「虚拟屏没有焦点窗口，点击不可能送达」。
**但同一次会话里点 WLAN 成功跳转了。**

原因【推测】：`mCurrentFocus` 反映的是默认 display 的焦点，
虚拟屏（displayId≠0）的焦点要用 `dumpsys window displays` 里对应段落读。

**判据：不要用 `grep mCurrentFocus` 判断虚拟屏能不能点。**

### ② `logcat -b events` 没有 `am_create_activity`

点了 WLAN，页面确实跳了，但：

```
$ logcat -b events -d | grep am_create_activity
(无)
```

**这台机器（红魔 Android 16）的 event log 抓不到 Activity 事件。**

【不知道】是缓冲区、格式变了、还是厂商关了。

**判据：不要用 event log 判断有没有导航。**

### ③ 首尾截图对比

旧方法：`截图 → 点 → sleep(2500) → 截图 → 比首尾`

- 「弹出又消失」看不见
- 终态相同（开关、聚焦）会判失败
- 143ms 采样太粗

**判据：改用 `watchFrames` 看时间线。**

## 什么信号可信

| 信号 | 可信度 | 说明 |
|---|---|---|
| **OCR 页面文字变化** | ✅ **最可靠** | 标题/内容变了就是跳转了 |
| **`watchFrames` 时间线** | ✅ 可靠 | 能看到何时变、持续多久 |
| `dumpsys input` TouchState | ✅ 可靠 | 能看到窗口有 touch target |
| InputDispatcher 丢弃日志 | ✅ 可靠 | 有 `Dropping event` 就是真点空了 |
| `mCurrentFocus` | ❌ **会骗人** | 虚拟屏上恒 null |
| `logcat -b events` | ❌ **会骗人** | 这台机器抓不到 Activity 事件 |
| 首尾截图对比 | ❌ 不可靠 | 漏瞬时态、终态相同误判 |

## `watchFrames`：看时间线而不是首尾

```js
const tl = await vd.watchFrames(3000, 40);   // 3 秒，40ms 一次
// → { totalFrames, bursts: [{startMs, endMs, frames}], firstChangeMs, changed }
```

实测点 WLAN：
```
44 帧, 1 段: 403ms→2950ms (2547ms, 44帧)
```

**用单调帧计数 `state.videoReader.frames`，不是 `packets.length`**（那个有 400 上限，饱和后 delta 恒 0）。

## 坐标必须 OCR 定位，不能猜

| 目标 | 我猜的 | OCR 实际 | 偏差 |
|---|---|---|---|
| 设置搜索框 | (0.30, 0.10) | **(0.101, 0.234)** | 20% 屏宽 |
| WLAN | — | (0.128, 0.700) | — |

**猜坐标点空了，我还以为点击坏了。** 两个问题叠在一起互相掩盖。

## 教训

1. **验证方法不可靠时，会把「我的错误」伪装成「平台不行」**
2. **多个信号源要交叉验证**，单一信号可能系统性骗人
3. **OCR 是最便宜可靠的导航判据**（虽然 1.9-3.3 秒，但只跑一次就够）
4. 用户批评「你说做好了但其实没验到位」是对的 —— 能力在，验证不在
