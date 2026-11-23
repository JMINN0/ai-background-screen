package com.dsh.overlay;

import android.app.Activity;
import android.hardware.display.DisplayManager;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;
import android.view.Display;

/**
 * **探针：以普通 App 的身份打印「我能看到几块屏」。**
 *
 * 为什么需要它：虚拟屏到底对别的 App 可不可见，用 `dumpsys display` 验不出来 ——
 * dumpsys 是 uid 2000(shell) 在跑，而 shell 就是虚拟屏的属主，它当然全看得见。
 * 要验的是**非属主 App** 的视角，所以只能在 App 进程里跑（本 APK 的 uid 不是 2000）。
 *
 * 用法：
 *   adb shell am start -n com.dsh.overlay/.ProbeActivity
 *   adb logcat -d | grep DSH_PROBE
 *
 * 判据：
 *   - 虚拟屏**可见** → 列表里出现 type=VIRTUAL、displayId 很大、名字是 scrcpy 或别的
 *   - 虚拟屏**不可见** → 列表里只有 displayId 0
 *
 * 注意：`getOwnerPackageName()` / `getFlags()` 是隐藏 API，编译用的 android-30.jar
 * 里没有，所以走反射。数量级不是问题，探针本来就是排查用的。
 */
public class ProbeActivity extends Activity {
    private static final String TAG = "DSH_PROBE";

    /** 反射调无参方法，失败返回 "?"。 */
    private static String call(Object target, String method) {
        try {
            java.lang.reflect.Method m = target.getClass().getMethod(method);
            Object r = m.invoke(target);
            return String.valueOf(r);
        } catch (Throwable t) {
            return "?(" + t.getClass().getSimpleName() + ")";
        }
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        try {
            int uid = Process.myUid();
            String pkg = getPackageName();
            DisplayManager dm = (DisplayManager) getSystemService(DISPLAY_SERVICE);
            Display[] ds = dm.getDisplays();

            Log.i(TAG, "===== PROBE START =====");
            Log.i(TAG, "caller uid=" + uid + " pkg=" + pkg);
            Log.i(TAG, "getDisplays() count=" + ds.length);

            for (Display d : ds) {
                String name;
                try { name = String.valueOf(d.getName()); } catch (Throwable t) { name = "?"; }
                String owner = call(d, "getOwnerPackageName");
                String ownerUid = call(d, "getOwnerUid");
                String flags = call(d, "getFlags");
                int w = -1, h = -1;
                try {
                    Display.Mode m = d.getMode();
                    if (m != null) { w = m.getPhysicalWidth(); h = m.getPhysicalHeight(); }
                } catch (Throwable t) { /* ignore */ }
                Log.i(TAG, "display id=" + d.getDisplayId()
                        + " name=" + name
                        + " type=" + call(d, "getType")
                        + " flags=" + flags
                        + " owner=" + owner
                        + " ownerUid=" + ownerUid
                        + " valid=" + d.isValid()
                        + " state=" + d.getState()
                        + " res=" + w + "x" + h
                        + " hz=" + d.getRefreshRate());
            }
            /* **探测：普通 App 能不能读到系统属性。**
             *
             * 背景：每次建虚拟屏，我们都会 setprop debug.sf.enable_hwc_vds 1。
             * 这个属性名里直接写着 vds（virtual displays）。如果普通 App 读得到，
             * 那 QQ 的反作弊也能读到 —— 它会看到「这台机器开了虚拟显示硬件合成」，
             * 这是「有人在跑虚拟屏」的铁证。
             *
             * 用反射读 android.os.SystemProperties（@hide），这是 App 读属性的常见手段。
             */
            try {
                Class<?> sp = Class.forName("android.os.SystemProperties");
                java.lang.reflect.Method get = sp.getMethod("get", String.class);
                String[] keys = {
                    "debug.sf.enable_hwc_vds",
                    "vendor.display.vds_allow_hwc",
                    "service.adb.tcp.port",
                    "ro.debuggable",
                    "ro.build.type",
                    "init.svc.adbd",
                };
                for (String k : keys) {
                    String v;
                    try { v = String.valueOf(get.invoke(null, k)); }
                    catch (Throwable t) { v = "?(read-failed:" + t.getClass().getSimpleName() + ")"; }
                    Log.i(TAG, "prop " + k + " = " + v);
                }
            } catch (Throwable t) {
                Log.i(TAG, "prop probe failed: " + t);
            }

            /* 探测：Settings.Global.ADB_ENABLED（零权限可读） */
            try {
                int adbOn = android.provider.Settings.Global.getInt(
                        getContentResolver(), android.provider.Settings.Global.ADB_ENABLED, -1);
                Log.i(TAG, "ADB_ENABLED = " + adbOn);
            } catch (Throwable t) {
                Log.i(TAG, "ADB_ENABLED read failed: " + t);
            }

            /* 探测：已启用的无障碍服务（Settings.Secure，零权限可读） */
            try {
                String acc = android.provider.Settings.Secure.getString(
                        getContentResolver(), android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
                Log.i(TAG, "accessibility = " + acc);
            } catch (Throwable t) {
                Log.i(TAG, "accessibility read failed: " + t);
            }

            Log.i(TAG, "===== PROBE END =====");
        } catch (Throwable t) {
            Log.e(TAG, "probe failed: " + t);
        }
        finish();
    }
}
