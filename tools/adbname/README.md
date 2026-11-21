# adb 配对名：把 `root@localhost` 改成 `dsh@dsh-go`

## 为什么要这个

手机「设置 → 开发者选项 → 无线调试 → 已配对的设备」里，我们的 adb 显示成
**`root@localhost`**。这个名字有两个问题：

1. **`root@` 前缀在风控眼里等于自报 root**（实际只是 proot 容器里的假 root）
2. **认不出是谁的**，别人看到容易误删

## 名字是怎么来的

adb 配对时上报的客户端名 = `<用户名>@<主机名>`。

我们跑在 proot Ubuntu 容器里：`whoami` = root，`hostname` = localhost
→ 拼成 `root@localhost`。

`adb pair` **没有 `--name` 参数**，proot 里也改不了 hostname
（`hostname dsh-go` 静默失败，需要 CAP_SYS_ADMIN）。

## 解法：LD_PRELOAD 拦 gethostname / getpwuid

`shim.c` 编译成一个 .so，在 adb 进程里把 `gethostname()` 和 `getpwuid(0)` 的返回值改掉：

| 函数 | 原值 | 拦后 |
|---|---|---|
| `gethostname()` | localhost | **dsh-go** |
| `getpwuid(0).pw_name` | root | **dsh** |

实测（2026-11-21）：
- `hostname` → dsh-go ✅
- `whoami` → dsh ✅
- Python `socket.gethostname()` → dsh-go ✅（说明是系统调用级拦截）
- **adb 加载后功能完全正常**（`id -u` 仍返回 2000）✅

## 怎么用

**关键：名字只在「配对」那一刻生成**，配对完就存在手机里了。
所以**只在重新配对时**需要 shim，平时跑 adb 不用带。

```bash
# 1. 手机上：设置 → 开发者选项 → 无线调试 → 点 root@localhost → 取消配对
# 2. 手机上：无线调试 → 使用配对码配对设备 → 拿到 6 位码和端口
# 3. 在 proot 里（注意带 LD_PRELOAD）：
LD_PRELOAD=/root/workspace/dsh-go-second-screen/tools/adbname/libhname.so \
  adb pair 127.0.0.1:<配对端口>
# 输入 6 位码
# 4. 配对完成后，手机上那条记录应该显示 dsh@dsh-go
```

## 重新编译

```bash
gcc -shared -fPIC -O2 -o libhname.so shim.c
```

## 注意

- 重新配对会生成**新的 adb key**（`~/.android/adbkey` 会被覆盖），
  **之前的授权会失效**，需要重新 `adb connect` 一次并确认授权弹窗
- 配对端口每次都会变（无线调试的随机端口），不是固定的 5555
- 我们用的是 `adb tcpip 5555` 之后的回环连接，pair 只是首次授权用
