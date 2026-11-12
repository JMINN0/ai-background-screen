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
| **Chrome** | `com.android.chrome` | Chrome/157.0.8103.38 | `@chrome_devtools_remote` | **L3** | ⚠️ 实测可用，但重启后不可靠 |
| **Lemur Browser** | `com.lemurbrowser.exts` | Chrome/154.0.8037.127 | `@chrome_devtools_remote` | **L3**（截图除外） | ⚠️ 实测受限 |
| **红魔浏览器** | `cn.nubia.browser` | V8.1.4.2026081811a | 未观察到 | **未到 L0** | ❓ 未能验证 |
| **mixiaba** | `mixiaba.com.Browser` | 5.5.4.2 | 未观察到 | **未到 L0** | ❓ 未能验证 |

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

### 红魔浏览器 —— 未能验证（不是"不支持"）

上一版我写的是"**厂商裁掉了 debug 接口，不是配置问题**"。**这句话超出了证据。**

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
6. **每轮之间必须真的清干净**：`am force-stop` 所有被测浏览器 → 等 2 秒 →
   确认 socket 数为 0 → `adb forward --remove-all` → 再启动下一个。
   否则上一轮的 forward 指向死 socket，表现为"连接成功但无数据"。

---

## 给使用者的结论

1. **用 Edge。** 它是唯一 L3 全通过、后台也稳的。
2. **Chrome 可以，但别在它重启之后指望自动恢复。**
3. **Lemur Browser 可用（除截图）**，如果 Edge 抽风可以当备选。
4. **红魔浏览器和 mixiaba 目前控制不了** —— 但这是"未观察到通道"，
   不是"确定不支持"。

---

## 可信度声明

| 结论 | 类别 |
|---|---|
| Edge / Chrome / Lemur 的 L0–L3 结果 | 【实测】本机 2026-11-12 |
| Edge 有约一半标签冻结 | 【实测】抽样 10 个标签 |
| 红魔 / mixiaba 无 devtools 通道 | 【实测】全表枚举；【推断】由此不能断定"不支持" |
| Chrome 多 socket 的成因 | **【不知道】** 上一版的 netns 归因已撤回 |
| 息屏后虚拟屏是否断电 | **【不知道】** 设备在使用时无法强制休眠，没测成 |
