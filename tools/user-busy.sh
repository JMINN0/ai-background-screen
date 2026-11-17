#!/system/bin/sh
# user-busy.sh —— 动前台之前必须先问的一句：「用户正在用吗？」
#
# 用法（在 bash 里）：
#   if sh tools/user-busy.sh; then echo "用户在用，别抢"; fi
#
# 退出码：
#   0 = 用户正在用（前台是 DSH Go，或键盘挂着）
#   1 = 可以操作
#
# 为什么需要它（2026-11-17 事故）：
#   我用 `mcp__phone__open(url)` 打开 Edge，Edge 切到前台，
#   用户正在 DSH Go 里打字，输入法的 InputConnection 被 detach，
#   键盘被抢走、正在拼的字丢了。
#
# 更危险的：`adb shell input text` 在 display 0 上会把文字拼进用户草稿，
# `input keyevent 66`（回车）可能把草稿直接发出去。

A="adb -s 127.0.0.1:5555 shell"

# ① 前台是谁
FRONT=$($A "dumpsys activity activities 2>/dev/null | grep -m1 -E 'topResumedActivity' " 2>/dev/null)

# ② DSH Go 在前台吗（这是用户跟我对话的地方，必须让）
case "$FRONT" in
  *dsh_app*|*io.github.ccch1mneyyy.dsh_app*)
    echo "BUSY: DSH Go 在前台（用户正在跟我说话）"
    exit 0
    ;;
esac

# ③ 键盘挂着吗
IME=$($A "dumpsys input_method 2>/dev/null | grep -m1 -E 'mInputShown=true'" 2>/dev/null)
case "$IME" in
  *mInputShown=true*)
    echo "BUSY: 输入法正在显示（用户可能正在打字）"
    exit 0
    ;;
esac

echo "OK: 用户没在前台交互"
exit 1
