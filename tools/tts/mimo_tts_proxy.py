#!/usr/bin/env python3
"""
小米 MiMo TTS → OpenAI 兼容代理

为什么要这层：
    DSH Go 的「她的声音 → OpenAI 兼容接口」发的是 OpenAI 格式
        POST /v1/audio/speech  {"input": "...", "voice": "...", "speed": 1.0}
    返回 audio/mpeg。

    但 MiMo 的 TTS 是 chat/completions 风格：
        POST /v1/chat/completions
            {"model": "mimo-v2.5-tts",
             "messages": [{"role": "user",      "content": "<风格指令>"},
                          {"role": "assistant", "content": "<要念的正文>"}],
             "audio": {"format": "mp3", "voice": "mimo_default"}}
    返回 choices[0].message.audio.data（base64）。

    这个脚本把前者翻译成后者。

用法：
    export MIMO_API_KEY=sk-xxxxx
    python3 mimo_tts_proxy.py [端口]

    App 里填：
        Base URL: http://127.0.0.1:8766/v1
        API Key:  随便（本代理不校验）
        模型:     mimo-v2.5-tts

音色（voice 字段）支持三种写法：
    1. 预设名：mimo_default / 冰糖 / 茉莉 / 苏打 / 白桦 / Mia / Chloe / Milo / Dean
    2. 带风格：写作 "<风格>@<预设>"，例如
           "慵懒 刚睡醒 有点沙哑@冰糖"
    3. 纯风格描述（不含 @ 且不是预设名）：当作风格指令，音色用默认
           例如 "二十七八岁成熟女性，声音低沉有磁性，语速偏慢"

风格可以用 MiMo 的音频标签，例如：
    "[气声]主人...[轻笑]今天也要好好努力哦。"
    风格指令 "慵懒 刚睡醒 有点沙哑" + 正文里的 [低语] 标签可以叠加
"""

import base64
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------- 配置

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766

API_KEY = os.environ.get("MIMO_API_KEY", "").strip()
# MiMo 的 OpenAI 兼容网关；不同区域可能不同，可用环境变量覆盖
API_BASE = os.environ.get("MIMO_API_BASE", "https://api.xiaomimimo.com/v1").rstrip("/")
MODEL = os.environ.get("MIMO_TTS_MODEL", "mimo-v2.5-tts")

# 预设音色。国内文档列的是中文名，海外是英文名，两套都放进来。
PRESETS = {
    # 海外名
    "mia", "chloe", "milo", "dean",
    # 国内名
    "冰糖", "茉莉", "苏打", "白桦",
    # 默认
    "mimo_default",
}

# 默认风格：想要"她"的性格，改这里，或者在 voice 里用 @ 覆盖。
DEFAULT_STYLE = os.environ.get(
    "MIMO_TTS_STYLE",
    "二十七八岁的成熟女性，声音低沉有磁性，语速偏慢，带着一点慵懒和漫不经心",
)

# OpenAI 那套音色名 → (预设, 风格)。App 默认会发 alloy，映射到最接近御姐的。
VOICE_MAP = {
    "alloy":   ("冰糖", "二十七八岁的成熟女性，声音低沉有磁性，语速偏慢，带着一点慵懒和漫不经心"),
    "echo":    ("Dean", "二十多岁的年轻男性，声音干净"),
    "fable":   ("茉莉", "温柔的女性声音，语速平缓"),
    "onyx":    ("Dean", "中年男性，声音沉稳有磁性"),
    "nova":    ("苏打", "活泼的年轻女性"),
    "shimmer": ("茉莉", "明亮的女性声音"),
    "zh-CN-XiaoxiaoNeural": ("茉莉", "温柔的女性声音"),
    "zh-CN-XiaoyiNeural":   ("冰糖", "活泼的年轻女性"),
}


def resolve_voice(voice_field: str):
    """把 App 传来的 voice 字段解析成 (预设音色, 风格指令)。"""
    v = (voice_field or "").strip()
    if not v:
        return "mimo_default", DEFAULT_STYLE

    # 写法 2： "<风格>@<预设>"
    if "@" in v:
        style, preset = v.rsplit("@", 1)
        style, preset = style.strip(), preset.strip()
        return (preset or "mimo_default"), (style or DEFAULT_STYLE)

    low = v.lower()

    # 写法 1：预设名
    if low in PRESETS or v in PRESETS:
        preset = v if v in PRESETS else low
        # OpenAI 的标准名走映射表（带默认风格）
        if low in VOICE_MAP:
            return VOICE_MAP[low]
        return preset, DEFAULT_STYLE

    # OpenAI 标准名
    if low in VOICE_MAP:
        return VOICE_MAP[low]

    # 写法 3：纯风格描述
    return "mimo_default", v


def synth(text: str, voice: str, fmt: str = "mp3", speed: float = 1.0) -> bytes:
    """调 MiMo，返回音频字节。"""
    preset, style = resolve_voice(voice)

    # 语速：MiMo 靠自然语言控制，把倍率翻译成一句描述
    if abs(speed - 1.0) > 0.02:
        if speed < 1.0:
            style = f"{style}，语速放慢到原来的 {speed:.2f} 倍"
        else:
            style = f"{style}，语速加快到原来的 {speed:.2f} 倍"

    payload = {
        "model": MODEL,
        "messages": [
            {"role": "user", "content": style},
            {"role": "assistant", "content": text},
        ],
        "audio": {"format": fmt, "voice": preset},
    }

    req = urllib.request.Request(
        f"{API_BASE}/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=120) as r:
        body = json.loads(r.read().decode("utf-8"))

    # 优先取 audio.data，兼容几种可能的返回结构
    audio_b64 = None
    try:
        msg = body["choices"][0]["message"]
        if isinstance(msg.get("audio"), dict):
            audio_b64 = msg["audio"].get("data")
        if not audio_b64:
            audio_b64 = msg.get("audio")
    except (KeyError, IndexError, TypeError):
        pass

    if not audio_b64 or not isinstance(audio_b64, str):
        raise RuntimeError(f"返回里没有 audio.data：{json.dumps(body, ensure_ascii=False)[:300]}")

    # 可能是 data URI
    if audio_b64.startswith("data:"):
        audio_b64 = audio_b64.split(",", 1)[-1]

    return base64.b64decode(audio_b64)


# ---------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[mimo-proxy] {self.address_string()} {fmt % args}\n")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path.rstrip("/")
        if p in ("/v1/models", "/models"):
            return self._json(200, {
                "object": "list",
                "data": [{"id": MODEL, "object": "model", "owned_by": "xiaomi-mimo"}],
            })
        if p in ("", "/health"):
            return self._json(200, {
                "ok": True,
                "service": "mimo-tts-openai-proxy",
                "model": MODEL,
                "api_base": API_BASE,
                "api_key_set": bool(API_KEY),
                "presets": sorted(PRESETS),
            })
        return self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/audio/speech", "/audio/speech"):
            return self._json(404, {"error": {"message": "not found"}})

        if not API_KEY:
            return self._json(500, {"error": {"message": "没设置 MIMO_API_KEY 环境变量"}})

        try:
            n = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._json(400, {"error": {"message": f"请求不是合法 JSON: {e}"}})

        text = (data.get("input") or "").strip()
        if not text:
            return self._json(400, {"error": {"message": "input 不能为空"}})

        voice = data.get("voice") or "alloy"
        try:
            speed = float(data.get("speed") or 1.0)
        except Exception:
            speed = 1.0

        # MiMo 单次上限 8K tokens，粗略按 2000 字截断
        if len(text) > 2000:
            text = text[:2000]

        try:
            audio = synth(text, voice, fmt="mp3", speed=speed)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            sys.stderr.write(f"[mimo-proxy] MiMo 返回 {e.code}: {detail}\n")
            return self._json(502, {"error": {"message": f"MiMo 返回 {e.code}: {detail}"}})
        except Exception as e:
            sys.stderr.write(f"[mimo-proxy] 合成失败: {e}\n")
            return self._json(500, {"error": {"message": f"合成失败: {e}"}})

        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)


if __name__ == "__main__":
    if not API_KEY:
        print("[mimo-proxy] 警告：没设 MIMO_API_KEY，请求会返回 500", file=sys.stderr)
    print(f"[mimo-proxy] 监听 http://127.0.0.1:{PORT}/v1")
    print(f"[mimo-proxy] 上游 {API_BASE}  模型 {MODEL}")
    print(f"[mimo-proxy] 预设音色 {', '.join(sorted(PRESETS))}")
    print("[mimo-proxy] App 里 Base URL 填 http://127.0.0.1:%d/v1" % PORT)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[mimo-proxy] 已停止")
