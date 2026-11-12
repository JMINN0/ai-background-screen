# 风控靶场实测结果

## 最终成绩：100 / 100

| 方式 | 分数 | 失败项 |
|---|---|---|
| JS `dispatchEvent` | 46 / 100 | bh.trusted(20)、bh.input-without-keys(18)、bh.click-without-mousedown、bh.mouse-missing |
| Android 注入 `input motionevent` | 92 / 100 | bh.mouse-missing(6) |
| **CDP `Input.dispatchMouseEvent` + 拟人轨迹** | **100 / 100** | **无** |

满分那次的指标：

```json
{
  "score": 100,
  "fails": [],
  "behaviorAnalysis": {
    "mouseStraightness": 0.312,     // 越接近 1 越像机器人走直线
    "mouseDtCv": 4.49,              // 移动间隔变异系数，太小 = 太规律
    "clicksWithDown": "2/2",        // 每次 click 都有对应 mousedown
    "untrustedEvents": [],
    "untrustedCount": 0
  }
}
```

## 关键发现：两条路各有短板，合起来才满分

### 1. JS 派发（46 分）—— `isTrusted` 是死穴

用 `dispatchEvent` 派发事件，浏览器标记 `isTrusted=false`，这一项权重 20，直接判死。
文字通过 DOM 赋值还拿不到按键事件（`input-without-keys`，权重 18）。

**无论怎么伪造轨迹都修不掉。**

### 2. Android 注入（92 分）—— 事件可信，但采样不够

`input motionevent` 从系统输入栈进来，浏览器看到 `isTrusted=true`（真正的突破）。
但虚拟屏路径下浏览器**每次注入只响应一两个移动事件**：

| 注入方式 | mousemove 采样数 |
|---|---|
| 5 个事件的点击 | 2 |
| 10 个事件 + 25ms 间隔 | 2 |
| 15 个事件的长距离轨迹 | 2 |
| `input swipe` | 2 |

采样数不够（< 3），`bh.mouse-missing`（权重 6）判失败。

### 3. CDP `Input.dispatchMouseEvent`（100 分）—— 补上了采样

CDP 的 Input 域走浏览器内部输入管道，**产生的事件同样是 `isTrusted=true`**，
而且能一次发任意多个 `mouseMoved`。

实测：12 次 mousemove → 12 个采样，全部可信。

**但它单独用只有 84 分**，因为轨迹和时序是"完美"的：

| 问题 | 现象 | 修法 |
|---|---|---|
| `bh.mouse-straight`(8) | 直线度 1.0 | 用 `human.js` 的曲线轨迹 |
| `bh.mouse-timing`(8) | 间隔变异系数 0.076 | 用对数正态抖动延迟 |

**两者合起来才是满分**：CDP 提供可信事件 + 足够采样，`human.js` 提供人形轨迹和节奏。

## 满分方案

```js
// 1. 用 human.js 生成带弯曲和抖动的轨迹
const { buildSwipe } = await import('../screen/src/human.js');
const s = buildSwipe(startX, startY, targetX, targetY, { points: 14 });

// 2. 逐个通过 CDP 发送
for (const e of s.events) {
  if (e.action === 'DOWN') {
    await cdp.send(tid, 'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: e.x, y: e.y, button: 'left', clickCount: 1, buttons: 1 });
  } else if (e.action === 'MOVE') {
    await cdp.send(tid, 'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: e.x, y: e.y, buttons: 1 });
  } else {
    await cdp.send(tid, 'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: e.x, y: e.y, button: 'left', clickCount: 1, buttons: 0 });
  }
  // 3. 延迟用对数正态抖动，不要固定值
  await new Promise(r => setTimeout(r, jitterMs()));
}
```

## 做不到的事（实测确认，别再试）

| 路径 | 结果 |
|---|---|
| `sendevent` 写真实触摸屏 | ❌ SELinux Enforcing 拒绝 |
| `/dev/uinput` 造输入设备 | ❌ 需 root |
| `input motionevent --axis PRESSURE` | ⚠️ 语法接受但不生效，压力恒为 1 |

## 注意

这个分数只说明**通过了我们自己写的靶场**。靶场是规则阈值式的（直线度、变异系数、权重求和），
真实的商业风控会用模型和行为序列分析，不是同一回事。**别把 100 分当成"能过任何风控"。**

