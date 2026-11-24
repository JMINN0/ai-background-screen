package com.dsh.overlay;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.lang.reflect.Method;

/**
 * **实验：能不能让普通 App 把「别人拥有的虚拟屏」镜像到自己的 SurfaceView 上？**
 *
 * 这是第一性原理审查（2026-11-24）提的「Surface 直通」路线的第一步验证。
 *
 * 如果这条路成立，现在的整条浮窗链路可以砍掉：
 *
 *   现在（13 步）：
 *     App渲染 → 镜像屏 → ImageReader → 逐像素RGBA→ARGB → Bitmap
 *     → 缩400px → JPEG → HTTP → 浮窗解码 → ImageView
 *
 *   直通（3 步）：
 *     App渲染 → 框架合成 → 我的 SurfaceView
 *
 * 需要验证的只有一件事：**跨 uid 的 displayIdToMirror 能不能用。**
 * 屏 909 是 com.android.shell 创建的，本 App 是 uid 10897。
 * 能枚举到（getDisplays 里有）不代表能镜像 —— 镜像有自己的权限检查。
 *
 * 用法：
 *   adb shell am start -n com.dsh.overlay/.SurfaceProbeActivity --ei display 909
 *   adb logcat -d | grep DSH_SURFACE
 *
 * 结果在 logcat 和屏幕文字上都有。
 */
public class SurfaceProbeActivity extends Activity {
    private static final String TAG = "DSH_SURFACE";

    private SurfaceView sv;
    private TextView tv;
    private VirtualDisplay vd;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        int displayId = getIntent().getIntExtra("display", -1);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        sv = new SurfaceView(this);
        root.addView(sv, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        tv = new TextView(this);
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(13);
        tv.setPadding(24, 24, 24, 24);
        tv.setText("DSH_SURFACE probe\ndisplayId=" + displayId + "\n等 SurfaceView 就绪…");
        root.addView(tv, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP));

        setContentView(root);

        log("start", "displayId=" + displayId);

        final int did = displayId;
        sv.getHolder().addCallback(new SurfaceHolder.Callback() {
            @Override public void surfaceCreated(SurfaceHolder h) {
                log("surfaceCreated", "surface=" + h.getSurface()
                        + " valid=" + (h.getSurface() != null && h.getSurface().isValid()));
                tryMirror(h.getSurface(), did);
            }
            @Override public void surfaceChanged(SurfaceHolder h, int fmt, int w, int hh) {
                log("surfaceChanged", w + "x" + hh);
            }
            @Override public void surfaceDestroyed(SurfaceHolder h) {
                log("surfaceDestroyed", "");
                releaseMirror();
            }
        });
    }

    /** 用反射调隐藏静态 API：createVirtualDisplay(name, w, h, displayIdToMirror, surface) */
    private void tryMirror(Surface surface, int displayId) {
        if (surface == null || !surface.isValid()) {
            log("skip", "surface 无效");
            return;
        }
        if (displayId <= 0) {
            log("skip", "displayId 无效");
            return;
        }

        /* 取那块屏的尺寸和名字 —— 镜像尺寸必须和源一致 */
        int w = 0, hgt = 0;
        String name = "?";
        int type = -1;
        String owner = "?";
        try {
            DisplayManager dm = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
            android.view.Display d = dm.getDisplay(displayId);
            if (d == null) {
                log("fail", "getDisplay(" + displayId + ") == null → 这块屏不可见");
                return;
            }
            android.util.DisplayMetrics m = new android.util.DisplayMetrics();
            d.getRealMetrics(m);
            w = m.widthPixels;
            hgt = m.heightPixels;
            /* getName() / getOwnerUid() 在 android-30 stub 里不可见，
             * 用反射拿；拿不到就退回 toString() 里抠出来。 */
            try {
                name = String.valueOf(
                        android.view.Display.class.getMethod("getName").invoke(d));
            } catch (Throwable t) { name = "(no-name)"; }
            try {
                type = (Integer) android.view.Display.class.getMethod("getType").invoke(d);
            } catch (Throwable t) { type = -1; }
            try {
                Object uid = android.view.Display.class.getMethod("getOwnerUid").invoke(d);
                owner = "uid=" + uid;
            } catch (Throwable t) {
                /* fallback: 从 toString 里找 ownerUid */
                String ts = String.valueOf(d);
                int oi = ts.indexOf("ownerUid");
                owner = oi >= 0 ? ts.substring(oi, Math.min(ts.length(), oi + 30)) : "(no-owner)";
            }
        } catch (Throwable t) {
            log("fail", "读 display 信息抛异常: " + t);
            return;
        }
        log("display", "name=" + name + " type=" + type + " " + w + "x" + hgt + " " + owner);

        try {
            Method m = DisplayManager.class.getDeclaredMethod("createVirtualDisplay",
                    String.class, int.class, int.class, int.class, Surface.class);
            m.setAccessible(true);
            long t0 = System.currentTimeMillis();
            vd = (VirtualDisplay) m.invoke(null, "dsh-passthrough", w, hgt, displayId, surface);
            long dt = System.currentTimeMillis() - t0;

            if (vd == null) {
                log("FAIL", "createVirtualDisplay 返回 null（" + dt + "ms）");
                setText("❌ 返回 null\n不能跨 uid 镜像");
                return;
            }
            log("OK", "VirtualDisplay 创建成功（" + dt + "ms）display=" + vd.getDisplay()
                    + " surfaceValid=" + surface.isValid());
            setText("✅ 创建成功！\n" + w + "x" + hgt
                    + "\n如果画面在动 = 直通成立，framesrv 可以删");
        } catch (Throwable t) {
            Throwable c = (t.getCause() != null) ? t.getCause() : t;
            log("FAIL", "createVirtualDisplay 抛异常: " + c);
            setText("❌ 失败\n" + c);
        }
    }

    private void releaseMirror() {
        try {
            if (vd != null) { vd.release(); vd = null; log("release", "ok"); }
        } catch (Throwable t) { log("release", "err " + t); }
    }

    private void setText(final String s) {
        runOnUiThread(new Runnable() {
            public void run() { if (tv != null) tv.setText("DSH_SURFACE\n" + s); }
        });
    }

    private static void log(String step, String msg) {
        Log.i(TAG, "[" + step + "] " + msg);
    }

    @Override
    protected void onDestroy() {
        releaseMirror();
        super.onDestroy();
    }
}
