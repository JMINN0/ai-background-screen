# 风控靶场实测结果

## 基线 vs 拟人化输入

| 方式 | 分数 | 失败项 |
|---|---|---|
| **JS `dispatchEvent`（旧）** | **46 / 100** | bh.trusted(20)、bh.input-without-keys(18)、bh.click-without-mousedown、bh.mouse-missing |
| **Android 输入注入（新）** | **92 / 100** | 只剩 bh.mouse-missing(6) |

**+46 分，翻了一倍。**

## 关键突破：`isTrusted` 变成 true

之前用 JS 的 `dispatchEvent` 派发事件，靶场直接判 `isTrusted=false` —— 这一项权重 20，是最重的扣分点。

改用 **Android 层输入注入**（`adb shell input motionevent`）后：

```json
"clicks": [
  {"trusted": true, "x": 68, "y": 449, "type": "down"},
  {"trusted": true, "x": 68, "y": 449, "type": "click", "target": "BUTTON"}
],
"behaviorAnalysis": {"untrustedEvents": [], "untrustedCount": 0}
```

**全部事件零不可信。** 原因：对浏览器来说，通过 Android 输入系统进来的事件就是真实输入，和手指按下去没有区别。

这条说明——**操作浏览器时，能用系统输入就别用 JS 派发**。

## 仍然失败的项

`bh.mouse-missing`（权重 6）：「鼠标移动采样只有 2 个，不足以判人」

试过的办法都不行：

| 办法 | 结果 |
|---|---|
| 5 个事件的点击 | 2 个采样 |
| 10 个事件 + 25ms 间隔 | 2 个采样 |
| 15 个事件的长距离接近轨迹 + 20ms 间隔 | 2 个采样 |
| `input swipe`（内部生成连续 MOVE） | 2 个采样 |

**判断**：虚拟屏上的浏览器只对每次注入响应一两个移动事件，换注入方式改不了。可能是虚拟屏的输入通道或浏览器的事件合并策略导致的，**在无 root 前提下暂时无解**。

## 做不到的事（实测确认）

| 路径 | 结果 |
|---|---|
| `sendevent` 写真实触摸屏 | ❌ SELinux Enforcing 拒绝（Permission denied） |
| `/dev/uinput` 造输入设备 | ❌ 需 root |
| `input motionevent --axis PRESSURE` | ⚠️ 语法接受但**不生效**，浏览器收到的压力恒为 1 |

所以：**行为分布可以像人，事件本身无法做到与真人不可区分。**

## 复测方法

```bash
# 1. 起靶场
cd tests/risk-sim && node server.mjs &

# 2. 起虚拟屏 + 投浏览器
cd screen && node bin/vdisplay.mjs start
node bin/vdisplay.mjs launch com.microsoft.emmx

# 3. 浏览器打开 http://127.0.0.1:3081/

# 4. 注入拟人点击（注意用 status 给的 displayId，dumpsys 里的可能是残留）
node -e "
import('./src/human.js').then(h => {
  const t = h.buildTap(133, 909, { size: 167 });
  console.log(h.toShellCommand(t.events, { displayId: <正确id> }));
});
" | xargs -I{} adb -s 127.0.0.1:5555 shell "{}"

# 5. 读分数
# 在页面执行 window.RiskDetect.run() 看 summary.score
```
