# QQ 掉线与虚拟屏：调查记录

> 创建于 2026-11-24 00:47。这份文件是**唯一的事实记录**，不要凭记忆判断。
> 每次有新证据就追加，不要覆盖旧结论；推翻旧结论时写清楚「曾经信什么、被什么推翻」。

---

## 一、现象（用户观察，原始记录）

### 用户原话

> 「QQ 完全是在后台的，有时候放在前台发完话放后台一分钟左右被登出了」
>
> 「但大概率都是在你操作手机的时候出现，而且都是在解决悬浮窗代码的情况下」
>
> 「但是悬浮窗也是工作了很久也没出现过，可能是自从上个星期六加装了什么功能开始的」
>
> 「我给你发那个消息的时候我看到你在执行什么命令来着……应该是执行这两个图片那会附近的指令导致的」
>
> 「我截图里面你在运行完什么东西后，开始写入也就是这段时间内发生的，**并且写入还失败了要重试**」
>
> 「之前有几次也是**写入啥的时候太长了一直写然后 QQ 就被登出了**，过了没多久就显示超时了
> 我不确定这是不是巧合也不确定是不是每次都这样」

### QQ 给出的官方提示（三种，都出现过）

**① 下线通知**
```
你的账号当前登录已失效，请重新登录。
```

**② 安全提醒（最严重的一次）**
```
已登录设备风险提醒
你登录过的设备存在安全隐患，为了你的账号及资产安全，
平台已对风险设备进行下线处理。
建议你重新安装并使用官方版本 QQ……

风险类型：设备存在外挂或其他软件影响 QQ 正常使用
设备名称：NX809J_V1A
登录应用：手机QQ-Android
最后登录：2026-11-22 12:31:42
```

**③ 登录被拒**
```
安全提醒
身份验证失败，请你重新登录。(w21)
```
`w21` = 「登录无效」（腾讯[预警类型文档](https://apidoc.dedaolm.com/321212411e0)里的 warnType）

### 已排除的

- ❌ **不是进程被杀**：QQ 主进程活 1h56m、MSF 活 1d12h 未重启；logcat 无 `Force stopping com.tencent.mobileqq`
- ❌ **不是密码导致**：用户 11-22 改密，但问题 11-21 就开始了
- ❌ **不是 Root/Frida/Xposed**：设备上没有（`pm list packages` 查过）
- ❌ **不是系统优化杀后台**：logcat 明确 `Don't kill pkg com.tencent.mobileqq for the reason of : !AUTO_OPTIMIZE`
- ❌ **不是截图**：Android 14/15 官方明确截图检测（含 ADB）不触发；有实测「Scrcpy is not recognized as a screen recorder」

### 时间线（2026-11-23 夜 → 24 日凌晨）

```
18:5x  拼多多测试（虚拟屏 + 中文粘贴）      → 之后 QQ 掉线（用户反馈）
20:4x  修浮窗代码、反复 install -r          → QQ 掉线
21:xx  建屏、泄漏点排查                      → QQ 掉线
23:20  建虚拟屏 897 做可见性测试             → 23:29 用户撞到 w21（登录被拒）
23:2x  QQ 恢复登录
00:27  启动完整一套（虚拟屏905+浮窗+推流+HWC=1）
00:39  QQ 再次被下线                        ← 这次时间点最干净
00:44  实测证明 HWC 属性 App 可读
```

---

## 二、已确证的暴露面（全部实测）

### 暴露面 1：虚拟屏对所有 App 可见（原版 scrcpy jar）

```
DisplayDeviceInfo{"scrcpy": uniqueId="virtual:com.android.shell,2000,scrcpy,891", 720x1592}
DisplayInfo{... 没有 FLAG_PRIVATE}
```

**探针实测**（`com.dsh.overlay`，普通 App uid 10895）：

```
原版 jar：  getDisplays() count=2
           display id=0    name=内置屏幕 type=1
           display id=903  name=scrcpy   type=5 flags=20360 owner=com.android.shell 720x1592
```

**→ App 零权限就能看到「一块叫 scrcpy、属主是 shell 的虚拟屏」。**

### 暴露面 2：`debug.sf.enable_hwc_vds` 属性 App 可读（⚠ 最危险）

**探针实测**（同一个普通 App，反射 `SystemProperties.get`）：

```
属性 = 0 时：  prop debug.sf.enable_hwc_vds = 0
属性 = 1 时：  prop debug.sf.enable_hwc_vds = 1
```

**而且这个属性完全没用：**

```
SurfaceFlinger 已运行 17 天 12 小时（从未重启）
AOSP：SF 在构造函数里读一次这个属性
实测置 1 后 dumpsys SurfaceFlinger 相关状态变化 = 0 处
```

**一个没用的属性，属性名里直接写着 vds（virtual displays），任何 App 读一眼就知道机器在开虚拟屏。**

### 暴露面 3：ADB 相关属性 App 可读（工具固有，难消除）

```
service.adb.tcp.port = 5555     ← ADB over TCP，工具依赖它
init.svc.adbd        = running
```

这是工具运行的前提，**无法消除**，只能承认。

### 暴露面 4：浮窗窗口（SYSTEM_ALERT_WINDOW）

`com.dsh.overlay` 带 `SYSTEM_ALERT_WINDOW`，窗口 flags = `FLAG_NOT_FOCUSABLE | FLAG_NOT_TOUCH_MODAL`（**可触摸**）。
QQ 在前台时，落在外面的触摸事件会带 `FLAG_WINDOW_IS_OBSCURED`。**未实测**。

---

## 三、尝试过的修复与结果

### ✅ 成功：PRIVATE 虚拟屏（验证充分，但未做默认）

**改法**：反编译 `scrcpy-server.jar` 的 `classes.dex`，改 `NewDisplayCapture.smali` 两处 flags：

```
1231: const/16 v1, 0x1cb  →  0x1da    （默认分支：去 PUBLIC 0x1，加 PRIVATE 0x10）
1236: const/16 v1, 0xcb   →  0xda     （非 destroyContent 分支，同上）
1284: const-string v2, "scrcpy" → "内置屏幕"
```

**关键**：必须改 `0x1cb`（默认走这条），只改 `0xcb` 无效。

**验证结果（干净对照实验，同一设备同一 App）**：

| | getDisplays() | 内容 |
|---|---|---|
| 原版 jar | **count=2** | id=0 内置屏幕 + id=903 scrcpy(owner=shell) |
| PRIVATE jar | **count=1** | 只有 id=0 |

**功能验证（PRIVATE 版下）**：
```
✅ am start --display 902 -n com.android.settings    窗口起来了
✅ am start --display 904 -n tv.danmaku.bili         B站完整渲染（截图 967KB 确认有画面）
✅ screencap -p -d <SF id>                            EXIT=0
✅ input -d 902 tap                                   EXIT=0
✅ DisplayInfo 出现 FLAG_PRIVATE
```

**注意坑**：`screencap -d` 要的是 **SurfaceFlinger display id**（19 位大数，来自 `dumpsys SurfaceFlinger --display-id`），
**不是逻辑 displayId**。用错会报「Display Id is not valid」——我因此误判过一次「PRIVATE 弄坏了功能」。

**代价/风险（未长期验证）**：
- 只有属主 + 「已在这块屏上的 App」能访问（AOSP `Display.hasAccess`）
- 跨 UID 窗口可能被拒（权限对话框/输入法）
- 私有非镜像屏会变成 `FLAG_NEVER_BLANK`（不熄屏）
- 在私有屏上运行的 App 自己仍能枚举到它（present-UID 例外）

**当前状态**：`tools/experimental/scrcpy-server-private.jar` 存档；**assets 里已恢复原版**（长期未验证，不当默认发布）。

### ❌ 失败：「PRIVATE 能隐藏但不能渲染」

**曾被误判为失败**，原因是我用错了 `screencap -d` 的参数。**已在同一个 jar 上推翻**，功能全部正常。

### ❌ 不可行：去掉 ↑force-stop（避免杀掉用户主屏 App）

**原计划**：投屏前不 `am force-stop`，改用 `am start --display`，避免杀掉用户主屏实例。

**子代理（AOSP 源码逐行）结论：不安全。**

> `am start --display N` 默认不是新建实例，而是**按 taskAffinity 找到已有任务并 reparent 到目标屏**。
> standard/singleTop 一样中招，不是 singleTask 专属。

决策链：`am start` 无条件加 NEW_TASK → `resolveReusableTask` 的
`putIntoExistingTask = (NEW_TASK && !MULTIPLE_TASK) || singleTask/singleInstance` →
`findTask` **遍历所有 TDA** → 找到别处的任务就 `reparent` 过去。

**所以去掉 force-stop 只是把「杀进程」换成「搬任务」，用户主屏 App 照样消失。**

**结论：这条不改。** 用户看到的「重进」确实存在，但没有安全替代方案
（真要分身只能多用户/work profile，成本高、要重新登录）。

---

## 四、根因假设（按可能性排序，**都未确证**）

### 假设 A：`debug.sf.enable_hwc_vds` 属性被反作弊读到 ← **目前最可能**

- 属性名含 `vds`（virtual displays）
- 普通 App 实测可读，能看到 0→1 变化
- **每次建屏都会设它**，且建屏期间一直是 1
- 而它**完全没用**（SF 不重启就不读）
- 与「AI 操作手机时掉线」「建屏/修浮窗时掉线」的时间相关性一致

### 假设 B：虚拟屏被 App 枚举到（原版 jar）

- 已实测：原版 jar 下 App 能看到 `scrcpy` 屏
- PRIVATE 版能隐藏
- **但 00:39 那次掉线用的就是 PRIVATE 版** → 单凭这条解释不了

### 假设 C：浮窗窗口遮挡检测

- 用户说「放前台发完话放后台一分钟左右被登出」
- 浮窗可触摸 + 在 QQ 上方 → `FLAG_WINDOW_IS_OBSCURED`
- **未实测**

### 假设 D：长时间重操作导致心跳超时 ← **用户刚提出的新线索**

用户观察：
> 「写入还失败了要重试」「之前有几次也是写入啥的时候太长了一直写然后 QQ 就被登出了，
> 过了没多久就显示超时了」

可能的机制：重 CPU/IO 操作（反编译 dex、smali 重编译、npm publish）让系统卡住 →
QQ 的 MSF 心跳被延迟 → 服务端判会话失效 → 下线。

**这条如果成立，就和虚拟屏无关，和「我跑重活」有关。**
**待验证**：监控 QQ 心跳/网络，看是否在重操作期间超时。

### 假设 E：`com.dsh.overlay` 这个包本身

- 带 `SYSTEM_ALERT_WINDOW`、无 LAUNCHER、反复 `install -r` 更新
- 需要 `QUERY_ALL_PACKAGES` 才看得见（启发式）
- **未实测**

---

## 五、待办清单

### P0 —— 安全

- [x] **删掉 `setprop debug.sf.enable_hwc_vds`**（已改代码 `vd.js`，还有两处 restore 要清）
- [ ] 验证：不设属性建屏，QQ 是否还掉线（**需要用户配合，用小号先试**）
- [ ] 决定 PRIVATE jar 是否作为默认（需长期验证）
- [ ] 写进 `docs/产品意图.md`：**QQ/微信/银行类 App 永不投到虚拟屏**

### P1 —— 代码修复

- [ ] `vd.js` 还有两处 `setprop debug.sf.enable_hwc_vds ${state.hwcPrev}` 要一起删
- [ ] **当前 `vd.js` 语法错误**（我改 setprop 那段的括号没配平）—— 先修这个
- [ ] `opmode` 显示 L3 的问题：桌面类 App 不该显示「L3 严格」（未知 App 默认 L3 造成误导）
- [ ] App 退出后虚拟屏露出底层桌面 → 需要兜底

### P2 —— 用户新需求（2026-11-24 00:39 提出）

用户原话：
> 「增加个提示比如进去其他软件的情况下会在悬浮窗显示此软件风控等级，而不是单纯的只显示一个风控」
>
> 「ai 操作虚拟屏的时候悬浮窗每次操作时都应该对应有虚拟屏边缘的灯效显示」
>
> 「操作 app 时如果是拟人点击就显示点击的位置（你之前做的功能）」← 多指标记，已有
>
> 「如果是其他操作方式就应该实时显示在悬浮窗下面」
>
> 「如果切换软件就要跟着新的软件刷新风控和操作方式」
>
> 「除了 ai 自己判断要给悬浮窗填入什么信息以外**还需要悬浮窗自己识别**，
> 不然有时候 ai 真的会忘记填入信息，也就是**虚拟屏尽可能全自动**」

拆成可执行项：
- [ ] 浮窗显示**具体软件名 + 风控等级**（现在只有「风控 L3」）
- [ ] **每次操作**都刷新边缘灯效（现在只有 input/launch/tap_text 等 5 个工具触发）
- [ ] 拟人点击显示落点波纹（已有 `marks`，需确认还在）
- [ ] **其他操作方式**（OCR/截图/等待/滚动）在浮窗下面实时显示
- [ ] **切换软件时自动刷新**风控 + 操作方式
- [ ] **浮窗自己识别**，不依赖 AI 填（AI 会忘）
- [ ] 总目标：**虚拟屏尽可能全自动**

### P3 —— 收尾

- [ ] 设备清理（已做：虚拟屏0/scrcpy0/framesrv0/浮窗0/HWC0）
- [ ] 提交代码（含 ProbeActivity 探针 + 实验存档 + 本文档）
- [ ] 更新 LIMITS.md：纠正「没有 FLAG_PUBLIC 所以看不到」这条错说法
- [ ] 回答用户「卖还是开源」

---

## 六、验证方法（下次继续从这里开始）

### 判断 QQ 是否被标记（用小号，别拿主号试）

> 来源：[QQ 安全提醒解决文章](http://mp.weixin.qq.com/s?__biz=MzkwMDcyMTI3OA==&mid=2247484834&idx=1&sn=e81d41fc182f11d082a4d965607370e7)
>
> 用**新注册的号**去登录，看是否显示「你的设备存在安全风险」。
> 显示 → 设备被标记；不显示 → 设备没问题。

### 判断虚拟屏对 App 是否可见

```bash
# 1. 建屏（PRIVATE 版 jar）
# 2. 跑探针
adb shell am start -n com.dsh.overlay/.ProbeActivity
adb logcat -d | grep DSH_PROBE
# 看 getDisplays() count 是 1 还是 2
```

### 判断某个操作是否触发掉线

每轮只开一个变量，**每轮间隔 30 分钟以上**（掉线有延迟）：

```
第 1 轮：只建虚拟屏（不设 HWC 属性、不开浮窗）   → 12 小时看掉不掉
第 2 轮：建屏 + 浮窗，不操作                      → 12 小时
第 3 轮：全套 + 注入输入                          → 12 小时
第 4 轮：跑重活（反编译/编译/大文件写入），不开虚拟屏 → 看是否掉线（验证假设 D）
```

**关键**：一轮不掉线**不能**证明安全（服务端判定是异步的）。只有「掉了」是可靠信号。

---

## 七、无法确认的

- QQ 到底读哪个信号（读不到腾讯 SDK）
- 掉线是客户端上报还是服务端周期扫描
- PRIVATE 屏长期使用的副作用（跨 UID 窗口、NEVER_BLANK）
- 假设 D（重操作导致心跳超时）是否成立
- `FLAG_WINDOW_IS_OBSCURED` 是否真被 QQ 使用
