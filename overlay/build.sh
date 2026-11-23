#!/bin/bash
# 编译悬浮窗 APK：javac → d8 → aapt → zipalign → apksigner。
set -e
# **先算绝对路径再 cd**：$0 可能是相对路径（如 overlay/build.sh），
# cd 之后再用 $0 算会重复叠一层（overlay/overlay/...），脚本就静默失败。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"
SDK="$ROOT_DIR/tools/sdk"
BT=/usr/lib/android-sdk/build-tools/debian
ADB="adb -s ${DSH_ADB_TARGET:-127.0.0.1:5555}"

[ -f "$SDK/android-30.jar" ] || { echo "缺 android-30.jar"; exit 1; }
[ -f "$SDK/r8.jar" ] || { echo "缺 r8.jar"; exit 1; }

# **签名密钥：不提交进仓库。**
#
# 历史教训（2026-11-24）：早期版本把这个 .jks 提交进了 git，
# 密码也明写在脚本里 —— 任何拿到仓库的人都能签出 Android 认可的
# 「官方更新」APK 覆盖 com.dsh.overlay。已经换了新密钥，
# 但旧密钥仍在 git 历史里，只能靠改包名或重建仓库彻底消除。
#
# 现在：密钥存在 build/（已被 .gitignore 排除），密码从环境变量读，
# 没设就用下面这个开发用的默认值。发布前请务必换成自己的。
KS_PASS="${DSH_KS_PASS:-dsh123456}"

[ -f build/dsh-release.jks ] || {
  echo "生成签名密钥（首次构建）…"
  mkdir -p build
  keytool -genkeypair -v -keystore build/dsh-release.jks -alias dsh \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=AI Background Screen, OU=Dev, O=OSS, L=CN, S=CN, C=CN" 2>&1 | tail -1
}

rm -rf build/classes && mkdir -p build/classes
javac -source 8 -target 8 -nowarn -cp "$SDK/android-30.jar" -d build/classes src/com/dsh/overlay/*.java
java -cp "$SDK/r8.jar" com.android.tools.r8.D8 --min-api 26 --release \
  --lib "$SDK/android-30.jar" --output build/ build/classes/com/dsh/overlay/*.class

cd build
rm -f app-*.apk
$BT/aapt package -f -M ../AndroidManifest.xml -I "$SDK/android-30.jar" -F app-u.apk
$BT/aapt add -f app-u.apk classes.dex >/dev/null
$BT/zipalign -f 4 app-u.apk app-a.apk
$BT/apksigner sign --ks dsh-release.jks --ks-key-alias dsh \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out app-s.apk app-a.apk
echo "✅ APK $(stat -c%s app-s.apk) 字节"

cp app-s.apk ../../screen/assets/overlay/ai-overlay.apk
echo "✅ 已更新内置 APK"
# **换了签名密钥之后必须先卸载**，否则 adb install -r 会报
# INSTALL_FAILED_UPDATE_INCOMPATIBLE（新旧签名不一致）。
# 这个 APK 没有用户数据，卸载不丢东西。
if ! $ADB install -r app-s.apk 2>&1 | grep -q Success; then
  echo "签名不一致（换过密钥？），先卸载再装…"
  $ADB uninstall com.dsh.overlay >/dev/null 2>&1 || true
  $ADB install app-s.apk 2>&1 | tail -1
fi
