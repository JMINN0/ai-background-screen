# app_process 注入器：做到了哪一步

> 目标：补齐 scrcpy 控制通道修不掉的三块破绽 —— `getDeviceId()`、`PointerCoords.size`、`getHistorySize()`。
>
> 状态：**事件造对了，注入被系统拒绝。半成品，不是死路。**
> 记录日期：2026-11-16。设备：红魔 NX809J / Android 16 / API 36。

## 一、已经打通的（都是实测）

| 项 | 结果 | 怎么验的 |
|---|---|---|
| shell 有 `INJECT_EVENTS` | ✅ `granted=true` | `dumpsys package com.android.shell` |
| 找到真实触摸屏 | ✅ `deviceId=7`、`synaptics_tcm_touch`、SPI 总线、非虚拟 | 注入器 `--list` 打出 8 个设备 |
| 造出带自定义字段的 MotionEvent | ✅ | 注入器打印 `EV act=0 dev=7 disp=231 src=0x1002 size=0.08` |
| **接触面积能自填** | ✅ `size=0.08`（不是 0 也不是 1） | 同上，读回 `getSize(0)` |
| **displayId 能指定** | ✅ `disp=231`（虚拟屏） | 同上，读回 `getDisplayId()` |
| **deviceId 能借真实设备** | ✅ `dev=7` | 同上，读回 `getDeviceId()` |

**这三块破绽在「事件层面」已经补上了。** 剩下的是把事件送进系统。

## 二、卡在哪

```
ONESHOT down done
ONESHOT done ok=false
```

`InputManagerGlobal.injectInputEvent(event, mode)` 返回 `false`（注入被拒），而且
**不抛异常**，所以看不到原因。

**关键对照实验（说明不是平台限制）**：

```bash
adb shell input -d 231 tap 188 1343     # 同一条屏、同一个坐标
```

**这个成功了**（屏幕从设置首页切到「显示」页）。所以：

- 注入到虚拟屏 231 **是可行的**
- 我的事件字段**是对的**（设备、屏、坐标、面积、source 都验过）
- 问题在**调用注入接口的方式**，不在能力

## 三、试过但没成功的（省得重复踩）

| 尝试 | 结果 |
|---|---|
| `InputManagerGlobal.injectInputEvent(ev, 0)` 两参，mode=ASYNC | false |
| 同上，mode=WAIT_FOR_FINISH(1) | false |
| 三参 `injectInputEvent(ev, 0, -1)` 显式 targetUid=-1 | 方法解析就失败（没打出 ENTRY） |
| 反射 `InputEvent.setDisplayId(231)` 显式补设 | 事件字段确实变成 231，但仍 false |
| deviceId 改成 0（scrcpy 用的值） | 仍 false |
| `InputManager.getInstance()` 旧路径 | 解析失败（Android 16 上可能已不可用） |

## 四、下一步该查什么（按可能性排）

1. **看 scrcpy 自己的注入代码到底怎么调的** —— 它在这台机器上是能注入的
   （控制通道点按实测生效）。读 `com/genymobile/scrcpy/Device.java` 反编译结果，
   照抄它的 `injectEvent` 路径，包括它拿 `InputManager` 实例的方式。
2. **`injectInputEvent` 返回 false 的具体 code** —— native 侧返回
   -1(DENIED) / -2(FAILED) / -3(TIMED_OUT)，Java 层压成 boolean 了。
   可以考虑反射调 `IInputManager` 的 binder 接口直接看 int 返回值。
3. **进程上下文**：`app_process` 从 `adb shell` 起，和 scrcpy-server 的启动参数
   是否等价（`--nice-name`、`--zygote`？）。scrcpy 用的完整命令行要对照。
4. **事件本身是否缺字段**：`MotionEvent` 可能还需要 `edgeFlags`/`flags` 之外的
   东西，或者需要 `event.setSource()` 之外再设 `toolType`。

## 五、副产品（这些是确定有用的）

**① 一个能读真实输入设备清单的工具**

```bash
CLASSPATH=/data/local/tmp/dsh-inject/inject.dex \
  app_process /system/bin com.dsh.inject.Injector --list
```

在 shell 下列出所有 `InputDevice` 的 id / sources / 名字。实测这台机器有 8 个设备，
真触摸屏是 `id=7 src=0x1103 name=synaptics_tcm_touch`。

**② 记下来的 smali 坑（我在这上面花了很久）**

| 坑 | 症状 | 正解 |
|---|---|---|
| `const/4` 只能寻址 v0-v15 | 报「Invalid register: v16」 | 高寄存器用 `const/16` 或 `const/high16` |
| `if-ltz` = **小于零**就跳 | 逻辑全反 | `if-gez` 才是「大于等于零」 |
| `if-eq` / `if-ne` 容易写反 | 条件永远不成立 | 每条都写注释说明「什么情况才跳」 |
| catch 标签名必须和 `.catch` 里引用一致 | `writeDebugAndCodeItems` 异常 | 检查 `{:a .. :b} :c` 三个标签都存在 |
| `.locals`/`.registers` 超过 16 时 | 我一度以为是工具限制 | 实际是 `const/4` 的问题，不是寄存器数 |
| **`app_process` 读不到 stdin** | `readLine()` 直接返回 null | 改成一次性模式（命令走 argv），别指望 stdin |

**最后这条很重要**：连最小复现类都读不到 stdin，`adb shell` 的 PTY 会把输入吃掉，
`shell -T` 和设备端文件重定向都不行。所以注入器必须做成**一次性进程**（每次注入起一个），
或者用 socket/文件队列通信。

## 六、诚实的判断

- **不是平台做不到**（`input -d` 能注入到虚拟屏，证明了）
- **不是事件造错**（字段全对，读回来验证过）
- **是调用细节没对上**，最可能就差在「怎么拿 InputManager 实例 / 用哪个重载」

按剩下两条线索（读 scrcpy 的实现、看 native 返回码），**再花半天应该能通**。
在那之前，`vd.js` 继续走 scrcpy 控制通道，不动。
