# AGENTS.md — 给 AI agent 的使用说明

> **先读 [`docs/产品意图.md`](docs/产品意图.md)。** 那份文件是唯一需求源头 ——
> 用户要的只有一件事：他在主屏刷视频，AI 在另一块屏后台干活，
> 他随时能瞄一眼、不想看能缩到最小、两边互不干扰。
> 跟那条对不上的功能就是跑偏了。


> 这个文件是给 **CLI agent / 编码助手** 读的，不是给人看的。
> Codex、Cursor、Copilot、Zed、Aider、Claude Code 会原生读 `AGENTS.md`。

## 这是什么

一个安卓**「AI 虚拟屏」**实现：给 AI 一块用户看不见的虚拟屏（`VirtualDisplay`），
AI 在那块屏上运行 App、点击、输入、截图，用户的物理主屏完全不受影响。

**不要**把它当成"另一个 scrcpy 封装"。区别在于：scrcpy 镜像的是**主屏**，
AI 的操作直接显示在用户脸上；这里操作的是**一块独立创建的显示设备**。

## 你能用它做什么

如果用户说：
- 「帮我挂机 / 帮我操作这个 App，但我要继续用手机」
- 「AI 点的时候别抢我屏幕 / 别弹窗 / 别抢键盘」
- 「让 AI 在后台跑微信/淘宝/游戏」
- 「同时盯着两个 App」

→ 这就是正确的工具。

如果用户说：
- 「帮我操作银行 App / 支付」→ **不行**，`FLAG_SECURE` 截不到图
- 「把微信开两个实例」→ **不行**，`singleTask` 限制
- 「在 iPhone 上」→ 不行

## 前置条件（先检查，别直接跑）

```bash
# ① 必须有 adb，且能连上本机
adb devices                      # 要有 127.0.0.1:5555
adb -s 127.0.0.1:5555 shell id   # 应该是 uid=2000(shell)

# ② 没有 5555 就先配（手机需开无线调试，只配一次）
adb connect 127.0.0.1:5555

# ③ 确认不是 root 设备也能跑
adb shell getprop ro.build.version.sdk   # 需要 >= 31（Android 12+）
```

**不要**试着 `adb root`，这套工具设计成 uid 2000 就能工作。

## 装法

**运行时不需要构建。** `screen/assets/` 里的 `scrcpy-server.jar`、`framesrv.dex`、
`overlay/ai-overlay.apk`、`injector/inject.dex` 都已经提交进仓库，装完就能用。

```bash
# 从 npm 装（推荐，当前 0.2.2）
dsh plugin --profile web add ai-background-screen

# 或者从本地仓库装（要改源码时）
git clone https://github.com/JMINN0/ai-background-screen.git
cd ai-background-screen
dsh plugin --profile web add ./screen
```

装完必须**重启引擎**才生效（MCP 工具是启动时加载的）。

**只有要改悬浮窗 / 取帧服务时才需要构建**（`tools/sdk/` 下两个 jar 不在 git 里，共 37MB）：

```bash
bash tools/fetch-sdk.sh        # 下载 android-30.jar + r8.jar
bash overlay/build.sh          # 重编悬浮窗 APK
bash framesrv/build.sh         # 重编取帧 dex
```

## 五个最容易踩的坑

1. **虚拟屏会随创建它的进程一起死。**
   如果你用 `node -e "..."` 建屏，进程一退屏就没了。要用长驻进程，或者用 MCP 工具（引擎持有的）。

2. **`am start --display N` 对 `singleTask` App 会把主屏任务搬走，投不过去。**
   但**「哪些 App 是 singleTask」不能凭印象**。2026-11-22 实测：`com.android.settings`
   的主入口 `com.android.settings.Settings` 是个 activity-alias（targetActivity 指向
   SettingsHomepageActivity），**没有 launchMode 属性，不是 singleTask** —— 这一条以前写错了。
   判断办法：`aapt dump xmltree <apk> AndroidManifest.xml | grep -A6 'android:name.*Settings'`，
   看有没有 `android:launchMode`。0x1 = singleTop，0x2 = singleTask，没有属性 = standard。
   投屏前先查这一个 App，别拿整类猜测。

3. **中文输入必须走「写剪贴板 + `KEYCODE_PASTE`」，`adb shell input text` 对中文必抛 NPE。**
   插件侧：`vdisplay_input { kind: "paste", text: "…" }`（实测能粘进 `abc中文测试abc`）。
   人在手机上：双击或长按输入框 → 点「粘贴」。
   ~~曾经写过「SET_CLIPBOARD + KEYCODE_PASTE 打不进中文」——那是早期版本的问题，已修复，别再用旧说法。~~
   详见本文末尾「打字不要抢用户键盘」一节。

4. **绝对不要用 `monkey` 启动 App。**
   实测 4/4 次会把系统的自动旋转打开。

5. **不要随手 `force-stop` 用户正在用的 App。**
   先查 `dumpsys window | grep mCurrentFocus` 和 `dumpsys media_session | grep PLAYING`。

## 关键命令

```bash
# 建一块 AI 虚拟屏（MCP 工具，推荐）
vdisplay_start  {orientation: "portrait"}

# 投 App 到 AI 虚拟屏（用 --display，且 App 不能是 singleTask）
adb shell am start --display <displayId> -n <pkg>/<activity>

# 看 AI 虚拟屏在不在
adb shell dumpsys display | grep "Virtual display"

# 取帧服务状态
curl -s http://127.0.0.1:38820/status

# 点击位置可视化（水滴波纹）
curl -s "http://127.0.0.1:38820/mark?nx=0.5&ny=0.5"
```

> 这个波纹只画在**推流 / 悬浮窗**的帧里。AI 自己用 `vdisplay_shot` 截的图走 `screencap`，
> **不带任何标记**，是干净的原图。

## 强制规则

- **不要碰 `accelerometer_rotation`**（用户 2026-11-05 明确禁止）
- **不要在没有确认前台的情况下 `am force-stop`**
- **操作浏览器只能进 Edge 的「AI操作」标签组**（用户 2026-11-05 定）
- 用户在用手机时（前台是 DSH Go 或输入法弹着）**不要抢前台**

## 已知不适用

- 需要 `FLAG_SECURE` 的目标 → 截不到，直接告诉用户做不到
- 高风控 App（银行、部分游戏）→ 事件注入可被识别，需要真实输入
- 想完全拟人化 → 做不到，`adb input` 没有 MOVE、压力恒定

## 边缘光效：让用户看见你在干什么（**不用你管，但要会用**）

用户屏幕上那块小窗口的**边框**会给状态上色。这不是装饰，是用户判断「AI 现在什么情况」的主要通道。

### 哪些是自动的（你什么都不用做）

```
你调 input / launch / tap_text / tap_image / tap_color
    → 边框自动变青色环绕（working，用户在看的屏）

建屏并自检通过
    → 边框自动变绿色横扫（done，任务完成）

你 8 秒没有新操作
    → 边框自动收回（idle，不打扰用户）
```

**用户明确要求**：「工作结束和工作中就不需要 AI 操作和控制边的颜色」。
所以 `working` 和 `done` **不要手动调** —— 系统自己会做。

### 哪些必须你调（`vdisplay_edge`）

只有三种情况需要你主动设边，因为系统不知道：

| 什么时候 | state | 用户看到 |
|---|---|---|
| 遇到阻碍但不致命：验证码、按钮找不到、页面超时 | `warning` | 黄色慢呼吸 |
| 明确失败：操作失败、需要用户介入 | `error` | 红色快脉冲（咚-咚） |
| **可能已出大事**：风控迹象、账号异常、支付/转账前最后确认、任何「再操作下去可能不可逆」 | `critical` | 粗红边高频闪 |

```js
vdisplay_edge { state: "warning", reason: "出现滑块验证码，等 30 秒再试" }
vdisplay_edge { state: "critical", reason: "检测到账号异常提示，停止操作" }
vdisplay_edge { state: "idle" }        // 问题解决了，清掉
```

**你手动设的 warning/error/critical 优先级最高**：在它过期之前，自动的
working/done 不会把它盖掉。所以报了就有效，不会闪一下变回青色。

### 三条使用原则

1. **宁可少报，不要乱报** —— 用户会认真对待这个颜色。如果什么小事都报 critical，
   真正出事时他就不看了。
2. **报完要收** —— 问题解决了记得 `state:"idle"`，或者等 TTL 自动过期
   （warning 15 秒 / error 20 秒 / critical 不自动过期，必须手动清）。
3. **`critical` 当作刹车** —— 一旦亮起来就应该停止操作，等用户看。而不是继续试。

### 颜色和运动是双编码

红绿色盲占男性约 8%，所以每个状态除了颜色不同，**运动方式也不同**：

```
working   匀速环绕流动      done      从左扫到右再淡出
warning   不对称慢呼吸      error     双拍「咚-咚」
critical  粗边低频闪（低于 3Hz，避免光敏性癫痫）
```

闭着眼听节奏也能分出来是哪一档。

## 详细文档

- [README.md](README.md) — 完整原理、安装、工具清单
- [LIMITS.md](LIMITS.md) — 25 条做不到的事
- [llms.txt](llms.txt) — 一页速览

## 打字不要抢用户键盘 —— 用剪贴板 + 粘贴

**教训（2026-11-21）**：隔壁的 AI 在帮用户搜东西时反复抢走键盘，用户正在打字就丢了。
原因只有一个：它用「聚焦输入框 + 弹输入法」的方式打字。

**这个动作在安卓上代价很高**：输入法一弹，用户原来的 InputConnection 被 detach，
半截草稿直接消失。而且 `input text` 会把字拼进**用户正在写的那个框**，`keyevent 66` 甚至会把草稿发出去。

### 正确做法：写剪贴板 + 粘贴，全程不弹输入法

| 场景 | 怎么做 |
|---|---|
| **AI 虚拟屏上**（有 `vdisplay_*` 工具时） | `vdisplay_input { kind: "paste", text: "要输入的内容" }`<br>插件写剪贴板 + 发 `KEYCODE_PASTE`，**不弹输入法、不碰主屏** |
| **主屏上，必须输入时** | ① 先 `adb shell am broadcast` 或 `service call clipboard` 写剪贴板<br>② 让用户自己「**双击或长按输入框 → 点粘贴**」<br>③ 或者用无障碍 `ACTION_PASTE` |

### 人在手机上怎么粘贴（写进用户文档）

**双击输入框** 或 **长按输入框** → 弹出菜单 → 点「粘贴」。
两种都能触发，**不需要切换输入法，也不需要键盘弹出来**。

### 什么时候只能弹键盘

- 目标 App 自绘输入框，且 `KEYCODE_PASTE` 无效
- 需要输入法联想的场景（比如中文候选词选择）

**这种情况下先问用户，别直接抢。**

### 判断标准

**只要不是用户本人要打字，就不要让输入法弹出来。** 输入法弹出 = 用户的输入被中断，
这是最容易被察觉、也最让人恼火的一种打断。
