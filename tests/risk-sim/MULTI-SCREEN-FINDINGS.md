# 多屏架构的前置实验结论

> 这些是**实测**，不是推断。用来决定「多 AI 多屏」这个架构能不能成立、怎么成立。
> 记录日期：2026-11-15，设备：红魔 NX809J / Android 16。

## U1 `dumpsys activity activities` 有 Display #N 分组吗

**✅ 有。** 这是占用检测的权威数据源。

```
Display #0 (activities from top to bottom):
  * Task{4626b03 #24685 type=standard I=io.github.ccch1mneyyy.dsh_app/.LauncherInk U=0 ...}
Display #210 (activities from top to bottom):
  * Task{ad74e9e #24742 type=standard A=1000:com.android.settings.root U=0 ...}
```

能读到：display 编号、taskId、包名、可见性、焦点。
**结论：占用检测可以走这条路，不需要降级到每屏 `mCurrentFocus`。**

## U2 同一 App 能不能同时在两块屏上

**❌ 对 singleTask 类 App 不行，而且强行做是破坏性的。**

实测（`com.android.settings`，它是 singleTask）：

| 做法 | 结果 |
|---|---|
| `am start --display 210 -n .../.Settings` | `Warning: Activity not started, intent has been delivered to currently running top-most instance.` → **主屏的任务被 reparent 到虚拟屏，主屏空了** |
| 加 `-f 0x18000000`（MULTIPLE_TASK+NEW_TASK） | 在虚拟屏上生成了 3 个 task（24742/24743/24744），但**主屏的 settings 还是没了** |
| 加 `-f 0x08080000`（NEW_DOCUMENT+MULTIPLE_TASK） | 同上，仍然全在虚拟屏 |

**结论：**
1. 「3 个 AI、3 块屏、都开同一个 App」**做不到**（对 singleTask 类）
2. 更糟的是：**尝试会把用户主屏上的任务搬走**，这是破坏性的
3. 所以架构必须把「屏」当唯一互斥资源，**不能把「App」当资源并行**

## U3 `am start --display` 在 App 已有主屏任务时的落点

**⚠️ 三态都出现过，必须每次启动后验证：**

- `new_instance`：目标屏出现新 taskId，源屏旧 taskId 仍在
- `moved_from_display`：源屏旧 taskId 消失（**实测 settings 就是这个**）
- `reused`：输出 `Warning: Activity not started, its current task has been brought to the front`

**必须后置校验，不能假设。**

## U4 `dumpsys display` 能读 density 吗

**✅ 能。**

```
density 320
density 520
```

**结论：dpi 金丝雀方案可行** —— 每块虚拟屏用不同 dpi（320+i，差 1 无感），
之后从 `DisplayInfo` 的 density 反查是哪块屏。这是解决「所有 scrcpy 屏都叫 scrcpy、
分不清谁是谁」的可行手段。

## U5 占用探测耗时

**✅ 很快，可以每次操作前查。**

```
dumpsys activity activities  → 32ms
dumpsys display             → 32ms
```

**结论：不需要 2 秒缓存，每次操作前现查都够。**

## U6 scrcpy 5.0.1 支持自定义 display name 吗

**❌ 不支持。** 从 jar 的 classes.dex 里提取，只有两个 `vd_` 参数：

```
vd_destroy_content
vd_system_decorations
```

**没有 `vd_name`。** 虚拟屏名字固定为 `scrcpy`，
`uniqueId` 还会写成 `virtual:com.android.shell,2000,scrcpy,<n>` ——
连建屏用户的 uid（2000 = shell）都暴露在那里。

**结论：想改名只能自己写 display host（用 app_process 调 VirtualDisplay），
不能用 scrcpy-server。这是「多屏归属」和「隐藏痕迹」两件事的共同前提。**

## U7 force-stop 主屏后台 App 会丢什么

**未做**（涉及用户数据，需要用户同意才能测）。

---

## 这些结论对架构的约束

1. **屏是唯一互斥资源**，不是 App。同一 App 的多个使用者靠「换手」，不靠「多实例」
2. **占用检测走 `dumpsys activity activities` 的 Display 分组**，32ms，可实时
3. **屏身份靠 dpi 金丝雀**（因为名字改不了）
4. **每次 `am start --display` 后必须验证三态**，`moved_from_display` 要回滚并报告
5. 想彻底解决「名字暴露 scrcpy」和「屏归属」，**必须自己写 display host**

## 还没解决的关键问题

- 自己写 display host 的可行性未知（需要 app_process + VirtualDisplay API + 不依赖 scrcpy）
- 用户的 App 被搬到虚拟屏之后，用户会看到什么、怎么恢复
- 多用户（`pm create-user`）能不能做到真正的 App 分身，代价多大
