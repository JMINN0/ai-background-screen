# dsh-go-plugin-screen

在手机上开一块**用户看不见的虚拟屏**，把 App 跑上去，Agent 可以截图、点击、输入，全程不打断用户。

```bash
dsh plugin --profile web add dsh-go-plugin-screen
```

## 为什么不是镜像一块屏

Android 上「造虚拟屏」有两条路，差别是生死攸关的：

| 做法 | 用户主屏上会怎样 |
|---|---|
| `settings put global overlay_display_devices` | 画一块半透明浮窗压在屏幕上、**吃触摸**、**抢输入法**、SurfaceFlinger 43.7%→68~80%、约 5.5W |
| `scrcpy-server` 的 `new_display`（本插件用的） | **完全不显示**。标志位 `FLAG_OWN_CONTENT_ONLY`（内容不跟主屏同步）+ `FLAG_OWN_FOCUS`（不抢主屏焦点）+ 没有 `FLAG_PUBLIC` |

实测：虚拟屏上跑着计算器，主屏仍在放视频，输入法焦点留在主屏（`mDisplayIdToShowIme=0`），主屏截图里没有任何浮窗。

代价：多占约 0.28 个核（基线 0.52 → 0.80 秒/秒），比 overlay 那条路便宜一个数量级。

## 前提

需要 `com.android.shell` 拥有 `ADD_TRUSTED_DISPLAY` 权限。一部分机型有（这台 nubia 有），Pixel 和部分 Android 15 没有（见 scrcpy issue #5523）。插件启动时会先检查，没有就明确报错，不会硬撑。

## 八个工具

| 工具 | 作用 |
|---|---|
| `screen_modes` | 列出四种操作方式（shell / browser / vdisplay / watch）和各自代价 |
| `vdisplay_start` | 建私有虚拟屏，返回 displayId 与能力标志 |
| `vdisplay_launch` | 把 App 投到虚拟屏（先 force-stop，避免把主屏的旧任务拉前台） |
| `vdisplay_input` | 往虚拟屏定向注入 tap / swipe / text / key / **paste** |
| `vdisplay_shot` | 截虚拟屏，返回本地路径，可直接当图片读 |
| `screen_shot_main` | 截主屏（只读），用来核对有没有影响用户 |
| `vdisplay_status` | 屏状态、上面跑着什么、主屏焦点是什么 |
| `vdisplay_stop` | 销毁 |

## 按任务选方式

1. 能用 `adb shell` 办的（装包、看日志、改设置）→ 不开屏，零打扰
2. 网页交互 → `dsh-go-plugin-web` 的 CDP，不点屏幕
3. 必须"看界面再点"的 App → `vdisplay_*`
4. 用户想看你干了什么 → `vdisplay_shot` 截图发上来

## 五个实测坑（都写进代码里了）

1. **socket 名有下划线**：`scrcpy_<scid>`。写成 `scrcpy<scid>` 会连不上，server 卡在 accept 不建屏。
2. **scid 必须在有符号 32 位内**：scrcpy 用 `Integer.parseInt(radix 16)` 解析，随机取 `0xffffffff` 会得到 `cd7bccd6` 这种超范围值，server 直接 `NumberFormatException` 退出。
3. **jar 会自杀**：scrcpy-server 启动后 `unlinkSelf` 删自己的 jar，所以要放在 `chmod 555` 的目录里，日志也要写到别处。
4. **客户端一断屏就消失**：必须常驻两个哑客户端（video + control）。
5. **`screencap -d` 要 SurfaceFlinger 的 64 位 id**，不是逻辑 displayId；传错会报 `Display Id 'NN' is not valid`，不带 `-d` 就截到主屏，看起来像"这块屏在镜像主屏"。

## 判据：这块屏到底能不能托管 App

看 `dumpsys display` 里 **`DisplayDeviceInfo`** 那一行：

```
FLAG_OWN_CONTENT_ONLY + FLAG_OWN_FOCUS  → 能托管，内容独立
缺 OWN_CONTENT_ONLY                     → 内容跟主屏（镜像）
缺 OWN_FOCUS                            → 窗口拿不到焦点
```

`mBaseDisplayInfo` / `mOverrideDisplayInfo` 那两段**永远**不带这两个标志，别拿它判断（我踩过，误判成"不能托管"）。

`canHostTasks` 也不能当判据——实测能正常投 App 的屏，它在 `mBaseDisplayInfo` 里是 `false`。

## 主屏保护

`vdisplay_launch` 做三件事：

1. 投屏前 `am force-stop` 目标 App（否则它如果在主屏后台跑着，`am start --display` 只会把旧任务拉到前台，直接顶掉用户正在看的东西）
2. 投完校验主屏焦点没变
3. 变了立刻切回原来的 App

第 2 步的判据只能读 **display 0 的 `mCurrentFocus`**：`dumpsys activity activities | grep topResumedActivity` 是全局的，虚拟屏上的 Activity 也会算进来，会误判。

## 已知限制

### ⚠️ 重度 3D 游戏画不出来（黑屏）

**实测结论：虚拟屏跑不了重度 3D 游戏。**

对 Minecraft（标准版，`com.mojang.minecraftpe`，无任何改造）实测：

```
vdisplay_start → vdisplay_launch：都报成功，landedOnVd=true
进程存活，logcat 显示 LICENSED、app-foreground 正常
但 vdisplay_shot 截出来是**全黑**，48 秒内画面只变化 1 次
多次测试：8–15 秒间进程退出，不稳定
```

而同一个游戏在真屏上：41 FPS、正常渲染 3D 画面。

**原因**：虚拟屏是软件合成，没有硬件合成层。3D 游戏的 SurfaceView 拿不到可用的硬件 buffer，
画面写不进去，所以截图全黑；进程随后因为等不到 surface 或 ANR 而退出。

改造过的 ApexM 更直接暴露了这点：它 hook 了引擎初始化，读到「窗口指针 = 0」
（真屏是 `0x7237a3ab40`），于是 `GEngine` 恒为 0，引擎从来没起来过。

**轻量 App 不受影响**（微信、小红书、设置、浏览器、文档类都实测正常）。
判断标准：**需要持续硬件 GPU 渲染到 Surface 的 App 不行**，UI 类 App 没问题。

<details>
<summary>技术细节与可能方案（展开）</summary>

**根本原因（已溯源到 Android 框架层）**

`VirtualDisplaySurface` 强制走 GLES 软件合成，不经过 HWC（Hardware Composer）。SurfaceView 依赖 HWC 硬件叠加层才能拿到 GPU 渲染的帧缓冲，软件合成路径下拿到的是空缓冲 → 黑屏。

所有 `VIRTUAL_DISPLAY_FLAG_*` 组合都是策略标记，不改变合成方式（已逐一验证）。

**验证当前设备是否支持硬件合成**

```bash
adb shell dumpsys SurfaceFlinger | grep -A 20 "Virtual displays"
# 看到 "hwc" / "hardware composer" 字样 → 支持
# 什么都没有 → 不支持，无解
```

**三条可能路径**

| 方案 | 可行性 | 成本 |
|---|---|---|
| 芯片组 HWC 支持虚拟屏（Qualcomm 旗舰部分型号） | 设备依赖 | 低（查 dumpsys 即可） |
| Root 后重定向 SurfaceFlinger layer | 技术可行 | 极高（需逆向 SF binder 接口） |
| 改用 GLSurfaceView 的游戏（Unity 导出等） | 理论可能 | 中（需找对应 App 实测） |

**scrcpy 的处理方式**：虚拟屏只用于轻量 App，重度游戏官方推荐走主屏镜像（`displayId=0`）。

</details>

### 其他

- 没有 root。虚拟屏上的 App 仍然受 SELinux 约束，读不了别人的 `/data/data`。
- 虚拟屏与插件进程同生共死：引擎重启，屏自动消失，任务里的 App 也会结束。
- 每次 `start` 会多占约 0.28 核，用完记得 `vdisplay_stop`。
