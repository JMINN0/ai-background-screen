# AI 使用手册（虚拟屏操作）

> 读者：拿到这批 `vdisplay_*` / `screen_*` 工具的 AI。目的：读完能一步步把事做成，不用试错。
> 依据：`screen/src/tool-spec.js`、`tools.js`、`vd.js`、`index.js`。「实测」= 仓库里有记录的现场验证，没标的按源码推导。

---

## 0. 30 秒速通

1. `vdisplay_start { pkg: "<包名>" }` —— 一步建屏、起浮窗、投 App、自检。**不要用 `screen_new`。**
2. 读最后一行：`创建完成并自检通过 ✅` 才算成功。有 `❌` 就按报的那项修（§2.1）。
3. `vdisplay_risk { pkg, level:"L0..L5 或 ?", mode, reason }` —— 定级。不定级浮窗一直显示「未评估」，而且**每一次** `vdisplay_input` 的返回里都会提醒你。
4. 操作三件套：`vdisplay_tap_text { text }` 点文字（最准）；`vdisplay_input { kind:"paste", text }` 输文字（中文走这条）；`vdisplay_input { kind:"swipe", ... }` 滑动。
5. 做完看结果：`vdisplay_wait_for { until:"text_appears", text:"..." }` → `vdisplay_shot`；出问题时第一时间调 `vdisplay_status`（它会直接告诉你「僵尸态」还是「没有 App」）。

**五条铁律**：不碰主屏 · 不用 `screen_new` · 先定风控等级 · 中文只走 `paste` · `nx/ny` 是 0–1。

---

## 一、这是什么，什么时候用

**一句话**：给 AI 单独造一块用户看不见的虚拟显示屏（`VirtualDisplay`），AI 在上面跑 App、点击、输入、截图；用户的主屏（Display 0）不被抢焦点、不被抢键盘、不弹窗。

| 该用 | 不该用 |
|---|---|
| 「帮我挂机 / 后台操作这个 App，我继续用手机」 | 银行 / 支付 → `FLAG_SECURE` + 事件可识别，交给人 |
| 「AI 点的时候别抢我屏幕、别抢键盘」 | 「微信开两个实例」→ `singleTask`，做不到 |
| 「同时盯两个 App」 | 「就点三下」→ 用户自己更快，不值得自动化 |
| 网页任务 → 优先 `web_*`（CDP，不碰屏） | 需要用户常识判断的任务 |

**耗时（实测）**：控件树 261ms · 指纹 7ms · 模板匹配 5–30ms · OCR 约 1.6s（首次 3–5s）· 截图 143ms · **一轮模型往返 6–9s**。往返才是瓶颈，少调一次比优化单次有用得多。

---

## 二、标准操作流程

### 2.0 通用循环（所有场景都是这个骨架）

```
看状态/看画面 → 决定目标 → 找准定位（文字/控件/图案）→ 注入 → 等结果 → 判断生效 → 不对就回第一步
```

对应工具：

| 环节 | 首选 | 备选 |
|---|---|---|
| 看画面 | `vdisplay_shot` | `vdisplay_live_shot`（需常驻解码 + 画面在动） |
| 读文字/数字 | `vdisplay_text`（0 图片 token） | `vdisplay_shot` + `region` |
| 读控件 | `vdisplay_ui` | OCR |
| 定位文字 | `vdisplay_tap_text`（找+点一步） | `vdisplay_find` 再自行点 |
| 定位图案 | `vdisplay_tap_image` | `vdisplay_tap_color` |
| 注入 | `vdisplay_input` | — |
| 等 | `vdisplay_wait_for` | `vdisplay_wait_stable` |
| 判生效 | `vdisplay_wait_for` / `vdisplay_diff` / `vdisplay_fingerprint` | `vdisplay_shot` |

---

### 2.1 场景一：投一个 App 到虚拟屏并操作它（最常见）

**第 1 步 · 查包名（不知道才查）**

```
vdisplay_apps {}          → 返回 `pm list packages -3` 的第三方包名列表
```

- `pkg` 是**包名**（`com.tencent.mm`），不是应用名（「微信」）。
- `vdisplay_apps` 只列第三方应用、不含中文名；系统应用（`com.android.settings`）不在列表里但能直接用。拿不准就问用户，别猜。

**第 2 步 · 确认这个 App 没被用户占着（可选但推荐，多 AI / 长期任务必做）**

```
screen_check_app { pkg }  → FREE / USER_BG / USER_ACTIVE / AI_HELD / FOREIGN
screen_claim_app { pkg }  → 拿租约（登录、支付时加 preemptible:false）
```

- `USER_ACTIVE` **绝对不能碰**，用户在看着；`FOREIGN` 是别的 AI 在用，也别碰。
- 单 AI 单任务可跳过：`vdisplay_launch` 自己会拦「正在主屏前台」。

**第 3 步 · 建屏 + 投 App（一步）**

```
vdisplay_start {
  pkg: "com.xunmeng.pinduoduo",
  keepMin: 30,            // 按任务估：短任务 3~5，挂机/长任务 30~360
  // 其余全部用默认值
}
```

`vdisplay_start` 一条命令做完：建屏 → 起推流 + 浮窗 → 投 `pkg`（不传就自动挑一个不会打断用户的 App）→ 五项自检 → 失败自动修一次再复检。

**怎么判断成功**：

| 返回里出现 | 含义 | 下一步 |
|---|---|---|
| `创建完成并自检通过 ✅` | 屏、推流、浮窗、画面、前台 App 全部验过 | 继续操作 |
| `创建完成并自检通过 ✅（但有 N 项没量到）` | 有项测不到，不等于失败，但别当全过 | 看一眼标 ⚠️ 的项 |
| 带 `❌` 的项 | 那一项真的失败 | 见 §2.5 排查 |
| `⚠️ 推流起来了但悬浮窗没浮起来` | 用户看不到画面，但 AI 仍可操作 | 可继续，别骗用户说「你能看到了」 |
| `建屏失败：<hint>` | 前置条件没满足（常见：adb 不通、机型缺 `ADD_TRUSTED_DISPLAY`） | 把 hint 原文转给用户，别自己改架构试 |

记下返回里的 **`displayId`**——`vdisplay_ui` 的 `displayId` 参数和 `vdisplay_status` 对账都要用它。`vdisplay_start` 已经投过 App 了，**不用再调一次 `vdisplay_launch`**。

**第 4 步 · 换 App / 投更多 App**

```
vdisplay_launch { pkg: "com.tencent.mm" }                 // move：接管已有实例，不 force-stop
vdisplay_launch { pkg: "com.tencent.mm", activity: ".ui.LauncherUI" }   // 省略 activity 会自动 resolve 入口
```

- 默认 `mode:"move"`：不 force-stop，靠 `am start --display N` 让系统把已有任务搬过来（实测 Edge 86 个标签、同 task、同进程全程没变）。
- **`activity` 只允许字母数字下划线和点**，带别的字符会被拒。
- 返回要看三行：`落在虚拟屏上：是 ✅` / `主屏前后：A → B` / 有没有 `⚠️ 主屏前台变了`。
  > ⚠️ 注意：`vdisplay_launch` **不会自动还原主屏**。报了「主屏前台变了」就自己处理：先 `screen_shot_main` 看用户现在在哪，再决定 `vdisplay_return` 还是把原来那个拉回来（§6.3）。

**第 5 步 · 定风控等级（做任何写操作之前）**

```
vdisplay_risk { pkg:"com.xunmeng.pinduoduo", level:"L2", mode:"拟人点击", reason:"社交电商，有商品/订单风控" }
```

漏了这步，浮窗一直显示「未评估」，每次输入的返回里都会重复提醒你（详见 §5）。

**第 6 步 · 操作它**

```
vdisplay_tap_text { text: "搜索" }
vdisplay_input { kind: "paste", text: "蓝牙耳机" }     // 中文只走 paste
vdisplay_input { kind: "key", key: "KEYCODE_ENTER" }
vdisplay_wait_for { until: "text_appears", text: "销量" }
vdisplay_tap_text { text: "销量", nth: 0 }
```

**第 7 步 · 收尾**

```
vdisplay_stop { forceStopApps: false }   // 销毁屏 + 停推流 + 释放 OCR/OpenCV 常驻进程
vdisplay_return { pkg }                   // 如果这个 App 是用户的（比如浏览器），还回主屏后台
screen_release_app {}                     // 拿过租约就还
```

---

### 2.2 场景二：看屏幕上有什么（识别路线怎么选）

**选路顺序（从便宜到贵，能用上面的就别往下走）**

| 优先级 | 工具 | 何时用 | 何时不用 |
|---|---|---|---|
| 1 | `vdisplay_ui` | 原生 App 的按钮 / 输入框 / 列表项，判断页面加载完 | 游戏、Flutter、Unity、自绘 UI（树是空的或一层壳） |
| 2 | `vdisplay_text`（OCR） | 读数字、金额、时间、列表文字、输入框内容 | 图形界面（图标没文字）；要精确结构 |
| 3 | `vdisplay_find` / `vdisplay_tap_text` | 知道要找哪几个字 | 字是图标 |
| 4 | `vdisplay_find_image` / `vdisplay_tap_image` | 图标、开关、返回箭头、技能格、血条、准星 | 元素带文字（OCR 更准） |
| 5 | `vdisplay_find_color` / `vdisplay_tap_color` | 颜色固定、位置或长度会变的：血条、进度条、选中框 | 颜色本身会变的东西 |
| 6 | `vdisplay_shot` | 布局、验证码、找位置、眼见为实 | 只想读字（浪费 token） |
| 7 | `vdisplay_shot { frames: 9 }` | 看「在动吗、往哪动」 | 想读小字（26px 的字只剩 9px，读了也会编） |

**不知道用哪个**：`vdisplay_choose_method {}` 量一次界面（边缘密度 / 颜色集中度 / 亮度对比）给排序建议，按界面指纹缓存；`vdisplay_probe {}` 是轻量版，也能判断「画面是不是空白」。

**`vdisplay_ui` 用法**

```
vdisplay_ui { onlyClickable: true, limit: 60 }
→ 屏 699 上的 activity：com.xunmeng.pinduoduo/.MainFrameActivity
  可见控件 12 个，列出 12 个（坐标是中心点，可直接当 x/y 用）
  ...
```

- 返回的坐标**就是中心点**，原样传给 `vdisplay_input` 的 `x`/`y`，不用算。
- 返回「没找到 activity / 没解析到可见控件」→ 立刻退到 `vdisplay_text` 或 `vdisplay_shot`，别反复调。
- `displayId` 不传就用当前活动虚拟屏。走 `dumpsys activity top`，不需要无障碍权限。

**`vdisplay_shot` 省钱用法**

```
vdisplay_shot {}                                    // 全屏，540 宽，读字用
vdisplay_shot { region: {x:540, y:820, w:360, h:300} }   // 局部放大：同样 token，细节翻倍
vdisplay_shot { format: "png" }                     // 要拿来当模板 → 必须 PNG 原分辨率
```

- `region` 坐标是**显示逻辑像素**，和点按同一套；`crop` **已废弃**，传了不裁。
- 返回「画面和上次完全一样」= 直接复用上一张图，别再开一次。
- 局部图的坐标要**按这张图自己的像素给 `x`/`y`**；`nx/ny` 是整屏归一化，裁过之后不能直接用。

---

### 2.3 场景三：点击 / 输入 / 滑动

**点击（四种，按可靠性排）**

```
vdisplay_tap_text  { text: "确定" }                 // ① 最稳：OCR 找 + 算坐标 + 注入 + 校验，模型不碰坐标
vdisplay_tap_image { template: "/tmp/icon.png" }    // ② 没有文字的东西
vdisplay_tap_color { color: {r:225,g:33,b:38} }     // ③ 纯色按钮/大色块
vdisplay_input     { kind: "tap", nx: 0.5, ny: 0.86 }   // ④ 最后手段，坐标只能来自控件树 x/y 或 text 的 nx/ny
```

`vdisplay_tap_text` 细节：

- 默认「包含」匹配：找「蓝牙」也会命中「蓝牙 已开启」。
- 多个命中默认点最靠上的，用 `nth` 指定第几个（从 0 开始）。**点「销量」这种列表里重复出现的词，一定要给 `nth` 或者先用 `vdisplay_find` 看清有几处。**
- 没找到会给出「相近的文字」建议 —— 用它换词重试，不要换坐标硬点。
- `verify:true`（默认）会校验画面变没变；没变说明可能没生效。

**输入文字**

| kind | 用于 | 说明 |
|---|---|---|
| `text` | ASCII 英文数字 | 标准输入框有效；自绘输入框（京东、部分搜索框）可能注不进去 |
| `paste` | **中文、任何 `text` 失败的情况** | 写剪贴板 + `KEYCODE_PASTE`，不经过输入法。虚拟屏默认 `ime:"hide"`，**只有这条打得进中文** |

```
vdisplay_input { kind: "text",  text: "hello123" }
vdisplay_input { kind: "paste", text: "蓝牙耳机" }      // 带 text：插件先写剪贴板再粘
vdisplay_input { kind: "paste" }                        // 不带 text：粘用户剪贴板现有内容
vdisplay_input { kind: "key",   key: "KEYCODE_BACK" }
vdisplay_input { kind: "key",   key: "KEYCODE_ENTER" }
```

> ⚠️ 注意：`kind:"paste"` 会**覆盖用户自己的剪贴板**，粘完告诉用户一声。

**滑动 / 长按 / 按住 / 双指**

```
// 滑动：像素坐标
vdisplay_input { kind: "swipe", x1: 360, y1: 1200, x2: 360, y2: 400, ms: 300 }
// 长按
vdisplay_input { kind: "hold", nx: 0.5, ny: 0.5, ms: 900 }
// 游戏摇杆：按住不动 + 缓慢漂移
vdisplay_input { kind: "hold", nx: 0.15, ny: 0.8, ms: 2000, driftX: 40, driftY: -20 }
// 双指：一根按住 + 另一根滑（边走路边转视角 / 双指缩放）
vdisplay_input { kind: "multitouch", p1: {nx:0.15, ny:0.8}, p2: {nx:0.6, ny:0.5}, p2To: {nx:0.8, ny:0.5}, ms: 600 }
```

- `driftX/driftY` 单位是逻辑像素；`driftY` 负数 = 往上 = 摇杆往前。`jitter` 默认 2，别设 0（绝对静止是机器特征）。
- `ms` 默认：`swipe` 300 / `hold` 1000 / `multitouch` 600。

**性能技巧**：连续点同一界面时传 `verify:false`（省两次 screencap，约 2 秒）；要看结果就传 `shotAfter:true`（省一轮往返），别「点一下 → 再单独截一次图」。

> ⚠️ 注意：`kind` 的说明里有 `multitouch`，**参数写错时的提示却只列 5 个**（少 `multitouch`）。实际白名单是 7 个，`multitouch` 可用。

---

### 2.4 场景四：判断操作有没有生效

**判断顺序**

1. **工具返回里自带的**：`vdisplay_input` 默认 `verify:true`，会告诉你「可能没生效」；`vdisplay_tap_*` 也会校验。
2. **等一个明确的界面事实**（首选）：

```
vdisplay_wait_for { until: "text_appears", text: "已加入购物车", timeoutMs: 8000 }
vdisplay_wait_for { until: "text_gone",    text: "加载中" }
vdisplay_wait_for { until: "fingerprint_changes" }        // 画面变没变（7ms）
vdisplay_wait_for { until: "stable" }                     // 转场结束
vdisplay_wait_for { until: "fingerprint_is", hash: "<16 位>" }
vdisplay_wait_for { until: "color_present", color: {r:255,g:60,b:60}, region: {...} }
vdisplay_wait_for { until: "diff_gt", threshold: 0.15 }
```

3. **不需要等待，只要一个数**：

```
vdisplay_diff           // MAD + maxCell。看 maxCell，别看 MAD
vdisplay_fingerprint    // 64 位指纹 + 和上次的汉明距离：0 相同，≤10 同一界面，>10 不同界面
vdisplay_wait_stable    // 等画面稳下来（滑动后 121–182ms 就稳）
```

> ⚠️ 注意：`vdisplay_diff` **看 `maxCell`，别看 MAD**。MAD 会被大片静态背景稀释：一个数字变了 MAD 可能只有 0.0012，`maxCell` 有 0.31。
> ⚠️ 注意：`vdisplay_fingerprint` 的 `key` 是独立槽位，不同任务用不同 `key`；同一个 `key` 第二次调用才给汉明距离。
> ⚠️ 注意：`vdisplay_wait_for` 的 `diff_gt` 实际比的是 `maxCell` 和 `threshold`（源码如此）。

**判「生效」的正确读法**

| 现象 | 含义 |
|---|---|
| 「已在 display=699 注入 tap」+ 画面变了 | 生效 |
| 「已发出，可能没生效」 | 点空 / 被挡住 / 页面本来没动画。**不要当失败重试**，先 `vdisplay_shot` 看 |
| 等超时 | ① 判据写错 ② 时间不够（加 `timeoutMs`，上限 30000）③ 真没成。返回里会给轮询次数和 OCR 次数 |

---

### 2.5 场景五（重要）：出错了怎么排查

**第一件事永远是 `vdisplay_status {}`**。它会把「屏上还有没有 App」写成一句话：

| 返回里的关键句 | 含义 | 怎么办 |
|---|---|---|
| `屏上 App：com.xxx（N 个任务）` | 正常 | 继续 |
| `⚠️ 这块屏处于**僵尸态**（任务还在但没焦点、渲染纯黑）` | 多半是手机锁屏过，虚拟屏醒了没恢复 | `vdisplay_stop` → `vdisplay_start` 重建。force-stop 重拉 App **没用** |
| `⚠️ 这块屏上**已经没有 App 了**` | 被用户从后台划掉 / App 崩了 | 重新 `vdisplay_launch`。截图会纯黑、OCR 读到 0 行，这不是「加载中」 |
| `虚拟屏没有在运行` | 屏没了 | `vdisplay_start` |
| `（屏上状态没测到 —— dumpsys 可能超时，不代表正常）` | 测不到 | 重试一次；还不行就重建成一次 |
| `主屏焦点：(未测到)` | 读不到用户前台 | 见 §6.3 |

**对照症状表**

| 症状 | 先查 | 常见原因 |
|---|---|---|
| 截图全黑 | `vdisplay_status` | 僵尸态 / 没有 App / `FLAG_SECURE`（`vdisplay_probe_secure` 确认） |
| OCR 读到 0 行 | `vdisplay_status` | 同上；或者在图片界面 |
| `vdisplay_ui` 返回空 | `vdisplay_probe` | 游戏 / Flutter / 自绘 UI → 换 OCR |
| 点击没反应 | `vdisplay_shot` 核坐标 | `nx/ny` 里填了像素；或列表里第 2 个同名文字（加 `nth`） |
| 中文打不进去 | — | 用了 `kind:"text"`，改 `kind:"paste"` |
| 浮窗不见了 | `vdisplay_window {}` | `collapsed:true` = 用户自己缩的，**不要重建**；`shown:false` = 被 App 的 `HIDE_NON_SYSTEM_OVERLAY` 藏了 |
| 每次输入都多一句「风控还没评估」 | — | 没调 `vdisplay_risk` |
| 「测不到主屏当前焦点，这次不动」 | — | §6.3 |

**降级路线（按顺序试，别一次换一个工具乱试）**

```
点不中 → vdisplay_find 看有几处 → vdisplay_ui 拿控件中心点 → vdisplay_shot + region 人眼核对坐标
读不到 → vdisplay_ui → vdisplay_text → vdisplay_shot(region)
画面不动 → vdisplay_status → vdisplay_probe_secure → 重建屏
```

---

## 三、参数速查

### 3.1 必填 / 可选 / 参数从哪来

| 工具 | 必填 | 关键可选 | 参数从哪来 |
|---|---|---|---|
| `vdisplay_start` | 无 | `pkg` `keepMin` `ime` `hwc` `maxFps` `width` `height` `dpi` `orientation` `systemDecorations` `overlay` `autoRepair` `repairOnly` | `pkg` 来自 `vdisplay_apps`；其余基本不传 |
| `vdisplay_launch` | `pkg` | `mode` `activity` | `pkg` 来自 `vdisplay_apps`；`activity` 一般省略 |
| `vdisplay_return` | `pkg` | `activity` | 同上 |
| `vdisplay_input` | `kind` | `nx/ny` 或 `x/y`；`text`；`key`；`ms`；`x1..y2`；`p1/p2/p2To`；`verify` `settleMs` `shotAfter` `width` | 坐标来自 `vdisplay_ui`（中心点）、`vdisplay_text`（nx/ny）、`vdisplay_find`;文字来自你要输入的内容 |
| `vdisplay_tap_text` | `text` | `mode` `nth` `verify` | 你要点的按钮文字 |
| `vdisplay_find` | `text` | `mode` `nth` `minConf` | 同上 |
| `vdisplay_tap_image` / `vdisplay_find_image` | `template` | `threshold` `scales` `region` | `template` 是**设备文件系统上一个 PNG 路径**，要先用 `vdisplay_shot {format:"png"}` 截下来再裁 |
| `vdisplay_tap_color` / `vdisplay_find_color` | `color` | `tolerance` `minArea` `region` | `{r,g,b}` 0–255 或 `{l,a,b}` |
| `vdisplay_shot` | 无 | `frames` `width` `region` `format` `intervalMs` `dir` | `region` 来自 `vdisplay_roi` 或你自己按截图估 |
| `vdisplay_text` | 无 | `minConf` `maxLines` `fresh` | — |
| `vdisplay_ui` | 无 | `displayId` `onlyClickable` `limit` | `displayId` 来自 `vdisplay_start` / `vdisplay_status` / `screen_pool` |
| `vdisplay_wait_for` | `until` | `text` `hash` `color` `threshold` `timeoutMs` `pollMs` `cheapFirst` `region` | `hash` 来自 `vdisplay_fingerprint` |
| `vdisplay_wait_stable` | 无 | `stableMs` `maxWaitMs` `threshold` | — |
| `vdisplay_status` | 无 | — | — |
| `vdisplay_stop` | 无 | `forceStopApps` | — |
| `vdisplay_risk` | `pkg` `level` | `mode` `reason` | 你的判断（§5） |
| `screen_risk` | `pkg` | — | `pkg` 来自 `vdisplay_apps` |
| `vdisplay_edge` | `state` | `reason` `intensity` `ttlSec` `color` | 你的判断（§6.7） |
| `screen_user_state` | 无 | — | — |
| `screen_keepalive` | `minutes` | — | 1–360 |
| `vdisplay_stream` | 无 | `fps`(1–4) `width`(240–720) | 一般由 `vdisplay_start` 自动调 |
| `screen_new` | 无 | `orientation` `hwc` | **单屏任务不要用**（§6.1） |
| `screen_use` / `screen_close` | `screenId` | — | `screen_pool` |
| `screen_check_app` / `screen_claim_app` | `pkg` | `onConflict` `preemptible` `nonPreemptibleReason` `priority` `ttlSec` `mode` | `pkg` 来自 `vdisplay_apps` |

### 3.2 `pkg` —— 是包名，不是应用名

```
✅ com.tencent.mm        ✅ com.xunmeng.pinduoduo     ✅ com.android.settings
❌ 微信                  ❌ 拼多多                    ❌ com.tencent.weixin
```

`vdisplay_launch` / `screen_check_app` / `screen_claim_app` 会校验格式，不合格直接回「`pkg` 看起来不是合法包名」，不会误投。`screen_risk` 实现里 `pkg` 和 `name` 都收——**统一写 `pkg`**。

> ⚠️ 注意：`vdisplay_risk` **不校验包名格式**。包名写错也照样「设置成功」，然后浮窗一直「未评估」、输入时一直提醒。

### 3.3 `nx` / `ny` —— 归一化坐标，0–1，不是像素

```
✅ { kind:"tap", nx: 0.5, ny: 0.9 }        // 屏幕正中偏下
❌ { kind:"tap", nx: 540, ny: 2400 }       // 这是像素，会被算到屏外
```

怎么换算：`nx = 像素x ÷ 屏宽`，`ny = 像素y ÷ 屏高`。屏宽高从 `vdisplay_status` 的 `<宽>x<高>` 拿（例如 `720x1592`）。

- **`x`/`y` 是像素，`nx`/`ny` 是 0–1**，两套二选一，别混。
- `vdisplay_text` 和 `vdisplay_find` 直接返回 `nx/ny`，可以原样传给 `vdisplay_input`。
- **局部截图（`region`）上量的比例不能当 `nx/ny`**，要换算回整屏。
- 转过屏后宽高会变（`vdisplay_status` 的 `width/height` 是实时值），坐标空间跟着变，重新取。

### 3.4 `displayId` —— 从哪拿

| 来源 | 返回形式 |
|---|---|
| `vdisplay_start` | `虚拟屏已就绪：displayId=699，...` |
| `vdisplay_status` | `虚拟屏运行中：displayId=699，...` |
| `screen_pool` | 每块屏一行 `sd-1 displayId=699 ...`（`screenId` 和 `displayId` 是两个不同的东西） |

**绝大多数工具不用传 `displayId`**：`vdisplay_*` 全部作用于「活动屏」。只有 `vdisplay_ui` 有这个参数。

### 3.5 `level` —— `L0`..`L5` 或 `?`

接受 `"L0"`..`"L5"`、`"0"`..`"5"`（自动补 `L`）、`"?"` / `"UNKNOWN"` / `"未评估"` / `"不知道"`（归一成 `?`）。别的值直接失败：「level 只能是 L0..L5、0..5、或 ?（判断不了）」。

`mode` 上限 20 字、`reason` 上限 80 字，超了**静默截断**，不报错。

### 3.6 其余易错参数

| 参数 | 真值范围 | 坑 |
|---|---|---|
| `vdisplay_edge.state` | `warning` / `error` / `critical` / `idle` | `working`、`done` 是自动的，手动设**会盖掉你刚报的 critical** |
| `vdisplay_shot.width` | 240–720 | `frames>1` 时默认 262，整张图读不出小字 |
| `vdisplay_shot.frames` | 1/2/4/6/9/12/16 | 会规整成能拼成矩形的数 |
| `vdisplay_ui.limit` | 默认 60 | 列表长时先 `onlyClickable:true` |
| `screen_keepalive.minutes` / `vdisplay_start.keepMin` | 1–360，默认 5 | 见 §6.5 |
| `vdisplay_wait_for.timeoutMs` | 200–30000，默认 8000 | 超过 30000 被截断 |
| `screen_claim_app.ttlSec` | 默认 600 | 到期自动释放 |
| `vdisplay_input.text` | `text` 只支持 ASCII；`paste` 支持中文 | — |

---

## 四、自动化 vs 手动

### 4.1 AI 可以全自动做完

- 建屏、投 App、自检、重建（僵尸态）、销毁
- 点击 / 滑动 / 长按 / 双指 / 按键
- ASCII 输入（`text`）和中文输入（`paste`）
- 截图、OCR、控件树、模板匹配、颜色检测、指纹、差分、条件等待
- 判断页面加载完没、操作生效没、只读浏览（看列表、读数字、翻页）
- 纯网页任务（走 `web_*` CDP，不碰屏）

### 4.2 必须问用户 / 交给用户

| 情况 | 为什么 | 怎么做 |
|---|---|---|
| 登录（密码、短信验证码、扫码） | 只有用户手上才有 | `vdisplay_edge { state:"warning", reason:"需要扫码登录" }`，让用户在浮窗里自己完成 |
| 支付、转账、下单、付款确认 | 不可逆，风控 L4 | 停下，`vdisplay_edge { state:"critical" }`，让用户看 |
| 滑块 / 图形验证码 / 二次验证 | §5.3 的「必须停」 | 第一次：停当前做法；第二次：全停，报用户 |
| 删除、发送、注销等不可撤销的写操作 | 可能不是用户本意 | 先说清楚要按哪个按钮 |
| App 正在用户主屏前台 | 投过去会把用户的任务搬走 | `vdisplay_launch` 会拒绝，转告用户「先切走」 |
| 出现账号异常 / 设备异常 / 操作频繁提示 | 风控已经动了 | `critical` + 停 |

### 4.3 要用户手动配合的操作

| 用户要做 | 什么时候 |
|---|---|
| 缩到最小 / 展开浮窗 | 用户嫌挡屏。**这是他的权利，不要阻止也不要替他展开** |
| 拖到滑轨右端删掉后台屏 | 用户不想看了。插件记成 `user_deleted` 事件，`screen_user_state` 会附在返回里 |
| 在浮窗里手动完成登录 / 扫码 | `vdisplay_edge warning` 之后 |
| 打开无线调试、配对 adb | 首次使用或 `adb` 不通 |
| 切走主屏上正在用的 App | `vdisplay_launch` 拒绝并说明原因时 |

### 4.4 边界：别为了省事去碰主屏

**只要命令会让用户看到东西变化，就不属于自动化。**

- 不要 `input tap`（不带 `-d`）、不要 `am start`（不带 `--display`）——那些打到主屏。用 `vdisplay_input`。
- 动主屏之前先 `screen_user_state {}`：🔴 = 用户在打字 / 在跟 AI 对话，改走虚拟屏或 CDP，或者等。
- 浮窗的位置大小**不要靠注入触摸去测**（`TYPE_APPLICATION_OVERLAY` 的触摸会漏到主屏），用 `vdisplay_window {}`。

---

## 五、风控等级怎么定

### 5.1 什么时候必须调 `vdisplay_risk`

**在第一次对某个 App 做写操作之前**，并且只对「当前屏上的那个包」有效。

- 换 App 就重新定一次（按 `pkg` 记，微信的 L3 不会套到拼多多上）。
- `vdisplay_launch` 在没评估过这个包时提醒一次；**`vdisplay_input` 每次都会提醒**。
- 判断不了就传 `level:"?"`：浮窗显示「未评估」，比瞎填 L3 诚实。

### 5.2 各等级怎么判

| 等级 | 含义 | 典型 | AI 的操作上限 |
|---|---|---|---|
| `L0` | 无风控 | 系统设置、文件管理、计算器、开源工具、单机游戏 | 随便操作，不用拟人化 |
| `L1` | 轻微 | 视频、音乐、阅读、浏览器 | 控制频率，别连续快点点同一个东西 |
| `L2` | 中等 | 微博、小红书、知乎、抖音、淘宝、京东、拼多多、闲鱼、美团、饿了么、滴滴、高德 | 拟人化：有间隔、有轨迹、不批量。第一次写操作选可撤销的 |
| `L3` | 严格 | 微信、QQ、支付宝、云闪付、各银行、交管12123、个税、12306 | **只读观察**。写操作必须先问用户 |
| `L4` | 禁止 | 王者荣耀、和平精英、原神、i茅台、大麦 | 只能交给人 |
| `L5` | 硬边界 | Netflix、Disney+（DRM） | 技术上也做不到（`FLAG_SECURE`） |
| `?` | 判断不了 | 没见过的新 App | 按最保守的方式做，或者先问用户 |

**`screen_risk { pkg }` 只是参考资料**（读 `docs/risk.json`，查不到回「未知 App → 按默认 L3」）。**浮窗只显示 `vdisplay_risk` 给的判断，不读这张表**：插件负责提醒和显示，判断由 AI 做。

怎么判（按成本排）：① 按类型推理（上表）② 上网查「<App> 封号 / 风控」有没有案例 ③ 只读观察 3 分钟，看有没有「检测到无障碍/录屏/多开」提示 ④ 一次无害写操作试探（**有风险，自己权衡**），触发验证就升级判定。

### 5.3 四次「必须停」（不看等级，命中就停）

1. 出现验证码 / 滑块 / 二次验证
2. 出现账号异常 / 设备异常 / 操作频繁提示
3. 目标 L3 且动作是「写」；**同一个目标第二次触发风控**

### 5.4 不调会怎样

- 浮窗底部一直显示「未评估」，用户以为插件没工作。
- **每一次** `vdisplay_input` 的返回里都追加：`⚠️ 风控等级还是「未评估」—— 操作前建议先调 vdisplay_risk 定级（L0..L5），浮窗会显示出来。`（2026-11-26 加的，起因是一次「操作拼多多 85 次、`vdisplay_risk` 一次没调」。）

```
vdisplay_risk { pkg:"com.xunmeng.pinduoduo", level:"L2", mode:"拟人点击+限额", reason:"社交电商，商品/订单侧有风控" }
→ 已记录 ... 的风控评估：L2（中等 —— 操作拟人化）
  操作方式：拟人点击+限额
  依据：...
  浮窗会显示这个等级。改主意了再调一次覆盖即可。
```

---

## 六、常见坑（都是实测踩到的）

### 6.1 `screen_new` 和 `vdisplay_start` 是两套接口，别混用

| | `vdisplay_*` | `screen_*` |
|---|---|---|
| 屏 | 一块「活动屏」 | 屏池，每块有 `screenId` |
| 建屏 | `vdisplay_start` | `screen_new` |
| 后续操作作用于 | 活动屏（隐式） | 活动屏（先 `screen_use` 切过去） |

**实测事故（2026-11-26）**：`screen_new` 建了池屏，接着 `vdisplay_launch` 却投到了「活动屏」，不是刚建的那块 → App 投错地方、屏是黑的，看着像插件坏了。

**规则**：单屏任务只用 `vdisplay_start` / `vdisplay_launch` / `vdisplay_shot` / `vdisplay_input` / `vdisplay_stop`；`screen_*` 只在「同时开好几块屏、多 AI 各占一块」时用，且必须 `screen_new` → `screen_use` → `vdisplay_launch` 走完三步。
> ⚠️ 注意：`screen_new` 的返回里写着「建完立刻调 `vdisplay_launch` 确实会投到它上面」——这句话只在中间没人动过活动屏时成立，实测那次就不成立。别依赖它，多屏时一律显式 `screen_use`。

### 6.2 App 被划掉 / 崩了 / 锁过屏 → 先 `vdisplay_status`

- 「僵尸态」（锁屏造成）：`force-stop` 重拉**没用**，必须 `vdisplay_stop` → `vdisplay_start`。
- 「没有 App 了」（用户划掉 / 崩了）：重新 `vdisplay_launch`。
- 这两种情况下 `vdisplay_shot` 给**纯黑图但 `ok:true`**、`vdisplay_text` 给**0 行**、`vdisplay_ui` 说「可能是游戏/自绘 UI」——三个信号都指向错的方向。**先 `vdisplay_status` 再判断。**

### 6.3 主屏焦点测不到 → 不要用 `mode:"fresh"`

`vdisplay_launch` 返回：

```
测不到主屏当前焦点，为了不误把你主屏上正在用的 App 搬走，这次不动。
建议：① 稍等 1-2 秒重试（多半是转场中）；② 调 vdisplay_status 看看现在什么状态；
③ 还是不行就直接问用户「现在能用你的手机吗」。
**不要用 mode:"fresh" 绕过 —— 它会 force-stop 主屏上那个 App。**
```

**为什么不能用 `fresh`**：`fresh` 分支**无条件** `am force-stop <pkg>`，而「主屏上有没有这个 App」的判断恰恰依赖读焦点。焦点读不到时走 `fresh` = 杀掉用户可能正在编辑的 App（实测：用户在剪映剪视频，AI 投剪映 → 进程被杀、草稿丢失）。

### 6.4 中文输入只用 `kind:"paste"`

- 虚拟屏默认 `ime:"hide"`：不弹键盘、不占用户输入法，**代价是 `kind:"text"` 打不进中文**（只有 ASCII 直注能进）。
- `kind:"paste"`：写剪贴板 + `KEYCODE_PASTE`，不经过输入法，自绘输入框也能进。
- 不要为了打中文改成 `ime:"local"`——实测（2026-11-22）用户正在主屏打字时**键盘被抢到虚拟屏**。确实需要就先问用户，用完立刻 `vdisplay_stop` 重建回 `hide`。
- 用户在手机上手动粘贴：**双击或长按输入框 → 点「粘贴」**，不用弹键盘。

### 6.5 `screen_keepalive` / `keepMin` 的真实效果和工具描述不一致

> ⚠️ 注意：工具描述说「连续 N 分钟没调工具就自动关闭」，**源码里到点什么都不销毁**，只写一行日志「屏和浮窗保持不动，要释放请显式调 vdisplay_stop」（判据用进程内计时，MCP/CLI 路径不刷新，会误拆用户正在看的屏）。
> **实际含义**：`keepMin` 现在等于什么都不做。**屏不会自己关，收尾必须你自己 `vdisplay_stop`。**

### 6.6 浮窗「不见了」有好几种，别一律重建

```
vdisplay_window {}
→ 悬浮窗：可见 ✅ / 状态：已最小化（用户在少挡主屏，**不要重建**） / 位置 / 端口
```

- `collapsed:true` → 用户自己缩的，**正常工作**，别展开也别重建。
- `shown:false` → 被某个 App 藏了（`HIDE_NON_SYSTEM_OVERLAY`，实测 `com.android.documentsui` 会），`vdisplay_launch` 也会主动提示。
- `没有悬浮窗在跑` → 才轮到 `vdisplay_stream` 或重建。

### 6.7 边缘光效：只报三种异常

- 自动：注入 / 投屏 / 按文字按图按色点击 → 青色「在干活」；建屏自检通过 → 绿色「干完了」。
- **手动只设三种**：`warning`（验证码、按钮找不到、页面超时，15 秒过期）/ `error`（明确失败、要用户介入，20 秒）/ `critical`（风控迹象、账号异常、支付前最后确认、任何「再操作下去可能不可逆」→ **亮起来就停手等用户**，不自动过期，必须 `state:"idle"` 清）。
- 不要手动设 `working` / `done`：会解除你刚报的 `critical` 的保护，用户看到的是一块「一切正常」的绿灯而问题还在。

### 6.8 `vdisplay_start` 是「复用」不是「重建」

屏已经活着时，`vdisplay_start` **直接复用，不按新参数重建**，只在配置不一致时提示 `⚠️ 复用了已有的屏，配置和这次请求不一致：...`。要按新参数建（改横屏、改 `ime`）→ 先 `vdisplay_stop` 再 `vdisplay_start`。

> ⚠️ 注意：实现里有 `reused:true`，但 `vdisplay_start` 的返回文本**不会说「这次是复用」**。判断办法：`vdisplay_status` 的 `已运行 N 秒`，不是刚建的就会是个大数。

### 6.9 `FLAG_SECURE` 是硬边界

投屏后先跑 `vdisplay_probe_secure {}`：`A` 正常出画 / `B?` 疑似受保护 / `C` 整屏黑（App 拒绝渲染或没起来）/ `A?` 原来疑似其实不是。`B?` 或 `C` 且确认是受保护窗口 → **这条线做不了**，直接告诉用户。

> ⚠️ 注意：工具描述说「无 root 的硬边界」，但仓库自己的复核报告指出 `LIMITS.md` A-03 标的是「【推断】，没做过专门靶场」。准确说法：机制上应该截不到，工具给的只是证据链（`FLAG_SECURE` 窗口数 + 上下半亮度）。**别对用户说成「已实测确认」。**

### 6.10 一次调用的隐形成本

- 一轮模型往返 6–9 秒，比任何工具本身都慢。**能用一次调用带出结果的，别拆成两次**：`shotAfter:true`、`verify:false`、`vdisplay_tap_text`（而不是 `vdisplay_find` + 自己算坐标 + `vdisplay_input`）。
- `vdisplay_live action=start` 后 `vdisplay_live_shot` 读一帧 <1ms（按需解码 244ms）。但 **scrcpy 只在画面变化时发帧**，静止屏读不到是正常的；要确定的静止帧用 `vdisplay_shot`。视频在虚拟屏上不刷新，别指望用它看视频。
- OCR 和 OpenCV 是常驻子进程（15MB / 80–150MB），`vdisplay_stop` 会关掉它们；反复建屏销毁会反复加载。

---

## 附：工具清单（实际注册 44 个，以 `screen/src/index.js` 为准）

**建屏与生命周期**：`vdisplay_start` · `vdisplay_status` · `vdisplay_stop` · `screen_keepalive` · `screen_pool` · `screen_new` · `screen_use` · `screen_close`
**投屏与归还**：`vdisplay_launch` · `vdisplay_return` · `vdisplay_apps`
**取帧与识别**：`vdisplay_shot` · `screen_shot_main` · `vdisplay_live` · `vdisplay_live_shot` · `vdisplay_text` · `vdisplay_ui` · `vdisplay_find` · `vdisplay_find_image` · `vdisplay_find_color` · `vdisplay_choose_method` · `vdisplay_probe` · `vdisplay_roi` · `vdisplay_probe_secure` · `vdisplay_window`
**输入**：`vdisplay_input` · `vdisplay_tap_text` · `vdisplay_tap_image` · `vdisplay_tap_color`
**判断与等待**：`vdisplay_fingerprint` · `vdisplay_diff` · `vdisplay_wait_for` · `vdisplay_wait_stable`
**推流与展示**：`vdisplay_stream` · `vdisplay_stream_stop` · `vdisplay_edge`
**占用与多屏**：`screen_check_app` · `screen_claim_app` · `screen_release_app` · `screen_leases`
**安全与风控**：`screen_user_state` · `vdisplay_risk` · `screen_risk` · `screen_modes`

（浏览器操控的 `web_*` 属于另一个包，不在本文范围；网页任务优先走它。`screen_modes` 只列四种操作方式的对比，不建屏、不改状态。）
