# MCP 配置指南 —— 在 Claude Desktop / Cursor / Cline 里用后台屏

> 不装 DSH 也能用。这个包自带一个 **零依赖的 MCP server**（`bin/mcp-server.mjs`），
> 任何支持 stdio 传输的 MCP 客户端都能接上，接上之后就能调同一个包里的 42 个工具。

**给你一个心理预期**：MCP 这一层**只负责协议转换**，不重复实现任何逻辑。
它把 `tools/call` 转成给常驻守护进程（`vdisplayd`）的 HTTP 请求，
所以工具行为和 DSH 插件里完全一致，不存在两套实现漂移。

---

## 目录

- [一、三条硬前提](#一三条硬前提)
- [二、先确认 server 能起来](#二先确认-server-能起来)
- [三、三种主流配置](#三三种主流配置)
- [四、各客户端配置文件的位置](#四各客户端配置文件的位置)
- [五、daemon 必须先起来吗](#五daemon-必须先起来吗)
- [六、常见错误](#六常见错误)
- [七、MCP 和 DSH 插件的差别](#七mcp-和-dsh-插件的差别)

---

## 一、三条硬前提

配 `mcpServers` 之前先过这三条，任何一条不满足，后面的配置都会失败，
而且报错看起来跟配置无关（这是最容易白折腾半天的地方）。

| # | 前提 | 怎么确认 |
|---|---|---|
| ① | **Node ≥ 22.19**（或 ≥ 24） | `node -v`，见 package.json 的 `engines` |
| ② | **adb 装在**跑 MCP 客户端的**同一台机器**上，且能连上手机 | `adb devices` 里要有 `127.0.0.1:5555`，或设 `ADB_TARGET` |
| ③ | 手机端 `com.android.shell` 有 `ADD_TRUSTED_DISPLAY` 权限 | 建屏时自己会查，没有会明确报错；Pixel 默认没有 |

> **②是最容易翻车的**：MCP server 跑在电脑上，调的是**电脑上的 `adb`**，
> 不是手机里的。所以你得先让电脑的 adb 连上手机（USB 或 `adb tcpip 5555`）。
> 如果 adb 不在 `PATH` 里，用环境变量 `ADB_BIN` 指定绝对路径。

---

## 二、先确认 server 能起来

**不要一上来就改客户端配置。** 先在命令行手动跑一次 MCP 握手，
这一步能把「路径错 / node 版本不够 / 依赖缺失」全部排除掉。

### 2.1 确认文件在

源码目录里：

```bash
ls -la screen/bin/mcp-server.mjs
```

npm 包里的同一个文件叫 `bin/mcp-server.mjs`（包根目录下，**没有** `screen/` 这一层），
这是两处路径最容易搞混的地方：

```
源码仓库：/path/to/ai-background-screen/screen/bin/mcp-server.mjs
npm 全局：/usr/local/lib/node_modules/ai-background-screen/bin/mcp-server.mjs
npm 本地：/path/to/项目/node_modules/ai-background-screen/bin/mcp-server.mjs
```

### 2.2 发两条 JSON 试握手

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node /path/to/ai-background-screen/screen/bin/mcp-server.mjs
```

**预期输出**：两行 JSON（一行一个响应）。第二行的 `result.tools` 数组长度是 **42**。

**不需要 adb 也能看到这两行** —— `tools/list` 只读工具定义，不碰设备。
拿不到这两行就是配置问题，跟手机无关。

### 2.3 顺便确认 npm 装的地方（可选）

```bash
npm root -g          # 全局包根目录，Linux/Mac 通常是 /usr/local/lib/node_modules
ls $(npm root -g)/ai-background-screen/bin/mcp-server.mjs
```

---

## 三、三种主流配置

三种客户端用的都是**同一种 JSON 结构**（`mcpServers` → 一个名字 → `command` + `args`），
差别只在配置文件放哪、以及能不能带 `env`。

### 3.1 通用写法（源码目录）

```json
{
  "mcpServers": {
    "background-screen": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/你的用户名/ai-background-screen/screen/bin/mcp-server.mjs"]
    }
  }
}
```

**`command` 建议写 node 的绝对路径**，不要写 `"node"`。
Claude Desktop 这类 GUI 程序启动时的 `PATH` 往往不是你在终端里的那个
（macOS 上尤其明显，`nvm` 装的 node 通常根本不在 GUI 的 `PATH` 里）。
用 `which node` 查出来填进去。

### 3.2 Claude Desktop（Windows / macOS）

```json
{
  "mcpServers": {
    "background-screen": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\你的用户名\\ai-background-screen\\screen\\bin\\mcp-server.mjs"],
      "env": {
        "ADB_BIN": "C:\\Users\\你的用户名\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe",
        "ADB_TARGET": "127.0.0.1:5555"
      }
    }
  }
}
```

Windows 路径的两个规则：

- JSON 里反斜杠要写成 `\\`
- 路径里有空格就原样保留，**不需要**额外加引号（`args` 是数组，每个元素是一个独立参数）

macOS：

```json
{
  "mcpServers": {
    "background-screen": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/你的用户名/ai-background-screen/screen/bin/mcp-server.mjs"],
      "env": { "ADB_BIN": "/opt/homebrew/bin/adb" }
    }
  }
}
```

> macOS 上 Homebrew 装在 Intel 机器是 `/usr/local`，Apple Silicon 是 `/opt/homebrew`，别抄错。

### 3.3 Cursor

Cursor 的配置是每个项目一份（`项目根/.cursor/mcp.json`），也能用全局的。

```json
{
  "mcpServers": {
    "background-screen": {
      "command": "node",
      "args": ["./screen/bin/mcp-server.mjs"]
    }
  }
}
```

Cursor 的工作目录是**项目根**，所以 `args` 里可以写相对路径。
但如果用的是 npm 装的那份，建议写绝对路径，别让 Cursor 去猜。

### 3.4 Cline（VSCode 扩展）

Cline 的 MCP 配置在 VSCode 的设置里（`mcpServers` 对象），也可以直接编辑它自己的
`cline_mcp_settings.json`（详见第四节）。格式和上面的一样：

```json
{
  "mcpServers": {
    "background-screen": {
      "command": "node",
      "args": ["/Users/你的用户名/ai-background-screen/screen/bin/mcp-server.mjs"],
      "disabled": false,
      "autoApprove": ["vdisplay_status", "vdisplay_shot", "vdisplay_text", "vdisplay_apps"]
    }
  }
}
```

`autoApprove` 是 Cline 特有的：列进去的工具不会每次弹确认。
**只往里放只读工具**（status / shot / text / apps），
`vdisplay_input`、`vdisplay_launch`、`vdisplay_stop` 这种会改设备的不要自动批准。

### 3.5 用 npm 全局装的那份（不克隆源码）

```bash
npm install -g ai-background-screen
which ai-background-screen-mcp      # 确认 shim 装上了
```

```json
{
  "mcpServers": {
    "background-screen": {
      "command": "ai-background-screen-mcp"
    }
  }
}
```

`bin` 字段里有三个等价的 MCP 入口，`command` 填哪个都行：

```
ai-background-screen-mcp
offscreen-android-mcp
vdisplay-mcp
```

> **npm 方式的一个坑**：`command` 填的是 shell 脚本（Windows 上是 `.cmd`），
> 有些客户端不解析 `.cmd`。遇到「server 起不来但手动跑又正常」，
> 改成 `"command": "node"`，`"args": ["<npm root -g>/ai-background-screen/bin/mcp-server.mjs"]`。

---

## 四、各客户端配置文件的位置

| 客户端 | 系统 | 路径 |
|---|---|---|
| **Claude Desktop** | Windows | `%APPDATA%\Claude\claude_desktop_config.json`<br>展开是 `C:\Users\<用户名>\AppData\Roaming\Claude\claude_desktop_config.json` |
| **Claude Desktop** | macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Claude Desktop** | 打开方式 | 菜单 `Settings → Developer → Edit Config`，点完会出现文件所在目录 |
| **Cursor** | 全部 | 项目级：`<项目根>/.cursor/mcp.json`<br>全局：`~/.cursor/mcp.json` |
| **Cline** | 全部 | `<VSCode 用户目录>/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`<br>Windows：`%APPDATA%\Code\User\globalStorage\...`<br>macOS：`~/Library/Application Support/Code/User/globalStorage/...` |
| **Cline** | 打开方式 | VSCode 侧边栏 Cline → `MCP Servers` → `Configure MCP Servers`（会直接打开那个 json） |

> 改完配置**必须完全退出并重启客户端**（Claude Desktop 连托盘一起退），
> 只关窗口不重载 MCP server。

---

## 五、daemon 必须先起来吗

**不用手动起，但你必须知道它在哪。**

`mcp-server.mjs` **不自己建屏**，它把每个工具调用转发给常驻守护进程
（`bin/vdisplayd.mjs`），靠读一个状态文件找到端口：

```
$DSH_HOME/plugin-screen/cli-daemon.json     # 默认 <家目录>/.dsh/plugin-screen/cli-daemon.json
```

- `DSH_HOME` 没设就是 `~/.dsh`
- 也可以用 `VD_DAEMON_FILE` 直接指到某个 json 文件（在另一台机器上手动指定时用）

**这一条在 MCP 场景下要特别注意**：MCP server 跑在电脑上，
它找的是**电脑上**的 `~/.dsh/plugin-screen/cli-daemon.json`。
所以 daemon 也得在电脑上跑（手机只出 adb 通道），两边的 `DSH_HOME` 必须一致。

### 第一次怎么把 daemon 拉起来

在跑 MCP 客户端的同一台机器、同一个 `DSH_HOME` 下执行一次：

```bash
node /path/to/ai-background-screen/screen/bin/vdisplay.mjs start
```

只要屏在跑，daemon 就一直活着；**没有屏、且 10 分钟没人调命令，它会自己退出**
（`IDLE_EXIT_MS = 10 * 60 * 1000`）。这是正常的，下次调用会再拉起来。

daemon 没在跑时的表现很明确：

```
daemon 没在跑。先在设备上执行一次 `vdisplay start` 或 `vdisplay status` 把它拉起来。
```

> **注意这句话指的是电脑上的那条 CLI，不是手机里的。**
> 看到它不要怀疑 MCP 配置，先回第三节第 2.1 步把 handshake 跑通，再看 daemon。

### 状态文件长这样

```json
{
  "pid": 10864,
  "port": 46011,
  "startedAt": 1795855727078
}
```

端口是随机分配的，**不要写死端口**，让它自己读文件。

---

## 六、常见错误

### 6.1 `daemon 没在跑`

见第五节。检查三件事：

```bash
# 都是「在跑 MCP 的那台机器、那个用户」下执行
ls -la ~/.dsh/plugin-screen/cli-daemon.json
cat ~/.dsh/plugin-screen/cli-daemon.json      # port 要 > 0
ps -eo pid,args | grep vdisplayd.mjs | grep -v grep
```

三者对不上就是 daemon 挂了或者 `DSH_HOME` 不一致。

### 6.2 路径错

**症状**：客户端里根本看不到这个 server，或者一调就断。

**原因**：`args` 写成了目录、写成了 `screen/` 而不是 `screen/bin/mcp-server.mjs`、
或者 `~` 没展开（JSON 里的 `~` **不会**被展开，必须写绝对路径）。

**排查**：把 `command` + `args` 拼成一条命令直接跑，能跑通才去改配置：

```bash
node /写进去的/那个/路径/mcp-server.mjs < /dev/null
```

一个合法的 server 会立刻退出（stdin 为 EOF），**不会**卡住。
卡住不退出说明它在等 stdin —— 那是客户端要的状态，不是你跑错了。

### 6.3 node 版本不够

**症状**：一启动就报 `SyntaxError`、`Unexpected token`、或者 `response.json is not a function`。

**原因**：`engines` 写的是 `^22.19.0 || >=24.0.0`。
低于这个版本：`fetch` 的 `AbortSignal.timeout`、`import.meta.url` 的一些用法、
以及内置 `node:test` 的行为都对不上。

**排查**：

```bash
node -v
```

v22.19 以下、或者 v23.x（`^22.19.0 || >=24.0.0` 不覆盖 23），
换一个 node，或者在 `env` 里把 `PATH` 指到正确的那份 node。

### 6.4 工具列出来了，一调就报连不上 adb

**症状**：`vdisplay_start` 返回 `启动 adb 失败（adb）`，或者一堆空输出。

**原因**：MCP server 用的 `adb` 不是你要的那个。
它按这个顺序找：环境变量 `ADB_BIN` → `PATH` 里的 `adb`。
目标设备地址按：`ADB_TARGET` → `$DSH_HOME/plugin-adb/state.json` 里的 port → `127.0.0.1:5555`。

**排查**：

```bash
env -i PATH=/usr/bin:/bin adb devices      # 模拟 GUI 程序的 PATH 环境
```

设备列表里没有 `127.0.0.1:5555` 就补上：

```bash
adb connect 127.0.0.1:5555
```

**另一个同源故障：连了不止一台设备。**
`adb devices` 里如果同时有 `127.0.0.1:5555` 和 `emulator-5554`，
不带 `-s` 的 `adb shell` 会直接报 `adb: more than one device/emulator`。
本插件的所有调用都强制带 `-s <ADB_TARGET>`，所以只要 `ADB_TARGET` 对就不会中招；
但**你手动排查时**必须自己带 `-s`：

```bash
adb -s 127.0.0.1:5555 shell id      # ✅ 应该是 uid=2000(shell)
adb shell id                        # ❌ 多设备时报 more than one device
```

然后再在配置里把 `env` 补全：

```json
"env": {
  "ADB_BIN": "/usr/bin/adb",
  "ADB_TARGET": "127.0.0.1:5555"
}
```

### 6.5 OCR 报「OCR 不可用」

`vdisplay_text` 依赖 Python 侧的 `rapidocr-onnxruntime`，
OCR 是**可选**的 —— 没装不影响建屏、投屏、点击、截图，只影响读文字。

```bash
pip install rapidocr-onnxruntime
```

报错原文是这两句之一：

```
OCR 不可用：<具体错误>
OCR 进程启动超时。装一下依赖：pip install rapidocr-onnxruntime
```

注意 OCR 用的是**`python3` 这个命令**（不是 `python`，也不是某个 venv 里的解释器），
装依赖时要装到 `python3` 能 import 到的那个环境里。

### 6.6 `vdisplay_shot` 返回「图太大」

MCP 的传输走的是单行 JSON-RPC，一张太大的 base64 会撑爆一帧（很多客户端会截断或直接崩）。
超过 **1.5MB** 会被拒绝，返回一句提示而不是图。解决：调小 `width`，或用 `region` 只截一块。

---

## 七、MCP 和 DSH 插件的差别

同一套工具，两边的行为只有**两处**不同，容易让人困惑：

| 项目 | DSH 插件 | MCP |
|---|---|---|
| 截图怎么给 | 返回本地**路径**，模型自己去 `read_image` | **直接把图 base64 塞进 content** |
| 为什么不同 | 模型和文件在同一台机器上 | MCP 客户端可能跑在另一台电脑上，手机 `/tmp` 的路径对它没有意义 |

| 项目 | DSH 插件 | MCP |
|---|---|---|
| `vdisplay_stream` / `vdisplay_stream_stop` | 有 | **不暴露** |

那两个不暴露是故意的：它们的消费者是 DSH Go 的「AI 画面」胶囊
（原生插件去回环端口拉 MJPEG 流），别的宿主没有这个组件，暴露了只会让模型白调一次。

**其余 42 个工具全部可用**，行为一致。工具名和签名直接照 DSH 那边写就行。

---

## 附：一句话版本

```bash
npm install -g ai-background-screen
adb connect 127.0.0.1:5555
node $(npm root -g)/ai-background-screen/bin/vdisplay.mjs start
```

然后往客户端配置里加：

```json
{
  "mcpServers": {
    "background-screen": {
      "command": "node",
      "args": ["<npm root -g 的实际路径>/ai-background-screen/bin/mcp-server.mjs"]
    }
  }
}
```

重启客户端，跟模型说「列出手机上的第三方 App」，
它应该会调 `vdisplay_apps` 并给你一串包名。
