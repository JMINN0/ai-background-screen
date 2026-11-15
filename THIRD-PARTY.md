# 第三方组件与许可

本仓库自己的代码是 **MIT**（见 [LICENSE](LICENSE)）。

但 `screen/assets/scrcpy-server.jar` **不是我们的代码**，它是 [scrcpy](https://github.com/Genymobile/scrcpy)
的 server 端，以 **Apache License 2.0** 分发。所以这个仓库实际是 **MIT + Apache-2.0 双许可**，
两部分各自按自己的条款。

## 打包了什么

| 文件 | 来源 | 许可 | 版权 |
|---|---|---|---|
| `screen/assets/scrcpy-server.jar` | [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy) server，版本 **5.0.1** | Apache-2.0 | Copyright (C) 2018 Genymobile |

Apache-2.0 全文见根目录 [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)。

## Apache-2.0 要求我们做的事（第 4 条）

1. **给接收者一份许可副本** —— 已完成，见 `LICENSE-APACHE-2.0`。
2. **修改过的文件要显著标注"已修改"** —— **我们未修改这个 jar**，原样取自上游 release。
   如果有人改了，必须在这里写明改了哪些。
3. **保留原版权、专利、商标、归属声明** —— 见上表。
4. **如果上游有 NOTICE 文件，要一并转交** —— scrcpy 上游**没有** NOTICE 文件
   （截至 5.0.1，仓库根目录只有 LICENSE，内容是 Apache-2.0），所以这里无需转交。

## 如果你要再分发

- 本仓库自己的代码：按 MIT，保留版权声明即可。
- `scrcpy-server.jar`：按 Apache-2.0，需要带上 `LICENSE-APACHE-2.0` 和上表的归属信息。
  不需要开源你的修改（Apache-2.0 不是传染性许可），但必须保留声明。

## 怎么自己生成这个 jar

不想用我们打包的、想自己从源码构建（比如想确认没被改过）：

```bash
git clone https://github.com/Genymobile/scrcpy
cd scrcpy
git checkout v5.0.1
# 按上游文档构建 server，产物即 scrcpy-server
```

放回 `screen/assets/scrcpy-server.jar`，然后删掉设备上的旧 jar
（`/data/local/tmp/dshvd/scrcpy-server.jar`）——插件的 `ensureJar()` 会按大小判断是否需要重推。

## 其他依赖

插件代码**没有任何第三方 npm 依赖**，只用 Node 内置模块。运行时用到的外部程序：

| 程序 | 用途 | 许可 |
|---|---|---|
| `adb` | 与设备通信 | Apache-2.0（AOSP platform-tools） |
| `ffmpeg`（含 `ffprobe`） | 缩放、九格拼图 | LGPL/GPL（取决于构建） |
| `python3` + `rapidocr-onnxruntime` | OCR 读屏（可选） | Apache-2.0 / MIT（模型各有许可） |

这些是运行时依赖，不随本仓库分发。
