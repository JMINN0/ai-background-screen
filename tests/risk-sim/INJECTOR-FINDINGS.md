# app_process 注入器的前置验证

> 目标：补齐 scrcpy 控制通道修不掉的三块破绽（`deviceId`、接触面积、`getHistorySize`）。
> 这些是**从 framework.jar 反编译出来的硬证据**，不是文档推断。
> 验证日期：2026-11-16。设备：红魔 NX809J / Android 16 / API 36。

## 一、shell 有没有注入权限

**✅ 有，已授予。**

```
dumpsys package com.android.shell:
  android.permission.INJECT_EVENTS: granted=true
```

这是**按 uid 检查**的，不是按进程身份。所以 `app_process` 起的进程和 `adb shell input`
的检查结果完全一样 —— 都是 uid 2000。这也是 scrcpy 能注入的真正原因，
跟"它用 app_process"或 SELinux 域无关。

## 二、`injectInputEvent` 的签名（**关键，有个陷阱**）

从 `services.jar` → `classes2.dex` → `android/hardware/input/InputManagerGlobal.smali` 反编译：

```smali
.method public blacklist injectInputEvent(Landroid/view/InputEvent;I)Z       # (event, mode)
.method public blacklist injectInputEvent(Landroid/view/InputEvent;II)Z      # (event, mode, targetUid)
```

3 参版本的参数名是明确的：

```smali
.param p1, "event"      # Landroid/view/InputEvent;
.param p2, "mode"       # I
.param p3, "targetUid"  # I            ← 不是 displayId！
invoke-interface {v0, p1, p2, p3}, Landroid/hardware/input/IInputManager;->injectInputEventToTarget(...)
```

**⚠️ 陷阱**：如果按直觉把 displayId 当第 3 个参数传进去，会变成"注入到某个 uid 的窗口"，
**不抛异常、静默失败或点到主屏**。这个坑必须先排掉。

## 三、displayId 怎么传（正确路径）

`InputEvent` 自己带 displayId：

```smali
.method public abstract blacklist getDisplayId()I
.method public abstract blacklist setDisplayId(I)V
```

而 `MotionEvent.obtain` 有个**公开（whitelist）**的 14 参重载直接吃 displayId：

```smali
.method public static whitelist obtain(JJIFFFFIFFIIII)Landroid/view/MotionEvent;
  downTime(J) eventTime(J) action(I) x(F) y(F) pressure(F) size(F)
  metaState(I) xPrecision(F) yPrecision(F) deviceId(I) edgeFlags(I) source(I) displayId(I)
```

**`whitelist` = 正式公开 API**，不需要反射、不需要黑名单绕过。

所以正确做法是：

```
MotionEvent.obtain(14 参，带 deviceId + source + displayId)   ← 全公开
  → injectInputEvent(event, mode) 2 参                        ← displayId 由事件自带
```

**完全不需要碰那个 targetUid 的 3 参版本。**

## 四、真实触摸屏（deviceId 的来源）

```
Device 7: synaptics_tcm_touch
  SysfsRootPath: /sys/devices/platform/soc/.../spi19.0   ← 真实硬件 SPI 总线
  Sources: KEYBOARD | TOUCHSCREEN
  IsExternal: false                                       ← 非虚拟设备
  PRESSURE:    0.000 - 1.000
  SIZE:        0.000 - 1.000
  TOUCH_MAJOR: 0.000 - 2950.254
```

这是真实面板，可以借它的 deviceId，压力和面积也有真实范围可以照抄分布。

挑设备的逻辑（照抄 AOSP `input` 但加虚拟过滤）：

```java
for (int id : InputDevice.getDeviceIds()) {
    InputDevice d = InputDevice.getDevice(id);
    if (d == null) continue;
    if ((d.getSources() & 0x1002) != 0x1002) continue;   // 必须含 SOURCE_TOUCHSCREEN
    if (!d.isVirtual()) { pick(id); break; }              // isVirtual() 是 @hide，包 try
}
```

## 五、这个方法补不了什么（诚实记录）

即使全部做到，还剩两条：

1. **`InputDevice.getAssociatedDisplayId()` 对不上** —— 真触摸屏关联的是 display 0（主屏），
   而事件发生在虚拟屏上。App 可以反射这个 @hide 方法比对，发现不一致。
2. **历史采样条数本身是新指纹** —— `LIMITS.md` 的 E-01 已经说过：任何恒定生成过程
   都会被样本量识别。所以历史点必须**按真机分布随机**，不能固定填 3 条。

## 六、编译环境的现实

这台机器上：

- **没有 javac**（`/usr/lib/jvm/java-21-openjdk-arm64/` 只有 JRE，`bin/javac` 不存在）
- **没有 d8/dx**（`/usr/lib/android-sdk/build-tools/debian/` 只有 aapt/aapt2/apksigner/zipalign）
- **有 smali/baksmali**（`/usr/share/java/smali-2.5.2.git2771eae.jar`）

**所以手写 smali 不是退路，是唯一能产出 dex 的路。**

要回到 Java→dex 需要 `apt-get install openjdk-21-jdk-headless` + 从 Maven 取 `r8.jar`，
但那条路要联网，而且没必要。

## 七、还没验的

| 项 | 状态 |
|---|---|
| `MotionEvent.addBatch` 造的历史点真的能到 App 侧 | 【未实测】需要真跑一次读 `getHistorySize()` |
| 注入到虚拟屏的事件真的落到虚拟屏 | 【未实测】需要真跑 |
| 20 参 `obtain`（带 flags）是否也需要 | 【不知道】14 参够用就不必 |
| `--nice-name` 起的进程名会不会被 App 枚举到 | 【未实测】 |
