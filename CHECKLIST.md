# 总清单（2026-11-23 00:45）

> 用户要求：全部搞定 + 交叉验证 + 对抗挑刺，确认了才推送。
> 压缩上下文后按这份重建。

## 已完成（今天全部改动）

### 用户报的 bug
- [x] 「浮窗没了但说已创建」根因：③ 内容检测没有 opBusy 保护，建屏中被自己拆掉
- [x] 重建前 markLost（否则 T.start 复用死屏、无限循环）
- [x] tick 重建走 withLock（和外部请求同一把锁）
- [x] 「卡住」根因：daemon 串行锁无超时 → 90 秒上限 + 超时不破坏互斥
- [x] 「待机黑屏」根因1：framesrv 120 秒自杀 → 屏还在就不退
- [x] 「待机黑屏」根因2：**stop() 账本泄漏导致端口漂移**（实测 3 个进程挤同一端口）
- [x] tick 端口改成从账本读，不用公式

### 作用域/静默失败（同型 bug 三次）
- [x] emptyStreak / streamFailStreak 未声明
- [x] opBusy 声明位置错
- [x] lastStreamStartAt 声明位置错
- [x] 删掉 3 处会吞作用域错误的 try{赋值}catch
- [x] tick catch 改成打日志
- [x] T.start 套 5 分钟超时
- [x] tick 防重入（ticking + finally）

### 转屏/横屏
- [x] EDGE_GUARD 被级联引擎打穿（实测 x=106）
- [x] autoPos 死标志
- [x] clampAll 全量夹取
- [x] 横屏尺寸不再压成细缝
- [x] 横屏自动收起 15.1% → 0.74%
- [x] 启动即横屏时 watchMode 不初始化
- [x] 全屏进出不重排
- [x] 单位混用 dp/px
- [x] 右侧投放条 END 语义
- [x] layoutWatchThumbs 尊重 autoPos
- [x] 自动收起时弹 Toast 解释

### 边缘光效
- [x] 六档状态 + 双编码（颜色 + 运动）
- [x] critical 1.43Hz（WCAG 光敏性癫痫合规）
- [x] critical 线宽按窗口缩放（36dp 缩略图不糊成红块）
- [x] 自动 working/done/idle
- [x] AI 手动 warning/error/critical 优先级保护
- [x] working/done 不再解除 critical 保护
- [x] 操作停下来先亮 4 秒绿 done
- [x] 按端口路由
- [x] 500ms 快速轮询
- [x] BlurMaskFilter 改两层描边
- [x] 路径测量缓存
- [x] **限帧真正生效**（固定 33ms，原来 lastDrawAt 从未赋值）
- [x] tool-spec 重写（删掉会擦掉自己警告的矛盾说明）

### 点击标记
- [x] 多指支持（收集 p1/p2/p2To、swipe 起终点）
- [x] 连续点击不再互相擦除（遍历所有标记）
- [x] 静止画面年龄环（startMarkAnim 重绘线程）
- [x] 过期后推干净帧

### 打包/命名
- [x] screen/package.json files 补 cordis.patch.yml + dsh.plugin.json（**包是坏的**）
- [x] README 不再教用户装 404 的包
- [x] 去掉 invisible 措辞
- [x] **名字统一**：ai-background-screen / android-adb-direct，版本 0.2.0
- [x] 五处一致：package.json / cordis.patch.yml / dsh.plugin.json / src/index.js / README
- [x] adb 项目同样处理（含 repository URL）

### 端到端实测
- [x] 建屏 12 秒、自检通过、截主屏确认浮窗真的可见
- [x] verifyOverlayVisible 工作正常（亮度 189）
- [x] 建屏期间不误触发重建
- [x] 杀 framesrv → 48 秒自愈 → 端口正确 → 画面 200/55KB

## 待做

- [ ] 1. 测点击标记（多指、连续点击、静止画面年龄环）—— **未在设备验证**
- [ ] 2. 清掉测试残留（虚拟屏、framesrv、浮窗、daemon）
- [ ] 3. 最终一致性检查（15 个提交的 diff 全看一遍）
- [ ] 4. 最后一轮子代理交叉验证
- [ ] 5. 推 GitHub（两个仓库）
- [ ] 6. 发 npm（ai-background-screen@0.2.0、android-adb-direct@0.2.0）
- [ ] 7. npm 上把旧包 offscreen-android deprecate，指向新包

## 已知不做
- cleanupOrphans 不自动跑（端口会漂移，会误杀）
- expandedInWatch 行为不改（修复是空操作，但行为本身合理）
- 两套标记系统不合并（互斥不会同时生效，AI 截图不污染）
