# 稳定性与兼容性说明

版本：2026.1105.1908 ｜ 最后验证：2026-11-05 ｜ 验证环境：nubia REDMAGIC NX809J / Android 16 (SDK 36) / Chrome & Edge (Chromium 156)

## 一句话

CDP 通道本身稳定可用；但"浏览器在后台"这个场景有明确限制，属于设计取舍，不是 bug。

## 已通过的测试

| 项目 | 结果 |
|---|---|
| 宿主工具契约（defineTool 编译） | **7/7 通过** |
| 假上下文加载（抓 ctx.inject 越界） | 通过，零 console.error |
| 真实引擎加载 | 通过（安全模式 trial：13 秒启动 + 稳定 30 秒） |
| 端到端手工验证 | 通道建立、开标签、读页面、点击、填表、截图、关闭，全部走通 |

## 核心原理

通过 `adb forward tcp:<端口> localabstract:chrome_devtools_remote` 把浏览器暴露的 DevTools Unix Socket 转发到本机 TCP，再用 WebSocket 说 CDP 协议。

这条链路的关键优势：**不点屏幕、不抢焦点**，直接读写页面的 DOM。

## 已适配

- Chrome（`com.android.chrome`，默认）
- Edge（`com.microsoft.emmx`，设 `WEB_BROWSER_PKG=com.microsoft.emmx WEB_BROWSER_NAME=Edge` 切回）
- Chromium 156（Android 版）
- 端口随机化（9300–9500），避免多实例冲突
- 标签页用 URL 标记 `#dsh-<marker>` 双重保护，关闭时只碰自己开的标签

## 未验证

1. **非 Chromium 浏览器**（Firefox / 国产内核浏览器不支持 CDP，本插件原理上不能用于它们）
2. 其他 Android 版本
3. 浏览器被系统低内存回收后的自动恢复：有重连逻辑，但只在 Edge 上实测过
4. Chrome 首次启动的欢迎页/登录页会不会影响 CDP 连接（还没在这台机器上跑过 Chrome 的完整流程）

## 已知限制（重要）

1. **不主动拉起浏览器**。除非调用方明确传 `allowForeground:true`，否则只报错不唤醒——用户可能刚主动关掉浏览器，擅自唤醒会打断他。
2. **浏览器在后台时无法新建标签**。Android 上 `Target.createTarget` 在后台会失败（"Could not create a Tab"）。按用户规则本插件**不会退回 `newWindow:true` 偷偷开窗**，而是返回 `needsUserConfirm` 让 Agent 去问用户。
3. **同一时刻只有一个 Chromium 能绑定 devtools socket**。Chrome 和 Edge 都开着时会冲突，需要先关掉不用的那个。
4. **填表用 `Input.insertText`**，不是直接改 DOM 的 value——因为 React/Vue 的 value tracker 会把直接赋值当成"没变化"，onChange 不触发。这是实测踩过的坑。

## 依赖

- 宿主：`@deepseek-ai/dsh-tools`（可选 peer，插件内有五级路径回退）
- 设备侧：`adb` 二进制、一个 Chromium 系浏览器
