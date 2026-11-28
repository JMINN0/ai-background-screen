# AI 后台屏 · 让 AI 在你手机的另一块屏上干活

> 你刷视频、剪片子、聊天，AI 在**另一块看不见的屏**上跑 App、点按钮、打字。
> 你想看的时候瞄一眼浮窗，不想看就缩到最小。两边互不打扰。

**这是一个实验性项目。它能用，但有真实风险，请先读完 [⚠️ 风险](#️-风险必读)。**

[![Android](https://img.shields.io/badge/Android-12%2B%20(API%2031%2B)-green)]()
[![No Root](https://img.shields.io/badge/Root-不需要-blue)]()
[![License](https://img.shields.io/badge/License-AGPL--3.0-orange)](LICENSE)
[![npm](https://img.shields.io/npm/v/ai-background-screen)](https://www.npmjs.com/package/ai-background-screen)

---

## 目录

- [这是什么](#这是什么)
- [为什么会有这个项目](#为什么会有这个项目)
- [它能做什么 / 不能做什么](#它能做什么--不能做什么)
- [三分钟上手](#三分钟上手)
- [5 分钟跑通](#5-分钟跑通)
- [它是怎么做到的](#它是怎么做到的)
- [浮窗：让你看见 AI 在干什么](#浮窗让你看见-ai-在干什么)
- [开发历程](#开发历程)
- [⚠️ 风险（必读）](#️-风险必读)
- [已知限制](#已知限制)
- [给接手开发的人 / AI](#给接手开发的人--ai)
- [参与](#参与)
- [授权](#授权)

---

## 这是什么

安卓有一套很少被用到的能力：**创建一块和物理屏幕完全独立的虚拟显示器**
（`VirtualDisplay`），在上面跑 App，用户看不见，主屏完全不受影响。

这个项目把它封装成了一套可用工具：

```
你的主屏                      AI 的虚拟屏（用户看不见）
┌──────────────┐             ┌──────────────┐
│ 刷视频 / 剪片 │             │  AI 在这里   │
│ 聊天 / 打游戏  │  ← 互不干扰 → │  跑 App     │
│              │             │  点击 / 打字  │
│   ┌────────┐ │             └──────────────┘
│   │ 浮窗   │ │ ← 实时画面，想看就看，能缩到最小
│   └────────┘ │
└──────────────┘
```

**和 scrcpy 的区别**：scrcpy 镜像的是**你的主屏**，AI 的操作直接显示在你脸上；
这里操作的是**一块新建的显示设备**，你在主屏做什么都不受影响。

**和「模拟器」的区别**：它跑在**真实设备、真实系统**上，App 就是正常安装的那个，
登录态共用，不是另一套环境。

---

## 为什么会有这个项目

> 下面这段是作者的原话，是整个项目的需求源头。

> 「我的想法是**我刷我的视频、我在主屏幕做视频，而你在后台自己建一个屏幕
> 做我要求你的事情**，然后**我还能随时看得到**，**不想看到的时候也可以缩到最小**
> 就这么简单。
>
> 然后延伸出风控操作方式、工作时完成时出问题时会显示不同的边缘灯效，
> 然后还要**我不能打扰到你虚拟屏**，然后又延伸出一堆问题。」

拆开就是四条硬要求，整个项目的每一行代码都是为这四条服务的：

| 要求 | 实现 |
|---|---|
| **① 双向不打扰** | 用户的操作不影响虚拟屏；AI 的操作不影响主屏 |
| **② 随时看得到** | 浮窗实时显示虚拟屏画面（MJPEG，变化即出帧） |
| **③ 随时能缩** | 36dp 缩略图，收起后画面仍刷新 |
| **④ 状态能看出** | 边缘光效六档，working/done 全自动，只有异常要 AI 主动报 |

更详细的需求拆解见 [`docs/产品意图.md`](docs/产品意图.md) —— **那份文件是唯一需求依据**，
改功能前先对一遍，跟它冲突的功能就是跑偏了。

---

## 它能做什么 / 不能做什么

### ✅ 能

| 能力 | 说明 |
|---|---|
| 在同一台手机上跑第二个 App 实例 | 用户主屏继续用，AI 在后台操作 |
| 点击 / 滑动 / 长按 / 双指 | 支持 60Hz 连续按住（游戏摇杆）、多指手势 |
| 中文输入 | 走「写剪贴板 + KEYCODE_PASTE」，不弹输入法 |
| 截图 / OCR / 模板匹配 / 颜色检测 | 40 个工具，见工具清单 |
| 3D 游戏渲染 | 依赖设备 `vendor.display.vds_allow_hwc=1` |
| 多块屏 | 最多受设备内存限制（每块约 75-185MB） |
| 实时看画面 | MJPEG 推流到浮窗，变化即出帧 |

### ❌ 不能

| 做不到 | 原因 |
|---|---|
| **操作银行 / 支付类 App** | `FLAG_SECURE` 截不到图，等于瞎子 |
| 把微信/QQ 开两个**独立**实例 | 同进程，不是真分身 |
| 在 iPhone 上 | 平台不同 |
| 让虚拟屏上的 App 看到一个「正常的单屏环境」 | **虚拟屏对 App 可见，这是设计限制**，见 [风险](#️-风险必读) |
| 完全拟人化操作 | `adb input` 没有 MOVE 轨迹、压力恒定，可被识别 |

完整清单（25 条）见 [`LIMITS.md`](LIMITS.md) —— **每条都写了「为什么做不到」和「怎么验证的」**，
不是凭感觉写的。

---

## 三分钟上手

### 前置条件

```bash
# 需要 Android 12+ (API 31+)，不需要 root
adb shell getprop ro.build.version.sdk     # 应该是 31 或更高

# 需要 adb，且能连上本机
adb devices                                 # 要有 127.0.0.1:5555

# 第一次配置（手机需开无线调试，只配一次）
adb connect 127.0.0.1:5555
```

> **为什么是 `127.0.0.1`**：无线调试默认绑在 WiFi 网卡上，WiFi 一断就没了。
> 跑一次 `adb tcpip 5555` 之后固定走回环，**关 WiFi、开飞行模式都不断**。

### 安装

**方式一：从 npm 装（推荐）**

```bash
dsh plugin --profile web add ai-background-screen
```

**方式二：从源码装（要改代码时）**

```bash
git clone https://github.com/JMINN0/ai-background-screen.git
cd ai-background-screen
dsh plugin --profile web add ./screen
```

**装完必须重启引擎**才生效（MCP 工具是启动时加载的）。

> **运行时不需要构建。** `screen/assets/` 里的 scrcpy-server.jar、framesrv.dex、
> ai-overlay.apk 都已经提交在仓库里，装完就能用。
> 只有要改悬浮窗 / 取帧服务时才需要构建，见 [构建](#构建)。

### 跑起来

```bash
# 建一块虚拟屏（会同时开浮窗和推流）
vdisplay_start

# 往上投一个 App
vdisplay_launch { pkg: "com.android.settings" }

# 点一下
vdisplay_input { kind: "tap", nx: 0.5, ny: 0.5 }

# 看一眼
vdisplay_shot

# 收工
vdisplay_stop
```

命令行形态（不装 DSH 也能用）：

```bash
node screen/bin/vdisplay.mjs start
node screen/bin/vdisplay.mjs status
node screen/bin/vdisplay.mjs shot --width 400 --out /tmp/a.jpg
node screen/bin/vdisplay.mjs stop
```

### 自检

**没有单独的 `selfcheck` 命令** —— 五项自检是 `start` 的一部分，建完屏当场跑、
不过就自动修一次再复检，结果写在 `start` 的输出里。所以别去找别的命令，
看 `start` 那一段输出就够了（逐项含义见下面的[清单](#第一次建屏失败自检项逐项含义)）。

### 用 Claude Desktop / Cursor / Cline（不装 DSH）

这个包自带零依赖的 MCP server，配一个 `mcpServers` 条目就能用：

```json
{
  "mcpServers": {
    "background-screen": {
      "command": "node",
      "args": ["/Users/你的用户名/ai-background-screen/screen/bin/mcp-server.mjs"]
    }
  }
}
```

配置细节、各客户端配置文件位置、常见错误 → [`docs/MCP-配置指南.md`](docs/MCP-配置指南.md)

---

## 5 分钟跑通

装完之后照着做一遍。**每一步都有命令、预期输出、和失败时看哪里**，
每步都能独立判断过没过，不要跳步。

> 下面的命令都在**仓库根目录**（`ai-background-screen/`）执行，
> 跑 adb 的那台机器要和手机连着。

### 第 0 步：adb 连通（最常见的失败点）

```bash
adb devices
```

**预期**：至少有一行 `127.0.0.1:5555	device`。注意结尾是 `device`，
不是 `offline` / `unauthorized`。

```bash
adb -s 127.0.0.1:5555 shell id
```

**预期**：

```
uid=2000(shell) gid=2000(shell) groups=2000(shell),1004(input),... context=u:r:shell:s0
```

`uid=2000(shell)` 是这套工具的工作前提。**不要 `adb root`**，它设计成 uid 2000 就能跑。

```bash
adb -s 127.0.0.1:5555 shell getprop ro.build.version.sdk
```

**预期**：`31` 或更大（`36` 也行）。小于 31 就是 Android 11 及以下，虚拟屏这条路走不通。

| 你看到 | 意思 | 怎么办 |
|---|---|---|
| `List of devices attached` 后什么都没有 | 没连上 | `adb connect 127.0.0.1:5555`；还不行就在手机上重开无线调试再配对 |
| `127.0.0.1:5555	offline` | 连着但 adbd 没响应 | `adb disconnect 127.0.0.1:5555` → `adb connect 127.0.0.1:5555` |
| `unauthorized` | 手机没授权这台电脑 | 看手机屏幕，点「允许 USB 调试」 |
| `adb: more than one device/emulator` | 连了不止一台（比如手机 + 模拟器） | **每条命令都带 `-s 127.0.0.1:5555`**，插件自己也是这么调的 |
| `command not found: adb` | 没装 platform-tools | 装完之后用 `ADB_BIN=/绝对路径/adb` 指给插件 |

**为什么是 `127.0.0.1:5555`**：无线调试默认绑在 WiFi 网卡上，WiFi 一断就没了。
跑一次 `adb tcpip 5555` 之后固定走回环，**关 WiFi、开飞行模式都不断**。

**权限那一关也得先过**：私有虚拟屏要求 `com.android.shell` 有 `ADD_TRUSTED_DISPLAY`。
一部分机型有，Pixel 和部分 Android 15 没有。查法：

```bash
adb -s 127.0.0.1:5555 shell dumpsys package com.android.shell | grep "ADD_TRUSTED_DISPLAY: granted"
```

**预期**：出现 `ADD_TRUSTED_DISPLAY: granted=true`。
**一条都没有**，后面的步骤全部做不了，直接换机型。

### 第 1 步：建屏

```bash
node screen/bin/vdisplay.mjs start
```

**预期**（节选）：

```
虚拟屏已就绪：displayId=1396，SurfaceFlinger id=11529215049433181066
能托管 App：是 ✅
硬件合成（HWC）：未开启（3D 游戏会黑屏，轻量 App 正常）
标志位：FLAG_OWN_CONTENT_ONLY ... FLAG_OWN_FOCUS ...
这块屏用户看不见，不占主屏焦点。
✅ 推流已自动开启，悬浮窗浮起（能看到这块屏的画面）
...
  ✅ 虚拟屏存在：displayId=1396
  ✅ 推流在监听：port=38836 ...
  ✅ 画面帧可取：27425 字节 JPEG头正确
  ✅ 画面有内容：平均亮度=14 标准差=21
  ✅ 悬浮窗可见：窗口数=1，位置(59,312) 尺寸117x208
  ✅ 画面是预期的 App：前台=mCurrentFocus=Window{...com.android.calendar...}
创建完成并自检通过 ✅
```

看到最后一行 **`创建完成并自检通过 ✅`** 才算过。
同时你手机上应该出现一块小浮窗，里面是刚投上去的 App 画面。

### 第 2 步：投一个 App

先查包名（别猜）：

```bash
adb -s 127.0.0.1:5555 shell pm list packages -3
```

**预期**：一行一个 `package:com.xxx.yyy`。

> **CLI 没有 `apps` 子命令**（`vdisplay help` 里也没列，别试）。
> 上面这条 adb 命令就是 `vdisplay_apps` 工具内部做的那件事 —— 结果一模一样。
> 用 MCP / DSH 时有 `vdisplay_apps` 工具，不用自己敲 adb。

挑一个投上去：

```bash
node screen/bin/vdisplay.mjs launch com.android.calendar
```

**预期**：

```
投到虚拟屏 display=1396
方式：接管已有实例（没 force-stop，进程和状态保住）
落在虚拟屏上：是 ✅
```

`落在虚拟屏上：是 ✅` 是关键。**是 `否 ❌` 就别往下做了** —— 说明任务没落到这块屏上，
后面所有点击都会点在空气里。

> **投之前先看一眼**：如果这个 App 正开在你的主屏上，插件会**拒绝**投屏，
> 因为它投过去会杀掉你正在用的那个实例。切到别的 App 再投。

### 第 3 步：点一下

看整屏，随便点中间：

```bash
node screen/bin/vdisplay.mjs input tap --nx 0.5 --ny 0.5
```

**预期**：`已在 display=1396 注入 tap`，有时后面跟一句风控状态。

也可以读屏文字，直接按文字点（比算坐标准）：

```bash
node screen/bin/vdisplay.mjs text
```

**预期**：

```
识别到 N 行文字，耗时 1.6 秒
屏 720x1592，下面每行的 nx/ny 是归一化坐标，可直接传给 vdisplay_input。

  [0.98] (  32, 210) 120x40  nx=0.128 ny=0.145  日程
  ...
```

拿到 `nx=` `ny=` 之后：

```bash
node screen/bin/vdisplay.mjs input tap --nx 0.128 --ny 0.145
```

**`text` 报 OCR 相关的错是正常的、可以不装**：它依赖 `pip install rapidocr-onnxruntime`。
没装不影响建屏、投屏、点击、截图，只影响读文字。

### 第 4 步：看到画面

```bash
node screen/bin/vdisplay.mjs shot --out /tmp/a.jpg
```

**预期**：`截图：/tmp/a.jpg`，然后打开 `/tmp/a.jpg` 就是刚才点过之后的画面。

**别忘了抬头看手机**：主屏上那块小浮窗里的画面，应该和这张截图是同一个界面。
两边不一致就是出问题了（多半是浮窗还指着旧屏）。

### 第 5 步：关掉

```bash
node screen/bin/vdisplay.mjs stop
```

**预期**：

```
虚拟屏已销毁。
仍在后台运行：com.android.calendar              ← 正常，默认不杀 App
```

或者 `虚拟屏已销毁。`（没有残留时就这一行）。

```bash
node screen/bin/vdisplay.mjs status
```

**预期**：`虚拟屏没有在运行。`

**默认不杀投上去的 App**（里面有可能是微信、Shizuku 这类不能随便杀的）。
要一并清掉就加开关：

```bash
node screen/bin/vdisplay.mjs stop --forceStopApps
```

---

### 第一次建屏失败：自检项逐项含义

`start` 会跑这六项。**任何一项标 ❌，先对照下表**，别直接重装。

| 自检项 | 它到底在量什么 | ❌ 说明什么 | 怎么办 |
|---|---|---|---|
| `虚拟屏存在` | `running` 为真**且**拿得到 displayId | 屏根本没建起来，或者建完立刻被系统收掉 | 先看 adb 是否还连通（第 0 步重跑）；再检查 `ADD_TRUSTED_DISPLAY` 权限 |
| `推流在监听` | 取帧服务的端口在听，**且属于这块屏** | 端口被别的屏占着，或者 framesrv 没起来 | 插件会自动修一次；修完还 ❌ 就 `stop` 再 `start` |
| `画面帧可取` | 真取一帧，且帧头是合法 JPEG | 取到 0 字节，或者根本不是图 | 屏上没 App 时 ImageReader 一帧不出，所以 `start` 会自动投一个 App —— 这一步 ❌ 多半是投放也失败了，看上一项 |
| `画面有内容` | 算这一帧的平均亮度和标准差 | 纯黑 / 纯白（App 崩了，或者渲染不出来） | 全白通常是崩溃页；全黑见下面的[「虚拟屏全黑」](#虚拟屏全黑state-off) |
| `悬浮窗可见` | 主屏上那个窗口真的在，且在屏幕范围内 | 窗口没出现，或者被别的 App 藏了 | 插件自己会 `appops set ... SYSTEM_ALERT_WINDOW allow`，一般不用你手点；某些 App 带 `HIDE_NON_SYSTEM_OVERLAY` 会把浮窗强制藏掉，`start` 会自动换一个 App 重试 |
| `画面是预期的 App` | 这块屏的前台确实是刚投的那个包 | 投放失败，或者任务跑到了别的屏上 | 常见于 `singleTask` App —— `am start --display` 只会把主屏任务搬过去；也可能这个 App 主屏正开着，被拒绝了 |

自检不过时插件**会自动修一次**（只修失败的那几项），修完再来一遍复检。
所以输出里可能看到两轮 ✅/❌。**以复检那一轮为准**，而且复检里标 ⚠️ 的是「没量到」——
它既不算通过也不算失败，不要把 ⚠️ 当 ✅ 用。

### 虚拟屏全黑（state OFF）

**症状**：自检全绿或者部分绿，但 `shot` 截出一张纯黑的图，OCR 读到 0 行，浮窗里也是黑的。

**先分清三种黑屏，处理办法完全不同：**

```bash
node screen/bin/vdisplay.mjs status
```

| `status` 说 | 含义 | 怎么办 |
|---|---|---|
| `⚠️ 这块屏处于僵尸态（任务还在但没焦点、渲染纯黑）` | 手机锁过屏，虚拟屏醒了没恢复 | `stop` → `start` **重建**。重拉 App 没用 |
| `⚠️ 这块屏上已经没有 App 了` | App 被划掉或者崩了 | 重新 `launch`。这是黑屏，不是「加载中」 |
| `虚拟屏没有在运行` | 屏没了 | `start` |
| 屏在跑、App 也在，但图就是黑的 | 见下面的 state OFF | 继续看 |

**state OFF 是什么**：虚拟屏在系统里建成功了，但系统**没给它上电**。
App 渲染不出来，画面自然全黑。`start` 会直接拦下来并告诉你是谁：

```
虚拟屏创建成功但系统没给它上电（state OFF），App 渲染不出来、画面全黑。
这不是你的操作问题，也不是插件坏了：实测等 30 秒、注入触摸、screencap、keyevent 都救不回来。
怎么办：① 再调一次 vdisplay_start（多数情况第二次就好）；
② 反复出现就重启手机 —— SurfaceFlinger 跑太久（实测 20 天）会出这个状态。
```

**根因**：`start` 会先清残留（有旧虚拟屏没清干净时再建，新的那块就容易不上电）。
干净环境下实测 3/3 都是正常上电，有残留时才会踩到。
所以**最简单的一条：失败了就再跑一次 `start`**，多数第二次就正常。
反复出现再考虑重启手机。

**还有一种「全黑」不是黑屏**：银行、支付类 App 用了 `FLAG_SECURE`，
截屏 API 拿到的一律是纯黑 —— 这是系统保护，绕不过去，也不是你的问题。
用 `vdisplay_probe_secure` 可以确认。

### 跑不通时先看这里

```bash
# daemon 在不在、端口是多少
cat ~/.dsh/plugin-screen/cli-daemon.json

# daemon 的日志
tail -50 ~/.dsh/plugin-screen/vdisplayd.log

# 系统里到底有几块虚拟屏
adb -s 127.0.0.1:5555 shell dumpsys SurfaceFlinger --display-id | grep "Virtual display"
```

> **`vdisplayd.log` 有没有文件，取决于 daemon 是怎么起来的**：
> 它由 `vdisplay.mjs` 拉起时（CLI 第一次调用）输出全部写进这个文件；
> 而 DSH 引擎自己持有的那份 daemon 不经过这条路径，那就没有这个文件。
> 所以「这个文件不存在」不代表 daemon 没跑 —— 以 `cli-daemon.json` 的 `port` 为准。

`cli-daemon.json` 里没有 `port` 或者端口是 0，说明 daemon 没起来 ——
跑一次 `start` 或 `launch` 这类要写状态的命令，它会自动拉起来。
（提醒：`start` 会真的建屏，不想建屏就先用 `status` 看一眼当前状态。）

---

## 它是怎么做到的

```
┌─────────────────────────────────────────────────────────────┐
│ Node 侧（插件 / CLI / MCP，三种入口共用一套工具）              │
│                                                             │
│  tools.js ── 40 个工具 ──┐                                  │
│  vd.js   ── 虚拟屏核心 ──┤                                  │
│  pool.js ── 多屏管理    ──┤                                  │
│  stream.js ─ 推流       ──┘                                  │
└──────────────────────────┬──────────────────────────────────┘
                           │ adb (uid 2000)
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌──────────────┐  ┌─────────────────┐
│ scrcpy-server │  │  framesrv    │  │ com.dsh.overlay │
│ 建虚拟屏      │  │  取帧 + HTTP │  │ 浮窗 APK        │
│ 注入输入      │  │  MJPEG 推流  │  │ 显示画面 + 灯效 │
└───────────────┘  └──────────────┘  └─────────────────┘
```

| 组件 | 语言 | 干什么 | 关键约束 |
|---|---|---|---|
| `screen/` | JS | 插件入口、40 个工具、虚拟屏生命周期 | 跑在 proot，读设备文件必须走 adb |
| `overlay/` | Java | 浮窗、画面显示、边缘灯效 | 独立 APK，跟插件进程隔离 |
| `framesrv/` | Java | ImageReader 取帧 + HTTP 服务 | 必须由PID 存活绑定的虚拟屏驱动 |
| `web/` | JS | 浏览器控制（CDP） | 同一套思路的另一个应用 |
| `plugin/` | JS | 一条装全部的聚合插件 | 动态 import，单个失败不拖垮其它 |

**为什么是三个进程**：Android 的 VirtualDisplay 随创建它的进程死亡。
如果建屏进程是短命的 `node -e`，屏立刻就没了。所以必须有长驻进程持有它。

更细的模块划分和数据流见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 浮窗：让你看见 AI 在干什么

浮窗是**独立 APK**（`com.dsh.overlay`），用 `TYPE_APPLICATION_OVERLAY` 盖在主屏上。

### 为什么是独立 APK

浮窗要在用户主屏上画东西，但插件进程跑在 proot 里，拿不到 Android 的
`WindowManager`。所以拆出一个 APK，用 `am start` 启动，通过本地 HTTP 取画面。

### 双向隔离

- 浮窗窗口带 `FLAG_NOT_FOCUSABLE | FLAG_NOT_TOUCH_MODAL` → **不抢焦点**
- AI 的所有输入都带 `-d <displayId>` → **只打到虚拟屏**
- 中文输入走剪贴板 + 粘贴 → **不弹输入法**

### 边缘灯效：AI 状态的视觉反馈

窗口边框会给状态上色。这不是装饰，是用户判断「AI 现在什么情况」的主要通道。

| 状态 | 颜色 | 运动 | 谁触发 | 持续 |
|---|---|---|---|---|
| `working` | 青色 | 匀速环绕流动 | **自动**（AI 一操作就亮） | 不自动消 |
| `done` | 绿色 | 从左扫到右 | **自动**（操作告一段落） | 4 秒 |
| `warning` | 黄色 | 不对称慢呼吸 | AI 主动报 | 15 秒 |
| `error` | 红色 | 双拍「咚-咚」 | AI 主动报 | 20 秒 |
| `critical` | 深红 | 粗边低频闪（<3Hz） | AI 主动报 | **永不自动消** |

**颜色和运动是双编码**：红绿色盲占男性约 8%，所以每档除了颜色不同，
运动节奏也不同。闭着眼听节奏也能分出来是哪一档。

**设计原则**：`working` 和 `done` 必须全自动 —— 用户明确说过
「工作结束和工作中就不需要 AI 操作和控制边的颜色」，AI 只负责三种异常。

---

## 开发历程

**18 天，330 个提交，从零到一个能用的工具。** 完整记录见 [`docs/HISTORY.md`](docs/HISTORY.md)，
这里只留主干。

### 时间线

```
11-06  起点：给 DSH Go 做「第二块屏」，用 scrcpy 的 new_display
11-12  第一个大突破：40 个工具成型，能投屏、点击、截图
11-15  浮窗出来了：独立 APK + MJPEG，用户终于能看见
11-16  边缘灯效：从「装饰」变成「状态通道」
11-17  对抗审查发现第一批「看着对但不生效」的 bug
11-18  多屏池、租约、风控等级
11-19  文档体系建成（LIMITS / FIRST-PRINCIPLES）
11-20  发布 npm
11-21  投放交互（hub 圆圈 + 两条边条）
11-22  50 个提交：横屏、旋转、多指标记、原子写
11-23  两轮独立对抗审查，抓出 10+ 个真 bug
11-24  发现 QQ 掉线真因，开源
```

### 踩过的坑（这些才是这个项目真正的价值）

**① 「看着对但实际不生效」出现了 4 次**

同一个模式：代码写了、注释说做了、测试看起来过了，但**实际没跑**。

```
catch {} 空吞       → ReferenceError 被吞掉，整个看门狗从来没启动
变量作用域写错       → grace period 永远不生效
readFileSync 读设备路径 → proot 里 ENOENT，静默失败
限帧变量从没赋值     → 60fps 实际跑满
```

**教训**：写完必须验证「它真的执行了吗」，不能只看「代码看起来对」。

**② 一个假 bug 浪费了半天**

`mHasContent` 字段被用来判断「屏是不是黑了」。实测发现这个字段
**对所有虚拟屏永远是 false** —— 包括正在正常显示的那块。
于是看门狗每 30 秒把好屏拆一次，用户画面乱跳。

**修法**：删掉整个机制。收益（修一个未被证实的黑屏）远小于风险（拆好屏 + 换 App + 泄漏）。

**③ `am start --display` 会搬走你主屏的任务**

原以为只有 `singleTask` 的 App 会中招。逐行读 AOSP 才发现：
**standard/singleTop 一样中招** —— `am start` 无条件加 `NEW_TASK`，
然后 `findTask` 遍历所有显示器找已有任务，找到就 `reparent` 过去。

**这直接否定了一个「优化方案」**（去掉 force-stop 避免杀用户 App）。
真相是：去掉 force-stop 只是把「杀进程」换成「搬任务」，用户 App 照样消失。

**④ 一个没用的属性造成了最大的暴露面**

为了 3D 游戏在虚拟屏渲染，代码每次建屏都 `setprop debug.sf.enable_hwc_vds 1`。

实测发现两件事：
- **它没用**：SurfaceFlinger 已运行 17 天没重启，这个属性只在 SF 启动时读一次
- **它危险**：普通 App 零权限就能读到它。属性名里直接写着 `vds`（virtual displays）

**一个没用的属性，换来「这台机器在开虚拟屏」的铁证。**

---

## ⚠️ 风险（必读）

### 高风控 App 可能强制下线你的账号

**这不是假设，是实测。** 作者的 QQ 在开发期间被腾讯强制下线 4 次，其中一次
安全中心明确写：

> **风险类型：设备存在外挂或其他软件影响 QQ 正常使用**
> 平台已对风险设备进行下线处理

后续登录被拒，报 `w21`（登录无效）。

**已确证的暴露面**（全部实测，见 [`docs/QQ掉线调查.md`](docs/QQ掉线调查.md)）：

| 暴露面 | 状态 | 影响 |
|---|---|---|
| 虚拟屏对**所有 App 可见** | 已确证 | App 能枚举到一块叫 `scrcpy` 的屏，属主是 shell |
| 系统属性可被 App 读取 | 已确证 | ~~`debug.sf.enable_hwc_vds`~~ **已删除**（2026-11-24） |
| ADB over TCP 开着 | 工具固有 | `service.adb.tcp.port=5555`，App 可读 |
| 浮窗遮挡 | 未实测 | QQ 前台时触摸事件可能带 `FLAG_WINDOW_IS_OBSCURED` |

**根因未完全确定。** 我们排除了「进程被杀」（QQ 进程一直活着）、
「密码问题」「Root/Frida/Xposed」「截图检测」，但**无法确认 QQ 到底读哪个信号**。

### 建议

```
✅ 可以用：自己写的工具、购物比价、内容浏览、个人自动化
⚠️ 谨慎用：有账号价值的 App（电商、社交）
❌ 不要用：QQ / 微信 / 银行 / 支付 —— 账号风险自己承担
```

**特别是：绝对不要把 QQ/微信投到虚拟屏上。** 一旦 App 跑到那块屏上，
AOSP 的 present-UID 例外会让它照样能枚举到那块屏。

### 其他风险

- **会杀掉目标 App 的主屏实例**：`vdisplay_launch` 投屏前会 `am force-stop`。
  如果你主屏正开着那个 App，它会被杀（正在编辑的内容可能丢失）。
- **全局属性**：本项目已不修改任何系统属性，但历史上的版本会改
  `debug.sf.enable_hwc_vds`（重启设备自动恢复）。
- **`FLAG_SECURE`**：银行类 App 截不到图，会明确报错。

---

## 已知限制

25 条做不到的事，每条都写了原因和验证方式 → [`LIMITS.md`](LIMITS.md)

几条最常撞上的：

```
❌ 虚拟屏会随创建它的进程一起死 —— 用短命进程建屏，进程一退屏就没了
❌ singleTask App 投不过去 —— am start --display 只会把主屏任务搬过去
❌ 中文输入必须走剪贴板 —— adb shell input text 对中文必抛 NPE
❌ 不要用 monkey 启动 App —— 实测 4/4 次会打开系统自动旋转
```

---

## 构建

**只有要改悬浮窗或取帧服务时才需要。** 运行时不需要构建。

```bash
# ① 下载构建依赖（两个 jar 共 37MB，不在 git 里）
bash tools/fetch-sdk.sh

# ② 重编悬浮窗 APK
bash overlay/build.sh

# ③ 重编取帧 dex
bash framesrv/build.sh
```

**签名密钥**：`overlay/build/dsh-release.jks` **不会被提交**（在 `.gitignore` 里）。
首次构建会自动生成一个开发用的；发布前务必换成自己的：

```bash
export DSH_KS_PASS='你的密码'
bash overlay/build.sh
```

> ⚠️ **历史密钥已泄露**：2026-11-24 之前的版本把这个 `.jks` 提交进过 git
> （提交 `d5d46ca`），密码也明写在脚本里。已经换掉并生成新密钥，
> 但**旧密钥仍在 git 历史里**。如果你要正式分发，请改包名或重建仓库。

---

## 给接手开发的人 / AI

这个项目是按「**别人 clone 下来就能继续开发**」的标准整理的：

| 文件 | 作用 |
|---|---|
| [`docs/产品意图.md`](docs/产品意图.md) | **唯一需求依据**，改功能前先对 |
| [`AGENTS.md`](AGENTS.md) | 给 AI 编码助手的操作手册（Codex/Cursor/Claude Code 会自读） |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 模块划分、数据流、关键设计决策 |
| [`docs/HISTORY.md`](docs/HISTORY.md) | 完整开发历程、试过什么、推翻过什么 |
| [`docs/QQ掉线调查.md`](docs/QQ掉线调查.md) | 风控问题的完整证据链 |
| [`LIMITS.md`](LIMITS.md) | 25 条做不到的事 + 验证方法 |
| [`CHECKLIST.md`](CHECKLIST.md) | 当前进度和待办 |
| [`THIRD-PARTY.md`](THIRD-PARTY.md) | 第三方组件和许可 |

**给 AI 的特别提示**：`AGENTS.md` 开头就是「先读产品意图」。
项目里有很多「看着对但实际不生效」的历史坑，那份文件里列了检查清单。

---

## 参与

**欢迎 Issue 和 PR。** 但请先看 [`LIMITS.md`](LIMITS.md)，很多「做不到」是
客观限制，不是没实现。

提交 PR 前请确认：

1. 改的行为不违背 [`docs/产品意图.md`](docs/产品意图.md)
2. 新增的「自动机制」有可靠判据（这个项目被不可靠的自动机制坑过）
3. 文档同步更新（这个项目对「文档和实现不一致」零容忍）

---

## 授权

**GNU AGPL-3.0** —— 你可以自由使用、修改、分发。

**如果你要商业化**（做成闭源产品、或作为 SaaS 提供服务而不想公开修改），
需要单独取得商业授权：

👉 [开一个 Issue](https://github.com/JMINN0/ai-background-screen/issues) 说明用途

商业授权是 AGPL 的**替代方案**，不是额外限制 —— 你始终可以免费遵守 AGPL 使用。

---

## 致谢

- [scrcpy](https://github.com/Genymobile/scrcpy) —— 虚拟屏和输入注入的底层实现
- [Shizuku](https://github.com/RikkaApps/Shizuku) —— 证明了 uid 2000 能做到什么
- 以及这个项目里每一轮对抗审查 —— 它们抓出的 bug 比写的代码更有价值
