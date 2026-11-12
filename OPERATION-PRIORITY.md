# AI 操作手机的操作方式选择

这份文档给任何要用这套插件操作手机的 AI 看。**动手之前先读这一份。**

---

## 一、选择顺序

按「对用户的打扰成本」从低到高排：

| 顺序 | 方式 | 打扰 | 速度 | 适用 |
|---|---|---|---|---|
| **1** | 后台 + **命令** | 无 | 快 | `adb shell`、CDP 读 DOM/点元素 |
| **2** | 后台 + **事件注入** | 无 | 慢（约 2 秒/步） | 虚拟屏 + `vdisplay_input` |
| **3** | 前台 + **命令** | **会抢屏** | 快 | 必须在前台才能做的命令操作 |
| **4** | 前台 + **事件注入** | **会抢屏** | 慢 | 最后手段 |

**但顺序不是死的**，真正的判据是 **总打扰成本 = 抢屏次数 × 时长 × 是否切走用户正在用的东西**：

- 用户手机闲着（熄屏、放视频不用管）→ **抢一次前台的成本接近 0**，第 3 级可能比第 2 级更划算
- 用户正在用 → 第 3、4 级要慎重，30 步的注入任务（60 秒）比抢一次前台（1.5 秒）更"安静"

**先判断用户当前在干什么，再选方式。**

---

## 二、抢了前台之后怎么还原

**能还原，但有前提和风险。**

### 正确的方法

```bash
# 抢前台之前先记下来
adb shell dumpsys activity activities | grep -m1 topResumedActivity
#  → topResumedActivity=ActivityRecord{... u0 <包名>/<Activity全名> ...}

# 操作完，用这一条还原
adb shell am start -W -n <包名>/<Activity全名> --activity-no-animation
```

成功时返回：

```
Warning: Activity not started, its current task has been brought to the front
Status: ok
LaunchState: HOT
```

`brought to the front` 这句就是判据 —— 它复用了原来的 task，**滚动位置和界面状态都还在**。

### 我一开始测错的原因

最早试的是不带 `-W` 也不带 `--activity-no-animation` 的 `am start -n`，失败了，于是下了"还原不回去"的结论。**那个结论是错的。**

实测 4 轮，3 轮成功。**唯一失败的那轮，是测试期间用户自己切到了别的 App** —— 我的"还原"把用户刚切过去的界面又顶掉了。

### ⚠️ 必须先检查，否则会抢用户的操作

还原前必须判断：**用户在我们操作期间自己切走了没有？**

```
记下抢前台之前的 foreground（A）
操作完之后，如果当前 foreground 不是「我们抢的那个」（B），而是第三个 App（C）
  → 说明用户自己动了，此时【不要还原】，否则会把用户的操作顶掉
```

判据（来自 dumpsys）：

- 当前 `topResumedActivity` 是 **B（我们抢的）** → 用户没动，**可以还原**
- 当前是 **A（原来的）** → 已经回去了，不用动
- 当前是**别的 App** → 用户自己切了，**放弃还原，只报告**

### 其他还原方式的实测结果

| 方法 | 结果 |
|---|---|
| `am start -W -n ... --activity-no-animation` | ✅ **主力方式**（复用 task，状态保留） |
| `am start -n ...`（不带 -W） | ❌ 不可靠 |
| `am start -a MAIN -c LAUNCHER -p <pkg>` | ❌ 失败 |
| `am start -n ... -f 0x10000000` | ❌ 失败 |
| `input keyevent HOME` | 只能到桌面，**不是还原** |
| `am task move-to-front` | ❌ Android 16 上不存在 |
| `am stack move-task` | ❌ 抛异常 |
| `am task lock` | ⚠️ 会进锁任务模式，别用 |

### 还原也可能失败的情况

- 原 App 在操作期间被系统回收 → task 没了，还原会**新启动一个实例**（滚动位置丢失）
- 原界面是对话框/浮层而不是 Activity
- 分屏、画中画、悬浮窗 → 焦点和 task 的关系会变
- 用户期间自己切了 App（见上，**这时候不该还原**）

**还原不保证成功，失败时要如实告诉用户，不要假装还原了。**

## 三、"模拟人操作"这个说法是错的

准确叫法是 **事件注入**。

`adb shell input -d <id> tap/keyevent/swipe` 注入的事件，对目标 App 来说**是可识别的非真实输入**：

| 特征 | 真实触摸 | `input` 注入 |
|---|---|---|
| 输入设备 | 有真实 `InputDevice` | `getDeviceId()` 不对应真实设备 |
| 事件序列 | DOWN → 多个 MOVE → UP | 只有 DOWN/UP，**没有 MOVE** |
| 压力值 | 连续变化 | 恒为默认值，是平的 |
| 时间戳 | 人类节奏 | 固定步进 |
| 文字输入 | 逐字符按键 | 部分 App 可绕开键盘直接写 |

**所以第 2、4 级不适用于有风控的目标。** 微信、支付、银行这类，注入痕迹会被识别。

想验证这一点，跑 `tests/risk-sim/` 那个靶场：它会把 `isTrusted`、无按键的文字、无 mousedown 的点击逐条量出来。

---

## 四、每级的具体做法

### 第 1 级：后台 + 命令

```bash
# 装包、看日志、改设置、读状态
adb shell <任何命令>

# 网页：CDP，比截图快几十倍
web_ensure {} → web_tabs / web_read / web_click / web_fill
```

**优先用这个。** 能拿到结构化返回值，快、可靠、零打扰。

### 第 2 级：后台 + 事件注入

```bash
vdisplay_start {}                    # 建一块看不见的屏
vdisplay_launch { pkg }              # 投 App 上去（注意：会先 force-stop 目标）
vdisplay_shot {}                     # 截图确认
vdisplay_input { kind: "tap", nx, ny }
vdisplay_stop {}                     # 用完必须销毁
```

**必须注意**：

- `vdisplay_launch` **会先 force-stop 目标 App**。如果它正是用户正在用的，等于杀掉重启、丢状态
- 每步约 2 秒，30 步的任务要 60 秒
- 有 17.6% 的点击是「画面没变」的静默失败，**必须看返回值**，不要盲目重试同一坐标
- 用完必须 `vdisplay_stop`，否则虚拟屏一直占资源

### 第 3 级：前台 + 命令

```bash
# 会让 App 弹到前台（实测 am start 5/5 次都抢）
adb shell am start -a android.intent.action.MAIN \
  -c android.intent.category.LAUNCHER -p <pkg>
```

**不要用 `monkey`** —— 实测 4/4 次会把系统的自动旋转打开（见 README 铁律一点五）。

### 第 4 级：前台 + 事件注入

最后手段。用真实触摸注入操作前台界面。

---

## 五、收尾检查清单

每次任务结束前对一遍：

- [ ] `vdisplay_status` → 虚拟屏已销毁
- [ ] `debug.sf.enable_hwc_vds` → 已复位成 0
- [ ] `adb forward --list` → 没有残留
- [ ] 自动旋转设置没被动过
- [ ] 抢过前台的话：已经回到桌面，并且告诉过用户
- [ ] 关掉自己开的浏览器标签

---

## 六、一句话版本

> **能后台就别前台，能用命令就别注入。**
> **抢了前台就还不回去——所以要么不抢，要么先说清楚。**
> **注入不是"模拟人"，有风控的地方别用。**
