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
- [x] 1. ✅ multitouch 标记 —— 改成收集所有触点（tap/swipe 起终点/p1/p2/p2To）
- [x] 2. ✅ 两套标记 —— 审计确认**互斥不会同时生效**，AI 截图也**不受污染**（走 screencap 不走标记管线）
- [x] 2b. ✅ 连续点击互相擦除 —— reencodeWithMark 改成遍历所有标记
- [x] 2c. ✅ 静止画面年龄环没画过 —— 加 startMarkAnim 重绘线程（1秒内 60ms，之后 250ms，过期后推干净帧）
- [x] 3. ✅ displayAlive 改三态（活着/死了/不知道），UNKNOWN + 长时间没人看 → 退 → 那类机型上永不退出
- [x] 4. ✅ 删掉 3 处无用的 try/catch（第 142/257/714 行）（只会吞下次的作用域错误）
- [x] 5. ✅ T.start 套了 5 分钟超时，opBusy 不会永久卡住（adbd 卡死时 opBusy 永久 >0 → 看门狗永久失效）
- [x] 6. ✅ layoutWatchThumbs 只排 autoPos 的窗，用户摆好的不搬（用户摆好的位置被抢）
- [x] 7. ✅ 只在回竖屏时清，横屏期间记住用户的选择（手动展开只保到下次转屏）
- [x] 8. ✅ 去掉 BlurMaskFilter、缓存路径测量、限帧 30fps 压在视频上（性能）
- [x] 9. ✅ 线宽按窗口短边缩放（36dp 窗：17.9px → 5.85px）
- [x] 10. ✅ 自动收起时弹 Toast 解释（手动收起不弹）（标签只剩风控等级）

### 文档
- [x] 11. ✅ README 加 6.8.1 小节 + llms.txt 加视觉反馈段

### 验证
- [ ] 12. 端到端实测：建屏 → 截主屏确认浮窗 → 杀 framesrv 看自愈 → 转横屏看自动收起
- [ ] 13. 建屏期间盯 mHasContent，确认不会误触发重建
- [ ] 14. 子代理交叉验证 + 对抗挑刺

### 发布（确认后才做）
- [ ] 15. 推 GitHub
- [ ] 16. 发 npm（发之前先确认 files 齐全）

## 不做的（已决定）
- ~~npm 改名~~ → **已决定统一**：ai-background-screen / android-adb-direct，版本 0.2.0
- GitHub 仓库名不动：ai-background-screen / android-adb-direct
- 旧包 offscreen-android 暂不 deprecate（等新包验证可用）
