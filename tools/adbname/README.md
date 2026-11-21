# adb 配对名：`root@localhost` → `dsh-go@go`

## 为什么要改

手机上「设置 → 开发者选项 → 无线调试 → 已配对的设备」里，我们的 adb 显示成
**`root@localhost`**：

1. `root@` 前缀看着像自报 root（实际只是 proot 容器里的假 root）
2. **认不出是谁的**，别人看到容易误删 —— 这是用户真实的诉求

## 名字怎么来的（AOSP 源码）

`packages/modules/adb/crypto/rsa_2048_key.cpp` → `CalculatePublicKey()`：

```cpp
out->append(" ");
out->append(sysdeps::GetLoginNameUTF8());
out->append("@");
out->append(sysdeps::GetHostNameUTF8());
```

`packages/modules/adb/sysdeps/env.cpp`：

```cpp
kHostNameEnvVar[] = "HOSTNAME";    // 先读环境变量
kUserNameEnvVar[] = "LOGNAME";     // 非空就用，否则回退 gethostname/getlogin
```

所以名字 = **`$LOGNAME@$HOSTNAME`**，两个环境变量都能直接覆盖。

名字**藏在公钥串尾部**，随公钥一起发给手机，手机存进 `/data/misc/adb/adb_keys` 的第二列，
Settings 只是原样显示那一列。

## 怎么改（一行命令）

```bash
# 手机上：无线调试 → 使用配对码配对设备 → 记下 IP:端口 和 6 位码
LOGNAME=dsh-go HOSTNAME=go adb pair 127.0.0.1:<配对端口> <6位码>
```

结果：`dsh-go@go`

**实测验证**（2026-11-21，用 `adb keygen` 生成到临时目录，不动现有 key）：

| 环境变量 | 生成的名字 |
|---|---|
| 不设 | `root@localhost` |
| `LOGNAME=dsh-go HOSTNAME=go` | **`dsh-go@go`** |

## 注意事项

- **不要 `adb kill-server`**：名字是 client 进程算的，跟 server 无关，kill 反而断你现有连接
- **不要改 `~/.android/adbkey.pub`**：客户端每次从私钥重算，不读这个文件
- 旧的 `root@localhost` 条目要手动 Forget 掉（AOSP 的已配对设备页只有「删除」，没有重命名）
- 重新配对可能**重新生成 adbkey** → 原有授权失效，需要重新 `adb connect` 并确认授权弹窗
- 配对端口每次随机，跟连接端口 5555 不是同一个

## 这个改动对风控有用吗

**没有。** 第三方 App（包括 QQ）**读不到**这份列表：

- `AdbManager` 整个类是 `@SystemApi`，相关方法要 `MANAGE_DEBUGGING` 权限
- `MANAGE_DEBUGGING` 是 `signature|privileged`，只有系统签名 App 拿得到
- `/data/misc/adb` 是 `adb_keys_file` 标签，`untrusted_app` 域连目录都进不去
- 走 `dumpsys` 也要 `android.permission.DUMP`

**所以这是「给人看」的问题，不是「给 App 识别」的问题。** 缓解的是误删风险，不是风控。

## 旧方案（LD_PRELOAD，已不需要但保留）

`shim.c` + `libhname.so` 用 LD_PRELOAD 拦 `gethostname`/`getpwuid`，也能达到同样效果。
**但环境变量方案更简单，优先用环境变量。** LD_PRELOAD 留作万一环境变量被某些 adb 版本忽略时的兜底。

---

# 附：配对流程为什么这么别扭，以及怎么让 AI 代劳

## 那个「必须停留在界面」的限制

安卓的无线调试配对码有个硬性行为：

> **「使用配对码配对设备」弹窗一关（切 App、切后台、锁屏、超时），
> 配对码和配对端口立刻作废，必须重新点开拿新的。**

所以「人肉抄码 → 切到终端 → 输入」这个流程天然别扭：
你切走的瞬间，码就没了。

## 三种可行姿势

### ① 准备好命令再弹码（纯手工，最稳）

1. 在终端里把命令敲好，**不要按回车**：
   ```bash
   LOGNAME=dsh-go HOSTNAME=go adb pair 127.0.0.1:
   ```
2. 再在手机上点「使用配对码配对设备」，抄下端口和 6 位码
3. **不要切 App**（用分屏、或手快）补全端口后回车

### ② 让 AI 代劳（推荐，我们有 adb + 无障碍）

AI 可以：
1. 用 `am start` 打开无线调试页
2. 用 `screencap` + OCR **读出配对码和端口**（不用你抄）
3. 在 proot 侧执行 `adb pair`（**不切手机界面，码不会失效**）

这是 Shizuku 等 App 走「通知栏输入配对码」的同类思路 —— 都是为了绕开
「一离开界面就作废」这个限制。

### ③ 配对后再连（两种连接端口）

| 阶段 | 端口 | 说明 |
|---|---|---|
| 配对 | 随机（如 37123） | 只在配对那一两分钟有效 |
| 连接 | 无线调试主页显示的端口（如 41000） | 长期有效，直到关无线调试 |

配对完成后用**连接端口** `adb connect`，然后 `adb tcpip 5555` 把端口固定到 5555，
之后关 WiFi 也能用（5555 绑回环）。

## 为什么 Shizuku / GKD 能在通知栏输码

它们把自己注册成「配对服务」的客户端，用 `AdbManager` 的 pairing 流程
（`@SystemApi`，需要 `MANAGE_DEBUGGING` 权限）在**不切界面**的情况下拿码。

我们没有系统签名，走不了那条路 —— 但「AI 读屏 + 自己执行 adb pair」
效果等价：**码在你手机上显示的同时，AI 在另一侧把它用掉。**
