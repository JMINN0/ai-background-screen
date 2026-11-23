# 实验存档

这里放的是**验证过但没作为默认发布**的东西。留在这里是为了让后来的人
不用重复踩坑。

---

## scrcpy-server-private.jar

**它是什么**：改过 flags 的 scrcpy-server，把虚拟屏从「公有」改成「私有」。

**为什么要做**：2026-11-23 实测发现，原版 jar 建的虚拟屏**对所有 App 可见**：

```
普通 App 的 getDisplays()：
  原版 jar    → count=2，多出一块 name=scrcpy type=5 owner=com.android.shell 的屏
  私有版 jar  → count=1，只有主屏
```

**怎么改的**：反编译 `classes.dex`，改 `NewDisplayCapture.smali` 三处：

```
1231: const/16 v1, 0x1cb  →  0x1da   （默认分支：去掉 PUBLIC 0x1，加上 PRIVATE 0x10）
1236: const/16 v1, 0xcb   →  0xda    （非 destroyContent 分支，同上）
1284: const-string v2, "scrcpy"  →  const-string v2, "内置屏幕"
```

**⚠️ 注意**：必须改 `0x1cb` 那条（默认走这条）。只改 `0xcb` 不会生效 ——
我第一次就改错了，白测一轮。

完整复现命令：

```bash
mkdir -p /tmp/sp && cd /tmp/sp
unzip -q <原版 jar>
baksmali d classes.dex -o out
# 改上面三处
smali a out -o classes.dex
# 重新打包（保留其它条目）
```

**验证过什么**（2026-11-24 实测）：

```
✅ DisplayInfo 出现 FLAG_PRIVATE
✅ 普通 App 的 getDisplays() 从 2 变成 1
✅ am start --display 仍能启动 App
✅ 第三方 App（B站）完整渲染，截图 967KB
✅ screencap / input 都正常
```

**为什么没做默认**：

1. **长期未验证** —— 只测了几分钟，不知道跑几小时会怎样
2. **有已知代价**：
   - 跨 UID 窗口可能被拒（权限对话框、输入法）
   - 私有非镜像屏会变 `FLAG_NEVER_BLANK`（不熄屏）
   - **App 一旦跑到私有屏上，它自己仍能枚举到**（AOSP 的 present-UID 例外）
3. **根本矛盾**：AOSP 用同一个 `hasAccess` 判据决定「能不能渲染」和「能不能枚举」，
   做不出「能渲染但别的 App 看不见」

**要用的话**：替换 `screen/assets/scrcpy-server.jar` 即可。
但要先删设备上的旧 jar（`/data/local/tmp/dshvd/scrcpy-server.jar`），
否则 `ensureJar` 按大小判断，可能不重推。

**一个坑**：`screencap -d` 要的是 **SurfaceFlinger display id**（19 位大数），
不是逻辑 displayId。用错会报「Display Id is not valid」—— 我因此误判过一次
「私有屏把截图弄坏了」。

---

## scrcpy-server-orig.jar

原版备份。改动上面那个之前先留着这个，方便回滚。
