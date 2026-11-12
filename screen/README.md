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

## 命令行版本（给任何 agent 用，不限于 DSH）

同一个包也带 CLI，**不需要装 DSH**。Claude Code、opencode、Codex、Cursor 只要能跑 bash 就能用。

```bash
vdisplay start                          # 建一块看不见的屏
vdisplay launch com.tencent.mm          # 把微信投上去
vdisplay shot --out /tmp/wx.jpg         # 截图
vdisplay input tap --nx 0.5 --ny 0.9    # 归一化坐标点击
vdisplay status
vdisplay stop
```

完整命令：

```
vdisplay start [--width 720] [--height 1280] [--dpi 320]
               [--orientation landscape|portrait] [--hwc auto|on|off]
vdisplay stop [--forceStopApps]
vdisplay status
vdisplay launch <包名> [Activity]
vdisplay shot [--out 路径] [--width 540] [--format jpeg|png]
vdisplay main-shot [--out 路径]
vdisplay input tap   --x 100 --y 200        或 --nx 0.5 --ny 0.5
vdisplay input swipe --x1 100 --y1 200 --x2 300 --y2 400 [--ms 400]
vdisplay input text  --text "要输入的字"
vdisplay input key   --key KEYCODE_BACK
vdisplay input paste [--text "要粘的内容"]
vdisplay daemon stop
```

加 `--json` 输出机器可读的完整结果。

### 为什么需要一个守护进程

虚拟屏跟"建它的那个进程"同生共死。CLI 每次调用都是新进程，退出就把屏带走了 —— 所以 `vdisplay shot` 这种一次性命令没法直接工作。

做法是常驻一个 `vdisplayd`，把屏握在手里，CLI 通过回环 HTTP 把命令发进去：

```
vdisplay（CLI）──HTTP──> vdisplayd（常驻，持有虚拟屏）
```

**CLI 会自动拉起守护进程**，你不用管。它闲置 10 分钟且没有虚拟屏时会自己退出，不留垃圾进程。

状态文件在 `$DSH_HOME/plugin-screen/cli-daemon.json`，里面是 `{pid, port}`。

查看守护进程：`vdisplay daemon`；让它退出：`vdisplay daemon stop`。

## 八个工具

| 工具 | 作用 |
|---|---|
| `screen_modes` | 列出四种操作方式（shell / browser / vdisplay / watch）和各自代价 |
| `vdisplay_start` | 建私有虚拟屏，返回 displayId 与能力标志。支持 `orientation: 'landscape'/'portrait'` 自动调整宽高 |
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

## 横屏/竖屏支持

`vdisplay_start` 支持 `orientation` 参数：

```javascript
// 横屏（确保宽 > 高）
await vdisplay_start({ orientation: 'landscape' });  // → 1280x720

// 竖屏（确保高 > 宽）
await vdisplay_start({ orientation: 'portrait' });   // → 720x1280

// 自定义尺寸
await vdisplay_start({ width: 1920, height: 1080 }); // 直接指定
```

**实测**：Minecraft PE 在横屏虚拟屏（1280x720）上正常渲染；虚拟屏带有 `FLAG_ROTATES_WITH_CONTENT` 标志，App 强制某个方向时虚拟屏会自动旋转匹配。

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

### 3D 游戏：开了 HWC 就能跑，不开会黑屏

**能跑，前提是让硬件合成器（HWC）参与虚拟屏合成。**

实测 REDMAGIC NX809J（Adreno 8 Gen 3 / Android 16）：

```
厂商声明     vendor.display.vds_allow_hwc = 1     ← 硬件支持
系统默认     debug.sf.enable_hwc_vds     = 0     ← 但出厂是关的
置 1 之后    王者荣耀在虚拟屏正常渲染（启动页非黑屏，3D 场景初始化成功）
```

所以插件现在会自动处理（`vdisplay_start` 的 `hwc` 参数，默认 `"auto"`）：
检测到 `vds_allow_hwc=1` 就打开 `debug.sf.enable_hwc_vds`，`vdisplay_stop` 时恢复原值。

**没有 HWC 支持的设备仍然会黑屏。** 未开启时的实测记录（Minecraft，`com.mojang.minecraftpe`）：

```
vdisplay_start → vdisplay_launch：都报成功，landedOnVd=true
进程存活，logcat 显示 LICENSED、app-foreground 正常
但 vdisplay_shot 截出来是全黑，48 秒内画面只变化 1 次
多次测试：8–15 秒间进程退出，不稳定
```

同一个游戏在真屏上：41 FPS、正常渲染 3D 画面。

> 早期版本把这条写成"虚拟屏跑不了 3D 游戏"，那是**只测了默认配置**得出的结论，已修正。

**HWC 的作用**：虚拟屏默认走 GPU 软件合成，SurfaceView 拿不到硬件叠加层，画面写不进去。
HWC 参与后，硬件直接合成到虚拟屏的 buffer，3D 内容就能出图。

**怎么判断自己的机器行不行**：

```bash
adb shell getprop vendor.display.vds_allow_hwc
# 1 = 硬件支持，插件会自动开启
# 0 或空 = 不支持，3D 游戏仍然黑屏
```

**轻量 App 从来不受影响**（微信、小红书、设置、浏览器、文档类都实测正常）。

**风险提示**：`debug.sf.enable_hwc_vds` 是**全局** SurfaceFlinger 属性，会影响整台设备的合成策略。
插件只在 `vds_allow_hwc=1` 时才动它，并在 `vdisplay_stop` 时恢复原值；
它是 `debug.*` 属性，重启设备也会自动复原，不会留下永久改动。

### 其他

- 没有 root。虚拟屏上的 App 仍然受 SELinux 约束，读不了别人的 `/data/data`。
- 虚拟屏与插件进程同生共死：引擎重启，屏自动消失，任务里的 App 也会结束。
- 每次 `start` 会多占约 0.28 核，用完记得 `vdisplay_stop`。
