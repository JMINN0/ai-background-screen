# 多 AI 多屏 broker 设计

> 目标：让**每个会话、每个 AI、每个子代理**都能拥有自己的后台屏，
> 并且能检测「这个 App 已被别的屏占用」，按策略决定等待、抢占还是换路。
>
> 状态：**设计完成，代码未实现。** 前置实验已跑（见 `MULTI-SCREEN-FINDINGS.md`）。
> 预计工作量：MVP 2.5-4 天。

---

## 一、先说清楚做不到的部分

用户问过一个很好的问题：「哪怕是官方 App 也不能三个 AI 三块屏都开同样的软件吧？」

**判断是对的。** 实测（U2）：

```
com.android.settings（singleTask）
  am start --display 210 -n .../.Settings
  → "Activity not started, intent has been delivered to currently running top-most instance"
  → 主屏的 settings 任务被 reparent 到虚拟屏，主屏空了
```

加 `MULTIPLE_TASK` 或 `NEW_DOCUMENT` flag 也没用 —— 新任务全都落在虚拟屏，
用户那份还是丢了。

**所以三条硬结论：**

1. **「3 个 AI、3 块屏、同一个 App」对 singleTask 类做不到**
2. **强行尝试是破坏性的** —— 会把用户主屏上的任务搬走
3. **架构必须把「屏」当唯一互斥资源，不能把「App」当资源**

想要真正的 App 分身，只有多用户（`pm create-user`，上限 4），
代价是存储翻倍 + 每个用户重新登录（微信要扫码，有风控）。

---

## 二、架构

```
┌─────────────────────────────────────┐
│  MCP 进程 A   MCP 进程 B   DSH 插件  │   各自独立
└────────┬───────────┬──────────┬─────┘
         │           │          │
         └───────────┴──────────┘
                     │  HTTP POST /cmd
         ┌───────────▼───────────┐
         │   broker (vdisplayd)  │  ← 唯一裁决者
         │   屏池 / 租约 / 队列   │
         └───────────┬───────────┘
                     │
         ┌───────────▼───────────┐
         │  DisplayHost × N      │  每屏一个 app_process
         │  (现在是 scrcpy)      │
         └───────────────────────┘
```

**为什么必须单写者**：`vd.js` 的 state 是模块级单例，`start()` 从判空到写
`displayId` 中间有多段 await。两个客户端同时 start 会各建一块屏，而设备上有多块
scrcpy 屏时 `resolveScrcpySfId()` 会分不清（`vd.js:556`），之后所有截图都报歧义。

**已实现的部分**：daemon 加了 single-flight 互斥链，串行化
`start/stop/launch/input/shot/mainShot/text`，只读命令（status/focusedApp）不加锁。

---

## 三、三个实体

### Screen（屏）

```js
{
  screenId: 'sd-3',        // 对外唯一身份，一次开机内不复用
  displayId: 213,          // 只做 adb 参数，会被系统复用
  sfId: '1152921...',      // 转屏即换，每次操作前 refresh
  dpi: 323,                // 金丝雀：用来反查身份（见下）
  hostPid: 12345,          // DisplayHost 进程
  createdAt: 1794755723812,
}
```

**屏身份是最大的难点** —— 所有 scrcpy 屏都叫 `scrcpy`（U6 实测：scrcpy 5.0.1
没有 `vd_name` 参数），分不清谁是谁。

**可行方案：dpi 金丝雀**（U4 实测可行）

```
第 i 块屏用 dpi = 320 + i（差 1 dpi，肉眼无感）
之后从 dumpsys display 的 DisplayInfo density 反查是哪块
```

备用：串行创建 + displayId 差集（差集 ≠ 1 直接报 `E_AMBIGUOUS_DISPLAY`）。

### Lease（租约）

全局按包名唯一，`exclusive` 类型最多 1 个 active。

```js
{
  leaseId: 'ls-7',
  screenId: 'sd-3',
  pkg: 'com.tencent.mm',
  owner: 'session-abc',    // exec.agent.session.id
  mode: 'exclusive' | 'readonly',
  priority: 'user' | 'agent' | 'subagent',
  expiresAt: ...,
  preemptible: true,
  nonPreemptibleReason: null,   // 登录/支付/发送中由 AI 自报
}
```

### Session（会话）

一个会话最多持有 1 块屏（配额）。子代理默认「借父会话的屏，只读」。

---

## 四、占用检测

**关键认知：Android 不记录「谁在用 App」，只记录「task 在哪块屏」。**

所以分两层：

| 层 | 来源 | 管什么 |
|---|---|---|
| 事实层 | 系统查询 | 某包在哪些 display 上有 task、哪个有焦点、pid 是多少 |
| 归属层 | 自己记账 | 这块屏是哪个会话租的 |

**两层必须每次对账。** 只查系统不知是谁；只记账会撒谎（App 崩了、用户按返回了）。

### 查询（U1 实测可行，32ms）

```bash
dumpsys activity activities | grep -E 'Display #|Task\{.*A=[0-9]+:'
```

能读到 display 编号、taskId、包名、可见性、焦点。

### 占用等级

| 等级 | 含义 | 能不能动 |
|---|---|---|
| `FREE` | 没有 task | 可以 |
| `SOFT` | 只有进程，没 task | 可以 |
| `USER_BG` | 主屏有 task 但不在前台 | 谨慎 |
| `USER_ACTIVE` | 主屏前台就是它 | **禁止** |
| `AI_HELD` | 自家屏 + 有租约 | 按租约 |
| `ORPHAN` | 自家屏但无租约 | 可以回收 |
| `FOREIGN` | 外来屏（不是我们建的） | **永不碰** |

**利用一个事实**：私有屏用户看不见，**所以出现在 scrcpy 屏上的 task 100% 是 AI 的**。

### 三条不变式（写成 assertInvariants）

1. 一个 pkg 最多一个 active 的 exclusive lease
2. 一个 screenId 最多一个 owner
3. 记账里的 screenId 必须在系统查询里存在；不存在就报 `E_STATE_CONFLICT` 并禁止 destructive 操作

---

## 五、抢占

**核心原则：抢占 = 转移「屏的租约」，不是杀进程、不是 force-stop。**

App 的任务留在原屏，新持有者直接接手 —— UI 状态、滚动位置全保留。

### 流程

```
请求 → broker 校验
     → 给 victim 发 E_LEASE_REVOKING
     → 宽限 5 秒（victim 可提交 keep 说明为什么不能放）
     → 释放 → 授予
```

**宽限期只有 5 秒，而 AI 一轮往返 6-9 秒** —— 所以**「体面退场」不可能实现**，
只能保证「victim 知道自己被抢了、不再误操作」。

任何要求 AI 在宽限期内收尾的设计都是错的。

### 默认不抢

`onConflict` 默认 `'fail'`，冲突时返回三个选项让上层选：

```js
{ code: 'E_APP_BUSY', data: { next: ['wait', 'preempt', 'use_other_app'] } }
```

**默认抢占会变成 AI 互抢常态**，默认失败才逼出「先查再决定」。

---

## 六、给 AI 的工具

保留现有 12 个（向后兼容，改坏会崩所有对话），新增 5 个：

| 工具 | 干什么 |
|---|---|
| `screen_whoami` | 我的屏是哪块、剩多少时间、我的 App 是谁 |
| `screen_check_app(pkg)` | 这个 App 现在被占了吗、谁占的、能不能抢 |
| `screen_claim_app(pkg, {onConflict})` | 申请占用，默认 fail |
| `screen_release_app` | 释放 |
| `screen_pool` | 池里有几块屏、谁在用 |

**AI 怎么知道「我的屏是哪块」**：
`exec.agent.session.id` 能拿到（`defineTool` 的 `execute(args, exec)` 原样透传）。
现在 `index.js` 写成 `(a) => T.start(a)` 把 exec 丢了，要改成 `(a, e) => T.start(a, e)`。

**错误码**：20 个，统一带 `retryAfterMs` + `data.next.action` 枚举，
让 AI 能自己决定下一步（等 / 抢 / 交给人 / 改用 shell）。

---

## 七、资源上限

```
16GB / 8 核，系统常驻 4.5-6GB，留给应用约 8-10GB

每屏成本：
  display + 合成缓冲  10-25MB
  抓帧 2fps          0.28 核（实测）
  scrcpy-server 进程  75-185MB（实测）
  屏上的 App          80MB（轻）~ 1GB（微信）

内存上：轻 App 能开 10 块以上
真瓶颈是 CPU/热：4-6 块稳，8 块极限
```

**默认 4 块，硬上限 6**，用
`min(floor(核数/2), floor((MemAvailable-1200)/900), 6)` 动态算。

**关键风险**：DisplayHost 是 uid 2000 普通进程，oom_adj 不占优，
**比前台 App 先死，display 跟着宿主消失**。broker 必须监听屏消失，
重建后 screenId 不变、displayId 换新。

---

## 八、MVP 边界

**做**：
- broker 骨架 + `vd.js` 去单例化（逻辑零改动）
- 屏池 + dpi 金丝雀 + 租约账本
- 启动时 7 步对账
- 占用检测 L0-L6（先「只记录不决策」跑一天，再开决策）
- exclusive 租约 + 5s 宽限 + 5 新工具

**不做**：
- `shared_*`（同屏共用，坐标和焦点是屏级全局，做不到互不干扰）
- 用户确认 UI（只返回 `E_CONFIRM_REQUIRED`，让 AI 走 `ask_user_question`）
- 跨引擎联邦、远程 HTTP、metrics

---

## 九、还没验证的关键前提

| 编号 | 问题 | 影响 |
|---|---|---|
| U7 | force-stop 主屏后台 App 会丢什么 | 涉及用户数据，需用户同意才能测 |
| — | 自写 display host 能不能自定屏名 | 决定 A-02 能不能解决 |
| — | 多用户（`pm create-user`）在本机能不能后台启动 App | 决定 App 分身可不可行 |

前两个不解决，broker 只能做到「串行创建 + 差集 + 歧义即报错」，
并发创建被禁、重启后无法认领。
