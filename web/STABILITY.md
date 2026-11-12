# 稳定性与兼容性说明

版本：2026.1112 ｜ 最后验证：2026-11-12 ｜ 验证环境：nubia REDMAGIC NX809J / Android 16 (SDK 36) / Chrome 157 与 Edge 156

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

- Edge（`com.microsoft.emmx`，默认，75 个标签实测通过）
- Chrome（`com.android.chrome`，2026-11-12 补测全流程通过）
- ❌ 红魔浏览器（`cn.nubia.browser`）**不支持**：虽是 Chromium 内核，但不暴露 `chrome_devtools_remote` socket
- Chromium 156（Android 版）
- 端口随机化（9300–9500），避免多实例冲突
- 标签页用 URL 标记 `#dsh-<marker>` 双重保护，关闭时只碰自己开的标签

## 未验证

1. **非 Chromium 浏览器**（Firefox / 国产内核浏览器不支持 CDP，本插件原理上不能用于它们）
2. 其他 Android 版本
3. 浏览器被系统低内存回收后的自动恢复：有重连逻辑，但只在 Edge 上实测过
4. ~~Chrome 的完整流程~~ —— 2026-11-12 已补测，通过

## 已知限制（重要）

1. **不主动拉起浏览器**。除非调用方明确传 `allowForeground:true`，否则只报错不唤醒——用户可能刚主动关掉浏览器，擅自唤醒会打断他。
2. **浏览器在后台时无法新建标签**。Android 上 `Target.createTarget` 在后台会失败（"Could not create a Tab"）。按用户规则本插件**不会退回 `newWindow:true` 偷偷开窗**，而是返回 `needsUserConfirm` 让 Agent 去问用户。
3. **同一时刻只有一个 Chromium 能绑定 devtools socket**。Chrome 和 Edge 都开着时会冲突，需要先关掉不用的那个。
4. **后台标签会被 Chromium 冻结**，冻结后对 CDP 完全无响应。`web_attach` 会探测出来，带 `wake:true` 可唤醒（激活 + 等渲染进程恢复，不重载不丢状态）。
5. **启动浏览器会抢前台**。要避免就用虚拟屏启动（`vdisplay_start` + `vdisplay_launch`），实测主屏焦点不变。
4. **填表用 `Input.insertText`**，不是直接改 DOM 的 value——因为 React/Vue 的 value tracker 会把直接赋值当成"没变化"，onChange 不触发。这是实测踩过的坑。

## 依赖

- 宿主：`@deepseek-ai/dsh-tools`（可选 peer，插件内有五级路径回退）
- 设备侧：`adb` 二进制、一个 Chromium 系浏览器

---

## 2026-11-12 场景实测（用户实际操作中会遇到的）

| 场景 | 结果 | 说明 |
|---|---|---|
| 浏览器切后台（按 HOME） | ✅ 正常 | CDP 依然应答，13ms |
| 浏览器被系统杀掉 | ✅ 能检测 | 报"没有任何 Chromium 浏览器开着调试通道"，并给出重启建议 |
| 浏览器重启后自动恢复 | ⚠️ **不可靠** | Edge 通常能重连；**Chrome 实测失败**——重启后 `/proc/net/unix` 里同名 socket 从 5 个一路涨到 11 个，全都连不上。**成因【不知道】**：上一版这里写"沙箱进程各有独立 netns"是错的（abstract socket 按 netns 隔离，同一 netns 第二次绑定会 EADDRINUSE，所以更可能是残留进程/残留条目），但没做 inode 对账，不写机制 |
| 主屏按 HOME | ✅ 虚拟屏存活 | 上面的 App 不受影响 |
| 给虚拟屏 App 发返回键 | ✅ 生效 | 但旧版验证只等 500ms 会误报"没生效"，已改为轮询 2 秒 |
| 息屏 | ⚠️ 未验证 | 设备在用的时候 `KEYCODE_POWER` 不会真的休眠，测不出来 |
| scrcpy server 被杀后自愈 | ⚠️ 未验证 | adb shell 里的 `ps` 输出解析不可靠，测试没得出可信结论 |

### 由此得出的使用建议

1. **优先用 Edge**。Chrome 的调试通道在多进程场景下不如 Edge 稳定（实测 Chrome 重启后 socket 累积且不可达）。
2. **浏览器已经在跑就别重启它**。重启后能否自动重连取决于浏览器，Chrome 实测不行。
3. 虚拟屏这块比浏览器稳：主屏怎么操作都不影响它。
