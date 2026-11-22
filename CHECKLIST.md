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

- [x] 1. ✅ 点击标记实测通过
      · 多标记同时显示：三个位置各 700 左右红像素
      · 年龄环递减：T+3s 多128 → T+7s 多23 → T+11s 多-3（噪声内）
      · 到期清理：T+16s 回到基线（对照组 1163，标记组 1163）
      · 关键：**做对照组才能看出来**，闲鱼界面本身有 1163 个红像素
- [x] 2. ✅ 测试残留已清（虚拟屏/framesrv/浮窗/daemon 全 0）（虚拟屏、framesrv、浮窗、daemon）
- [x] 3. ✅ 冒烟测试通过（40 工具、插件能加载、五处名字一致）（15 个提交的 diff 全看一遍）
- [x] 4. ✅ 六轮子代理审查（命名/作用域/标记/横屏/对抗/发布）
- [x] 5. ✅ 推 GitHub —— ai-background-screen a3da6795 / android-adb-direct ab6a2753
- [x] 6. ✅ 发 npm
      · ai-background-screen@0.2.0 —— **真装验证通过**（39 文件，补丁都在）
      · android-adb-direct@0.2.0 —— **真装验证通过**（21 文件，bin/adbgo 在）
- [x] 7. ✅ offscreen-android 已 deprecate，提示「已改名为 ai-background-screen」

## 已知不做
- cleanupOrphans 不自动跑（端口会漂移，会误杀）
- expandedInWatch 行为不改（修复是空操作，但行为本身合理）
- 两套标记系统不合并（互斥不会同时生效，AI 截图不污染）

## 2026-11-23 深夜：用户新报的问题 + 实测结果

### 已修
- [x] **浮窗拖不到屏幕最左/最右（会被弹回中间）**
      根因：拖动过程没夹、松手时 clampPos 拉回 96px
      修法：拖动用 clampPosFlush（允许贴边），自动摆放保留手势区
      实测：拖到最左松手停在 x=0，不弹回 ✅
- [x] displayHasContent 的 grep 加固（-A6 无锚定 → -A20 + 行尾锚定）
      读错会以为屏空了去拆好屏，正是「浮窗突然没了」那个 bug

### 实测结果（31 分钟最小化稳定性）
- [x] 窗口一直 117x208 在 x=2，没弹回没漂移
- [x] mHasContent 一直 true（之前「40 分钟黑屏」就是它变 false）
- [x] frames 18,967 → 150,379 单调递增，没停过
- [x] framesrv 一直 1 个实例，没重复
- [x] 浮窗一直 1 个，没消失没多开
- [x] daemon 一直活着
- [x] AI 截图 30 次全成功，38-39KB，没有一次黑图
- [ ] 跨过 40 分钟那道坎（跑了 31 分钟，差一点）

### 待做
- [ ] 推 GitHub（2 个提交待推）
- [ ] 发 npm（0.2.0 → 0.2.1）
- [ ] 子代理找出问题直到完全没问题
