# 架构

> 这份文件讲**代码怎么组织的、数据怎么流的、关键决策为什么这么定**。
> 想改代码的人先读这份。需求层面的约束见 [`产品意图.md`](产品意图.md)。

---

## 一、全景

```
┌─────────────────────────────────────────────────────────────────────┐
│  用户主屏                                                            │
│  ┌──────────────┐        ┌────────────────────────┐                 │
│  │ 用户的 App   │        │ 浮窗 com.dsh.overlay   │                 │
│  │ (刷视频/剪片) │        │ ┌────────────────────┐ │                 │
│  └──────────────┘        │ │ ImageView (MJPEG)  │ │                 │
│                          │ │ EdgeView (灯效)     │ │                 │
│                          │ └────────────────────┘ │                 │
│                          └───────────▲────────────┘                 │
└──────────────────────────────────────┼──────────────────────────────┘
                                       │ HTTP MJPEG (127.0.0.1:388xx)
┌──────────────────────────────────────┼──────────────────────────────┐
│  虚拟屏 displayId=N                  │                              │
│  ┌──────────────────────┐   ┌────────┴────────────┐                 │
│  │ App（AI 在操作）      │   │ framesrv            │                 │
│  │ 点击/输入/渲染        │──▶│ ImageReader 取帧    │                 │
│  └──────────────────────┘   │ HTTP 服务           │                 │
│           ▲                 └─────────────────────┘                 │
│           │ 输入注入（scrcpy 控制通道 / adb input -d N）             │
└───────────┼─────────────────────────────────────────────────────────┘
            │
┌───────────┴─────────────────────────────────────────────────────────┐
│  Node 侧（三种入口共用一套工具）                                      │
│  src/tools.js (40 工具)  ←  src/vd.js (虚拟屏核心)                   │
│  src/pool.js (多屏)      ←  src/stream.js (推流)                     │
│  src/framesrv.js (取帧进程管理)  src/index.js (插件入口)              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、模块职责

| 模块 | 行数 | 职责 | 关键约束 |
|---|---:|---|---|
| `screen/src/` | 11,161 | 虚拟屏核心 + 40 个工具 | 跑在 proot，**读设备文件必须走 adb** |
| `screen/bin/` | 2,435 | CLI / daemon / MCP server | 三种入口，共用同一套工具 |
| `overlay/src/` | 3,079 | 浮窗 APK（Java） | 独立进程，只能通过 HTTP 说话 |
| `framesrv/src/` | 1,058 | 取帧服务（Java） | 由 app_process 跑，随屏生死 |
| `web/src/` | 1,733 | 浏览器控制（CDP） | 同一套思路的另一个应用 |
| `plugin/src/` | 320 | 聚合插件 | 动态 import，单个失败不拖垮其它 |

### 为什么是三个进程

```
进程 1: Node（插件/CLI）     →  持有逻辑，调工具
进程 2: scrcpy-server        →  创建并持有 VirtualDisplay
进程 3: framesrv             →  从 VirtualDisplay 的 Surface 取帧
```

**核心约束**：`VirtualDisplay` 随创建它的进程死亡。

- 用 `node -e "..."` 建屏 → 命令结束屏就没了
- 所以必须有长驻进程持有它

`framesrv` 单独一个进程，是因为它需要 `ImageReader` + 持续编码，
放在 Node 里做不到（proot 里没有 Android API）。

---

## 三、关键数据流

### 3.1 建屏

```
用户: vdisplay_start
  │
  ├─▶ vd.start()
  │     ├─ 检查已存在的屏（能复用就复用，见 3.5）
  │     ├─ 探测尺寸/DPI（按物理屏比例算）
  │     ├─ adb forward tcp:<port> localabstract:scrcpy_<scid>
  │     ├─ adb shell CLASSPATH=... app_process / com.genymobile.scrcpy.Server \
  │     │     v5.0.1 new_display=WxH display_ime_policy=hide ...
  │     ├─ 建两个 socket：video / control
  │     └─ 持久化 displayId/sfId/scid/宽高到 ~/.dsh/plugin-screen/vdisplay.json
  │
  ├─▶ streamStart()
  │     ├─ 起 framesrv（adb shell app_process）
  │     ├─ 端口 = 38820 + displayId % 20
  │     └─ 起浮窗（adb shell am start com.dsh.overlay）
  │
  └─▶ selfCheck()  ← 五项验证，任何一项不过都会明确报
```

### 3.2 取帧与推流

```
VirtualDisplay 渲染
  └─▶ framesrv 的 ImageReader.onImageAvailable()
        ├─ 有变化才编码（静止画面不编码，省电）
        ├─ MJPEG 长连接推给浮窗（变化即出帧）
        └─ /frame.jpg 单帧兜底（MJPEG 断了时用）
```

**关键优化**：`IDLE_PAUSE_MS` —— 15 秒没人取帧就停止编码。
静止画面的 CPU 开销接近 0。

### 3.3 输入注入

两条路，按优先级：

```
① scrcpy 控制通道（优先）
   - 支持连续 MOVE（60Hz 按住，游戏摇杆）
   - 支持双指 multitouch
   - 压力值/时间可调
   ⚠️ deviceId 写死 0、size 恒 0、没有 history → 可被检测

② adb shell input -d <displayId>（兜底）
   - 控制通道不可用时用
   - 会挑真实触屏的 deviceId（反而更像真人）
   - 但没有 MOVE，做不了拖拽

中文输入：两条都不行 → 必须走「写剪贴板 + KEYCODE_PASTE」
```

### 3.4 状态文件（跨进程通信）

浮窗是独立 APK，拿不到 Node 的内存。所以用文件通信：

```
/data/local/tmp/dshframe/
├── edge      状态文件：状态|颜色|强度|时间戳|ttl|端口
├── opmode    浮窗显示：风控等级|操作方式|屏号
└── edge.<port> / opmode.<port>   按端口的精确版本（多屏时用）
```

**为什么用文件而不是 socket**：
浮窗是普通 App，权限受限。`/data/local/tmp` 是 shell 和 App 都能读写的地方。

**坑**：写文件必须原子（先写 `.tmp` 再 `mv`），否则浮窗可能读到半截内容。

### 3.5 复用已有屏

新进程（引擎重启、插件热重载）怎么接上已有的屏：

```
loadPersistedState()  从 vdisplay.json 读 displayId/sfId/scid
  │
  ├─ alive()          查 dumpsys 确认屏还在
  │     ⚠️ 认不出 SF id 时**保守判活** —— 认不出不是死亡证据
  │        （判死会 SIGKILL 掉一块正在用的屏）
  │
  └─ reconnectControl()  重连 socket
        ⚠️ socket 是进程内状态，不重连的话 hold/multitouch/中文粘贴 全废
```

---

## 四、关键设计决策

### 决策 1：端口用公式，不用随机

```js
port = 38820 + (displayId % 20)
```

**为什么**：浮窗启动时只知道端口，不知道 displayId。公式让两边能对上。

**坑**：端口可能被占，要往上下一个。所以有 `screenPorts` 账本记录实际端口，
**读端口优先查账本，查不到才用公式**。

### 决策 2：边缘状态用 6 段文件格式

```
state|color|intensity|timestamp|ttlMs|port
```

**为什么带 timestamp**：浮窗可能比写入晚几秒才读到，
按剩余时长继续动画，而不是从头重播。

**为什么带 port**：多屏时每块屏的窗口要看自己的状态，不能串。

### 决策 3：`working`/`done` 全自动，不用 AI 调

**需求来源**：用户明确说过「工作结束和工作中就不需要 AI 操作和控制边的颜色」。

**实现**：`tools.js` 里 5 个操作类工具（input/launch/tap_text/tap_image/tap_color）
在入口处调 `touchWorking()` + `flushAutoEdge('working')`。

**坑**：`touchWorking` 只在插件进程调，`settleIfIdle` 只有 daemon 会调 ——
所以**插件形态下必须自己起定时器**，否则青色边框永远不消。

### 决策 4：不做「自动修复」，除非判据可靠

**这个项目被不可靠的自动机制坑过多次**，最惨的一次是 `mHasContent` 看门狗：

```
判据：mHasContent=false 连续 3 次 → 拆屏重建
现实：这个字段对所有虚拟屏永远是 false
结果：每 30 秒拆一块好屏
```

**现在的原则**（写进了产品意图）：

> 任何「自动修复」逻辑，判据必须能验证（不能靠猜）。
> 宁可少一个功能，不能多一个会自己坏的机制。

### 决策 5：包名和 npm 名统一

```
GitHub 仓库名 = npm 包名 = 插件 id = ai-background-screen
```

**为什么**：早期叫过 `offscreen-android` / `dsh-go-plugin-screen`，
三个名字到处漂移，文档和代码对不上。现在统一成一个。

---

## 五、哪些地方最容易踩坑

按「被坑次数」排序：

### ① proot 读不到设备路径

```js
// ❌ 错：proot 里没有 /data/local/tmp
readFileSync('/data/local/tmp/dshframe/opmode');

// ✅ 对：必须走 adb
await shell('cat /data/local/tmp/dshframe/opmode');
```

**这个坑踩过至少 3 次**，每次都表现为「静默不执行」。

### ② `catch {}` 会吞掉 ReferenceError

```js
try {
  someUndeclaredVar += 1;   // ReferenceError
} catch { /* ignore */ }     // 被吞掉，什么都看不出来
```

**规矩**：`catch` 里必须打日志，或者至少确认里面没有可能失败的调用。

### ③ 变量作用域

```js
function startWatch() {
  let counter = 0;   // ❌ 每次调用都是新的，计数器永远归零
}
```

**这个 bug 出现过 3 次**（不同变量）。
跨调用要保持的状态，必须放模块作用域。

### ④ `am start --display` 会搬任务

```bash
# 这个不只在目标屏新建，还会把别处的已有任务搬过来
am start --display N -n pkg/activity
```

**影响**：见 [`产品意图.md`](产品意图.md) 和 [`HISTORY.md`](HISTORY.md)。
目前的做法是投屏前 `am force-stop`，代价是会杀掉主屏实例。

### ⑤ 屏幕分辨率和 `screencap -d`

```bash
# ❌ 错：-d 要的是 SurfaceFlinger display id，不是逻辑 displayId
screencap -d 902

# ✅ 对：先从 --display-id 拿 SF id（19 位大数）
screencap -p -d 11529215048893173287
```

**这个坑导致过一次误判**：以为 PRIVATE 虚拟屏把截图弄坏了，其实是用错了参数。

---

## 六、怎么验证改动

### 语法 / 编译

```bash
# JS
node --check screen/src/vd.js

# Java
cd overlay && bash build.sh
```

### 功能自检

```bash
node screen/bin/vdisplay.mjs selfcheck
```

### 真机验证（必须做）

**这个项目的教训是「静态正确不等于真机可用」。** 改完必须：

1. 建屏 → `vdisplay.mjs status` 确认 running
2. 投 App → `dumpsys window displays | grep mCurrentFocus` 确认真的在跑
3. 截图 → 看画面是不是预期内容
4. 点一下 → 看坐标对不对
5. 关掉 → 确认没有残留进程/窗口

### 清理检查

```bash
# 这几项都必须是 0
adb shell "dumpsys SurfaceFlinger --display-id | grep -c 'Virtual display'"
adb shell "ps -A | grep -c scrcpy.Server"
adb shell "ps -A | grep -c framesrv.Main"
adb shell "dumpsys window windows | grep -cE 'u0 dsh-overlay:'"
adb shell "getprop debug.sf.enable_hwc_vds"   # 应该是 0
```

---

## 七、文件地图

```
screen/
├── src/
│   ├── vd.js          虚拟屏核心（建屏/复用/输入/截图/边缘状态）
│   ├── tools.js       40 个工具的实现
│   ├── tool-spec.js   40 个工具的契约（描述/参数）
│   ├── index.js       插件入口（注册工具）
│   ├── stream.js      推流生命周期
│   ├── framesrv.js    取帧进程管理
│   ├── pool.js        多屏池
│   ├── inject.js      输入事件构造（scrcpy 协议）
│   ├── video.js       H.264 解码
│   ├── ocr.js         OCR（可选，常驻 python）
│   ├── vision.js      模板匹配/颜色检测（可选，常驻 OpenCV）
│   └── ...
├── bin/
│   ├── vdisplay.mjs      CLI 入口
│   ├── vdisplayd.mjs     daemon
│   └── mcp-server.mjs    MCP server
└── assets/
    ├── scrcpy-server.jar   建屏 + 输入注入
    ├── framesrv.dex        取帧
    ├── injector/inject.dex 输入构造（备用）
    └── overlay/ai-overlay.apk  浮窗

overlay/src/com/dsh/overlay/
├── OverlayService.java   浮窗主逻辑（2900 行，最大的文件）
├── EdgeView.java         边缘光效（六档 + 双编码）
├── MainActivity.java     启动入口
└── ProbeActivity.java    诊断探针（打印 App 视角的显示器列表）

framesrv/src/com/dsh/framesrv/
└── Main.java             ImageReader 取帧 + HTTP MJPEG
```
