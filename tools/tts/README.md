# 小米 MiMo TTS 接入说明

## 一、你要做的（只有你能做）

1. 打开 `platform.xiaomimimo.com`
2. **小米账号登录**（免费使用不需要实名）
3. 控制台 → API Keys → 创建 → 复制 `sk-xxxxx`

## 二、我这边启动代理

```bash
cd tts-server
export MIMO_API_KEY=sk-你复制的那个
nohup python3 mimo_tts_proxy.py 8766 > /tmp/mimo-proxy.log 2>&1 &
```

## 三、App 里填

```
她的声音 → 声音来源 → OpenAI 兼容接口

Base URL:  http://127.0.0.1:8766/v1
API Key:   随便填（比如 sk-local）
模型:      mimo-v2.5-tts
音色:      冰糖
```

## 四、音色怎么选

### 预设音色
```
冰糖 / 茉莉 / 苏打 / 白桦   （中文名）
Mia / Chloe / Milo / Dean   （英文名）
mimo_default
```

### 带风格控制（推荐）
写法：`风格@预设`

```
慵懒 刚睡醒 有点沙哑@冰糖
二十七八岁成熟女性，声音低沉有磁性@茉莉
撒娇 夹子音@苏打
深情款款 语速慢@冰糖
压抑的愤怒@白桦
带着哽咽的笑意@茉莉
```

### 只写风格（用默认音色）
```
二十七八岁的成熟女性，声音低沉有磁性，语速偏慢，带着一点慵懒和漫不经心
```

## 五、正文里还能插音频标签

这些标签插在要念的话里，任意位置：

| 类别 | 标签 |
|---|---|
| 语速节奏 | [吸气] [深呼吸] [叹气] [长叹一口气] [喘息] [屏息] |
| 语音特征 | [气声] [鼻音] [沙哑] [颤抖] [变调] [破音] |
| 情绪 | [紧张] [害怕] [激动] [疲惫] [委屈] [撒娇] [心虚] [震惊] [不耐烦] |
| 哭笑 | [轻笑] [大笑] [冷笑] [抽泣] [呜咽] [哽咽] [嚎啕大哭] |

例：
```
[气声]主人……[轻笑]今天也要好好努力哦。
```

## 六、改默认风格

不想每次写风格，改环境变量：

```bash
export MIMO_TTS_STYLE="慵懒 漫不经心 声音低沉有磁性"
```

或者直接改 `mimo_tts_proxy.py` 里的 `DEFAULT_STYLE`。

## 七、端点会自动识别

代理按 key 前缀自动选端点，不用你操心：

| key 格式 | 端点 |
|---|---|
| `sk-xxxxx`（按量付费） | `https://api.xiaomimimo.com/v1` |
| `tp-xxxxx`（Token Plan 中国） | `https://token-plan-cn.xiaomimimo.com/v1` |
| `ttp-xxxxx`（Token Plan 团队） | 同上 |

**这两条线互不通用，弄错直接 401。** 官方 Token Plan 快速接入页和 MiMo-Code issue #2280
的实测对照表都确认了这一点。

要手动覆盖：`export MIMO_API_BASE=https://token-plan-sgp.xiaomimimo.com/v1`

## 八、注意

1. **限时免费**，官方没公布结束时间，随时可能收费
2. **不要开着代理不管**：它在 127.0.0.1 上，外网访问不到，但会占一个进程
3. 重启手机会没掉，要重新跑第二步

## 九、排错

看日志：
```bash
tail -20 /tmp/mimo-proxy.log
```

常见问题：
- `401` → API Key 错了或过期
- `404` → API_BASE 不对，用 `export MIMO_API_BASE=https://api.mimo.mi.com/v1` 试试
- `返回里没有 audio.data` → 模型名不对，确认是 `mimo-v2.5-tts`
