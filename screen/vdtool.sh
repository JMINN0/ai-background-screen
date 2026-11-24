#!/bin/bash
# 快速调 daemon 的工具：./vdtool.sh <工具名> '<json参数>'
# 比 node -e 快 5-15 倍（不用冷启动整个插件）
D=$(cat /tmp/vd_addr.txt 2>/dev/null)
if [ -z "$D" ]; then
  echo "❌ daemon 地址不知道（/tmp/vd_addr.txt 为空）—— 先启动 vdisplayd.mjs" >&2
  exit 1
fi
TOOL="$1"
if [ -z "$TOOL" ]; then
  echo "用法: $0 <工具名> ['<json参数>']" >&2
  exit 1
fi
ARGS="${2:-{\}}"
# JSON 合法性先验一下；不合法就直接报错，别让 curl 发出去再静默变 {}
if ! printf '%s' "$ARGS" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
  echo "❌ 参数不是合法 JSON: $ARGS" >&2
  exit 1
fi
curl -s --noproxy '*' -m 120 -X POST "http://$D/cmd" \
  -H 'content-type: application/json' \
  -d "{\"action\":\"runTool\",\"args\":{\"tool\":\"$TOOL\",\"args\":$ARGS}}" 2>/dev/null \
| python3 -c "
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    print('❌ daemon 没返回（可能没起来，或 URL 不对）'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception as e:
    print('❌ 返回不是 JSON:', raw[:200]); sys.exit(1)
if not d.get('ok'):
    print('❌ daemon 报错:', d.get('error') or d.get('hint') or json.dumps(d, ensure_ascii=False)[:300])
    sys.exit(1)
r = d.get('result')
# 剥掉可能的层层包裹，直到不是 {'result': {...}} 为止
while isinstance(r, dict) and isinstance(r.get('result'), dict):
    r = r['result']
if isinstance(r, dict):
    # daemon 内层也可能报错
    if r.get('ok') is False:
        print('❌ 工具报错:', r.get('hint') or r.get('text') or json.dumps(r, ensure_ascii=False)[:300])
        sys.exit(1)
    print(r.get('text') or r.get('hint') or json.dumps(r, ensure_ascii=False))
elif r is None:
    print('（工具没有返回内容）')
else:
    print(r)
"
