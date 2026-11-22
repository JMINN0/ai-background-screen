# 项目清单（2026-11-22 夜）

> 用户要求：列清单防忘记。这份是**当前未完成工作的唯一清单**，
> 每完成一项就更新。压缩上下文后按这份重建。

## A. 命名统一（用户 23:22 提出）

- [x] A1. ✅ 已改 `screen/package.json` 描述（去掉 invisible，改成「后台屏 · Offscreen」+ 连续操作卖点）
      ✅ 顺手改掉 `README.en.md:37` 的 invisible
- [ ] A2. 决定 npm 主包名：`ai-background-screen`（和 GitHub 仓库同名）
- [ ] A3. `offscreen-android@0.1.2` 在 npm 上 deprecate，指向新包
- [ ] A4. `android-adb-direct` / `ai-background-screen` 是否也要发 npm 主包
- [ ] A5. 检查所有 README / llms.txt / 文档里的旧名残留
- [ ] A6. 确认旧链接：`dsh-go-plugin-adb` → `android-adb-direct` 的 301 重定向正常

## B. 代码 BUG（用户 23:08 报的，最优先）

- [ ] B1. 🔴 **假成功**：报「悬浮窗已创建」但窗口实际没了
      - 根因已定位：`lastStreamStartAt` 作用域 bug（第三次同型）
      - 已修，**待端到端验证**
- [ ] B2. `verifyOverlayVisible` 截主屏验证 —— 已写，**待实机验证**
- [ ] B3. `closeOrphanWindows` 硬保护 + 清理后复验 —— 已写，**待验证**
- [ ] B4. 端到端实测：建屏 → 截主屏确认浮窗 → 杀 framesrv 看自愈 → 转横屏看自动收起

## C. 边缘光效（今天做完，待验证）

- [ ] C1. 自动 working/done/idle —— 已写，待验证
- [ ] C2. AI 手动设的 warning/error/critical 优先级保护 —— 已写，逻辑已验证
- [ ] C3. 按端口路由（多屏不会同时亮）—— 已写，待验证
- [ ] C4. 500ms 快速轮询（done 不再只剩 1 秒）—— 已写，待验证
- [ ] C5. critical 低于 3Hz（WCAG 光敏性癫痫）—— 已做
- [ ] C6. critical 闩锁 60 秒 —— 已做

## D. 转屏 / 横屏（今天做完，部分待验证）

- [ ] D1. EDGE_GUARD 被级联引擎打穿 —— 已修，**实测 x=106 ✅**
- [ ] D2. autoPos 死标志 —— 已修
- [ ] D3. clampAll 全量夹取 —— 已修
- [ ] D4. 横屏尺寸不再压成细缝 —— 已修
- [ ] D5. 横屏自动收起（15.1% → 0.74%）—— 已写，**待实机验证**
- [ ] D6. 全屏进出不重排 —— 已修
- [ ] D7. 单位混用 dp/px —— 已修
- [ ] D8. 右侧投放条 END 语义 —— 已修
- [x] D9. ✅ 启动即横屏时 watchMode 不初始化 —— 已修（first 分支也调 updateWatchMode）

## E. 待机黑屏 / 卡住（今天做完，待验证）

- [ ] E1. framesrv 120 秒自杀 —— 已修
- [ ] E2. 互斥锁 90 秒上限 + 不破坏互斥 —— 已修
- [ ] E3. 重复 framesrv（看门狗抢跑）—— 已修 opBusy/宽限期，**待验证**
- [ ] E4. mHasContent 检测 + 自动重建 —— 声明已修，**待验证**
- [ ] E5. 脏状态清理（running=false 但 displayId 还在）—— 已修，日志已验证

## F. 未做

- [ ] F1. 点击标记从烤进 JPEG 挪到浮窗图层
- [ ] F2. README / README.en / llms.txt 补 `vdisplay_edge` 说明
- [ ] F3. npm 发布（**用户要求全部优化完再发**）

## F2. 文档补充

- [ ] F2a. README / README.en / llms.txt 补 `vdisplay_edge` 说明
- [ ] F2b. 检查 `screen/` 被标成 "Cordis plugin" 是否正确（keywords 有 cordis，应该是）

## G. 发布前必做

- [ ] G1. 全部端到端实测通过
- [ ] G2. 子代理对抗审查通过
- [ ] G3. 推 GitHub（**用户要求先不推**）
- [ ] G4. 发 npm

---

## 本地未推送的提交（截至 23:22）

```
c7b3f7a  自动边缘光效 + 端口路由 + 500ms 轮询 + AGENTS.md
4641568  截主屏验证（verifyOverlayVisible）
63e4fda  作用域 bug 第三次修复 + critical 闩锁 + cross-process settle
```

远端 HEAD = `b57743f`。**用户要求全部优化完再推。**
