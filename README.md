# dsh-go-second-screen · 安卓第二屏

给 Android 手机加**一块用户看不见的屏**。AI 在那块屏上操作任意 App，你想看的时候点一下就能看到。

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

## 二、为什么是两个包

这个功能**分两半，跑在两个不同的地方**，必须都装：

| 包 | 类型 | 干什么 | 装在哪 |
|---|---|---|---|
| `screen/` | Cordis 插件 | 建虚拟屏、投 App、点击、截图、推流 | profile（给引擎注册工具） |
| `watch/` | dsh-go 原生插件 | 输入框上方的胶囊 + 点开的画面板 | `$DSH_HOME/dsh-go/plugins/`（画 App 界面） |

**为什么不能合成一个**：App 只认原生插件来画界面，引擎只认 Cordis 插件来注册工具。所以想实现「AI 在后台干活 + 你能看到」，必须两个都装。

---

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
print('watch :', 'local-screen-watch' in b)"
# 都要是 True

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

## 五、十个工具（`screen/` 提供）

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

---

## 七、已知问题（所以先不公开发布）

| 问题 | 现状 | 影响 |
|---|---|---|
| **打字只对部分 App 有效** | `input text` 在系统设置、标准输入框能用；京东这类自绘输入框注不进去 | 遇到注不进去的，只能靠深链带参数跳页面 |
| **剪贴板粘贴方案未完成** | 已验证 `KEYCODE_PASTE` 可行、设置页实测成功，但没做成工具 | 目前没有 `paste` 那个输入类型 |
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

没有用无障碍、没有用公开 overlay 屏（那个会压屏、吃触摸、抢输入法）。

---

## 十、许可

MIT。见 [LICENSE](LICENSE)。

商业使用、修改、再分发都允许，保留版权声明即可。作者不承担任何责任。
