# 总清单（2026-11-23 00:20）

> 用户要求：全部搞定 + 交叉验证 + 对抗挑刺，确认了才推送。
> 这份是唯一清单。压缩上下文后按它重建。

## 已完成（今天修的，不再动）

代码类：
- [x] 看门狗从没执行过（emptyStreak/streamFailStreak 未声明 → ReferenceError 被吞）
- [x] opBusy / lastStreamStartAt 作用域（同型 bug 第二、三次）
- [x] 互斥锁 90 秒上限 + 超时不破坏互斥
- [x] framesrv 120 秒自杀（屏还在就不退）
- [x] mHasContent 检测 + 自动重建 + 重建前 markLost
- [x] ③ 内容检测加 opBusy 保护（用户 bug 的真根因：建屏中被自己拆掉）
- [x] tick 重建走 withLock（和外部请求同一把锁）
- [x] tick 防重入（ticking + finally 复位）
- [x] 脏状态清理（running=false 但 displayId 还在）
- [x] EDGE_GUARD 被级联引擎打穿（实测 x=106）
- [x] autoPos 死标志（拖动后不再被弹回）
- [x] clampAll 全量夹取
- [x] 横屏尺寸不再压成细缝
- [x] 横屏自动收起 15.1% → 0.74%
- [x] 启动即横屏时 watchMode 不初始化
- [x] 全屏进出不重排（rotated/big 判据）
- [x] 单位混用 dp/px
- [x] 右侧投放条 END 语义
- [x] 自动边缘状态（working/done/idle 由插件自己挂）
- [x] AI 手动 warning/error/critical 优先级保护
- [x] working/done 不再解除 critical 保护
- [x] 操作停下来先亮 4 秒绿 done 再回 idle
- [x] done TTL 2500 → 4000ms
- [x] 边缘状态按端口路由
- [x] 500ms 快速轮询（不再等 3 秒）
- [x] critical 降到 1.43Hz（WCAG 光敏性癫痫合规）
- [x] critical 闩锁 60 秒
- [x] settleIfIdle 走 adb（proot 里 readFileSync 读不到设备文件）
- [x] flushAutoEdge 先读文件 mode（不覆盖 AI 设的严重状态）
- [x] verifyOverlayVisible 截主屏验证
- [x] closeOrphanWindows 硬保护 + 清理后复验
- [x] 多指点击标记（8 个 / 15 秒 / 年龄环）

文档/打包类：
- [x] screen/package.json 描述去掉 invisible
- [x] README.en.md 去掉 invisible
- [x] screen/README.md 安装命令改成真实可用的（原来教用户装 404 的包）
- [x] screen/package.json files 补 cordis.patch.yml + dsh.plugin.json（**包是坏的**）
- [x] AGENTS.md 加边缘光效章节

## 待做（本轮目标）

### 代码
- [ ] 1. multitouch 标记画不出来（tools.js 取 a0.nx/ny，但 multitouch 参数是 p1/p2/p2To）
- [ ] 2. 两套标记系统（framesrv 8个/15秒 vs stream.js 3个/60秒）—— 统一或确认不冲突
- [ ] 3. framesrv displayAlive() 反射失败时 return true → 那类机型上永不退出
- [ ] 4. 删掉 vdisplayd 99/214 两处无用的 try/catch（只会吞下次的作用域错误）
- [ ] 5. T.start 没套超时（adbd 卡死时 opBusy 永久 >0 → 看门狗永久失效）
- [ ] 6. layoutWatchThumbs 不看 autoPos（用户摆好的位置被抢）
- [ ] 7. expandedInWatch 每次转屏都重置（手动展开只保到下次转屏）
- [ ] 8. EdgeView 60fps + BlurMaskFilter 压在视频上（性能）
- [ ] 9. critical 在 36dp 缩略图上糊成一团红
- [ ] 10. 收起时没有任何提示（标签只剩风控等级）

### 文档
- [ ] 11. README / README.en / llms.txt 补 vdisplay_edge 说明

### 验证
- [ ] 12. 端到端实测：建屏 → 截主屏确认浮窗 → 杀 framesrv 看自愈 → 转横屏看自动收起
- [ ] 13. 建屏期间盯 mHasContent，确认不会误触发重建
- [ ] 14. 子代理交叉验证 + 对抗挑刺

### 发布（确认后才做）
- [ ] 15. 推 GitHub
- [ ] 16. 发 npm（发之前先确认 files 齐全）

## 不做的（已决定）
- npm 改名：保持 dsh-go-plugin-screen / dsh-go-plugin-adb
- GitHub 仓库名不动：ai-background-screen / android-adb-direct
- 旧包 offscreen-android 暂不 deprecate（等新包验证可用）
