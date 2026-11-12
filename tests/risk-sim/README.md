# 风控检测靶场

一个在本机跑的风控模拟器。目的不是防人，是**量出自动化工具的破绽**。

```bash
cd tests/risk-sim
node server.mjs          # → http://127.0.0.1:3081
```

- `/` 被保护的测试页（有表单、按钮、滚动区，需要"人"的操作）
- `/dashboard` 所有检测报告的看板

## 它在测什么

**静态指纹**：navigator.webdriver、plugins、Canvas/WebGL、字体枚举、屏幕参数、时区
**行为**：鼠标轨迹直线度与时间变异系数、触摸压力变化、按键按住/间隔时长、滚动
**输入真实性**：`isTrusted`、click 有没有对应 mousedown、输入框有字但没有按键
**CDP 痕迹**：console.debug 劫持、错误栈里的注入函数

评分 0~100，逐项列出哪一条可疑、占多少权重。

## 2026-11-12 基线（当前的 web 插件）

```
46/100  —— 通过 8 项，失败 4 项
❌ bh.trusted              权重20  1 个事件 isTrusted=false（JS 合成点击）
❌ bh.input-without-keys   权重18  输入框出现 11 个字符，零次按键（insertText）
❌ bh.click-without-mousedown 权重15  click 但零次 mousedown（el.click()）
❌ bh.mouse-missing        权重 6  鼠标移动采样 0 个
```

**要通过，得改三件事**：
1. 点击改用 `Input.dispatchMouseEvent`（moved → pressed → released）
2. 打字改用逐字符 `Input.dispatchKeyEvent`
3. 动作前先发一串带随机抖动和曲线轨迹的 mousemove

## 注意

这个靶场只是**第一层**。真实风控还有 TLS/JA3 指纹、HTTP2 特征、
设备指纹关联、账号历史行为等，本地模拟不到。能过这里不等于能过大厂风控。
