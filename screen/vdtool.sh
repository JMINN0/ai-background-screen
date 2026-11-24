#!/bin/bash
# 快速调 daemon 的工具：./vdtool.sh <工具名> '<json参数>'
# 比 node -e 快 5-15 倍（不用冷启动整个插件）
D=$(cat /tmp/vd_addr.txt 2>/dev/null)
if [ -z "$D" ]; then
  D=$(grep -oE 'listening on [0-9.:]+' /tmp/vd_*.log 2>/dev/null | tail -1 | sed 's/listening on //')
  echo "$D" > /tmp/vd_addr.txt
fi
TOOL="$1"
ARGS="${2:-{\}}"
curl -s --noproxy '*' -m 120 -X POST "http://$D/cmd" \
  -H 'content-type: application/json' \
  -d "{\"action\":\"runTool\",\"args\":{\"tool\":\"$TOOL\",\"args\":$ARGS}}" 2>/dev/null \
| python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print('解析失败:', e); sys.exit(0)
r = d.get('result', {})
# 双层包裹：result.result
if isinstance(r, dict) and 'result' in r:
    r = r['result']
if isinstance(r, dict):
    print(r.get('text', json.dumps(r, ensure_ascii=False)))
else:
    print(json.dumps(d, ensure_ascii=False)[:500])
"
