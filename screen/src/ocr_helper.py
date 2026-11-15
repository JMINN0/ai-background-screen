#!/usr/bin/env python3
"""
ocr_helper.py — 常驻 OCR 服务，给 Node 侧调用。

为什么是常驻而不是每次起一个：RapidOCR 加载模型要 3-5 秒，每次调用都重新加载
就没法用了（一次识别才 1.6 秒）。所以这里保持进程活着，模型只加载一次。

协议：stdin 一行一个 JSON 请求，stdout 一行一个 JSON 响应。
  {"id":1,"image":"/tmp/a.png","minConf":0.45,"maxLines":80}
  → {"id":1,"ok":true,"lines":[{"text":..,"conf":..,"x":..,"y":..,"w":..,"h":..}],"elapsedMs":..}
  → {"id":1,"ok":false,"hint":"..."}

启动后先输出 {"ready":true} 表示模型加载好了。
"""

import sys
import json
import time


def main():
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as e:
        print(json.dumps({"ready": False, "error": f"rapidocr 未安装: {e}"}), flush=True)
        return

    try:
        # det_limit_side_len=320：实测比默认 736 快 2.5 倍（4.5s → 1.6s），
        # 文本框从 101 降到 96，关键文案 6/6 全保留。
        engine = RapidOCR(
            det_limit_side_len=320,
            det_limit_type="min",
            intra_op_num_threads=6,
        )
        # 预热：先跑一张 1x1 的假图，把第一个 conv 的分配做完
        from PIL import Image
        import tempfile
        import os

        tmp = os.path.join(tempfile.gettempdir(), "_ocr_warm.png")
        Image.new("RGB", (64, 64), (255, 255, 255)).save(tmp)
        try:
            engine(tmp)
        except Exception:
            pass
        try:
            os.remove(tmp)
        except Exception:
            pass
    except Exception as e:
        print(json.dumps({"ready": False, "error": f"模型加载失败: {e}"}), flush=True)
        return

    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        path = req.get("image")
        min_conf = float(req.get("minConf") or 0.45)
        max_lines = int(req.get("maxLines") or 80)

        if not path:
            print(json.dumps({"id": rid, "ok": False, "hint": "缺 image 路径"}), flush=True)
            continue

        t0 = time.time()
        try:
            out = engine(path)
            raw = out[0] if isinstance(out, tuple) else out
        except Exception as e:
            print(json.dumps({"id": rid, "ok": False, "hint": f"识别失败: {e}"}), flush=True)
            continue

        if not raw:
            print(json.dumps({"id": rid, "ok": True, "lines": [], "count": 0,
                              "elapsedMs": int((time.time() - t0) * 1000)}), flush=True)
            continue

        lines = []
        for item in raw:
            try:
                box = item[0]
                text = str(item[1]).strip()
                conf = float(item[2])
            except Exception:
                continue
            if not text or conf < min_conf:
                continue
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            x, y = min(xs), min(ys)
            lines.append({
                "text": text,
                "conf": round(conf, 2),
                "x": int(round(x)),
                "y": int(round(y)),
                "w": int(round(max(xs) - x)),
                "h": int(round(max(ys) - y)),
            })

        # 按行分带排序：同一行的字按 x 排，不同行按 y
        lines.sort(key=lambda l: (l["y"] // 14, l["x"]))
        total = len(lines)
        lines = lines[:max_lines]

        print(json.dumps({
            "id": rid,
            "ok": True,
            "lines": lines,
            "count": len(lines),
            "total": total,
            "elapsedMs": int((time.time() - t0) * 1000),
        }), flush=True)


if __name__ == "__main__":
    main()
