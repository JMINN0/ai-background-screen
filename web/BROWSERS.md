# Android 浏览器 CDP 可控制性实测

这份文档只记录**实际测到的东西**，以及每条结论的可信度。推断和不确认的地方都标出来了 ——
上一版把推断写成了实测，被审查抓出来，这次改正。

设备：nubia REDMAGIC NX809J / Android 16 (SDK 36) / 单机实测
测试日期：2026-11-12

---

## 分层判据

"能不能控制"不是一个是非题，拆成四层分开判：

| 层 | 判据 | 含义 |
|---|---|---|
| **L0 通道** | 存在 abstract socket，`/json/version` 返回 `Browser` 和 `Protocol-Version` | 连得上 |
| **L1 枚举** | `/json/list` 能列出 `type:"page"` 的 target | 看得到标签 |
| **L2 单标签驱动** | 对某个 target 发 `Runtime.evaluate` 能拿到结果 | 能操作 |
| **L3 页面能力** | `Page.navigate` / 读 DOM / `Input.dispatchMouseEvent` / `Input.insertText` / `Page.captureScreenshot` | 功能齐全 |

**"支持 CDP"的最低门槛应该是 L3 全通过。** 只到 L0 就写"可用"，会误导别人 ——
这条正是上一版犯的错。

---

## 结果总表

| 浏览器 | 包名 | 版本 | 通道 | 最高到达 | 状态 |
|---|---|---|---|---|---|
| **Edge** | `com.microsoft.emmx` | EdgA/156.0.4314.56 | `@chrome_devtools_remote` | **L3** | ✅ 实测可用（L2 有条件） |
| **Chrome** | `com.android.chrome` | Chrome/157.0.8103.38 | `@chrome_devtools_remote_<pid>` | **L3** | ⚠️ 可用；之前"连不上"是 socket 名找错了 |
| **Lemur Browser** | `com.lemurbrowser.exts` | Chrome/154.0.8037.127 | `@chrome_devtools_remote` | **L3**（截图除外） | ⚠️ 实测受限 |
| **红魔浏览器** | `cn.nubia.browser` | V8.1.4.2026081811a | 无 | **未到 L0** | 🔶 CDP 不可用，**虚拟屏路线可用** |
| **mixiaba** | `mixiaba.com.Browser` | 5.5.4.2 | 无 | **未到 L0** | 🔶 CDP 不可用（虚拟屏路线未测） |

---

## 逐个说明

### Edge —— 唯一可以当主力用的

```
/json/version → Browser: EdgA/156.0.4314.56, Protocol-Version: 1.3
/json/list    → 75 个 page target
```

**L3 全部通过**：导航、读 DOM、真实鼠标事件、insertText 都实测过。

**但 L2 是有条件的**，必须写清楚：

> 那 75 个标签里，抽样 10 个实测**约一半对 CDP 完全无响应**。
> `Runtime.evaluate` 超时、`Page.setWebLifecycleState` 超时、
> `Target.activateTarget` 返回成功但渲染进程照样睡着。
> 只有 `Page.reload` 能拉回来 —— 而 reload 会丢滚动位置和未提交的表单。

所以准确说法是：**能枚举 75 个标签，其中一半冻结，需要先唤醒才能操作。**
不是"75 个标签都正常"。

### Chrome —— 能用，但重启后恢复不了

通道、枚举、页面能力（含截图）都实测通过。

**问题在恢复**：`am force-stop` 之后重新启动 Chrome，`/proc/net/unix` 里
`devtools_remote` 的条目从 5 个一路涨到 11 个，**全部连不上**，等了 20 多秒也没有一个能应答。

**关于机制的说明（这里是【推断】，不是实测）**：

上一版我写的是"Chrome 沙箱进程各有独立网络命名空间"，**这个归因是错的**。
抽象 socket 的命名空间是**按网络命名空间隔离的，不是按进程**，同一 netns 里第二个绑定会
`EADDRINUSE`。更可能的解释是：

1. `am force-stop` 之后残留进程（渲染进程、crash handler）还在退出过程中；
2. 死掉的进程留下的 socket 条目还挂在表里（inode 残留，没有存活持有者）；
3. 多个 Chromium profile / 多用户各自绑定。

**没有做 inode 与 `/proc/<pid>/fd` 对账，所以真实机制【不知道】。**
结论里不写机制，只写现象。

### Lemur Browser —— 意外的好用，但截图不行

国内少见的支持扩展的 Chromium 浏览器，实测 **Chromium 154**。

| 能力 | 结果 |
|---|---|
| CDP 握手 | ✅ `Chrome/154.0.8037.127` |
| `Runtime.evaluate` | ✅ |
| `Target.createTarget` 新建标签 | ✅ |
| `Page.navigate` | ✅ |
| `Input.dispatchMouseEvent` | ✅ |
| `Input.insertText` | ✅ |
| **`Page.captureScreenshot`** | ❌ **一直超时** |

截图不是偶发：把 4 个标签逐个试都超时；试过 `Page.bringToFront` 之后再截、
试过 `fromSurface:false`、`optimizeForSpeed:true`，全都超时。

**所以定位是"部分支持"**：除截图外的页面能力可用。对本项目影响不大 ——
截图走虚拟屏那条路就行。

### 红魔浏览器 —— CDP 走不通，但**虚拟屏路线完全可用**

**结论先说：它能被自动化，只是不走 CDP。**

上一版写"厂商裁掉了 debug 接口"，那句话超出了证据。补做检查后证据链更硬了，
但更重要的是：**发现了一条替代路线，而且实测完全跑通。**

#### CDP 这条路的三条独立证据

| 检查 | 结果 |
|---|---|
| APK 里的原生库 | **没有任何 Chromium 库**（无 libchrome/libmonochrome/libblink/libcontent），也没有 WebView 库。只有字节系解码器、广告拦截、加密这些 |
| 启动+加载网页后 abstract socket 差集 | **一个都没新增**（11 条基线 → 11 条，`comm` 差集为空） |
| 版本 | V8.1.4.2026081811a |

三条证据互相独立，都指向"没有调试通道"。

#### 但虚拟屏路线完全可用（实测）

把它投到虚拟屏上，用真实输入注入操作，**全流程跑通**：

```
vdisplay_start                                    → displayId=142
vdisplay_launch { pkg: "cn.nubia.browser" }       → 落在虚拟屏上
vdisplay_shot                                     → 看到完整界面（含通知权限弹窗）
vdisplay_input tap { nx: 0.30, ny: 0.588 }        → 弹窗关掉了
vdisplay_input tap { nx: 0.35, ny: 0.175 }        → 搜索框聚焦
vdisplay_input paste { text: "测试输入" }          → 文字进去了，联想列表出来了
```

截图逐步验证过：弹窗消失 → 更新提示出现 → 关掉 → 搜索框活 → 输入出建议。

**所以结论是**：CDP 不可用 ≠ 不可自动化。虚拟屏 + 输入注入这条路对**任何 App** 都通用，
代价是慢（每次操作要截图确认），而且拿不到 DOM 只能看画面。

#### 保留的限制说明

没做过的检查（所以仍然不能说"厂商裁掉了"）：

- 静态分析 APK 里有没有 remote-debugging 相关符号
- 尝试别的 socket 名做正向对照（差集已经为空，意义不大）

#### 旧版检查记录（保留）

实际做过的检查：

| 检查 | 结果 |
|---|---|
| 启动后默认命名空间里 `grep devtools_remote` | 0 条 |
| 全表枚举所有 abstract socket（不限名字） | 只有 `@nubia_cube_socket`、`@jdwrp-control`、`@THERMALE_UI`、`@time_genoff`、`@defend.localsocket` 等，**没有任何 devtools 相关条目** |
| 版本 | V8.1.4.2026081811a，Chromium 内核 |

**没做过的检查**（所以不能说"不支持"）：

- 逐个尝试 `localabstract:<其他可能名字>` 做正向对照
- 从进程反查 `/proc/<pid>/net/unix`（uid 2000 读不到 App 的 `/proc`）
- 静态分析 APK 里有没有 remote-debugging 相关符号

**准确表述**：「**在当前环境下没有观察到可连通的 devtools 通道**」。
这只描述现象，不解释原因。

### mixiaba —— 同样未能验证

`mixiaba.com.Browser` 5.5.4.2。启动后进程起来了（1 个），但：

- 默认命名空间 `grep devtools_remote` → 0
- 全表 abstract socket 枚举 → 无 devtools 相关条目

同样的限制：没做正向对照，所以只写"未观察到"。

---

---

## 最重要的发现：socket 名不是固定的

这一条解释了我之前所有的困惑。

**多个 Chromium 浏览器同时存在时，每个会绑定 `chrome_devtools_remote_<pid>`，只有其中一个用无后缀的名字。** 实测：

```
@chrome_devtools_remote          → com.microsoft.emmx    (Edge)
@chrome_devtools_remote_32148    → com.lemurbrowser.exts (Lemur)
@chrome_devtools_remote_31115    → 无响应（Chrome 已 force-stop，残留条目）
```

**写死 `chrome_devtools_remote` 的后果**：永远只连到"碰巧拿到无后缀名"的那个（通常是第一个启动的），
其余浏览器看起来就像"没有通道"。

这解释了之前几件看起来互相矛盾的事：

- 为什么 Chrome 有时能用、有时连不上 —— 取决于它启动时是不是"第一个"
- 为什么 Chrome 重启后 socket 从 5 个涨到 11 个 —— 每次重启都加一个带新 PID 后缀的，
  旧的没清掉就成了残留条目（**不是网络命名空间，上一版的归因是错的**）
- 为什么切到 Lemur 却连到了 Edge —— forward 指向的是无后缀那个

### 正确的识别方法

`/json/version` 返回体里有 `Android-Package` 字段，直接写着这个通道属于哪个包：

```json
{ "Android-Package": "com.microsoft.emmx", "Browser": "EdgA/156.0.4314.56", ... }
```

所以流程应该是：

1. 枚举 `/proc/net/unix` 里所有 `devtools` 相关的 socket 名（**不要按固定名字 grep**）
2. 逐个 `adb forward` 到临时端口，请求 `/json/version`
3. 读 `Android-Package` 认身份；连不上的就是残留，跳过
4. 选目标浏览器对应的那个 socket

插件里已经按这个改了：`cdp.discoverSockets()`。实测能同时认出 Edge 和 Lemur，
并正确跳过残留的 Chrome 条目。

## 方法论上的坑（测的时候踩到或者差点踩到）

1. **不能只 grep `chrome_devtools_remote`**。socket 名不是固定的 —— WebView 用
   `webview_devtools_remote_<pid>`，Chromium 可以用 `--remote-debugging-socket-name`
   改成任意名字。**名字对不上不代表没有通道**，要全表枚举。
2. **不能靠数进程判断浏览器在不在跑**。实测 `am force-stop` 之后进程数还会短暂报 1，
   而 socket 已经没了。反过来也成立。**socket 比进程可信。**
3. **`/proc/net/unix` 是按网络命名空间分表的**，adb shell 只看得到默认那一张。
   "看不到"不能推出"不存在"。
4. **能连上不等于能控制**。Edge 的 75 个标签里一半冻结，就是活生生的例子。
   必须在**单个 target** 上实测命令，不能只看 `/json/version` 返回 200。
5. **`monkey -c LAUNCHER` 会触发会话恢复**，恢复过程是异步的，
   在它没结束时测"新建标签"可能失败，会误判成"不支持建标签"。
6. **`monkey` 会改系统设置**。实测 `monkey -p <pkg> -c LAUNCHER 1` 4/4 次把
   `accelerometer_rotation` 从 0 翻成 1，换成 `am start` 4/4 次不变。启动 App 一律用 `am start`。
7. **每轮之间必须真的清干净**：`am force-stop` 所有被测浏览器 → 等 2 秒 →
   确认 socket 数为 0 → `adb forward --remove-all` → 再启动下一个。
   否则上一轮的 forward 指向死 socket，表现为"连接成功但无数据"。

---

## 给使用者的结论

1. **用 Edge。** 它是唯一 L3 全通过、后台也稳的。
2. **Chrome 可以，但别在它重启之后指望自动恢复。**
3. **Lemur Browser 可用（除截图）**，如果 Edge 抽风可以当备选。
4. **红魔浏览器 CDP 控制不了，但虚拟屏可以操作** —— 实测点弹窗、点搜索框、
   粘贴文字全跑通。mixiaba 预计同理（没测）。
5. **CDP 不是唯一的路。** 没有调试接口的 App，一律可以走虚拟屏 + 输入注入，
   代价是慢（要截图确认）且只能看画面拿不到 DOM。

---

## 可信度声明

| 结论 | 类别 |
|---|---|
| Edge / Chrome / Lemur 的 L0–L3 结果 | 【实测】本机 2026-11-12 |
| Edge 有约一半标签冻结 | 【实测】抽样 10 个标签 |
| 红魔 / mixiaba 无 devtools 通道 | 【实测】全表枚举；【推断】由此不能断定"不支持" |
| Chrome 多 socket 的成因 | **【不知道】** 上一版的 netns 归因已撤回 |
| 息屏后虚拟屏是否断电 | **【不知道】** 设备在使用时无法强制休眠，没测成 |
