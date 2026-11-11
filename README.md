# dsh-go-second-screen · 安卓第二屏

让 AI **在后台操作手机，不抢你的屏幕**。

包含三个包：一块看不见的虚拟屏（跑任意 App）、一个浏览器控制器（不点屏幕直接操作网页）、以及一个让你能偷看 AI 干了什么的胶囊。

[English](README.en.md) ｜ 中文

> **状态：实验性（v0.1.0）**。核心链路已实测跑通，但还有已知问题未解决，见文末「已知问题」。**暂不推荐普通用户使用。**

---

## 一、这是什么

普通做法是"截图 → 看画面 → 算坐标 → 点屏幕"，慢、容易点偏、还会打断你正在用的应用。

这个项目走另一条路：**造一块不在物理屏幕上显示的虚拟屏**，把 App 投上去，AI 在那上面操作。

| 对比 | 你在看的屏 | 这块屏 |
|---|---|---|
| 用户能看见吗 | 能 | **看不见**（不画在物理屏上） |
| 抢焦点吗 | 是 | **不抢**（`FLAG_OWN_FOCUS`） |
| 抢输入法吗 | 是 | **不抢**（焦点永远留在你的主屏） |
| 能操作哪些 App | — | 任意 App（微信、小红书、游戏、设置…） |
| 你想看的时候 | — | 点胶囊，能看到实时画面 |

实测：AI 在虚拟屏上刷小红书、读评论、翻页，你的主屏一直是你自己的东西，输入法一次都没被抢。

---

## 二、三个包，各管一段

这个仓库有三个包，**分工按"跑在哪个子系统里"划**：

| 包 | 类型 | 干什么 | 装在哪 |
|---|---|---|---|
| `screen/` | Cordis 插件 | 建看不见的虚拟屏、投 App、点击、截图、推流 | profile（给引擎注册工具） |
| `web/` | Cordis 插件 | 用 CDP 操作浏览器：读 DOM、点元素、填表单、截图 | profile（同上） |
| `watch/` | dsh-go 原生插件 | 输入框上方的胶囊 + 点开的画面板 | `$DSH_HOME/dsh-go/plugins/`（画 App 界面） |

**共同点**：三个都做到"AI 在后台干活，不打断你在用的东西"。

- `screen/` 解决**原生 App**（微信、小红书、游戏）——它们没有调试接口，只能投到虚拟屏上操作
- `web/` 解决**网页**——浏览器自带 CDP，直接读 DOM 比截图猜坐标准得多
- `watch/` 是**你的窗口**——想看一眼 AI 在干什么时点它

**为什么 `web/` 放在这个仓库而不是单开一个**：浏览器自动化是很常见的需求，单独开仓库只是多一个地址，没有独立价值。它跟 `screen/` 是同一类东西（都是"后台操作、不抢屏"），放一起更好找。

**为什么 `watch/` 不能和 `screen/` 合并**：App 只认原生插件来画界面，引擎只认 Cordis 插件来注册工具。想实现「AI 在后台干活 + 你能看到」，必须两个都装。

**`screen/` 和 `web/` 选哪个**：

| 要操作的东西 | 用哪个 |
|---|---|
| 网页（登录、填表、点按钮、读内容） | `web/`，快且准 |
| 原生 App（微信、抖音、小红书、游戏） | `screen/`，投到虚拟屏 |
| 只是抓网页文字（不需要点） | **都不用**，DSH 自带的 `web_fetch` 就够 |

> DSH 自带的 `web_search` / `web_fetch` 只能抓文字，**不能点按钮、不能填表单、不能登录**。要交互才需要 `web/`。

## 三、安装

### 前置条件

1. **adb 可用**（硬依赖，`screen` 所有操作都靠它）
   ```bash
   apt-get update && apt-get install -y android-tools-adb
   adb connect 127.0.0.1:5555
   adb -s 127.0.0.1:5555 shell echo ok   # 返回 ok 才算通
   ```
   连不上就看 [dsh-go-plugin-adb](https://github.com/JMINN0/dsh-go-plugin-adb) 的配对流程。

2. **手机要有 `ADD_TRUSTED_DISPLAY` 权限**
   ```bash
   adb shell dumpsys package com.android.shell | grep "ADD_TRUSTED_DISPLAY: granted=true"
   ```
   有输出才能用。一部分机型没有（Pixel 和部分 Android 15 默认没有），没有就装不了。

3. **`ffmpeg`**（推流时转码用）
   ```bash
   apt-get update && apt-get install -y ffmpeg
   ```

### 装 `screen/`（Cordis 那块）

```bash
git clone https://github.com/JMINN0/dsh-go-second-screen.git
cd dsh-go-second-screen
dsh plugin --profile web add ./screen
```

### 装 `web/`（浏览器控制，可选）

```bash
dsh plugin --profile web add ./web
```

**只在需要操作网页时才装**。它需要浏览器已经在运行（插件不会主动拉起浏览器，避免打断你）。

### 装 `watch/`（原生那块）

```bash
# 必须先放到 dsh-go 插件目录，否则胶囊不会出现（放错不会报错，只是没效果）
mkdir -p "$HOME/.dsh/dsh-go/plugins"
cp -r "$(pwd)/watch" "$HOME/.dsh/dsh-go/plugins/local-screen-watch"
dsh plugin --profile web add ~/.dsh/dsh-go/plugins/local-screen-watch
```

### 装完必须重启引擎

App 内：**设置 → 引擎 → 重启引擎**。

### 验证

```bash
# ① 两个包都进 profile 了吗
python3 -c "
import json
d=json.load(open('$HOME/.dsh/profiles/web/package.json'))
b=d['dsh']['profile']['bundles']
print('screen:', 'dsh-go-plugin-screen' in b)
print('web   :', 'dsh-go-plugin-web' in b)   # 只在装了 web 时检查
print('watch :', 'local-screen-watch' in b)"

# ② 引擎有没有加载错误
grep -i "apply failed" "$HOME/.dsh/dsh-app/diagnostics.md" | grep -E "screen|watch" || echo "没有加载错误 ✅"
```

然后在对话里说一句「用 vdisplay_status 看看虚拟屏状态」，能返回状态就是装好了。
输入框上方应该能看到一条「AI 未操作」的胶囊。

---

## 四、给 AI 的安装提示（如果你是被要求安装本插件的 AI，读这段）

这个仓库里有**两个包，初始位置不对也不要紧，照下面判断**：

| 包 | 特征 | 正确位置 |
|---|---|---|
| `screen/` | `package.json` 里有 `dsh.bundle.patch` | 用 `dsh plugin --profile web add ./screen` |
| `watch/` | `package.json` 里有 `dshGo` 字段 | **必须**放到 `$DSH_HOME/dsh-go/plugins/<名字>/`，再 `dsh plugin add` 那个路径 |

**怎么区分**：看 `package.json` 里有没有 `dshGo` 字段。
- 有 `dshGo` → 原生插件，画界面的，**不能直接 `add` 仓库里的目录**，要先复制到 `dsh-go/plugins/`
- 只有 `dsh` → Cordis 插件，直接 `add` 目录

**装错的表现**：不报错，但胶囊不出现（原生插件没加载）或者 AI 说没有 `vdisplay_*` 工具（Cordis 插件没加载）。

---

## 五、工具清单

| 工具 | 作用 |
|---|---|
| `screen_modes` | 列出可用的操作方式与代价，帮你选 |
| `vdisplay_start` | 建一块私有虚拟屏 |
| `vdisplay_launch` | 把 App 投到虚拟屏（先 force-stop，避免顶掉主屏旧任务） |
| `vdisplay_input` | 往虚拟屏注入 tap / swipe / text / key |
| `vdisplay_shot` | 截虚拟屏，返回本地图片路径 |
| `screen_shot_main` | 截主屏（只读），核对有没有影响用户 |
| `vdisplay_status` | 查屏状态、上面跑着什么、主屏焦点 |
| `vdisplay_stop` | 销毁虚拟屏 |
| `vdisplay_stream` | 把画面以 2fps JPEG 推给胶囊（约 0.30 核） |
| `vdisplay_stream_stop` | 停止推流 |

### `web/` 提供八个工具（浏览器控制）

| 工具 | 作用 |
|---|---|
| `web_browser` | 查看或切换目标浏览器（Edge / Chrome / 红魔浏览器，默认 Edge） |
| `web_ensure` | 检查并修复 CDP 通道；默认**不**启动浏览器 |
| `web_open` | 打开标签页，返回 `targetId` |
| `web_read` | 读页面文字（读 DOM，不花图片 token） |
| `web_click` | 按 CSS 选择器或可见文字点击 |
| `web_fill` | 填表单（走 `Input.insertText`，React/Vue 能收到） |
| `web_shot` | 截图 |
| `web_close` | 只关自己开的标签 |

> 浏览器必须已经在跑。插件**不会**主动启动它——你可能刚把它关掉，擅自唤醒会打断你，还会覆盖浏览器的会话恢复记录（这个事故真发生过）。

---

## 六、典型用法

```
1. vdisplay_start {}                                  → displayId=81
2. vdisplay_launch { pkg: "com.xingin.xhs", activity: ".index.v2.IndexActivityV2" }
3. vdisplay_shot {}                                   → /tmp/vd-xxx.png，用 read_image 打开看
4. vdisplay_input { kind: "tap", x: 360, y: 1042 }
5. vdisplay_input { kind: "key", key: "KEYCODE_BACK" }
6. vdisplay_stop {}
```

**要看实时画面**：`vdisplay_stream { fps: 2, width: 360 }`，然后点输入框上方的胶囊。

**操作网页**（用 `web/`，比虚拟屏快得多）：

```
1. web_ensure {}                                          → 通道就绪
2. web_open { url: "https://example.com" }                → targetId: "ABC123"
3. web_read { targetId: "ABC123" }                        → 页面文字
4. web_click { targetId: "ABC123", text: "登录" }
5. web_fill { targetId: "ABC123", selector: "#user", text: "xxx" }
6. web_close {}
```

---

## 6.5、使用建议

**⚠️ 操作期间请保持屏幕常亮**

虚拟屏依赖设备保持唤醒状态。如果设备息屏：
- 虚拟屏会断电，displayId 失效
- 息屏后需要人脸/指纹/密码解锁，AI 无法自动恢复

**如何避免**：正常的点击/滑动/输入操作会自动重置息屏计时器。只要任务在持续执行，设备不会自动息屏。

---

## 七、已知问题（所以先不公开发布）

| 问题 | 现状 | 影响 |
|---|---|---|
| **打字只对部分 App 有效** | `input text` 在系统设置、标准输入框能用；京东这类自绘输入框注不进去 | 遇到注不进去的，可用 `paste` 输入类型（走剪贴板） |
| **深链不可靠** | 小红书那次 2 次全被系统拦（`SecurityException: not exported`） | 深链只能碰运气 |
| **每次命令行调用会重建屏** | 每个 node 进程自己建屏，进程退出屏就消失 | 只能用长驻进程或插件内调用 |
| **截屏读界面较慢** | 一轮"截图→看图→点击"中位 19.4 秒 | 不适合高频操作 |
| **每张截图约 1.1k tokens** | 且永久留在上下文 | 长任务会吃满上下文 |
| **坐标点击会静默失败** | 已加操作后校验（画面没变返回 `ok:false`），但仍有 17.6% 白点率 | 需要看返回值判断 |
| **只在一台机器验证** | nubia NX809J / Android 16 | 其他机型未测 |

---

## 八、已知限制（不是 bug）

| 限制 | 原因 |
|---|---|
| 需要 `ADD_TRUSTED_DISPLAY` 权限 | 部分机型没有，起不了虚拟屏 |
| 虚拟屏上软键盘不弹 | `display_ime_policy=hide`，为的是不抢你的输入法 |
| 虚拟屏随进程消亡 | 设计如此，不会留垃圾 |
| 读不到别人 App 的 `/data/data` | SELinux 限制（没有 root） |
| 虚拟屏空转约 +0.28 核 | 推流 2fps 再加约 0.02 核 |
| `web/` 浏览器在后台时建不了新标签 | Android 系统限制；插件不会偷偷开窗，会返回 `needsUserConfirm` |
| `web/` 两个 Chromium 浏览器不能同时用 | 它们抢同一个 `chrome_devtools_remote` socket |

---

## 九、原理

```
screen/（Cordis 插件，跑在引擎里）
  ↓ 调 scrcpy-server 的 new_display
DisplayManager.createNewVirtualDisplay(OWN_CONTENT_ONLY | OWN_FOCUS | TRUSTED)
  ↓ 不画在物理屏上、不抢焦点
虚拟屏（displayId 动态）
  ↓ am start --display 投 App，input -d 注入，screencap -d 截图
目标 App

watch/（原生插件，跑在 App 里）
  ← 每 500ms 从 screen 的本地回环 HTTP 取一帧
  → 画在输入框上方胶囊 / 面板里
```

`web/` 是另一条独立链路：

```
web/（Cordis 插件）
  ↓ adb forward tcp:<随机端口> localabstract:chrome_devtools_remote
浏览器进程的 DevTools socket
  ↓ 说 CDP 协议（WebSocket）
读写 DOM、点击、填表、截图 —— 完全不碰屏幕
```

`screen/` 没有用无障碍、也没有用公开 overlay 屏（那个会压屏、吃触摸、抢输入法）。

---

## 十、许可

MIT。见 [LICENSE](LICENSE)。

商业使用、修改、再分发都允许，保留版权声明即可。作者不承担任何责任。
