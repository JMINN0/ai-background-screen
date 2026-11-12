# dsh-go-plugin-web

用 Chrome DevTools Protocol 操作手机上的浏览器，**不点屏幕、不抢焦点**。

[English](README.en.md) ｜ 中文

| 项目 | 值 |
|---|---|
| 版本 | 2026.1105.1908 |
| 验证环境 | nubia REDMAGIC NX809J / Android 16 / Chromium 156（Edge & Chrome） |
| 工具数 | 8 |
| 需要 root | **不需要** |
| 需要无障碍 | 不需要 |

---

## 一、这是什么

普通做法是"截图 → 看画面 → 算坐标 → 点屏幕"，慢、脆、还会打断用户。

这个插件走的是另一条路：**直接和浏览器说话**。

浏览器（Chrome / Edge）内部跑着一个 DevTools 调试服务，通过 Unix socket 暴露 CDP 协议。我们用 adb 把这个 socket 转发成本机 TCP 端口，然后用 WebSocket 说 CDP：

- 读页面文字（拿 DOM，不是看截图）
- 点元素（按 CSS 选择器或文字匹配，不靠坐标）
- 填表单（走浏览器原生输入通道，框架能收到事件）
- 截图

**关键优势**：

| | 截图+坐标点击 | CDP |
|---|---|---|
| 读文字 | OCR / 视觉模型猜 | 直接拿 DOM，精确 |
| 点元素 | 算坐标，弹窗一来就偏 | 按选择器定位，自动滚动到可见 |
| 填文字 | 模拟按键，框架可能收不到 | `Input.insertText`，React/Vue 都能触发 |
| 用户屏幕 | 会被占 | 完全不碰 |

---

## 二、前提条件

1. **手机装了 Chromium 系浏览器**：Chrome、Edge、或红魔浏览器（国产内核浏览器不行，它们不支持 CDP）
2. **adb 必须可用（硬依赖，不是可选）**——这个插件所有操作都靠 `adb forward` 转发 socket，没有 adb 完全不能工作。

   装 adb 客户端：
   ```bash
   apt-get update && apt-get install -y android-tools-adb
   adb version   # 应显示 1.0.41 或更高
   ```

   **连上手机**——回环 5555 **不是 adbd 默认监听**，冷启动必须走这套（顺序不能跳）：

   ```bash
   # 手机：开发者选项 → 无线调试 → 使用配对码配对设备
   # 记下：配对端口（如 192.168.1.100:37123）和 6 位码
   adb pair 192.168.1.100:37123        # 输入配对码

   # 记下「无线调试」主页的「IP 地址和端口」（如 :41000，和配对端口不是同一个）
   adb connect 192.168.1.100:41000     # 不能跳过这步，否则下一条必失败
   adb tcpip 5555
   adb connect 127.0.0.1:5555
   adb -s 127.0.0.1:5555 shell echo ok   # 返回 ok 才算通
   ```

   首次配对要连着 WiFi；配对成功后关 WiFi 也能用。手机重启后要重做 `adb tcpip 5555`。
3. **浏览器要在运行**——本插件**不会**主动启动它（原因见下面第五节）

检查环境：

```bash
# adb 通不通
adb -s 127.0.0.1:5555 shell echo ok

# 有没有 Chromium 浏览器
adb -s 127.0.0.1:5555 shell pm list packages | grep -E "com.android.chrome|com.microsoft.emmx"

# 浏览器在跑吗
adb -s 127.0.0.1:5555 shell ps -A | grep -E "chrome|emmx"
```

---

## 三、安装

```bash
dsh plugin --profile web add dsh-go-plugin-web
```

**包从哪来**（两步，缺一步就报 `package not found`）：

```bash
# 1. 克隆仓库
git clone https://github.com/JMINN0/dsh-go-plugin-web.git
cd dsh-go-plugin-web

# 2. 从当前目录安装（注意最后那个点）
dsh plugin --profile web add .
```

这个包**没有发布到 npm registry**，所以直接写包名（`add dsh-go-plugin-web`）会失败。

**克隆后不用构建**：纯 ESM 的 JS，没有 `npm install` 步骤，`peerDependencies` 缺了会走内置回退。

**装完必须重启引擎**：App 内 → 设置 → 引擎 → 重启引擎。不重启工具不会出现。

**重启后什么时候能用**：重启会中断当前对话的引擎进程。等 App 回到可输入状态（约几秒到十几秒），**在这一条对话里直接说话就行**，不用新开对话——工具是全局注册的，不是按对话隔离的。如果这条对话里 Agent 还说没有工具，新开一条对话试试。

**验证装好了**：

```bash
# ① 配置里有没有
python3 -c "
import json
d=json.load(open('$HOME/.dsh/profiles/web/package.json'))
print([b for b in d['dsh']['profile']['bundles'] if 'plugin-web' in b])"
# 期望输出：['dsh-go-plugin-web']

# ② 引擎有没有加载错误
grep -i "apply failed" ~/.dsh/dsh-app/diagnostics.md 2>/dev/null | grep web || echo "没有加载错误 ✅"
```

两项都对、并且重启过引擎，8 个 `web_*` 工具才会出现。

---

## 四、十个工具

### `web_browser`

查看或切换要操作的浏览器。

| 参数 | 类型 | 说明 |
|---|---|---|
| `select` | string | `edge` / `chrome` / `nubia`，省略则只查看 |

支持三个：

| key | 包名 | 名字 |
|---|---|---|
| `edge` | `com.microsoft.emmx` | Edge（**默认**） |
| `chrome` | `com.android.chrome` | Chrome |
| `nubia` | `cn.nubia.browser` | 红魔浏览器 |

> ⚠️ Chromium 系的调试 socket 都叫 `chrome_devtools_remote`，**同一时刻只允许一个进程绑定**。两个浏览器都开着会冲突，切换前先关掉不用的那个。

### `web_ensure`

检查 CDP 通道，坏了就修（清理残留 forward、重建连接）。

| 参数 | 类型 | 说明 |
|---|---|---|
| `allowForeground` | boolean | **默认 false**。传 true 才允许拉起浏览器（会占前台 1–2 秒） |

```
web_ensure {}
→ 通道就绪：EdgA/156.0.4314.43（端口 9360）
```

**如果浏览器没在运行**，按这四步走——这是唯一被许可的路径：

```
① web_ensure {}                     → 返回"通道未就绪"
② 判断浏览器在不在跑（用第二节那条 ps 命令，注意用包名全名）
③ 若不在 → 问用户："我需要打开浏览器，会占用屏幕 1-2 秒，可以吗？"
④ 用户同意 → web_ensure { allowForeground: true }
   用户不同意 → 停在这里，不要自己想别的办法。没有第二条路。
```

启动的是 `web_browser` 当前选中的那个浏览器。失败时返回文本会说明原因（包没装、adb 不通）。

**用户不同意、但任务必须做**：让用户手动打开浏览器，等他打开后再调一次 `web_ensure {}`。这是唯一合法的兜底。

### `web_open`

打开一个标签页。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | ✅ | 完整的 http(s) 地址 |
| `reuse` | boolean | | 复用本插件上次开的标签，默认 true。**复用 = 把那个标签导航到新 url**，原页面内容会被覆盖 |

**返回值**：`{ targetId: "ABC123" }`。失败时返回 `{ needsUserConfirm: true, hint: "..." }`——见第五节「铁律三」。

**重要限制**：Android 上**浏览器在后台时建不了新标签**。也就是说用户没在用浏览器时，`web_open` 可能失败。这不是 bug，是系统限制。要么让用户把浏览器切到前台，要么用 `reuse: true` 复用已有标签。

返回 `targetId`，后续所有操作都用它。

### `web_read`

读页面文字，不花图片 token。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `targetId` | string | ✅ | 从 `web_open` 拿到 |
| `maxChars` | integer | | 读多少字符，默认 4000，最大 20000 |

返回 url、title 和正文。

**页面还没加载完怎么办**：插件**没有内置等待**。`web_open` 返回后页面可能还在加载，立刻 `web_read` 可能读到半截。做法：读到结果明显不完整时，等 1–2 秒再读一次（不需要重新 open）。需要等某个条件出现时，多读几次比对内容变化。

### `web_click`

按 CSS 选择器或**可见文字**点击。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `targetId` | string | ✅ | 标签 id |
| `selector` | string | 二选一 | CSS 选择器，如 `#submit`、`button[type=submit]` |
| `text` | string | 二选一 | 可见文字，如 `创建仓库`（不区分大小写，取最内层匹配） |

会自动把元素滚动到可见区域再点，所以页面滚动不会导致点错。

```
web_click { targetId: "ABC123", text: "创建仓库" }
```

**返回值**：成功 `{ ok: true, targetId, ... }`，失败带 `hint` 说明原因。

**匹配语义**：

- `text` 是**子串包含**匹配（不是完全相等），不区分大小写，多个命中时取最内层的那个
- `selector` 用标准 `querySelector` 语义，多个命中时取第一个
- `selector` 和 `text` 都不传 → 报错；两个都传 → 以 `selector` 优先

**点了没反应怎么判断**：`web_click` 返回成功只代表"事件发出去了"，不代表页面有变化。确认方式是再 `web_read` 一次看内容变没变，或者 `web_shot` 看画面。常见原因：元素被弹层遮住、匹配到了不可点的父元素、页面还在加载。

### `web_fill`

往输入框写字。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `targetId` | string | ✅ | 标签 id |
| `selector` | string | ✅ | 输入框的 CSS 选择器 |
| `text` | string | ✅ | 要写的内容 |

**是追加还是覆盖**：`Input.insertText` 是**在光标处插入**，不自动清空原内容。要覆盖已有内容，先 `web_click` 聚焦输入框，再按 `Ctrl+A` 全选（或先算好要删的字符数），或者用 JS 清空——但直接用 JS 赋值会踩下面的坑。

**为什么不用直接赋值**：`element.value = "x"` 会让 React/Vue 的 value tracker 认为"没变化"，onChange 不触发，页面显示还是空的。所以这里走焦点 + `Input.insertText`，经过浏览器原生输入通道，框架能正确收到。

### `web_shot`

截图存 PNG。

| 参数 | 类型 | 说明 |
|---|---|---|
| `targetId` | string | 标签 id |
| `dir` | string | 本地目录，默认 `/tmp` |

只在需要看布局时用。**只想知道页面说什么，用 `web_read`**，不花图片 token。

### `web_tabs`

列出浏览器里**所有**页面标签，包括用户自己的。只读，不碰任何东西。

每一项标明归属：

| 标记 | 含义 |
|---|---|
| `插件开的` | 本插件创建的（URL 带 `#dsh-<marker>`） |
| `已接管` | 用户自己的，但这次会话里用 `web_attach` 接管了 |
| `你自己的` | 用户自己的，本插件没碰过 |

用途：用户说"用我已经开着的那个页面"时，先 `web_tabs` 找到它。

### `web_attach`

接管一个已有标签：`web_attach { targetId: "..." }`

**只登记，不导航、不刷新、不改地址。** 目的是复用用户已经登录好的页面，而不是每次重新开一个再走一遍登录。

接管之后 `web_read` / `web_click` / `web_fill` 都能用它。但它的归属仍然是用户的——`web_close` 关它照样要 `confirm:true`。

**休眠标签**：标签多、浏览器又退到后台时，Chromium 会把没在用的标签冻结。这类标签在 `web_tabs` 里照样列出来，但对 CDP 完全无响应。

实测（Edge 后台、75 个标签）：约一半处于冻结状态，`Runtime.evaluate`、`Page.setWebLifecycleState`、`Target.activateTarget` 全部超时。

`web_attach` 会先实测探测，发现冻结就告诉你，要唤醒带 `wake:true`：

```
web_attach { targetId: "...", wake: true }
```

唤醒的做法是 `Target.activateTarget` 激活它，然后轮询等渲染进程自己恢复（约 5~7 秒）。**这一步不会重载页面，不丢状态。** 只有等不醒才退回 `Page.reload`，那一步会丢滚动位置和未提交的表单。

实在不行让用户在浏览器里点一下那个标签，立刻就恢复。

### `web_close`

两种用法。

**不带参数**：关掉本插件开过的所有标签，并移除 adb forward。**用户自己的标签一个都不碰。**

**带 `targetId`**：关指定的那一个。

| 标签归属 | 需要 confirm 吗 |
|---|---|
| 本插件开的 | 不需要，直接关 |
| 用户自己的（含已接管） | **需要**。不带 `confirm:true` 会被拒绝并说明原因 |

这条线是 2026-11-05 事故换来的：工具擅自动用户的浏览器，60 多个标签一次性没了，找不回来。

---

## 五、三条铁律

### 铁律一：绝不主动启动浏览器

用户的浏览器可能是**他自己刚关掉的**。擅自 `monkey` 唤醒会：

- 打断他正在做的事
- 创建一个新窗口（Chromium 会把"最后一次关闭的会话"覆盖掉，他的标签就丢了——这是真实发生过的事故）

所以：

- `web_ensure` 默认只做"探测 + 修复 forward"，**不会启动浏览器**
- 只有显式传 `allowForeground: true` 才会拉起，且必须先得到用户同意
- 测试脚本一律不得传这个参数
- **连接失败时会先检查别的浏览器是否在跑**：如果在跑（比如 Edge 没开但 Chrome 开着），直接拒绝给出启动建议，只允许让用户自己切回来或改指向正在运行的那个。多开一个浏览器就足以让用户的标签全丢。

### 铁律二：只关自己的标签

标签在打开时会在 URL 上加 `#dsh-<marker>`。关闭时按 marker + 记录的 targetId **双保险**匹配，不在名单里的标签一律不碰。

### 铁律三：不新建窗口

Android 上 `Target.createTarget` 在浏览器后台时会失败。这时候**不会退回 `newWindow: true` 偷偷开窗**，而是返回 `needsUserConfirm: true`，让调用方去问用户。

---

## 六、典型用法

### 读一个页面

```
1. web_ensure {}                                    → 通道就绪
2. web_open { url: "https://example.com" }          → targetId: "ABC123"
3. web_read { targetId: "ABC123" }                  → 页面文字
4. web_close {}
```

### 填表单并提交

```
1. web_open { url: "https://github.com/new" }       → targetId: "ABC123"
2. web_fill { targetId:"ABC123", selector:"#repository_name", text:"my-repo" }
3. web_click { targetId:"ABC123", text:"Create repository" }
4. web_read { targetId:"ABC123" }                   → 确认结果
```

### 看布局（要图的时候）

```
1. web_open { url: "https://example.com" }
2. web_shot { targetId: "ABC123", dir: "/tmp" }     → /tmp/xxx.png
```

---

## 七、稳定性与兼容性

完整报告在 [STABILITY.md](STABILITY.md)。摘要：

| 项目 | 结果 |
|---|---|
| 工具契约（宿主 defineTool 编译） | 8/8 通过 |
| 假上下文加载（抓 ctx 越界） | 通过，零报错 |
| 真实引擎加载 | 通过（安全模式 trial：13 秒启动 + 稳定 30 秒） |
| 端到端手工验证 | 通道、开标签、读页面、点击、填表、截图、关闭，全走通 |

**已验证**：Edge / Chrome / 红魔浏览器（`cn.nubia.browser`）、Chromium 156、Android 16、端口随机化 9300–9500 避免多实例冲突。

**未验证**（附症状，方便自诊）：

| 未验证项 | 遇上了会是什么样 |
|---|---|
| 非 Chromium 浏览器 | `web_ensure` 一直报"通道未就绪"，`/proc/net/unix` 里没有 `devtools_remote` —— 这是浏览器不支持 CDP，不是配置问题，换浏览器 |
| 其他 Android 版本 | `Target.createTarget` 报奇怪的错误码，或者 `screencap` 尺寸不对 |
| 浏览器被系统低内存杀掉 | 操作中途突然 `通道未就绪`，`ps` 里浏览器没了 —— 重新让用户打开浏览器 |
| 端口 9300–9500 全被占 | `web_ensure` 报无法建立 forward —— 关掉其他插件/工具占用的端口，或重启引擎 |

---

## 八、排错

**`通道未就绪`**

```bash
# 1. 浏览器在跑吗
adb -s 127.0.0.1:5555 shell ps -A | grep -E "chrome|emmx"

# 2. socket 存在吗
adb -s 127.0.0.1:5555 shell cat /proc/net/unix | grep devtools_remote

# 3. 清掉残留 forward 再试
adb -s 127.0.0.1:5555 forward --remove-all
```

**`CDP 连不上但浏览器在跑`**

forward 残留了。清理办法二选一：

- 装 [dsh-go-plugin-adb](https://github.com/JMINN0/dsh-go-plugin-adb) 的话，调它的 `adb_reconnect` 工具
- 或者直接在 proot 命令行执行 `adb forward --remove-all`，然后重试

注意 `adb_reconnect` 是 **dsh-go-plugin-adb 这个另一个插件**提供的工具，不是本插件的。

**`建标签失败`**

浏览器在后台，Android 不允许后台建标签。要么让用户把浏览器切前台，要么复用已有标签（`reuse: true`）。

**两个浏览器都开着，行为诡异**

它们抢同一个 devtools socket。关掉一个。

---

## 九、卸载与回滚

```bash
# 1. 从 profile 移除
dsh plugin --profile web remove dsh-go-plugin-web

# 2. 重启引擎（App → 设置 → 引擎 → 重启引擎）
```

**验证已移除**（和第三节的验证命令一样，期望输出 `[]`）：

```bash
python3 -c "
import json;d=json.load(open('$HOME/.dsh/profiles/web/package.json'))
print([b for b in d['dsh']['profile']['bundles'] if 'plugin-web' in b])"
```

**清理残留**：`adb forward --remove-all` 清掉转发，`rm -rf ~/.dsh/plugin-web` 删状态（如果存在）。

**引擎进安全模式了怎么办**：说明插件让引擎起不来。App 会自动用纯净 profile 启动，界面上会有提示。

```bash
# 看是哪个插件的问题
/var/lib/dsh-app/safe-mode/bin/dsh-app-plugins list
/var/lib/dsh-app/safe-mode/bin/dsh-app-plugins blame

# 停用可疑插件（可逆，不删文件）
/var/lib/dsh-app/safe-mode/bin/dsh-app-plugins disable dsh-go-plugin-web

# 试启动验证修好了
/var/lib/dsh-app/safe-mode/bin/dsh-app-plugins trial
# 看到 PASS 再点「恢复正常模式」
```

**常见触发安全模式的原因**：工具定义里 `description` 写成了数组而不是字符串——这类错误能通过打包检查，但在真实引擎里会让所有对话一发送就报错。本插件当前版本已通过宿主 `defineTool` 全量编译验证。

---

## 十、能做什么、不能做什么

**能做**（都实测过）：

| 场景 | 支持 |
|---|---|
| 读普通页面的文字 | ✅ 拿 DOM 文本 |
| 按选择器或文字点元素 | ✅ |
| 填表单（React/Vue 页面也行） | ✅ 走原生输入通道 |
| 截图看布局 | ✅ |
| 多标签页并行 | ✅ 每个 targetId 独立 |
| 读取 iframe 里的内容 | ⚠️ **只有同源 iframe 能读**，跨域 iframe 拿不到 |
| Shadow DOM 里的元素 | ⚠️ `selector` 需要写穿 shadow root 的路径，普通 CSS 选择器穿不过去 |
| 纯 canvas 渲染的页面（如在线游戏） | ❌ 拿不到 DOM 文本，只能截图 |
| 需要原生输入法的操作 | ❌ 见下面限制 |
| 上传文件 | ❌ 没有这个工具 |
| 处理 alert / confirm 弹窗 | ❌ 没实现，会卡住页面 |

**不能做的原因**：

| 限制 | 为什么 |
|---|---|
| 浏览器没在跑就不能用 | 插件不主动启动浏览器（铁律一） |
| 浏览器在后台时建不了新标签 | Android 系统限制，`Target.createTarget` 会失败 |
| 两个 Chromium 浏览器同时开着会冲突 | 它们抢同一个 devtools socket |
| Firefox / 国产内核浏览器用不了 | 它们不支持 CDP |

---

## 十一、返回值契约

**所有工具都返回 `{ text: string }`，不抛异常。** 部分工具还会带结构化字段。

| 工具 | 成功返回 | 失败返回 |
|---|---|---|
| `web_ensure` | `{ text: "通道就绪：<浏览器版本>（端口 <port>）" }` | `{ text: "通道未就绪：<原因>" , hint }` |
| `web_open` | `{ targetId }` | `{ needsUserConfirm: true, hint }` 或带错误原因 |
| `web_read` | `{ text }`，含 url / title / 正文 | 带 `hint` |
| `web_click` | 成功提示 | `hint` 说明是没匹配到还是别的原因 |
| `web_fill` | 成功提示 | `hint` |
| `web_shot` | `{ text: "截图：<路径>" }` | `hint` |
| `web_browser` | 当前浏览器与可选项列表 | 不认识的浏览器名会列出可选值 |
| `web_close` | 关闭了几个标签 | — |

**怎么判断成败**：看 text 里有没有 `未就绪`、`失败`、`不是`、`hint` 这些词。真正需要区分细节时（比如"是没匹配到元素还是被遮挡"），`web_click` 的 `hint` 会说明。

**`needsUserConfirm` 的意义**：只有 `web_open` 会返回它。意思是"需要用户同意才能继续"——不是错误，是让你去问用户，而不是自己想办法绕过去。

---

## 十二、原理

```
Agent
  ↓ CDP over WebSocket
本机 TCP 端口（随机 9300–9500）
  ↓ adb forward tcp:<port> localabstract:chrome_devtools_remote
浏览器进程（Chrome / Edge）的 DevTools Unix socket
  ↓
Chromium 的调试服务
```

不用无障碍、不用截图识别、不注入按键事件。全部走浏览器自己的调试协议。

---

## 十三、许可

MIT。见 [LICENSE](LICENSE)。
