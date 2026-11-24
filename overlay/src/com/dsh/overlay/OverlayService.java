package com.dsh.overlay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 多窗口悬浮显示器 —— 一块虚拟屏一个窗口。
 *
 * ## 为什么重写成多窗口
 *
 * 上一版是单窗口：所有字段（root/img/label/lp/port）都是单实例，
 * 第二块屏 `am start` 进来只是把 port 换掉 → **第 1 块的窗口被顶掉**。
 * 用户开 N 块屏，永远只能看到最后一块（用户实测报的「没看到别的对话的后台屏」）。
 *
 * ## 架构
 *
 *   OverlayService          —— 只管 Service 生命周期、通知、端口分发
 *     └ Map<Integer, Win>   —— 每个 port 一个 Win（= 一个悬浮窗）
 *          Win              —— 独自持有视图树、布局参数、轮询线程、缩放状态
 *
 * **关键不变式**：port 是窗口的身份。同一个 port 再来一次 = 更新那一个窗口，
 * 不会新建、也不会影响别的窗口。
 *
 * ## 级联布局
 *
 * 第 n 个窗口初始位置阶梯错开，超出屏幕就换列并收缩偏移，
 * 保证 N 个窗口互不重叠且都在屏内（见 {@link #cascadePos}）。
 */
public class OverlayService extends Service {

    /** 返回手势边缘保护带（px）。左右各留这么宽，窗口不许贴边。
     *
     *  用户 2026-11-21 报：主屏侧滑返回时 B 站没反应 —— 手势被悬浮窗抢走。
     *  系统返回手势从屏幕左右边缘的窄条起手（各厂商 20-40dp），
     *  @480dpi 下 96px ≈ 32dp，覆盖大部分机型。
     */
    /**
     * **手势安全区的兜底值（px）。**
     *
     * 2026-11-23 子代理查证：AOSP 手势导航的 `config_backGestureInset` 是 **30dp**，
     * 本机 density 3.25 → 30dp = 97.5px。所以原来的 96 几乎正好，数字没错。
     *
     * 但错的是策略 —— 见 [edgeGuard] 的说明。这个常量现在只做兜底。
     */
    static final int EDGE_GUARD = 96;

    /**
     * **读系统真实的边缘返回手势宽度（px）。**
     *
     * 为什么不能写死：AOSP 默认 30dp，但厂商会改（CTS 提交里自己承认
     * "the value could be overlaid by different device models"）。
     * 而且用户可以调「返回灵敏度」——对应 Settings.Secure 的
     * `back_gesture_inset_scale_left/right`，设 0 就关掉那一侧的边缘返回。
     *
     * @param right true 读右侧，false 读左侧
     * @return px，已按用户灵敏度缩放，并夹在 8~64dp 之间
     */
    private int gestureInsetPx(boolean right) {
        int px = 0;
        try {
            int id = getResources().getIdentifier("config_backGestureInset", "dimen", "android");
            if (id != 0) px = getResources().getDimensionPixelSize(id);
        } catch (Throwable t) { /* 读不到就走兜底 */ }
        if (px < dp(8) || px > dp(64)) px = dp(30);
        try {
            float scale = android.provider.Settings.Secure.getFloat(getContentResolver(),
                    right ? "back_gesture_inset_scale_right" : "back_gesture_inset_scale_left", 1f);
            if (scale > 0.05f && scale < 3f) px = Math.round(px * scale);
        } catch (Throwable t) { /* 读不到就用 1.0 */ }
        return Math.min(Math.max(px, dp(8)), dp(64));
    }

    /**
     * **自动摆放时要留的手势安全区。**
     *
     * 注意：这个值**只用于自动级联摆放**，不用于限制用户拖动。
     *
     * 2026-11-23 的关键事实（子代理查 AOSP 一手源码得出）：
     * 系统的边缘返回手势由 SystemUI 的 gesture monitor（spy 通道）实现，
     * `InputManager.monitorGestureInput` 的注释写着它
     * "receives all events on the display"，`pilferPointers()` 的注释写着
     * "the foreground windows **and all other spy windows** will have those pointers
     * canceled. Only the pilfering window will continue"。
     *
     * 也就是说：**系统能从任何前台窗口（包括 TYPE_APPLICATION_OVERLAY 浮窗）
     * 把边缘滑动的触摸抢走**。所以浮窗贴在屏幕最边上，并不会让返回手势失效。
     *
     * 那为什么 2026-11-21 用户报过「B 站侧滑返回被浮窗抢走」？
     * 最可能的原因不是"盖住边缘"，而是：①当时还没加 FLAG_NOT_FOCUSABLE；
     * ②或者 B 站自己调了 setSystemGestureExclusionRects 把那条边要回去，
     * 导致 SystemUI 不接管，触摸落进浮窗，谁都收不到。
     *
     * 所以现在的策略改成：
     *   · 用户拖动 → **允许贴边**（用户的选择）
     *   · 自动摆放 → 留安全区（避免一建屏就压在手势带上）
     *   · 贴边时，最外侧那条手势区内的触摸**不启动拖动**（让给系统）
     */
    private int edgeGuard() {
        return gestureInsetPx(false);
    }

    private static final String TAG = "DshOverlay";
    private static final String CH_ID = "dsh_overlay";
    private static final int CH_NUM = 4201;

    private WindowManager wm;

    /* **转屏检测：记上一次看到的屏幕尺寸。**
     *
     * 为什么不只依赖 onConfigurationChanged：Service 的这个回调在进程被判定
     * 不可见时并不保证送达（实机上踩到过不回调）。而且折叠屏展开/分屏切换
     * 都算配置变化。所以主路径是「每 3 秒自己比对尺寸」，回调只用来立即响应。
     */
    private int lastScreenW = 0;
    private int lastScreenH = 0;
    /** 屏幕尺寸变了之后要做的重排。 */
    private void onScreenSizeChanged(int w, int h) {
        if (w <= 0 || h <= 0) return;
        if (w == lastScreenW && h == lastScreenH) return;
        boolean first = (lastScreenW == 0);
        // 真的转屏了？（宽高关系翻转）
        boolean rotated = (w > h) != (lastScreenW > lastScreenH);
        // 尺寸变化够大？（超过 96dp 或 20%）—— 全屏进出只差状态栏/导航栏，不该算
        int bigThreshW = Math.max(dp(96), lastScreenW / 5);
        int bigThreshH = Math.max(dp(96), lastScreenH / 5);
        boolean big = Math.abs(w - lastScreenW) > bigThreshW
                || Math.abs(h - lastScreenH) > bigThreshH;
        lastScreenW = w;
        lastScreenH = h;
        if (first) {
            /* **第一次也要判一次横竖屏。**
             *
             * 2026-11-22 复核指出：原来这里直接 return，于是「服务启动时手机已经是横屏」
             * 的情况下 watchMode 永远停在初始值 false —— 用户横屏看视频、这时新建浮窗，
             * 自动收起完全不生效，要等一次真实的竖→横转动才会醒。
             * 这正好是用户最常见的场景（已经横屏看视频，然后叫 AI 干活）。
             */
            try { updateWatchMode(); } catch (Throwable t) { /* ignore */ }
            return;
        }
        /* **全屏进出（看视频时隐藏状态栏/导航栏）不该触发重排。**
         *
         * 2026-11-22 审计指出：全屏切换会让 getDisplayMetrics 跳 65-173px
         * （代码自己在 :1041 记录过这个现象），于是「开始看视频」这一下
         * 会触发 appliedAspect=-1 + 重排 + clamp 三连 —— 用户看到的
         * 就是浮窗在视频开始播放时自己变了个尺寸/位置。
         * 这种情况只需要把窗口夹回屏内，不需要重新算尺寸和级联。
         */
        if (!rotated && !big) {
            try { clampAll(); } catch (Throwable t) { /* ignore */ }
            return;
        }
        /* 转屏/折叠/分屏：所有窗口按新尺寸重算。
         * 顺序很重要 —— 先重算尺寸（applyAspect 用新的宽高），再级联排位置。 */
        for (Win win : wins.values()) {
            win.appliedAspect = -1f;
            try { win.applyAspect(); } catch (Throwable t) { /* 单个失败不影响其它 */ }
        }
        relayoutAuto();
        /* 重排之后必须再全量夹取 —— relayoutAuto 只管 autoPos 的窗口，
         * 用户拖过的和收起的不在它管辖内，转屏后可能整块在屏外。 */
        try { clampAll(); } catch (Throwable t) { /* 尽力而为 */ }
        // 转屏后重算「该不该自动收起」（横屏 = 大概率在看视频/全屏内容）
        try { updateWatchMode(); } catch (Throwable t) { /* ignore */ }
        /* 拖拽中心（hub）和左右投放条是独立窗口，位置是内联算的，
         * 这里按新尺寸重新摆一次 —— 否则转屏后它们会停在旧坐标上，
         * 用户拖动浮窗时找不到那个圆。 */
        try {
            if (hubView != null && hubLp != null) {
                hubLp.x = hubCx() - dp(28);
                hubLp.y = hubCy() - dp(28);
                wm.updateViewLayout(hubView, hubLp);
            }
        } catch (Throwable t) { /* hub 可能还没建 */ }
        try {
            if (leftBar != null && leftLp != null) {
                leftLp.x = 0;
                leftLp.y = (int) ((long) getResources().getDisplayMetrics().heightPixels / 2 - dp(18));
                wm.updateViewLayout(leftBar, leftLp);
            }
            if (rightBar != null && rightLp != null) {
                /* **gravity=TOP|END 时 x 是「右边距」，不是左边坐标。**
                 * 2026-11-22 审计抓到：这里原来写 `widthPixels - barW()`，
                 * 那是 START 语义 —— 在 END 下等于把「关闭并停后台屏」的红条
                 * 摆到 x≈0（屏幕左边缘），和蓝色「只关浮窗」条重叠。
                 * 转屏后用户拖动浮窗，右条消失/错位，连操作都做不出来。
                 * 正确写法是给它一个左边距（和 layoutDropViews 保持一致）。
                 */
                rightLp.x = dp(4);
                rightLp.y = (int) ((long) getResources().getDisplayMetrics().heightPixels / 2 - dp(18));
                wm.updateViewLayout(rightBar, rightLp);
            }
        } catch (Throwable t) { /* 投放条可能还没建 */ }
    }

    /**
     * **把所有窗口都夹回屏内 —— 不只是自动定位的。**
     *
     * 2026-11-22 审计指出：转屏后 `relayoutAuto` 只处理 `autoPos=true` 的窗口，
     * 用户拖过位置的（autoPos=false）和收起的窗口完全不管 —— 它们在转屏后
     * 可能整块在屏外，用户既看不到也点不到，只能 force-stop。
     *
     * 所以转屏重排之后必须再跑一次全量夹取。
     */
    private void clampAll() {
        for (Win win : wins.values()) {
            if (win.root == null || win.lp == null) continue;
            // 收起状态用 lp 里的真实小尺寸；否则用 curW/curH
            int ww = win.collapsed ? Math.max(dp(20), win.lp.width) : Math.max(dp(40), win.curW);
            int hh = win.collapsed ? Math.max(dp(20), win.lp.height) : Math.max(dp(40), win.curH);
            try {
                /* **用户摆过的尊重原位置（可贴边），自动摆的留手势区。**
                 * 2026-11-23：转屏重排时不能把用户拖到最边上的窗口又拉回中间。 */
                if (win.autoPos) win.clampPosAuto(ww, hh);
                else win.clampPosFlush(ww, hh);
                wm.updateViewLayout(win.root, win.lp);
            } catch (Throwable t) { /* 单个失败不影响其它 */ }
        }
    }

    /**
     * **横屏时自动把浮窗收到最小。**
     *
     * 2026-11-22 动效审计算出：横屏 2688x1216 时单窗是 473x1046，
     * 占屏 15.1%，而且是一条贴左边的竖带 —— 正好压住视频的画面主体和进度条。
     * 更糟的是窗口内所有触摸都被浮窗吃掉（FLAG_NOT_TOUCH_MODAL 只放行窗口外的），
     * 用户想双击暂停、左右滑进度、上下滑亮度，点在浮窗上全无反应。
     *
     * 自动收起之后：面积从 15.1% 降到 0.74%（少挡 95%），而且挪到顶部中间
     * （避开人脸和底部字幕/进度条）。AI 的视觉反馈不丢 —— 收起时仍然解码刷新，
     * 边缘光效也照常，用户点一下就能展开看细节。
     *
     * 为什么用「横屏」当判据而不是识别具体视频 App：
     *   · 零权限、零额外服务、立刻生效
     *   · UsageStatsManager 要授权还有延迟；MediaSessionManager 要通知使用权；
     *     ActivityManager.getRunningTasks 对第三方无效；无障碍太重
     *   · 误判代价很小：横屏游戏/看图也会收起，但那些场景同样不希望被挡，
     *     而且用户点一下就能展开，并且这一次不会被再自动收起
     */
    private boolean watchMode = false;
    /** 横屏提示是否已经弹过（1=弹过，0=没弹，-1=初始）。避免每次转屏都弹。 */
    private int toastShownForWatch = -1;

    private void updateWatchMode() {
        boolean landscape;
        try {
            landscape = getResources().getConfiguration().orientation
                    == android.content.res.Configuration.ORIENTATION_LANDSCAPE;
        } catch (Throwable t) {
            landscape = lastScreenW > lastScreenH;
        }
        if (landscape == watchMode) return;
        watchMode = landscape;
        for (Win w : wins.values()) {
            if (w.root == null) continue;
            try {
                if (watchMode) {
                    if (!w.collapsed) { w.collapsedByWatch = true; w.toggle(); }
                } else if (w.collapsedByWatch && !w.expandedInWatch) {
                    w.collapsedByWatch = false;
                    w.toggle();     // 恢复展开
                } else {
                    w.collapsedByWatch = false;
                }
                /* **不要每次转屏都清空「用户手动展开过」这个记忆。**
                 * 2026-11-22 对抗审查指出：原来这里无条件清，
                 * 于是用户横屏手动展开看细节 → 转竖屏 → 再转回横屏，
                 * 又会被自动收起一次。用户的感受是「点开了又被收起来」。
                 * 只在**回到竖屏**时清（那时候 watchMode 本来就不起作用），
                 * 横屏期间一直记着用户的选择。
                 */
                if (!watchMode) w.expandedInWatch = false;
            } catch (Throwable t) { /* 单个失败不影响其它 */ }
        }
        if (watchMode) {
            try { layoutWatchThumbs(); } catch (Throwable t) { /* ignore */ }
        }
        /* **告诉用户「它为什么变小了」。**
         *
         * 2026-11-22 对抗审查指出：横屏自动收起后窗口从占屏 15% 缩成 36dp，
         * 而收起时标签是隐藏的（36dp 放不下字），用户完全不知道发生了什么。
         * 他的原话「我最小化悬浮窗你怎么还又开了一个」说明他对窗口自己变化很敏感。
         *
         * 用 Toast 而不是标签：36dp 里放不下字，而 Toast 不需要空间、
         * 自动消失、不会挡住视频。只在**进入收起**时提示，展开时不提示。
         */
        try {
            if (watchMode && toastShownForWatch < 0) {
                toastShownForWatch = 1;
                /* Toast 必须在主线程，onConfigurationChanged 有时不在主线程上（厂商 ROM），
                 * 所以统一 post 到 ui handler 再弹。 */
                ui.post(new Runnable() {
                    public void run() {
                        try {
                            android.widget.Toast.makeText(OverlayService.this,
                                "横屏了，浮窗自动收起成小窗以免挡住画面，点一下可以展开",
                                android.widget.Toast.LENGTH_SHORT).show();
                        } catch (Throwable t) { /* 弹不出来就算了，不影响功能 */ }
                    }
                });
            } else if (!watchMode && toastShownForWatch > 0) {
                toastShownForWatch = 0;
            }
        } catch (Throwable t) { /* Toast 失败不影响功能 */ }
    }

    /** 横屏收起后，把缩略图排到顶部中间一排，别乱放。 */
    private void layoutWatchThumbs() {
        int n = 0, w0 = dp(36), gap = dp(8);
        /* **只排「自动定位」的窗口，用户自己摆过的不搬。**
         *
         * 2026-11-22 对抗审查指出：原来这里把**所有** collapsed 窗口都搬到
         * 顶部中间，完全不看 autoPos —— 用户在竖屏时把窗口拖到角落、
         * 手动最小化，一转横屏位置就被抢走。
         * 那不是「自动收起」，那是「我摆好的位置被覆盖了」。
         */
        for (Win w : wins.values()) {
            if (w.collapsed && w.lp != null && w.autoPos) n++;
        }
        if (n == 0) return;
        int total = n * w0 + (n - 1) * gap;
        int x0 = Math.max(edgeGuard(), (lastScreenW - total) / 2);
        int i = 0;
        for (Win w : wins.values()) {
            if (!w.collapsed || w.lp == null || !w.autoPos) continue;
            int x = x0 + i * (w0 + gap);
            x = Math.max(edgeGuard(), Math.min(x, Math.max(edgeGuard(), lastScreenW - w0 - edgeGuard())));
            w.lp.x = x;
            w.lp.y = Math.max(dp(8), dp(24));
            try { if (w.root != null) wm.updateViewLayout(w.root, w.lp); } catch (Throwable t) { }
            i++;
        }
    }

    /** 把一个候选位置夹进屏幕内。放不下时宁可贴边也不越界。 */
    private int[] clampSlot(int x, int y, int ww, int wh, int sw, int sh) {
        int cx = Math.max(0, Math.min(x, Math.max(0, sw - ww)));
        int cy = Math.max(0, Math.min(y, Math.max(0, sh - wh)));
        return new int[]{ cx, cy };
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration c) {
        super.onConfigurationChanged(c);
        // 立即响应（比等 3 秒 tick 快），但不作为唯一依赖
        /* **单位必须转 px。** onConfigurationChanged 给的是 dp，而 tick 传的是 px，
         * 两者共用一个 lastScreenW/H 就会互相判成「尺寸变了」，转一次屏重排两轮。
         * 2026-11-22 动效审计指出这个单位混用。 */
        try {
            float dens = getResources().getDisplayMetrics().density;
            if (dens <= 0) dens = 1f;
            onScreenSizeChanged(Math.round(c.screenWidthDp * dens),
                    Math.round(c.screenHeightDp * dens));
        } catch (Throwable t) { /* ignore */ }
    }
    private Handler ui;
    private volatile boolean running = true;

    /** port → 窗口。LinkedHashMap 保证级联顺序稳定（按启动先后）。 */
    private final Map<Integer, Win> wins = new LinkedHashMap<>();

    @Override
    public IBinder onBind(Intent i) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        ui = new Handler(Looper.getMainLooper());
        startForeground(CH_NUM, buildNotification());
    }

    /** 最近一次 startId —— 用来 stopSelf(startId) 精确停，避免多 startId 残留。 */
    private int lastStartId = -1;

    @Override
    public int onStartCommand(Intent it, int flags, int startId) {
        lastStartId = startId;
        if (it == null) return START_STICKY;

        // ① 全停
        if (it.getBooleanExtra("stop", false)) {
            closeAll();
            stopSelf();
            return START_NOT_STICKY;
        }

        // ② 关掉指定 port（一块屏停止推流时调用，不该把别的窗口也关了）
        int closePort = it.getIntExtra("closePort", 0);
        if (closePort > 0) {
            removeWin(closePort);
            if (wins.isEmpty()) { stopSelf(); return START_NOT_STICKY; }
            updateNotification();
            return START_STICKY;
        }

        // ③ 新建/更新一个窗口
        int p = it.getIntExtra("port", 0);
        if (p > 0) {
            Win w = wins.get(p);
            if (w == null) {
                w = new Win(p);
                wins.put(p, w);
                w.show();          // 位置按当前 wins.size() 级联
            }
            w.startLoop();
            updateNotification();
        } else if (wins.isEmpty()) {
            // 没有 port 也没有窗口：从持久化里恢复（服务被杀后重启）
            try {
                android.content.SharedPreferences sp = getSharedPreferences("dsh_overlay", 0);
                String saved = sp.getString("ports", "");
                for (String s : saved.split(",")) {
                    try {
                        int q = Integer.parseInt(s.trim());
                        if (q > 0 && !wins.containsKey(q)) {
                            Win w = new Win(q);
                            wins.put(q, w);
                            w.show();
                            w.startLoop();
                        }
                    } catch (NumberFormatException ignore) { }
                }
            } catch (Throwable t) { /* ignore */ }
            updateNotification();
        }
        persistPorts();
        return START_STICKY;
    }

    private void persistPorts() {
        try {
            StringBuilder sb = new StringBuilder();
            for (Integer q : wins.keySet()) {
                if (sb.length() > 0) sb.append(',');
                sb.append(q);
            }
            getSharedPreferences("dsh_overlay", 0).edit().putString("ports", sb.toString()).apply();
        } catch (Throwable t) { /* ignore */ }
    }

    /** 关掉一个窗口（只关这一个）。全关完了就把服务也停掉。 */
    private void removeWin(int p) {
        Win w = wins.remove(p);
        if (w != null) w.close();
        persistPorts();
        // 对抗审查 #9：原来不更新通知、也不 stopSelf
        // → 最后一个窗口关了之后，前台通知和空服务永远留着
        updateNotification();
        if (wins.isEmpty()) {
            try { hideRail(); } catch (Throwable t) { /* ignore */ }
            hideRail();
            try { stopForeground(true); } catch (Throwable t) { /* ignore */ }
            stopSelf();
        }
    }

    /** 全部关掉。 */
    private void closeAll() {
        // 对抗审查 #6：滑轨是独立窗口，不清会永远浮在屏幕上（还不可触摸，只能 force-stop）
        try { hideRail(); } catch (Throwable t) { /* ignore */ }
        for (Win w : wins.values()) { try { w.close(); } catch (Throwable t) { /* ignore */ } }
        wins.clear();
        persistPorts();
    }

    /**
     * 重排所有「自动定位」的窗口，**按每个窗口的实际高度纵向累加**。
     *
     * ## 为什么不能用固定阶梯
     *
     * 固定步长 64dp 在窗口高度不同时会重叠：
     * 横屏窗口高约 341px、竖屏高达 1478px，同样的步长既浪费空间又压在一起。
     * 用户拖动过的窗口标记 auto=false，**不动它**（只避开）。
     *
     * 算法：从上往下累加，一个字放不下就换列。
     */
    /**
     * 重排所有「自动定位」的窗口，**用碰撞检测保证绝对不重叠**。
     *
     * ## 为什么不用「累加高度」
     *
     * 上一版按顺序累加每个窗口高度排位置。问题：
     * 用户拖过的窗口（autoPos=false）被跳过，但它仍占着屏幕，
     * 后面的窗口照样往那儿放 → 重叠。实测出现 (-124,412) 这种跑出屏幕的坐标。
     *
     * ## 现在的做法
     *
     * 1. 先把「用户手动摆过」的窗口当成障碍物收进 placed
     * 2. 自动窗口逐个扫描屏幕，找第一个不和任何障碍物相交的位置
     * 3. 整屏都放不下就缩小到 70% 再试，再不行就叠在角落（极端情况）
     */
    /**
     * 窗口数量变了 → 所有「用户没手动调过大小」的窗口都要按新数量重算尺寸。
     *
     * **对抗审查发现的 P0**：applyAspect() 只在 aspect 变化时跑，完全不看 wins.size()。
     * 于是第 1 个窗口按「只有 1 个」定成 668×1478，后面再开第 2、3 个它不会缩，
     * findFreeSlot 放不下就回退到同一个坐标 → **重叠**。
     */
    private void reflowAll() {
        for (Win w : wins.values()) {
            if (w.userW > 0 || w.collapsed) continue;   // 用户调过大小/收起的别动
            w.appliedAspect = -1f;                      // 强制重算
            w.applyAspect();
        }
        relayoutAuto();
    }

    /** 延迟重排的句柄：多个窗口同一帧到达时只重排一次，避免互相打架。 */
    private final Runnable relayoutOnce = new Runnable() {
        public void run() { relayoutAuto(); }
    };

    private void relayoutAuto() {
        int screenW = getResources().getDisplayMetrics().widthPixels;
        int screenH = getResources().getDisplayMetrics().heightPixels;

        List<Rect> placed = new ArrayList<>();
        // 手动摆过的窗口当障碍
        for (Win w : wins.values()) {
            if (w.autoPos || w.root == null || w.lp == null) continue;
            int ww = w.curW > 0 ? w.curW : Math.round(screenW * 0.46f);
            int wh = w.curH > 0 ? w.curH : dp(200);
            placed.add(new Rect(w.lp.x, w.lp.y, w.lp.x + ww, w.lp.y + wh));
        }

        for (Win w : wins.values()) {
            if (!w.autoPos || w.root == null || w.lp == null) continue;
            int ww = w.curW > 0 ? w.curW : Math.round(screenW * 0.46f);
            int wh = w.curH > 0 ? w.curH : Math.round(screenH * 0.3f);
            int[] pos = findFreeSlot(placed, ww, wh, screenW, screenH);
            w.lp.x = pos[0];
            w.lp.y = pos[1];
            try { wm.updateViewLayout(w.root, w.lp); } catch (Throwable t) { /* ignore */ }
            placed.add(new Rect(pos[0], pos[1], pos[0] + ww, pos[1] + wh));
        }
    }

    /**
     * 在屏幕上找一块不和 placed 相交的空位。
     * 从左上往下扫，步长 dp(16)（足够细，不会漏掉能放的地方但不至于太慢）。
     */
    private int[] findFreeSlot(List<Rect> placed, int ww, int wh, int screenW, int screenH) {
        /* **必须从 edgeGuard() 开始，不能用 dp(6)。**
         *
         * 2026-11-22 独立审计抓到：这里原来是 dp(6)≈21px，而 EDGE_GUARD=96px ——
         * 于是级联排布把所有窗口放在离左边 21px 的地方，正好压在系统侧滑返回手势带上。
         * 2026-11-21 花了力气修的「B站侧滑返回被悬浮窗抢走」，会在**每次建窗口
         * 和每次转屏**时被这里撤销（只有用户手动拖一下再松手才修回来）。
         * 兜底分支同理，宁可放不下也别贴边。
         */
        /* **横屏和竖屏的起排位置不一样，而且返回前必须夹进屏内。**
         *
         * 2026-11-22 动效审计推演出：横屏 1216 高、单窗 1046 高时
         * startY=dp(96)=312 已经大于 limitY=118 —— 循环一次都不扫，
         * 直接走兜底返回 (96,312)，底边 1358 超出屏幕 142px。
         * 然后 applyAspect 的 250ms 延迟重排又把它放回同一个位置，clampAll 白做。
         *
         * 所以：横屏 startY 用 dp(28)（顶部留一点避开状态栏位置），
         * 并且所有返回路径都过 clampSlot 夹一次。
         */
        boolean landscape = screenW > screenH;
        int startX = edgeGuard();
        int startY = landscape ? dp(28) : dp(96);
        int step = dp(16);
        int limitX = Math.max(startX, screenW - ww - edgeGuard());   // 右边也留手势带
        int limitY = screenH - wh - (landscape ? dp(24) : dp(16));
        if (limitY < startY) {
            // 放不下一整窗：直接夹进屏内，不要往屏外放
            return clampSlot(startX, startY, ww, wh, screenW, screenH);
        }
        for (int y = startY; y <= limitY; y += step) {
            for (int x = startX; x <= limitX; x += step) {
                Rect r = new Rect(x, y, x + ww, y + wh);
                boolean hit = false;
                for (Rect o : placed) {
                    if (Rect.intersects(r, o)) { hit = true; break; }
                }
                if (!hit) return clampSlot(x, y, ww, wh, screenW, screenH);
            }
        }
        // 放不下：退到左上角（宁可重叠也别跑到屏幕外）
        return clampSlot(edgeGuard(), startY, ww, wh, screenW, screenH);
    }

    @Override
    public void onDestroy() {
        running = false;
        closeAll();
        super.onDestroy();
    }

    // ═══════════════════ 删除滑轨 ═══════════════════

    /** 滑轨窗口（拖动时出现，把窗口拖进右下端 = 删除）。 */
    private boolean railShown = false;

    /** 滑轨的几何：底部一条横向跑道。 */
    /* ═══════════════════════════════════════════════════════════════
     * 拖拽删除：底部投放环 + 左右两条出口
     *
     * 用户 2026-11-21 定的规格（逐条对应）：
     *   1. 拖到屏幕正下方圆圈 → 触发
     *   2. 屏幕最左 / 最右各出现一条文字+按钮
     *        左：只关闭悬浮窗
     *        右：关闭悬浮窗并关闭后台屏
     *   3. 全程不许松手：圆圈 → 左/右按钮
     *   4. 没滑到按钮上就松手 → 不触发，窗口留在松手处
     *   5. **不可以恢复进度**：下次拖动必须重新经过圆圈才能再出按钮
     *   6. 从圆圈往上离开水平带 → 按钮消失
     *
     * 关键设计点（前两版是两个子代理挑出来的教训）：
     *   · 按钮放屏幕**最左右边缘**，不放拇指底下 —— 拇指在中间，边缘才看得见
     *   · 判据用**手指**坐标，出圈每帧复位，绝不latch
     *   · 每个破坏性动作都要「进圈 + 到按钮 + 松手」三件事同时成立
     * ═══════════════════════════════════════════════════════════════ */

    private View hubView, leftBar, rightBar;
    private WindowManager.LayoutParams hubLp, leftLp, rightLp;
    private TextView leftLabel, rightLabel;
    private boolean hubShown = false;
    /** 本次手势内是否已经「过圈」。
     *
     *  2026-11-21 用户报「拖到左右两边有时有反馈有时没反馈」——
     *  根因：原来每帧用 `dropState >= 2` 判断是否武装，而 dropState 只有手指
     *  真的穿过那个 117px 的小圆才会变 2。斜着拖过去路径不经过圆心 → 永远不武装
     *  → 到了按钮位置也毫无反应。
     *  现在改成：进过圈就锁住，直到松手/取消/离开水平带才清。
     */
    private boolean armedThisGesture = false;
    /** refreshLabel 上次设置的文字和颜色 —— 用来判断真的变了没有。
     *  不加这个就会每 3 秒无条件重设视图，触发 requestLayout，用户看到字在抖。 */
    String labelText = "";
    int labelColor = 0;
    /** 窗口实际位置与 lp 请求位置的差（px）。
     *
     *  **这是「只有上半部分有反馈」的根因。**
     *  2026-11-21 用户实测：左右按钮只有上半截能触发。
     *  推演：若窗口实际渲染比 lp.y 低了约 dp(30)（状态栏 inset），
     *  视觉条整体下移，而判定矩形还按 lp 那套坐标算 → 视觉条只有上半部分
     *  落进判定区，下半部分「看得见但按不到」。
     *  解决：用 getLocationOnScreen() 实测一次，把差值补到判定坐标上。
     */
    private int originDX = 0, originDY = 0;
    private int dropState = 0;      // 0=隐藏 1=幽灵(拖动中) 2=已进圈(按钮显示) 3=选中左 4=选中右

    /** 圆圈中心：屏幕正下方，抬离导航条。 */
    private int hubCx() { return getResources().getDisplayMetrics().widthPixels / 2; }
    private int hubCy() {
        int sh = getResources().getDisplayMetrics().heightPixels;
        int ins = 0;
        try {
            android.util.DisplayMetrics m = new android.util.DisplayMetrics();
            android.view.WindowManager w = (android.view.WindowManager) getSystemService(WINDOW_SERVICE);
            if (w != null && w.getDefaultDisplay() != null) w.getDefaultDisplay().getRealMetrics(m);
        } catch (Throwable t) { /* ignore */ }
        return sh - dp(96) - ins;
    }
    /** 进圈半径 = 视觉半径 + 一点手指容错。
     *
     *  **这是「触碰位置跟 UI 有差别」的头号原因。**
     *  圈视觉直径 dp(56) → 半径 dp(28)=91px；原来这里写 dp(76)=247px，
     *  等于用户离圈边还有 156px 就被判成「进圈」了，2.7 倍的偏差。
     *  现在 = 视觉半径 + dp(8) 容错 = dp(36)。
     */
    private int hubR() { return dp(36); }
    /** 水平带半高：离开这个范围按钮就消失。 */
    private int hubBand() { return dp(52); }   // 原来 dp(120)=390px 占屏高 23%，太宽
    /** 左/右按钮窗口宽度。
     *
     *  原来是 dp(168)=546px，占屏宽 **45%**，两条加起来 90%，中间只剩 10% 空隙 ——
     *  而且左条的命中区一路延伸到屏幕中心，**人站在圆圈上就已经算「选中左」**，
     *  一松手就删。这是最致命的一条。
     *  现在 dp(120)=390px（32%），两条 64%，中间留 36% 的空档放圆圈。
     */
    private int barW() { return dp(96); }

    /** 按钮命中容差：只给一点手指误差，不许溢出视觉区太多。 */
    private int barPad() { return dp(6); }

    /** 造一个 Apple/SpaceX 质感的胶囊：深近黑底、极细描边、圆角。 */
    private GradientDrawable pill(int accent, boolean filled) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setCornerRadius(dp(16));
        g.setColor(filled ? accent : 0xE60A0A0C);
        g.setStroke(dp(1), filled ? 0xFFFFFFFF : (accent == 0 ? 0x33FFFFFF : accent));
        return g;
    }

    private TextView barText(String s, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 9.5f);
        t.setLetterSpacing(0.08f);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(4), dp(8), dp(4), dp(8));
        return t;
    }

    /** 建好三个视图（只建一次，复用）。 */
    private void ensureDropViews() {
        if (hubView != null) return;
        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        int flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;

        // ── 圆圈 ──
        android.widget.LinearLayout hub = new android.widget.LinearLayout(this);
        hub.setOrientation(android.widget.LinearLayout.VERTICAL);
        hub.setGravity(Gravity.CENTER_HORIZONTAL);
        View ring = new View(this);
        GradientDrawable rg = new GradientDrawable();
        rg.setShape(GradientDrawable.OVAL);
        rg.setColor(0xE60A0A0C);
        rg.setStroke(dp(2), 0x66FFFFFF);
        ring.setBackground(rg);
        /* **圆圈里要有个符号。** 原来是个纯黑空饼 + 发丝描边，
         * 在深色画面上等于不存在，用户根本看不出这是个投放目标。 */
        android.widget.TextView hubIcon = new android.widget.TextView(this);
        hubIcon.setText("✕");
        hubIcon.setTextColor(0xE6FFFFFF);
        hubIcon.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f);
        hubIcon.setGravity(Gravity.CENTER);
        android.widget.FrameLayout hubWrap = new android.widget.FrameLayout(this);
        android.widget.FrameLayout.LayoutParams rlp = new android.widget.FrameLayout.LayoutParams(dp(56), dp(56));
        hubWrap.addView(ring, rlp);
        android.widget.FrameLayout.LayoutParams ilp = new android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT);
        ilp.gravity = Gravity.CENTER;
        hubWrap.addView(hubIcon, ilp);
        hub.removeAllViews();
        hub.addView(hubWrap, new android.widget.LinearLayout.LayoutParams(dp(56), dp(56)));
        /* 原来这里还塞了一个 1dp 高的 TextView，导致内容 57dp > 窗口 56dp 被裁，
         * 视觉中心偏半像素。去掉，窗口和内容都严格 dp(56)。 */
        hubView = hub;
        hubLp = new WindowManager.LayoutParams(dp(56), dp(56), type, flags,
                android.graphics.PixelFormat.TRANSLUCENT);
        hubLp.gravity = Gravity.TOP | Gravity.START;
        hubLp.x = hubCx() - dp(28);
        hubLp.y = hubCy() - dp(28);

        // ── 左侧：只关浮窗 ──
        leftLabel = barText("关 闭 浮 窗", 0xE6FFFFFF);
        leftLabel.setBackground(pill(0xFF5E9EFF, false));
        leftBar = leftLabel;
        leftLp = new WindowManager.LayoutParams(barW(), dp(36), type, flags,
                android.graphics.PixelFormat.TRANSLUCENT);
        leftLp.gravity = Gravity.TOP | Gravity.START;
        leftLp.x = dp(4);
        leftLp.y = hubCy() - dp(18);

        // ── 右侧：关浮窗 + 停后台屏 ──
        rightLabel = barText("关闭并停 后台屏", 0xE6FFFFFF);
        rightLabel.setBackground(pill(0xFFFF453A, false));
        rightBar = rightLabel;
        rightLp = new WindowManager.LayoutParams(barW(), dp(36), type, flags,
                android.graphics.PixelFormat.TRANSLUCENT);
        rightLp.gravity = Gravity.TOP | Gravity.END;
        rightLp.x = dp(4);   // gravity=END 时 x 是右边距
        rightLp.y = hubCy() - dp(18);
    }

    /** **按当前屏幕重新摆三个投放窗口。** 每次 ACTION_DOWN 调一次。
     *
     *  为什么不缓存：heightPixels 在 Service 里不稳定（见 ACTION_DOWN 的注释），
     *  缓存的坐标会和现算的命中区脱钩。
     */
    /** 实测窗口渲染位置与 lp 请求位置的差，用于校正命中坐标。
     *
     *  **这是「只有上半部分有反馈」的解药。**
     *  如果窗口实际渲染比 lp.y 低了一个状态栏高度，视觉条整体下移，
     *  而判定矩形还按 lp 那套坐标算 → 视觉条只有上半截落进判定区，
     *  下半截「看得见但按不到」。实测出来补到判定坐标上即可对齐。
     */
    private void calibrateOrigin() {
        try {
            if (hubView == null || hubLp == null || !hubView.isAttachedToWindow()) return;
            if (hubView.getWidth() == 0 || hubView.getHeight() == 0) return;
            int[] loc = new int[2];
            hubView.getLocationOnScreen(loc);
            int dx = loc[0] - hubLp.x, dy = loc[1] - hubLp.y;
            if (Math.abs(dx) > dp(120) || Math.abs(dy) > dp(120)) return;
            if (dx != originDX || dy != originDY) {
                originDX = dx; originDY = dy;
                Log.i(TAG, "原点补偿更新 dx=" + dx + " dy=" + dy);
            }
        } catch (Throwable t) { /* ignore */ }
    }

    private void layoutDropViews() {
        if (hubLp == null) return;
        int sw = getResources().getDisplayMetrics().widthPixels;
        int sh = getResources().getDisplayMetrics().heightPixels;
        int cx = sw / 2, cy = sh - dp(96);
        hubLp.x = cx - dp(28);   hubLp.y = cy - dp(28);
        leftLp.x = dp(4);        leftLp.y = cy - dp(18);
        rightLp.x = dp(4);       rightLp.y = cy - dp(18);   // gravity=END，x 是右边距
        if (hubShown) {
            try { wm.updateViewLayout(hubView,  hubLp);  } catch (Throwable t) { }
            try { wm.updateViewLayout(leftBar,  leftLp); } catch (Throwable t) { }
            try { wm.updateViewLayout(rightBar, rightLp); } catch (Throwable t) { }
            /* 布局完成后实测一次位置，拿到原点补偿。
             * 必须 post：updateViewLayout 是异步的，立刻 getLocationOnScreen 还是旧值。 */
            if (hubView != null) {
                hubView.post(new Runnable() { public void run() { calibrateOrigin(); } });
            }
        }
    }

    /** 显示/更新投放 UI。state: 0 隐藏, 1 幽灵, 2 进圈, 3 选左, 4 选右。 */
    private void setDropState(int state) {
        try {
            ensureDropViews();
            dropState = state;
            if (state == 0) {
                if (hubShown) {
                    try { wm.removeView(hubView); } catch (Throwable t) { }
                    try { wm.removeView(leftBar); } catch (Throwable t) { }
                    try { wm.removeView(rightBar); } catch (Throwable t) { }
                    hubShown = false;
                }
                return;
            }
            if (!hubShown) {
                try { wm.addView(hubView, hubLp); } catch (Throwable t) { }
                try { wm.addView(leftBar, leftLp); } catch (Throwable t) { }
                try { wm.addView(rightBar, rightLp); } catch (Throwable t) { }
                hubShown = true;
            }
            // 圆圈：幽灵 40% / 进圈 100%
            hubView.setAlpha(state == 1 ? 0.58f : 1f);
            // 左右两条：只有进圈才看得见
            boolean showBars = state >= 2;
            leftBar.setAlpha(showBars ? 1f : 0f);
            rightBar.setAlpha(showBars ? 1f : 0f);
            leftBar.setVisibility(showBars ? View.VISIBLE : View.INVISIBLE);
            rightBar.setVisibility(showBars ? View.VISIBLE : View.INVISIBLE);
            // 选中态：填充 + 白字
            if (showBars) {
                leftLabel.setBackground(pill(0xFF5E9EFF, state == 3));
                rightLabel.setBackground(pill(0xFFFF453A, state == 4));
            }
        } catch (Throwable t) { /* ignore */ }
    }

    private void hideRail() { setDropState(0); }

    /** 左按钮的**实测**矩形（直接问视图，不再自己算）。
     *
     *  **这是「反馈区和视觉错位」的根治办法。**
     *  用户 2026-11-21 实测：左右按钮只有上半截能触发 ——
     *  这说明视觉渲染位置比 lp 请求的低了 60~100px（一个状态栏高度），
     *  而判定矩形一直按 lp 那套坐标算，于是判定区整体比视觉高。
     *
     *  之前想用 calibrateOrigin() 算差值再补，方向对但脆弱（要等布局、要防抖动）。
     *  现在直接问视图自己在屏幕上的真实矩形 —— 眼睛看到哪，判定就在哪，天然自洽。
     */
    private int[] leftBarRect() {
        return realRect(leftBar, dp(4), hubCy() - dp(18));
    }

    /** 取视图的真实屏幕矩形；视图还没挂上去时退回请求值。 */
    private int[] realRect(View v, int fallbackX, int fallbackY) {
        if (v != null && v.isAttachedToWindow() && v.getWidth() > 0 && v.getHeight() > 0) {
            int[] loc = new int[2];
            v.getLocationOnScreen(loc);
            return new int[] { loc[0], loc[1], loc[0] + v.getWidth(), loc[1] + v.getHeight() };
        }
        return new int[] { fallbackX, fallbackY, fallbackX + barW(), fallbackY + dp(36) };
    }
    /** 右按钮的**实测**矩形。 */
    private int[] rightBarRect() {
        int sw = getResources().getDisplayMetrics().widthPixels;
        return realRect(rightBar, sw - dp(4) - barW(), hubCy() - dp(18));
    }

    /** 手指是否在左按钮上：**严格按视觉矩形 + barPad 容错**。
     *  绝不允许命中区延伸到屏幕中间 —— 那会让「站在圆圈上」被误判成「选中左」。 */
    private boolean onLeftBar(float x, float y) {
        int[] b = leftBarRect();
        int padY = dp(10);
        /* **扣掉原点补偿**：判定按「视觉上真正在哪」算，不是按 lp 请求值。 */
        float xx = x, yy = y;
        return xx >= b[0] - barPad() && xx <= b[2] + barPad()
                && yy >= b[1] - padY && yy <= b[3] + padY;
    }
    /** 手指是否在右按钮上。 */
    private boolean onRightBar(float x, float y) {
        int[] b = rightBarRect();
        int padY = dp(10);
        float xx = x, yy = y;
        return xx >= b[0] - barPad() && xx <= b[2] + barPad()
                && yy >= b[1] - padY && yy <= b[3] + padY;
    }
    /** 手指是否还在圆圈那一带的水平线附近（离开就藏按钮）。 */
    private boolean inBand(float y) { return Math.abs(y - hubCenterYReal()) < hubBand(); }
    /** 手指是否进了圆圈（视觉判定用）。 */
    private boolean inHub(float x, float y) {
        /* 同样用实测矩形：取圆圈视图在屏幕上的真实中心。 */
        if (hubView != null && hubView.isAttachedToWindow() && hubView.getWidth() > 0) {
            int[] loc = new int[2];
            hubView.getLocationOnScreen(loc);
            float cx = loc[0] + hubView.getWidth() / 2f;
            float cy = loc[1] + hubView.getHeight() / 2f;
            return Math.hypot(x - cx, y - cy) < hubR();
        }
        return Math.hypot(x - hubCx(), y - hubCy()) < hubR();
    }

    /** 屏幕上的圆圈中心 Y（实测优先）。供水平带判定用。 */
    private float hubCenterYReal() {
        if (hubView != null && hubView.isAttachedToWindow() && hubView.getHeight() > 0) {
            int[] loc = new int[2];
            hubView.getLocationOnScreen(loc);
            return loc[1] + hubView.getHeight() / 2f;
        }
        return hubCy();
    }

    /** **武装区**：以圆圈为中心的方形区域，边长比圆直径大一圈。
     *
     *  为什么不用圆：手指斜着拖过来时，圆形边界命中率低，会出现
     *  「有时碰到有时没碰到」的飘忽感。方形区在四个方向上给的容错一致，
     *  而且和「圆圈所在的中间那一块」这个直觉吻合。
     */
    private boolean inArmZone(float x, float y) {
        /* **必须等于真实的圆。**
         * 2026-11-21 对抗审查抓到：这里原来是个半宽 dp(110)=358px 的方块，
         * 面积是圆的 19.7 倍，手指离圈边还有 266px 就判「进圈」。
         * 而 inHub()/hubR() 根本没被调用，所以我之前把 hubR 从 76dp 改到 36dp
         * 对行为是零影响 —— 用户那句「触碰位置跟 UI 有差别」一点没修掉。
         * 「斜着拖过去没反应」的问题由 armedThisGesture（进过一次就锁）解决，
         * 不需要靠放大判定区。 */
        return inHub(x, y);
    }



    /** 通知 AI：用户手动关了后台屏。 */
    /** 告诉插件「用户手动关掉了这个浮窗」。
     *
     *  alsoStopScreen=true 表示用户还要求连后台屏一起关 —— 那时连 /stop 一起打，
     *  否则只关浮窗、屏留着。
     *
     *  为什么这件事必须通知 AI：用户可能正在等这个屏上的结果，
     *  也可能只是收拾界面。AI 收到之后要自己判断「是不是打断了用户的活」，
     *  再决定停下来问还是继续。
     */
    private void notifyUserDeleted(int port, boolean alsoStopScreen, int displayId) {
        try {
            final int p = port;
            new Thread(new Runnable() {
                public void run() {
                    try {
                        java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                                new java.net.URL("http://127.0.0.1:" + p + "/event?type=user_deleted"
                                        + "&stopScreen=" + (alsoStopScreen ? "1" : "0")
                                        + "&displayId=" + displayId).openConnection();
                        c.setConnectTimeout(1200);
                        c.setReadTimeout(1200);
                        c.getResponseCode();
                        c.disconnect();
                    } catch (Throwable t) { /* 端口已经没了，正常 */ }
                }
            }).start();
        } catch (Throwable t) { /* ignore */ }
    }

    // ═══════════════════════════════════════════════════════════════
    // 单个窗口
    // ═══════════════════════════════════════════════════════════════

    private class Win {
        final int port;
        volatile boolean alive = true;
        volatile boolean looping = false;
        /** MJPEG 长连接连续失败次数。到 3 次改用单帧轮询兜底。 */
        int mjpegFails = 0;

        View root;
        /** 边缘光效层。null 表示这个窗口还没有（老版本）。 */
        EdgeView edge;
        ImageView img;
        TextView label;
        LinearLayout bar;      // 顶栏（最小化时隐藏，否则按钮比小预览还宽，把窗口撑大）
        View handle;           // 缩放手柄（同样要藏）
        WindowManager.LayoutParams lp;

        float aspect = 0.5f;
        float appliedAspect = -1f;
        boolean autoPos = true;   // 用户拖过就设 false，重排时不动它
        /** 这次收起是不是「横屏自动收的」。手动收起时 false，转回竖屏不该替用户展开。 */
        /** 边缘状态的快速轮询是否已经在跑。 */
        boolean edgeTicking = false;
        boolean collapsedByWatch = false;
        /** 用户在这次横屏里手动展开过。展开后就不再自动收，尊重用户选择。 */
        boolean expandedInWatch = false;
        float dragFrac = -1f;     // 拖动时在滑轨上的位置（0..1，-1=不在滑轨上）
        boolean resizeMoved = false;   // 缩放手柄是否已越过阈值
        boolean docked = false;        // 已进入删除投放点（此时只判左右方向）
        int armDir = 0;                // -1 左=只关浮窗 / +1 右=关浮窗+关后台屏 / 0 未选
        boolean statusTimerStarted = false;
        int statusFails = 0;
        /** 当前是否处于「连不上、正在重连」的显示状态。只用于避免重复刷文案。 */
        boolean reconnecting = false;
        int curW = 0, curH = 0;   // 当前实际尺寸（relayoutAuto 要用）
        boolean collapsed = false;
        int userW = 0, userH = 0;
        long lastOk = 0;
        int portRetries = 0;
        long lastFrameAt = 0;        // 上一帧显示时间（限帧用）
        int dropped = 0;             // 被限帧丢掉的帧数（诊断）

        Win(int port) { this.port = port; }

        /** 建这个窗口的视图树并加进 WindowManager。 */
        void show() {
            if (root != null) return;

            // **FrameLayout：工具条浮在画面上，不占额外高度。**
            //
            // 原来是 LinearLayout 竖排（工具条 + 图 + 标签 + 手柄），
            // chrome 约占 60dp/180px —— 于是：
            //   ① 窗口比画面大，四周露出深色背景 = 用户说的「黑边」
            //   ② relayoutAuto 按估算高度排位置，算不准 → 两个窗重叠
            // 改成叠放后，**窗口尺寸 = 画面尺寸**，一个像素多余空间都没有。
            FrameLayout box = new FrameLayout(OverlayService.this);
            // 背景全透明：画面自己铺满，不留任何边框
            box.setBackgroundColor(0x00000000);

            // 顶栏：✕ 关自己 / — 收起（**存成字段**，最小化时才能隐藏）
            LinearLayout bar = new LinearLayout(OverlayService.this);
            this.bar = bar;
            bar.setOrientation(LinearLayout.HORIZONTAL);
            bar.setGravity(Gravity.CENTER_VERTICAL);
            /* **不设 ✕ 关闭按钮（用户 2026-11-24 要求删掉）。**
             *
             * 理由：已经有「拖到投放圈松手 = 关闭」这个手势了，
             * 顶上再放一个快捷关闭是重复的，还容易被误点。
             *
             * 关窗仍然有两条路：
             *   ① 拖进投放圈松手
             *   ② 工具调用 vdisplay_stop / overlayStop
             */
            TextView foldBtn = new TextView(OverlayService.this);
            foldBtn.setText("—");
            foldBtn.setTextColor(0xCCFFFFFF);
            foldBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            foldBtn.setPadding(dp(8), 0, dp(8), 0);
            foldBtn.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { toggle(); }
            });
            bar.addView(foldBtn);
            // 半透明底，叠在画面右上角，不占布局高度
            GradientDrawable barBg = new GradientDrawable();
            barBg.setColor(0x99000000);
            barBg.setCornerRadius(dp(6));
            bar.setBackground(barBg);
            FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
            blp.gravity = Gravity.TOP | Gravity.END;
            blp.topMargin = dp(2);
            blp.rightMargin = dp(2);
            box.addView(bar, blp);

            img = new ImageView(OverlayService.this);
            img.setScaleType(ImageView.ScaleType.FIT_XY);
            /* **画面也做成圆角，和边缘光效贴合。**
             *
             * 用户 2026-11-24 反馈：边缘光效是圆角的（EdgeView 里
             * inset=dp(4) + 半径 dp(10)），而画面是直角的 ——
             * 于是四个角上画面会露出光效外面，看着「没盖住」。
             *
             * 半径取 dp(14) = 光效半径 dp(10) + 光效内缩 dp(4)，
             * 这样画面圆角的弧线正好和光效外沿重合，不会露缝。
             *
             * **不能更大**：用户明确说「不能很圆，不然四个角的信息就被吞掉挺多了」。
             * 现在窗口宽度约 486dp-ness 下，14dp 只吃掉角落很小一块。
             *
             * 用 OutlineProvider + clipToOutline，不依赖 SurfaceView ——
             * 这里显示画面的是 ImageView，能裁剪。
             */
            try {
                final int cornerPx = dp(14);
                img.setOutlineProvider(new android.view.ViewOutlineProvider() {
                    @Override
                    public void getOutline(android.view.View v, android.graphics.Outline o) {
                        o.setRoundRect(0, 0, v.getWidth(), v.getHeight(), cornerPx);
                    }
                });
                img.setClipToOutline(true);
            } catch (Throwable t) { /* 圆角失败不影响显示 */ }
            // **给一个初始占位尺寸。**
            // 原来 WRAP_CONTENT + 没有 bitmap = 宽高 0，
            // 帧还没到时整个窗口只剩「✕ — 端口」一条细线，
            // 用户看到的就是「窗口塌了」。
            int phW = Math.round(getResources().getDisplayMetrics().widthPixels * 0.46f);
            // img 铺满整个窗口（MATCH_PARENT）—— 窗口就是画面，没有留白
            FrameLayout.LayoutParams ilp2 = new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
            box.addView(img, ilp2);
            // **顶栏必须在图之后 bringToFront。**
            // FrameLayout 后加的在上层，原来 bar 先加、img 后加 → 第一帧一到就把 ✕/— 盖住了，
            // 但按钮仍在触摸链里 → 用户点右上角会误关/误收起（对抗审查 #3）。
            try { bar.bringToFront(); } catch (Throwable t) { /* ignore */ }

            label = new TextView(OverlayService.this);
            label.setTextColor(Color.WHITE);
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
            label.setGravity(Gravity.CENTER);
            /* 单行显示：折行会让悬浮条高度跳变，看着就是「字在跳」。 */
            label.setSingleLine(true);
            label.setEllipsize(android.text.TextUtils.TruncateAt.END);
            refreshLabel();
            // 标签浮在底部居中，半透明底，不占布局高度
            GradientDrawable lbg = new GradientDrawable();
            lbg.setColor(0xE6000000);
            lbg.setCornerRadius(dp(4));
            label.setBackground(lbg);
            label.setPadding(dp(6), dp(1), dp(6), dp(1));
            /* **标签放左上角，和右上角的「—」同一行（用户 2026-11-24 要求）。**
             *
             * 原来是「底部居中」，压着画面下边缘 —— 那里正好是 App 的
             * 底部导航栏/输入框，遮住就看不见了。挪到顶部后：
             *   · 左上是画面里最空的区域（大部分 App 顶部只有状态栏）
             *   · 和右上角的收起按钮同一行，视觉上成一条
             * 注意：顶部区域会被顶栏（✕已删，剩 — 和两个图标）占右边，
             * 所以标签限制最大宽度，避免和它重叠。
             */
            FrameLayout.LayoutParams tlp2 = new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
            tlp2.gravity = Gravity.TOP | Gravity.START;
            tlp2.topMargin = dp(3);
            tlp2.leftMargin = dp(3);
            /* **右边只给「—」留位置。**
             * 原来按「两个按钮 + 内边距」留了 56dp，但用户 2026-11-24 要求删掉 ✕ 之后
             * 顶栏只剩一个「—」，56dp 白占了近 1/5 窗口宽度，导致「屏909」被截成「屏9…」。
             * 现在按「一个按钮 + 内边距」留 36dp。 */
            tlp2.rightMargin = dp(36);
            box.addView(label, tlp2);

            /* **边缘光效层：AI 状态的视觉反馈。**
             *
             * 加在 img 和 label 之上（最后加 = 最上层），但不拦截触摸 ——
             * 它只是画，所有手势仍然落到 box / handle 上。
             * idle 时 setWillNotDraw(true)，系统直接跳过它的绘制，零成本。
             */
            edge = new EdgeView(OverlayService.this);
            FrameLayout.LayoutParams elp = new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
            box.addView(edge, elp);
            try { edge.bringToFront(); } catch (Throwable t) { /* ignore */ }

            // **右下缩放手柄：画成斜向双箭头**，一眼就知道能拖大小
            View handle = new View(OverlayService.this) {
                @Override protected void onDraw(Canvas c) {
                    super.onDraw(c);
                    Paint p2 = new Paint(Paint.ANTI_ALIAS_FLAG);
                    p2.setColor(0xEEFFFFFF);
                    p2.setStrokeWidth(dp(2));
                    p2.setStyle(Paint.Style.STROKE);
                    p2.setStrokeCap(Paint.Cap.ROUND);
                    float w = getWidth(), h = getHeight();
                    float pad = dp(3), ar = dp(5);
                    // 主对角线 ╱
                    c.drawLine(pad, h - pad, w - pad, pad, p2);
                    // 右上箭头
                    c.drawLine(w - pad, pad, w - pad - ar, pad, p2);
                    c.drawLine(w - pad, pad, w - pad, pad + ar, p2);
                    // 左下箭头
                    c.drawLine(pad, h - pad, pad + ar, h - pad, p2);
                    c.drawLine(pad, h - pad, pad, h - pad - ar, p2);
                }
            };
            GradientDrawable hbg = new GradientDrawable();
            hbg.setColor(0x66000000);
            hbg.setCornerRadius(dp(6));
            handle.setBackground(hbg);
            this.handle = handle;   // 存字段，最小化时隐藏
            FrameLayout.LayoutParams hlp = new FrameLayout.LayoutParams(dp(16), dp(16));
            hlp.gravity = Gravity.BOTTOM | Gravity.END;
            hlp.bottomMargin = dp(2);
            hlp.rightMargin = dp(2);
            box.addView(handle, hlp);
            handle.setOnTouchListener(new View.OnTouchListener() {
                float downX, downY;
                int startW, startH;
                @Override public boolean onTouch(View v, MotionEvent e) {
                    switch (e.getActionMasked()) {
                        case MotionEvent.ACTION_DOWN:
                            downX = e.getRawX(); downY = e.getRawY();
                            startW = img.getWidth() > 0 ? img.getWidth() : dp(150);
                            startH = img.getHeight() > 0 ? img.getHeight() : dp(150);
                            resizeMoved = false;
                            return true;
                        case MotionEvent.ACTION_MOVE:
                            // **必须真的拖了才缩放。**
                            // 实机踩到：手柄被误触一下（dx≈0）就执行
                            //   nw = max(dp(80), startW + 0)
                            // 而 dp(80)=260 正好是下限 → 窗口瞬间缩到最小，
                            // 用户看到的就是「窗口莫名其妙变很小、尺寸和别的窗不一样」。
                            int mvx = (int)(e.getRawX() - downX);
                            int mvy = (int)(e.getRawY() - downY);
                            if (!resizeMoved && Math.abs(mvx) < dp(10) && Math.abs(mvy) < dp(10)) {
                                return true;   // 还没到阈值，不缩
                            }
                            resizeMoved = true;
                            int nw = Math.max(dp(120), startW + mvx);
                            userW = nw; userH = nw;
                            appliedAspect = -1f;
                            applyAspect();
                            return true;
                        case MotionEvent.ACTION_UP:
                            resizeMoved = false;
                            return true;
                    }
                    return false;
                }
            });

            root = box;

            int type = Build.VERSION.SDK_INT >= 26
                    ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    : WindowManager.LayoutParams.TYPE_PHONE;
            // **建窗口时就给固定尺寸，不要 WRAP_CONTENT。**
            // WRAP_CONTENT + FrameLayout(MATCH_PARENT img) + 还没帧 = 尺寸为 0，
            // 窗口塌成一条线，而且碰撞检测拿不到真实尺寸 → 排位置会重叠。
            int w0 = Math.round(getResources().getDisplayMetrics().widthPixels * 0.46f);
            int h0 = Math.round(w0 * 1.6f);
            curW = w0; curH = h0;
            /* **必须加 FLAG_NOT_TOUCH_MODAL，否则窗口边界内的触摸全被吃掉。**
             *
             * 2026-11-21 用户报的 bug：主屏侧滑返回时，B站没反应 —— 手势被悬浮窗抢了。
             * 根因是窗口位置 x=dp(12) 落在系统返回手势的边缘感应区里，
             * 手指从屏幕左/右边缘滑进来，起点就在窗口范围内，事件被这个窗口消费了。
             *
             * 修法两条一起上：
             *   1) 加 FLAG_NOT_TOUCH_MODAL —— 窗口外的触摸明确放行给下层
             *   2) clampPos 里把位置限制在手势安全区之外（见 EDGE_GUARD）
             * 只做其中一条都还会漏：单加 flag，窗口盖住边缘时照样抢；
             * 单挪位置，用户一拖动又回到边缘。
             */
            lp = new WindowManager.LayoutParams(w0, h0, type,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    android.graphics.PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.START;

            /* **给窗口一个带端口号的 title，让外部能按端口识别它。**
             *
             * 2026-11-22 独立复核抓到：所有窗口在 dumpsys 里长得一模一样
             * （`Window{hash u0 com.dsh.overlay}`），于是外部只能数「有几个 dsh.overlay 窗口」，
             * 分不清哪个窗口属于哪块屏。后果很严重：
             *   · 旧窗口还挂在屏幕上时，新建屏的「浮窗可见」检查直接通过（假成功）；
             *   · 用户看到的其实是上一块屏的画面，但自检一路 ✅。
             * 加 title 之后外部可以精确匹配 `dsh-overlay:<port>`，一个端口对一个窗口。
             */
            try { lp.setTitle("dsh-overlay:" + port); } catch (Throwable t) { /* 老 API 忽略 */ }

            // 先给个临时位置，等第一帧拿到尺寸后 relayoutAuto() 会重排
            lp.x = edgeGuard();   // 避开返回手势边缘区，见 clampPos
            lp.y = dp(120) + wins.size() * dp(60);

            root.setOnTouchListener(new View.OnTouchListener() {
                float downX, downY;
                int startX, startY;
                boolean moved;
                long downAt;
                @Override public boolean onTouch(View v, MotionEvent e) {
                    switch (e.getActionMasked()) {
                        case MotionEvent.ACTION_DOWN:
                            /* **贴边时，最外侧那条手势区内的触摸不接管。**
                             *
                             * 2026-11-23：允许用户把窗口拖到屏幕最边上之后，
                             * 如果那条边正好盖住了系统的手势起手区，用户在
                             * 那里按下就是想侧滑返回，不该被我们拿去做"拖动窗口"。
                             * 所以这里先判断：窗口贴边 + 落点在贴边侧的手势区内 → 放弃。
                             *
                             * 返回 false 的意义：这次按下不归我们。系统的手势
                             * monitor（spy 通道 + pilferPointers）本来就优先，
                             * 我们主动让开，它接管得更干净。
                             */
                            try {
                                int gL = gestureInsetPx(false);
                                int gR = gestureInsetPx(true);
                                int swNow = getResources().getDisplayMetrics().widthPixels;
                                /* 收起态要用真实宽度，否则贴边判定永远算成「没贴边」。 */
                                int wNow = collapsed
                                        ? Math.max(dp(20), lp.width)
                                        : Math.max(dp(40), curW);
                                boolean flushLeft = lp.x <= dp(1);
                                boolean flushRight = (lp.x + wNow) >= (swNow - dp(1));
                                float rawX = e.getRawX();
                                if ((flushLeft && rawX < lp.x + gL)
                                        || (flushRight && rawX > lp.x + wNow - gR)) {
                                    return false;   // 让给系统手势
                                }
                            } catch (Throwable t) { /* 判断失败就正常接管 */ }
                            downX = e.getRawX(); downY = e.getRawY();
                            startX = lp.x; startY = lp.y;
                            moved = false; downAt = System.currentTimeMillis();
                            /* **每次按下都强制复位。**
                             * 2026-11-21 对抗审查抓到：armedThisGesture 是 Service 级字段，
                             * 原来只在 UP/CANCEL/离开水平带 三处复位。只要有一次手势被打断
                             * （比如 pollStatus 发现屏没了、窗口自己关掉），它留 true，
                             * 下一次拖任何窗口都算「已武装」→ 没经过圆圈就能直接滑到按钮删。
                             * 这正是用户禁止的「恢复拖拽进度」。ACTION_DOWN 是唯一权威复位点。
                             */
                            armedThisGesture = false;
                            docked = false;
                            if (hubShown) setDropState(0);
                            /* **每次按下重算几何并重摆窗口。**
                             * 2026-11-21 坐标审查抓到：ensureDropViews() 里有
                             * `if (hubView != null) return;` —— 三个窗口坐标一辈子只算一次，
                             * 而 hubCy() 每帧现算。heightPixels 在服务里会变
                             * （API30+ 返回进程内顶层 Activity 的尺寸，而 MainActivity 是 noHistory，
                             * 销毁后值会跳 65~173px），一变就视觉停在旧位置、命中跟新位置走。
                             * 这就是「触碰位置跟 UI 有点差别」的时序来源。
                             */
                            layoutDropViews();
                            return true;
                        case MotionEvent.ACTION_MOVE:
int dx = (int)(e.getRawX() - downX);
                            int dy = (int)(e.getRawY() - downY);
                            if (Math.abs(dx) > dp(6) || Math.abs(dy) > dp(6)) moved = true;
                            if (!moved) return true;

                            int sw = getResources().getDisplayMetrics().widthPixels;
                            int sh = getResources().getDisplayMetrics().heightPixels;

                            /* ═══ 已进入删除投放点：只判左右，窗口跟手走 ═══ */
                              /* ═══ 已进入投放环：**窗口冻结不动**，只等停留计时 ═══
                               *
                               * 用户 2026-11-21 实测三个问题都来自上一版：
                               *   1) 巨大圆圈 —— 已缩到 56dp
                               *   2) 窗口被吸附 —— 现在进环后一个字都不改窗口坐标
                               *   3) 碰一下就没了 —— 现在必须「进环 + 停留 400ms 锁定」才允许执行，
                               *      单纯滑过去松手不会删。
                               */
                              /* **先跟手。** 2026-11-21 挑刺方抓到：上一版把这段删了，窗口完全拖不动。 */
                              /* ═══ 1. 先跟手拖动（窗口跟手指走）═══ */
                            int sw2 = getResources().getDisplayMetrics().widthPixels;
                            int sh2 = getResources().getDisplayMetrics().heightPixels;
                            /* **最小化时要用「当前真实尺寸」，不能用 curW/curH。**
                             *
                             * 用户 2026-11-24 报的 bug：「最小化后拖拽删除时，
                             * 悬浮窗下降到屏幕三分之一就不能再往下拖了，
                             * 但实际是可以拖到删除位置的，只是显示跟实际位置有偏差」。
                             *
                             * 根因：`curW/curH` 是**展开时**的尺寸（约 486x1074），
                             * `toggle()` 只改了 lp.width/height，没同步它们。
                             * 于是下面的 `sh2 - kh2` 用 1074 去算边界，
                             * 窗口其实只有 208 高 → 显示被卡在 60% 位置，
                             * 而手指（和删除判定用的 fy）还能继续往下。
                             *
                             * 修法：收起状态用 lp 里的真实小尺寸。 */
                            int kw2, kh2;
                            if (collapsed) {
                                kw2 = Math.max(dp(20), lp.width);
                                kh2 = Math.max(dp(20), lp.height);
                            } else {
                                kw2 = Math.max(dp(40), curW);
                                kh2 = Math.max(dp(40), curH);
                            }
                            /* **kx2 必须 ≤ kw2/2，否则左边界变成正数。**
                             *
                             * 审查抓到（2026-11-24）：收起时 kw2 = 117px，
                             * 而 `Math.max(dp(72), kw2/2)` = max(234, 58) = 234 > 117，
                             * 于是 `-(kw2 - kx2)` = -(117-234) = **+117**（正数！）
                             * → lp.x 被钉在 [117, sw-234]，最小化的窗左右各留一条缝，
                             * 而且下面 flushLeft/flushRight 的贴边让手势逻辑永久失效。
                             *
                             * 展开态保留 dp(72) 的最小半宽（窗口够宽，留点余量没关系）；
                             * 收起态直接用 kw2/2（窗口才 36dp，再留 72dp 就倒挂了）。
                             */
                            int kHalf = Math.max(dp(20), kw2 / 2);
                            int kx2 = collapsed ? kHalf : Math.max(dp(72), kHalf);
                            lp.x = Math.max(-(kw2 - kx2), Math.min(sw2 - kx2, startX + dx));
                            lp.y = Math.max(0, Math.min(Math.max(0, sh2 - kh2), startY + dy));
                            try { wm.updateViewLayout(root, lp); } catch (Throwable t) { }

                            /* ═══ 2. 状态机 ═══
                             *
                             * 用户 2026-11-21 的硬规则：
                             *   · 必须先到圆圈，按钮才出现（不可跳过 → 「不可以恢复拖拽进度」）
                             *   · 往上离开水平带 → 按钮消失
                             *   · 没滑到按钮上松手 → 什么都不发生
                             */
                            float fx = e.getRawX(), fy = e.getRawY();
                            boolean wasArmed = armedThisGesture || (dropState >= 2);

                            /* **幽灵圈要常显。**
                             * 审查抓到：原来只有 !inBand 时才 setDropState(1)，
                             * 而窗口本来就停在屏幕下半部时（用户反复拖的就是那），
                             * 第一帧就落在带内 → dropState 一直 0 → 圈根本不出现。
                             */
                            if (!hubShown) setDropState(1);

                            if (!inBand(fy)) {
                                // 离开水平带：按钮消失，重新过圈才能再出
                                if (wasArmed) {
                                    docked = false;
                                    armedThisGesture = false;
                                    setDropState(1);
                                } else if (!hubShown) {
                                    setDropState(1);
                                }
                            /* **按钮判定优先。**
                             * 武装区 dp(110) 半宽=357px，和左右按钮（命中到 x=455 / 从 x=761 起）
                             * 有一段 205px 的重叠。如果先判武装区，手指已经在按钮上了却只当「进圈」，
                             * 用户看到的就是「滑到按钮上没反馈」。所以按钮优先。
                             */
                            } else if (wasArmed && onLeftBar(fx, fy)) {
                                if (dropState != 3) {
                                    setDropState(3);
                                    try { root.performHapticFeedback(android.view.HapticFeedbackConstants.TEXT_HANDLE_MOVE); } catch (Throwable t) { }
                                }
                            } else if (wasArmed && onRightBar(fx, fy)) {
                                if (dropState != 4) {
                                    setDropState(4);
                                    try { root.performHapticFeedback(android.view.HapticFeedbackConstants.TEXT_HANDLE_MOVE); } catch (Throwable t) { }
                                }
                            } else if (inArmZone(fx, fy)) {
                                /* **回到圆圈必须无条件降级到 2。**
                                 * 2026-11-21 对抗审查抓到致命 bug：原来只在 dropState<2 时
                                 * setDropState(2)，所以「选中左(3) → 滑回圆圈 → 松手」时
                                 * dropState 仍是 3 → 直接删除。
                                 * 用户的原话是「只要没放在左右两边其中一个按钮上就不算」，
                                 * 松手在圆圈里正是「没放在按钮上」，绝不该删。 */
                                docked = true;
                                if (!armedThisGesture) {
                                    armedThisGesture = true;
                                    try { root.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK); } catch (Throwable t) { }
                                }
                                if (dropState != 2) setDropState(2);
                            } else if (wasArmed) {
                                // 已武装但不在按钮也不在武装区：按钮保持显示，取消选中
                                if (dropState > 2) setDropState(2);
                            }
                            return true;
                        case MotionEvent.ACTION_CANCEL:
                            /* 被打断（来电/系统弹窗/多指）：必须复位，否则 UI 会卡在屏幕上。 */
                            docked = false;
                            armedThisGesture = false;
                            setDropState(0);
                            return true;
                        case MotionEvent.ACTION_UP:
                            /* ═══ 3. 松手：只有正好停在按钮上才执行 ═══ */
                            {
                                /* **松手时用事件自己的坐标重判，不信上一帧的 dropState。**
                                 * 2026-11-21 对抗审查抓到：快速滑到按钮立刻抬手时，
                                 * 最后一次 MOVE 可能还没到，dropState 仍是 2 → 不触发。
                                 * 用户感知就是「有时灵有时不灵」。
                                 */
                                final float upx = e.getRawX(), upy = e.getRawY();
                                int pick = 2;
                                if (armedThisGesture && inBand(upy)) {
                                    if (onLeftBar(upx, upy)) pick = 3;
                                    else if (onRightBar(upx, upy)) pick = 4;
                                }
                                armedThisGesture = false;
                                if (docked || pick == 3 || pick == 4) {
                                    docked = false;
                                    setDropState(0);
                                    if (pick == 3) {
                                        final int p3 = port;
                                        Log.i(TAG, "松手在左按钮 → 只关浮窗 port=" + p3);
                                        notifyUserDeleted(p3, false, -1);
                                        ui.post(new Runnable() { public void run() { removeWin(p3); } });
                                        return true;
                                    }
                                    if (pick == 4) {
                                        final int p4 = port;
                                        Log.i(TAG, "松手在右按钮 → 关浮窗+停后台屏 port=" + p4);
                                        /* **真的停屏。**
                                         * 2026-11-21 对抗审查抓到：原来这里只发了个 /event 就 removeWin，
                                         * framesrv 只是往 events.log 写一行，虚拟屏照跑、CPU 照烧，
                                         * 用户按左按右结果一模一样。
                                         * framesrv 的 /quit 是 System.exit(0)，虚拟屏随持有它的进程一起释放。
                                         */
                                        try {
                                            new Thread(new Runnable() {
                                                public void run() {
                                                    try {
                                                        java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                                                                new java.net.URL("http://127.0.0.1:" + p4 + "/quit").openConnection();
                                                        c.setConnectTimeout(1200);
                                                        c.setReadTimeout(1200);
                                                        c.getResponseCode();
                                                        c.disconnect();
                                                    } catch (Throwable t) { /* 停不掉也不能拖住 UI */ }
                                                }
                                            }).start();
                                        } catch (Throwable t) { /* ignore */ }
                                          /* **真的停屏 —— 但浮窗自己停不了。**
                                           *
                                           * 2026-11-23 审查抓到这个一直是假的：
                                           * framesrv 的 /quit 只是 System.exit(0)，退的是**取帧进程**；
                                           * 虚拟屏和上面的 App 属于 **scrcpy server 进程**（另一个进程），
                                           * 跟 framesrv 没有任何父子关系。所以屏原封不动继续跑，
                                           * 还在后台占 75-185MB，AI 侧 status 仍报 running:true。
                                           *
                                           * 浮窗是独立 APK，它不知道 screenId / adb 怎么调。
                                           * 所以改成写一个「停止请求」文件，由插件/daemon 侧执行真停屏。
                                           */
                                          try {
                                              final String stopCmd = "mkdir -p /data/local/tmp/dshframe; "
                                                  + "echo " + p4 + " > /data/local/tmp/dshframe/stop-request";
                                              new Thread(new Runnable() {
                                                  public void run() {
                                                      try {
                                                          Runtime.getRuntime().exec(
                                                              new String[]{"sh", "-c", stopCmd}).waitFor();
                                                      } catch (Throwable t) { /* 写不进去也不能拖住 UI */ }
                                                  }
                                              }).start();
                                          } catch (Throwable t) { /* ignore */ }
                                        notifyUserDeleted(p4, true, -1);
                                        ui.post(new Runnable() { public void run() { removeWin(p4); } });
                                        return true;
                                    }
                                    // 只是进过圈但没到按钮：取消，窗口留在松手处
                                    Log.i(TAG, "投放取消（未到按钮）port=" + port);
                                    clampPosFlush(curW, curH);   // 用户拖动 → 允许贴边
                                    try { wm.updateViewLayout(root, lp); } catch (Throwable t) { }
                                    return true;
                                }
                            }
                            setDropState(0);
                            /* **正常松手也要 clampPos。**
                             * 2026-11-21 审查抓到：拖动时只保证「一半可见」，窗口能到 x=-300，
                             * 整块盖住屏幕左边缘 0..96 的返回手势保护区 —— 把之前修好的
                             * 「侧滑返回被悬浮窗抢走」重新引回来。收尾必须夹一次。
                             */
                            clampPosFlush(curW, curH);   // 用户拖动 → 允许贴边
                            try { wm.updateViewLayout(root, lp); } catch (Throwable t) { }
                            /* **用户摆过位置之后，就别再自动挪它了。**
                             *
                             * 2026-11-22 独立审计抓到：`autoPos` 这个标志
                             * 声明时是 true，注释写着「用户拖过就设 false，重排时不动它」，
                             * 但**全文件没有任何一处赋 false** —— 于是 relayoutAuto 的
                             * 「障碍表」永远是空的，用户辛苦摆好的位置会在
                             * 建新窗口 / 比例变化 / 转屏时被一律弹回自动槽位。
                             * 这正是用户说的「我最小化的窗口怎么跑别处去了」的机制之一。
                             */
                            if (moved) autoPos = false;
                            if (!moved && System.currentTimeMillis() - downAt < 400) {
                                /* **横屏里用户手动展开了，这一次就别再自动收。**
                                 * 不然用户点开看细节，3 秒 tick 又把它收回去，
                                 * 表现就是「点不开」。
                                 */
                                if (watchMode && collapsed) expandedInWatch = true;
                                collapsedByWatch = false;
                                toggle();
                            }

                        }
                    return false;
                }
            });

            try {
                wm.addView(root, lp);
                Log.i(TAG, "窗口已添加 port=" + port + " " + lp.width + "x" + lp.height + " x=" + lp.x + " y=" + lp.y);
                // **加完立刻重算所有窗口尺寸再重排**（P0：数量变了尺寸要跟着变）
                ui.post(new Runnable() { public void run() { reflowAll(); } });
            } catch (Exception e) {
                Log.e(TAG, "加窗口失败 port=" + port + ": " + e.getMessage());
            }
        }

        /** 把窗口位置拉回「至少一部分在屏内」。 */
        /**
         * **允许贴边**的夹取 —— 用户手动拖动之后用这个。
         *
         * 2026-11-23 用户报「拖到最左/最右会被弹回中间」。
         * 根因：拖动过程其实没夹（能贴到 x=0），但一松手调用 clampPos，
         * x 被拉回 EDGE_GUARD，肉眼看就是"弹回去"。
         *
         * 子代理查 AOSP 一手源码确认：系统返回手势走 SystemUI 的 spy 通道
         * （monitorGestureInput / pilferPointers），能从任何前台窗口抢走触摸，
         * 所以贴边**不会**让返回手势失效。用户想贴边就让他贴。
         */
        void clampPosFlush(int ww, int hh) {
            if (lp == null) return;
            int sw = getResources().getDisplayMetrics().widthPixels;
            int sh = getResources().getDisplayMetrics().heightPixels;
            int maxX = Math.max(0, sw - ww);
            lp.x = Math.max(0, Math.min(maxX, lp.x));
            lp.y = Math.max(0, Math.min(Math.max(0, sh - hh), lp.y));
        }

        /**
         * **自动摆放**时的夹取 —— 留手势安全区，避免一建屏就压在手势带上。
         *
         * 用于：级联自动定位、收起/展开、比例变化重排、全量 clampAll。
         * 用户手动拖过之后不再走这里（走 clampPosFlush）。
         */
        void clampPosAuto(int ww, int hh) {
            if (lp == null) return;
            int sw = getResources().getDisplayMetrics().widthPixels;
            int sh = getResources().getDisplayMetrics().heightPixels;
            int g = edgeGuard();
            int minX = g;
            int maxX = Math.max(minX, sw - ww - g);
            lp.x = Math.max(minX, Math.min(maxX, lp.x));
            lp.y = Math.max(0, Math.min(Math.max(0, sh - hh), lp.y));
        }

        /** 老名字保留成 auto 语义（自动路径都在用它）。 */
        void clampPos(int ww, int hh) {
            clampPosAuto(ww, hh);
        }

        void toggle() {
            collapsed = !collapsed;
            // **最小化时不隐藏画面** —— 用户要的是「很小的实时画面标识」，
            // 不是空白小方块。所以只改窗口尺寸，img 继续 MATCH_PARENT 刷新。
            if (img != null) img.setVisibility(View.VISIBLE);
            if (collapsed) {
                // **最小化要真的小。**
                // 原来 dp(76) 在 3.42 密度下是 260px —— 用户实测「还是太大」。
                // 改成 36dp（≈123px），并且高度按比例但限死在 36~64dp。
                int smallW = dp(36);
                int smallH = Math.round(smallW / Math.max(0.2f, Math.min(5f, aspect)));
                if (smallH < dp(36)) smallH = dp(36);
                if (smallH > dp(64)) smallH = dp(64);
                // **工具栏必须藏起来**：两个 13sp 按钮的宽度远超 36dp，
                // 不藏的话 FrameLayout 会把窗口撑回大尺寸，用户看到的就是「最小化还是太大」。
                if (bar != null) bar.setVisibility(View.GONE);
                if (label != null) label.setVisibility(View.GONE);
                if (handle != null) handle.setVisibility(View.GONE);
                if (lp != null) {
                    lp.width = smallW; lp.height = smallH;
                    clampPos(smallW, smallH);
                    try { wm.updateViewLayout(root, lp); } catch (Throwable t) { /* ignore */ }
                }
                if (label != null) refreshLabel();
                return;
            }
            if (label != null) {
                // **始终显示「屏 N」**：只显示数字会被误认为窗口坏了
                refreshLabel();
                label.setTextSize(TypedValue.COMPLEX_UNIT_SP, collapsed ? 11 : 10);
            }
            if (!collapsed) {
                if (bar != null) bar.setVisibility(View.VISIBLE);
                if (label != null) label.setVisibility(View.VISIBLE);
                if (handle != null) handle.setVisibility(View.VISIBLE);
                appliedAspect = -1f;
                applyAspect();
                clampPos(curW > 0 ? curW : dp(200), curH > 0 ? curH : dp(200));
                if (lp != null) { try { wm.updateViewLayout(root, lp); } catch (Throwable t) { /* ignore */ } }
            }
        }

        /** 按真实比例设定显示尺寸（精确尺寸，避免 letterbox）。 */
        void applyAspect() {
            if (img == null || collapsed) return;
            float a = (aspect > 0.15f && aspect < 8f) ? aspect : 0.5f;
            if (Math.abs(a - appliedAspect) < 0.005f) return;
            appliedAspect = a;

            int screenW = getResources().getDisplayMetrics().widthPixels;
            int screenH = getResources().getDisplayMetrics().heightPixels;
            int w, h;
            if (userW > 0) {
                w = userW;
                h = Math.max(dp(60), Math.round(w / a));
                /* 用户设过宽度也要受高度上限约束 —— 原来这里是裸的，
                 * 比例一翻（竖屏内容 + 横屏屏）窗口能高过屏幕。 */
                int maxHu = Math.round(screenH * 0.92f);
                if (h > maxHu) { h = maxHu; w = Math.max(dp(80), Math.round(h * a)); }
            } else {
                int n = Math.max(1, wins.size());
                /* **横屏和竖屏的取宽规则不同。**
                 *
                 * 2026-11-22 审计推演出：横屏（2688x1216）+ 竖屏内容（aspect 0.452）时，
                 * 原来先 w=0.40*2688=1075 再 h=w/a=2378，超过 maxH(0.55*1216=669)
                 * 回退成 h=669、w=669*0.452=302px（88dp 的细缝），字和图全糊。
                 *
                 * 根因是「先按宽度算，再用高度砍」在横屏下是错的：
                 * 横屏的稀缺资源是高，不是宽。所以横屏改成先看高度，
                 * 宽高两个方案里取更舒服的那个。
                 */
                if (screenW > screenH) {
                    int maxH = Math.round(screenH * (n <= 1 ? 0.86f : 0.62f));
                    int fracW = Math.round(screenW * (n <= 1 ? 0.42f : 0.30f));
                    int hFromW = Math.round(fracW / a);
                    if (hFromW <= maxH) { w = fracW; h = hFromW; }
                    else { h = maxH; w = Math.round(h * a); }
                } else {
                    float frac = n <= 1 ? 0.40f : (n <= 3 ? 0.34f : 0.28f);
                    w = Math.round(screenW * frac);
                    h = Math.round(w / a);
                    int maxH = Math.round(screenH * (n <= 1 ? 0.55f : 0.34f));
                    if (h > maxH) { h = maxH; w = Math.round(h * a); }
                }
            }
            int capW = Math.round(screenW * 0.92f);
            if (w > capW) { w = capW; h = Math.round(w / a); }

            // **设的是「窗口」尺寸，不是「图片」尺寸。**
            // FrameLayout 下 img 是 MATCH_PARENT，窗口多大画面就多大，
            // 所以窗口永远是「画面尺寸」——一个像素黑边都没有。
            curW = w;
            curH = h;
            /* **字号跟着布局走，不等定时器。**
             * 2026-11-22 审查抓到：原来 applyLabelScale 只由 3 秒定时器调用，
             * 而拖动改窗口大小时 applyAspect 每帧都在 updateViewLayout ——
             * 结果窗口平滑跟手、文字纹丝不动，过几秒突然跳一下，就是用户说的
             * 「文字跟随屏幕放大缩小非常不同步」。这里用刚算出的 w（不要读 getWidth，
             * updateViewLayout 是异步的，紧跟读会拿到旧值）。
             */
            applyLabelScaleTo(w);
            if (lp != null) {
                boolean sizeChanged = (Math.abs(lp.width - w) > 2 || Math.abs(lp.height - h) > 2);
                /* **设完新尺寸必须夹一次位置。**
                 *
                 * 2026-11-22 动效审计指出：窗口比例一变（虚拟屏转屏/App 强制横屏）
                 * applyAspect 只改 width/height 不动位置 —— 原来在下半屏的窗口，
                 * 高度变大后底边就被推出屏幕。而且 250ms 后的延迟重排
                 * 会把它放回候选位置，clampAll 那一次夹取白做。
                 */
                try { clampPos(w, h); } catch (Throwable t) { /* ignore */ }
                lp.width = w;
                lp.height = h;
                if (root != null) {
                    try { wm.updateViewLayout(root, lp); } catch (Throwable t) { /* ignore */ }
                }
                if (sizeChanged) ui.post(new Runnable() { public void run() { relayoutAuto(); } });

                /* **真实尺寸确定后要重新排一次所有窗口。**
                 *
                 * 2026-11-22 实机抓到两个窗口都在 y=585 重叠：加窗口时还没有帧，
                 * curW/curH 是 0，findFreeSlot 只能按兜底比例算位置；等第一帧到了、
                 * 真实尺寸定下来，位置却没人重算，于是一直重叠。
                 *
                 * 这里在尺寸变化后延迟一点重排（让同类窗口也走完各自的尺寸计算），
                 * 一次 post 统一重放，避免每个窗口各排一次互相打架。
                 */
                if (sizeChanged) {
                    ui.removeCallbacks(relayoutOnce);
                    ui.postDelayed(relayoutOnce, 250);
                }
            }
        }

        /**
         * **独立的状态定时器**：不依赖「收到帧」才查 /status。
         *
         * 对抗审查 #5：原来 pollStatus() 只在 readMjpeg() 收到帧后调用，
         * 于是「端口死了 / 那块屏没 App / 已经 stop」的窗口**永远不会关**，
         * 留下一个永久空白窗，还会吞触摸事件。
         */
        void startStatusTimer() {
            if (statusTimerStarted) return;
            statusTimerStarted = true;
            final Runnable tick = new Runnable() {
                public void run() {
                    if (!alive || !running) return;
                    /* 每 3 秒同时刷新底部等级。原来只 pollStatus 查存活，
                     * 从不刷 label —— 用户在那块屏上换了 App，L 等级一直停在旧值，
                     * 除非手动收起再展开。等级是用来判断能不能这么操作的，
                     * 显示过期值比不显示更糟。 */
                    refreshLabel();
                    /* **主动比对屏幕尺寸 —— 这是转屏检测的主路径。**
                     *
                     * onConfigurationChanged 在进程被判不可见时不一定送达，
                     * 所以每 3 秒自己看一眼：尺寸变了就全量重排（位置/尺寸/级联/边缘层）。
                     */
                    try {
                        int swNow = getResources().getDisplayMetrics().widthPixels;
                        int shNow = getResources().getDisplayMetrics().heightPixels;
                        onScreenSizeChanged(swNow, shNow);
                    } catch (Throwable t) { /* ignore */ }
                    new Thread(new Runnable() {
                        public void run() {
                            if (!pollStatus()) return;   // 返回 false = 已决定关闭
                        }
                    }).start();
                    ui.postDelayed(this, 3000);
                }
            };
            ui.postDelayed(tick, 3000);
        }

        /** 起轮询线程（幂等）。 */
        void startLoop() {
            if (looping || !alive) return;
            startStatusTimer();
            startEdgeTimer();
            looping = true;
            new Thread(new Runnable() {
                @Override public void run() {
                    while (alive && running) {
                        try {
                            /* **MJPEG 断了就退回单帧轮询。**
                             *
                             * 2026-11-22 复核抓到：stream.js 里写着「悬浮窗会走进回退轮询」，
                             * 而浮窗只连 /stream.mjpg，根本没有 /frame.jpg 兜底 —— 注释描述的东西不存在。
                             *
                             * 长连接在某些网络栈/省电策略下会莫名断掉，而单帧 GET 只要服务活着就成功。
                             * 连续失败 3 次以上改用轮询，轮询几次成功一次就回长连接（长连接延迟更低）。
                             */
                            if (mjpegFails >= 3) {
                                if (readOneFrame()) {
                                    mjpegFails = 0;      // 能取到帧就回长连接
                                    sleep(400);
                                    continue;
                                }
                                sleep(800);
                                continue;
                            }
                            if (readMjpeg()) { mjpegFails = 0; sleep(600); continue; }
                            mjpegFails++;
                        } catch (Throwable t) { mjpegFails++; }
                        sleep(600);
                    }
                }
            }, "overlay-" + port).start();
        }

        /**
         * **单帧兜底：GET /frame.jpg 取一张。**
         *
         * MJPEG 长连接断了的时候用它 —— 只要服务活着，单次 GET 就能拿到当前帧。
         * 比长连接多花一次连接开销，但比「什么都没显示」强太多。
         *
         * @return true = 取到并显示了
         */
        boolean readOneFrame() {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/frame.jpg").openConnection();
                c.setConnectTimeout(2000);
                c.setReadTimeout(4000);
                c.setUseCaches(false);
                if (c.getResponseCode() != 200) return false;
                java.io.InputStream in = c.getInputStream();
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream(64 * 1024);
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                byte[] jpg = bo.toByteArray();
                if (jpg.length < 200) return false;
                // JPEG 头校验：0xFF 0xD8
                if ((jpg[0] & 0xFF) != 0xFF || (jpg[1] & 0xFF) != 0xD8) return false;
                lastOk = System.currentTimeMillis();
                showJpeg(jpg);
                return true;
            } catch (Throwable t) {
                return false;
            } finally {
                try { if (c != null) c.disconnect(); } catch (Throwable t) { /* ignore */ }
            }
        }


        /**
         * **边缘状态的快速轮询。**
         *
         * 2026-11-22 复核指出：refreshEdge 原来挂在 3 秒的状态定时器上，
         * 而 done 的 TTL 只有 4 秒 —— 最坏情况用户只能看到 1 秒绿色，
         * 根本来不及注意到「完成了」。
         *
         * 这里单独开一个 500ms 的轮询，**只读一个本地小文件**（几十字节），
         * 不跑 adb、不联网，成本可以忽略。状态变化能在半秒内反映到边框上。
         */
        void startEdgeTimer() {
            if (edgeTicking) return;
            edgeTicking = true;
            ui.postDelayed(new Runnable() {
                public void run() {
                    if (!alive || !running) { edgeTicking = false; return; }
                    try { refreshEdge(); } catch (Throwable t) { /* 单次失败不影响 */ }
                    ui.postDelayed(this, 500);
                }
            }, 500);
        }

        /** MJPEG 长连接：一有新帧立刻显示。返回 true 表示「连上过但断了」。 */
        boolean readMjpeg() {
            HttpURLConnection c = null;
            boolean everConnected = false;
            try {
                c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/stream.mjpg").openConnection();
                c.setConnectTimeout(2500);
                c.setReadTimeout(20000);
                c.setUseCaches(false);
                int code = c.getResponseCode();
                if (code != 200) return false;
                everConnected = true;
                lastOk = System.currentTimeMillis();
                BufferedInputStream in = new BufferedInputStream(c.getInputStream(), 1 << 16);
                while (alive && running) {
                    byte[] jpg = readOnePart(in);
                    if (jpg == null) break;
                    lastOk = System.currentTimeMillis();
                    showJpeg(jpg);
                    // 每帧顺手看看状态（便宜，2 秒一次）
                    if (System.currentTimeMillis() - lastStatusAt > 2000) {
                        lastStatusAt = System.currentTimeMillis();
                        if (!pollStatus()) break;
                    }
                }
            } catch (Throwable t) {
                // 连接失败是常态（服务端没起），不刷日志
            } finally {
                try { if (c != null) c.disconnect(); } catch (Throwable t) { /* ignore */ }
            }
            return everConnected;
        }

        long lastStatusAt = 0;

        /**
         * 从 multipart 流里读一帧 JPEG。
         *
         * **第一版有 bug**：每遇到 '\n' 就 reset 缓冲区，结果只留下最后一行，
         * Content-Length 那行被清掉 → len<=0 → 返回 null → 窗口永远不显示。
         * 正确做法：把整个头部块（直到空行）累积起来再解析。
         */
        byte[] readOnePart(InputStream in) throws Exception {
            // ① 一次读一个字节累积整块头部，直到遇到空行（\r\n\r\n）
            ByteArrayOutputStream hb = new ByteArrayOutputStream();
            int b;
            int nl = 0;   // 连续换行计数
            while ((b = in.read()) != -1) {
                hb.write(b);
                if (b == '\n') {
                    nl++;
                    if (nl == 2) break;      // 空行 = 头部结束
                } else if (b != '\r') {
                    nl = 0;
                }
                if (hb.size() > 8192) break;  // 头部异常，放弃这一帧
            }
            String hdr = new String(hb.toByteArray(), "UTF-8");
            int len = -1;
            int ci = hdr.toLowerCase().indexOf("content-length:");
            if (ci >= 0) {
                int e = ci + 15;
                while (e < hdr.length() && !Character.isDigit(hdr.charAt(e))) e++;
                int st = e;
                while (e < hdr.length() && Character.isDigit(hdr.charAt(e))) e++;
                if (e > st) {
                    try { len = Integer.parseInt(hdr.substring(st, e)); } catch (Throwable t) { /* ignore */ }
                }
            }
            if (len <= 0 || len > 8_000_000) return null;

            // ② 精确读 len 字节
            byte[] buf = new byte[len];
            int off = 0;
            while (off < len) {
                int n = in.read(buf, off, len - off);
                if (n < 0) return null;
                off += n;
            }
            return buf;
        }

        /**
         * 解码并显示一帧。
         *
         * **限帧是必须的。** MJPEG 是全速推的（服务端有新帧就发），
         * 单窗口无所谓，但 N 个窗口时解码量 = N × 推送帧率：
         * 5 个窗口 × 50fps = 250 次解码/秒，主线程必然堆积、GC 抖动。
         *
         * 上限按窗口数动态算：1 个窗口 30fps，2-3 个 15fps，4+ 个 8fps。
         * 超出的帧直接丢（**丢掉比排队好** —— 排队只会越来越延迟）。
         */
          /** 刷新底部那行字：屏号 + 风控等级 + 当前操作方式。
           *
           * 数据来自 /data/local/tmp/dshframe/opmode，由插件每次操作前写入。
           * 收起状态只显示屏号。
           */
          /**
           * **读边缘状态文件，切换光效。**
           *
           * 文件：/data/local/tmp/dshframe/edge
           * 格式：`模式|颜色HEX|强度|时间戳ms|持续ms`
           *   模式：idle / working / done / warning / error / critical
           *   例：`error|#FF3B30|0.9|1732278000123|8000`
           *
           * 为什么用文件不用 HTTP：浮窗和插件是两个进程，文件是现成的、
           * 无连接的、写坏了也不会阻塞。和 opmode 同一套模式。
           *
           * 时间戳用来算「这个状态从什么时候开始」—— 浮窗可能比写入晚几秒
           * 才读到，按剩余时长继续动画，而不是从头重播。
           */
          void refreshEdge() {
              EdgeView ev = edge;
              if (ev == null) return;
              String line = null;
              try {
                  java.io.BufferedReader r = new java.io.BufferedReader(
                          new java.io.FileReader("/data/local/tmp/dshframe/edge"));
                  line = r.readLine();
                  r.close();
              } catch (Throwable t) { /* 文件不在 = idle */ }
              if (line == null || line.trim().isEmpty()) {
                  if (!ev.isIdle()) ev.setMode(EdgeView.MODE_IDLE, android.graphics.Color.TRANSPARENT, 0f, 0);
                  return;
              }
              String[] parts = line.trim().split("\\|", -1);
              if (parts.length < 2) return;
              String modeName = parts[0].trim();
              int col;
              try { col = android.graphics.Color.parseColor(parts[1].trim()); }
              catch (Throwable t) { col = 0xFFFF3B30; }   // 解析不了用红，宁可多提示
              float inten = 1f;
              if (parts.length > 2) { try { inten = Float.parseFloat(parts[2].trim()); } catch (Throwable t) { } }
              long startedAtMs = 0;
              if (parts.length > 3) { try { startedAtMs = Long.parseLong(parts[3].trim()); } catch (Throwable t) { } }
              long durMs = 0;
              if (parts.length > 4) { try { durMs = Long.parseLong(parts[4].trim()); } catch (Throwable t) { } }
              /* **按 displayId 过滤：不是这块屏的状态就不显示。**
               * 2026-11-22 复核指出：edge 文件原来没有屏标识，
               * 多屏时所有窗口会同时变成同一个颜色，用户分不清是哪块屏出事。
               * 0 表示「不限屏」（老格式），当做通用状态处理。 */
              long edgeDisp = 0;
              if (parts.length > 5) { try { edgeDisp = Long.parseLong(parts[5].trim()); } catch (Throwable t) { } }
              if (edgeDisp > 0) {
                  /* edgeDisp 现在存的是**端口**（浮窗知道自己端口，不知道 displayId）。
                   * 0 = 不限屏。 */
                  if ((long) port != edgeDisp) {
                      if (!ev.isIdle()) ev.setMode(EdgeView.MODE_IDLE, android.graphics.Color.TRANSPARENT, 0f, 0);
                      return;
                  }
              }

              int m = EdgeView.MODE_IDLE;
              if ("working".equals(modeName)) m = EdgeView.MODE_WORKING;
              else if ("done".equals(modeName)) m = EdgeView.MODE_DONE;
              else if ("warning".equals(modeName)) m = EdgeView.MODE_WARNING;
              else if ("error".equals(modeName)) m = EdgeView.MODE_ERROR;
              else if ("critical".equals(modeName)) m = EdgeView.MODE_CRITICAL;

              if (m == EdgeView.MODE_IDLE) {
                  if (!ev.isIdle()) ev.setMode(EdgeView.MODE_IDLE, android.graphics.Color.TRANSPARENT, 0f, 0);
                  return;
              }
              long remain = 0;
              if (durMs > 0) {
                  long elapsed = startedAtMs > 0 ? (System.currentTimeMillis() - startedAtMs) : 0L;
                  remain = durMs - Math.max(0L, elapsed);
                  if (remain <= 0) {
                      if (!ev.isIdle()) ev.setMode(EdgeView.MODE_IDLE, android.graphics.Color.TRANSPARENT, 0f, 0);
                      return;
                  }
              }
              ev.setMode(m, col, inten, remain);
          }


          void refreshLabel() {
              if (label == null) return;
                // refreshEdge 由独立的 500ms 定时器驱动（startEdgeTimer），此处不再重复调
                /* **重连中就别用正常内容覆盖它。**
                 *
                 * 2026-11-22 对抗审查抓到：setReconnecting(true) 只在连续第 3 次失败时
                 * 调一次，而 refreshLabel 每 3 秒无条件重写 labelText/label.setText。
                 * 于是「重连中」只显示约 3 秒就被盖回「风控 中 · 待机 · 屏 388xx」，
                 * 然后静默重试 3 分钟后窗口自己消失 —— 用户看到的是
                 * 「闪一下 → 正常 → 突然没了」，和注释承诺的「窗口留着，显示重连中」不一致。
                 */
                if (reconnecting) return;
              String[] st = readStatus(port);
              String lv = st == null ? "" : st[0];
              String op = st == null ? "" : st[1];
              String dn = st == null ? "" : st[2];
              /* 三段：等级 · 操作方式 · 屏号。用户 2026-11-21 明确要这三样。
               * 收起时空间小，只留等级。缺哪段就少显示哪段，不补占位符。 */
              StringBuilder sb = new StringBuilder();
              /* 等级不再显示 `L2`，显示「风控 中」。用户 2026-11-22 明确要求：
               * 「不要显示 L几，要显示风控等级无、低、中、高、很高之类的写法」。 */
              if (!lv.isEmpty()) {
                  String w = levelWord(lv);
                  sb.append(w.isEmpty() ? "风控" : "风控 " + w);
              }
              if (!collapsed) {
                  if (!op.isEmpty()) { if (sb.length() > 0) sb.append(" · "); sb.append(op); }
                  if (!dn.isEmpty()) { if (sb.length() > 0) sb.append(" · "); sb.append("屏").append(dn); }
              }
              /* **内容没变就别动视图。** 这个方法每 3 秒被定时器调一次，
               * 每次无条件 setText/setTextColor/setPadding/setBackground 都会 requestLayout，
               * 即使文字完全一样也会重新测量布局 —— 那就是「字自己抖」的直接来源。 */
              final String wantText = sb.length() == 0 ? ("屏 " + port) : sb.toString();
              final int wantColor = (sb.length() > 0 && !lv.isEmpty()) ? levelColor(lv) : 0xCCFFFFFF;
              if (wantText.equals(labelText) && wantColor == labelColor) return;
              labelText = wantText;
              labelColor = wantColor;
              label.setText(wantText);
              label.setTextColor(wantColor);
              /* **字号和背景随窗口缩放。** 用户要求：「如果装不下这么多字，
               * 就根据虚拟屏放大缩小来同步放大缩小这些字体显示的大小以及字体后面的背景」。
               * 窗口小 → 字小；窗口大 → 字大。以窗口宽度为基准，10sp 对应 300px 宽。 */
              applyLabelScale();
          }

          /** **量完再定字号** —— 让整行文字正好填满可用宽度，不换行、不溢出。
           *
           *  2026-11-22 实机踩到：上一版按「窗口宽 / 300」乘系数，559px 的窗口算出 1.6 倍，
           *  10sp 变 16sp，字直接溢出窗口还折成两行 —— 用户说的「字跳来跳去、缩放不同步」
           *  就是这个。按比例放大是错的，因为字数不是恒定的：`风控 中 · 待机 · 屏 748`
           *  和 `风控 极高 · 注入·tap · 屏 712` 长度差很多，同一个系数不可能都对。
           *
           *  正确做法：先量这行字在当前字号下有多宽，再按「可用宽度 ÷ 实测宽度」回推字号。
           *  上限 12sp 防止短文本被放得过大，下限 7sp 保证小窗也读得清。
           */
          /** 定时器那条路的入口：读当前视图宽度。 */
          void applyLabelScale() {
              if (root == null) return;
              applyLabelScaleTo(root.getWidth());
          }

          /** 真正的实现：按给定宽度定字号。 */
          void applyLabelScaleTo(int w) {
              if (label == null) return;
              if (w <= 0) return;                      // 还没布局
              CharSequence cs = label.getText();
              if (cs == null || cs.length() == 0) return;

              /* 可用宽度要留够：文字左右各留 8dp，否则会贴边甚至被裁。
               * 2026-11-22 实机：559px 窗口里「风控 中 · 待机 · 屏760」按 12sp 算刚好超，
               * 渲染出来左边「风控」被裁掉一截。 */
            /* **宽度要减掉「标签真实的左右边距」，不是拍一个 dp(16)。**
             *
             * 2026-11-24 审查算过：标签边距是 leftMargin dp(3) + rightMargin dp(36)
             * = 39dp，而这里只减 16dp → 少算 23dp → 字号算大了 → 尾部被 ellipsize 截掉。
             * 注释里 2026-11-22 记的「屏909 被截成 屏9…」就是它。
             */
            int labelMargin = dp(3) + dp(36);
            int availW = Math.max(dp(24), w - labelMargin - dp(4));
              // 先用一个基准字号量宽度，再按比例回推
              float base = 10f;
              label.setTextSize(TypedValue.COMPLEX_UNIT_SP, base);
              android.text.TextPaint tp = label.getPaint();
              float measured = tp.measureText(cs.toString());
              if (measured <= 0f) return;

              float want = base * (availW / measured);
              /* 上限从 12sp 降到 9sp：实机看 12sp 在 40% 屏宽的浮窗里明显过大、压住内容。
               * 9sp 在同样窗口里清晰但不抢戏。下限 7sp 保证小窗可读。 */
              if (want > 9f) want = 9f;
              if (want < 7f) want = 7f;
              label.setTextSize(TypedValue.COMPLEX_UNIT_SP, want);

              int padH = Math.max(dp(2), Math.round(dp(5) * (want / base)));
              int padV = Math.max(dp(1), Math.round(dp(1) * (want / base)));
              label.setPadding(padH, padV, padH, padV);
              GradientDrawable bg = new GradientDrawable();
              bg.setColor(0xE6000000);
              bg.setCornerRadius(Math.max(dp(2), Math.round(dp(4) * (want / base))));
              label.setBackground(bg);
          }

        void showJpeg(byte[] jpg) {
            long now = System.currentTimeMillis();
            int n = Math.max(1, wins.size());
            /* **收起时降到 5fps。**
             *
             * 第一性原理审查（2026-11-24）：36dp 的小窗里放 400px 的 JPEG，
             * 按 30fps 解码 = 每秒 30 次 Bitmap 分配。用户收起是为了少挡屏幕，
             * 不是为了看 30fps —— 5fps 足够「瞄一眼知道在动」。
             */
            int capFps = collapsed ? 5 : (n <= 1 ? 30 : (n <= 3 ? 15 : 8));
            if (now - lastFrameAt < (1000 / capFps)) { dropped++; return; }
            lastFrameAt = now;
            try {
                // **收起时也解码**：用户要的是「很小的实时画面」，不是冻结帧。
                // 只是不解码到不可见窗口（被 ✕ 隐藏那种）。
                if (root == null || root.getVisibility() != View.VISIBLE) return;
                /* **收起时降采样解码（inSampleSize=4 → 宽约 100px）。**
                 *
                 * 审查算过：400px 宽的 JPEG 全尺寸解出来约 1.3MB，
                 * 30fps 就是每秒 40MB 分配，主线程 GC 抖动。
                 * 小窗根本用不上那个分辨率，降 4 倍省 16 倍内存和时间。
                 */
                Bitmap bm;
                if (collapsed) {
                    BitmapFactory.Options o = new BitmapFactory.Options();
                    o.inSampleSize = 4;
                    o.inPreferredConfig = android.graphics.Bitmap.Config.RGB_565;
                    bm = BitmapFactory.decodeByteArray(jpg, 0, jpg.length, o);
                } else {
                    bm = BitmapFactory.decodeByteArray(jpg, 0, jpg.length);
                }
                if (bm == null) return;
                final Bitmap fb = bm;
                // 更新比例（用解码出来的真实尺寸）
                float a = (float) fb.getWidth() / Math.max(1, fb.getHeight());
                if (Math.abs(a - aspect) > 0.01f) {
                    aspect = a;
                    // 收起状态不改尺寸（否则实时刷新会把小预览打回大窗口）
                    if (!collapsed) {
                        ui.post(new Runnable() { public void run() { applyAspect(); } });
                    }
                }
                ui.post(new Runnable() {
                    public void run() {
                        // **收起时也要刷新画面！** 原来写了 !collapsed，最小化后小预览永远停在第一帧
                        if (img != null && alive) img.setImageBitmap(fb);
                    }
                });
            } catch (Throwable t) { /* 单帧解码失败不影响流 */ }
        }

        /** 查 /status；服务端说没在跑就关掉自己这个窗口。 */
        boolean pollStatus() {
            try {
                String st = http("http://127.0.0.1:" + port + "/status");
                if (st == null) {
                    /* **连不上不等于要关窗。**
                     *
                     * 2026-11-22 实机：framesrv 死掉后，这里连续 20 次不通就把窗口关掉，
                     * 之后再也不重连 —— 用户看到的就是「过一会儿黑屏，再也回不来」，
                     * 哪怕屏后来恢复了也永远不会自己出现。这是「黑屏就再也看不到」的直接原因。
                     *
                     * 现在：不关窗。窗口留着，显示「重连中」，后台继续按原节奏重试。
                     * 理由 —— 一个正被看着的窗口突然消失，比显示一句「重连中」糟糕得多；
                     * 而且屏和推流可能只是瞬时抖动，关掉就等于放弃了恢复的机会。
                     */
                    statusFails++;
                    if (statusFails == 3) {
                        // 只提示一次，别每 3 秒刷一条
                        Log.i(TAG, "端口 " + port + " 连不上，进入重连（窗口保留）");
                        ui.post(new Runnable() { public void run() { setReconnecting(true); } });
                    }
                    /* **重试要有上限。**
                     *
                     * 2026-11-22 实机：上面「永不放弃」写完就发现新问题 ——
                     * 反复建屏/杀推流之后，攒了 4 个窗口分别对着 38825/38827/38829
                     * 这些永远回不来的端口，每个都在无限重试。僵尸窗口堆在屏幕上，
                     * 而且它们永远显示「重连中」，用户没法区分「等一会就好」和「这块屏没了」。
                     *
                     * 3 秒一次 × 60 次 ≈ 3 分钟。真的断了 3 分钟还不回来，
                     * 基本可以断定这块屏被销毁或端口换了（端口按 displayId 推导，
                     * 换了 displayId 就是换了端口）。这时关窗比留着更有用：
                     * 屏幕干净，用户也知道该重新建屏了。
                     */
                    if (statusFails >= 60) {
                        Log.i(TAG, "端口 " + port + " 重试 3 分钟仍不通，判定这块屏已关闭，移除窗口");
                        ui.post(new Runnable() { public void run() { removeWin(port); } });
                        return false;
                    }
                    return true;    // **继续轮询，不关窗**
                }
                setReconnectingIfNeeded();
                /* **running:false 不能立即关窗。**
                 *
                 * 2026-11-23 产品审查抓到一个自证死的循环：
                 * framesrv 的 alive 判据是「120 秒内有人取帧」，而浮窗被系统
                 * 限制（省电策略 / 后台限制）时取帧变慢 → framesrv 判 alive=false
                 * → 浮窗收到 running:false 立刻关窗 → 用户看到窗口凭空消失，
                 * 而屏和 App 其实都还在。
                 *
                 * 推流挂了 ≠ 屏没了。所以改成和「端口不通」同一条路：
                 * 计入 statusFails，连续多次才关窗。
                 */
                if (st.contains("\"running\":false")) {
                    statusFails++;
                    Log.i(TAG, "端口 " + port + " 报 running:false（第 " + statusFails + " 次），继续等");
                    if (statusFails >= 60) {
                        Log.i(TAG, "端口 " + port + " 连续 " + statusFails + " 次报 running:false，关窗");
                        ui.post(new Runnable() { public void run() { removeWin(port); } });
                        return false;
                    }
                    return true;
                }
                statusFails = 0;
                float a = parseAspect(st);
                if (a > 0.15f && Math.abs(a - aspect) > 0.01f) {
                    aspect = a;
                    ui.post(new Runnable() { public void run() { applyAspect(); } });
                }
            } catch (Throwable t) { /* ignore */ }
            return true;
        }

        /** 切到「重连中」提示。窗口不关，只是把画面替换成一句说明。
         *  用户看到的不再是突然消失，而是「暂时连不上，正在重试」。 */
        void setReconnecting(boolean on) {
            if (reconnecting == on) return;
            reconnecting = on;
            if (on) {
                if (img != null) img.setImageDrawable(null);
                labelText = "重连中";
                labelColor = 0xFFFFC107;
                if (label != null) {
                    label.setText("重连中");
                    label.setTextColor(0xFFFFC107);
                }
            } else {
                labelText = "";   // 让 refreshLabel 重新写回正常内容
                labelColor = 0;
            }
        }

        /** 连上了就把「重连中」撤掉。已经正常时什么都不做。 */
        void setReconnectingIfNeeded() {
            if (reconnecting) setReconnecting(false);
        }

        void close() {
            alive = false;
            if (root != null) {
                try { wm.removeView(root); } catch (Throwable t) { /* 可能已经不在 */ }
                root = null;
            }
            img = null;
            label = null;
            // 位图交给 GC（限帧后不再复用同一个 buffer，避免撕裂）
            Log.i(TAG, "窗口已关闭 port=" + port);
        }
    }

    // ═══════════════ 工具 ═══════════════

    static float parseAspect(String st) {
        try {
            int i = st.indexOf("aspect");
            if (i < 0) return 0f;
            int c = st.indexOf(':', i);
            int e = c + 1;
            while (e < st.length() && "-0123456789.".indexOf(st.charAt(e)) >= 0) e++;
            return Float.parseFloat(st.substring(c + 1, e).trim());
        } catch (Throwable t) { return 0f; }
    }

    String http(String u) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(u).openConnection();
            c.setConnectTimeout(1200);
            c.setReadTimeout(1200);
            InputStream in = c.getInputStream();
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int n;
            while ((n = in.read(b)) > 0) o.write(b, 0, n);
            return new String(o.toByteArray(), "UTF-8");
        } catch (Throwable t) {
            Log.w(TAG, "http 失败 " + u + " : " + t.getClass().getSimpleName() + " " + t.getMessage());
            return null;
        } finally {
            try { if (c != null) c.disconnect(); } catch (Throwable t) { /* ignore */ }
        }
    }

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { /* ignore */ }
    }

    /** 当前操作方式与风控等级，从 /data/local/tmp/dshframe/opmode 读。
     *
     *  为什么走文件：插件（Node）和浮窗（Java）是两个进程，
     *  但都在 uid 2000 能写的 /data/local/tmp 下，落一个小文件最省事，
     *  不用再开 socket。插件每次操作前写一行，浮窗轮询读，读不到就显示空。
     *
     *  格式：`L2|拟人化|vdisplay_tap_text` 或简写 `L2|vdisplay_tap_text`
     */
    /** 读插件写的状态行：`L2|注入·tap|699`。缺段返回空串。
     *
     *  用户 2026-11-21 要求浮窗同时显示：风控等级、当前操作方式、后台屏编号。
     *  插件在每次操作前/守护进程定时写这一行，浮窗轮询解析。
     */
    static String[] readStatus(int port) {
        java.io.BufferedReader r = null;
        try {
            /* **先读「本窗口端口」那份，读不到再退回全局那份。**
             *
             * 2026-11-23 审查抓到：opmode 是单文件单槽，所有浮窗读同一份 ——
             * 多屏时每个窗口显示的都是「最后一次操作的那块屏」的屏号。
             */
            java.io.File perPort = new java.io.File("/data/local/tmp/dshframe/opmode." + port);
            java.io.File f = perPort.exists() ? perPort
                    : new java.io.File("/data/local/tmp/dshframe/opmode");
            r = new java.io.BufferedReader(new java.io.FileReader(f));
            String line = r.readLine();
            if (line == null) return null;
            line = line.trim();
            if (line.isEmpty()) return null;
            String[] parts = line.split("\\|", -1);
            String[] out = new String[] { "", "", "" };
            for (int i = 0; i < parts.length && i < 3; i++) {
                String v = parts[i].trim();
                out[i] = v.length() > 24 ? v.substring(0, 24) : v;
            }
            /* **等级段允许三种：L0..L5、`?`（未评估）、空。**
             *
             * 2026-11-24 对抗审查抓到：原来只认两字符的 L0..L5，
             * 而 `?` 长度是 1 → 第一个条件就挂 → out[0]="" → 整段丢掉。
             * 于是 refreshLabel 里 `if (!lv.isEmpty())` 跳过，
             * 浮窗只显示「待机 · 屏925」，用户看不到风控状态。
             * levelWord 里的 `case "?"` 因此是死代码，永远走不到。
             */
            String lv = out[0];
            if ("?".equals(lv)) {
                out[0] = "?";
            } else if (lv.length() == 2
                    && (lv.charAt(0) == 'L' || lv.charAt(0) == 'l')
                    && lv.charAt(1) >= '0' && lv.charAt(1) <= '5') {
                out[0] = "L" + lv.charAt(1);
            } else {
                out[0] = "";
            }
            return out;
        } catch (Throwable t) {
            return null;
        } finally {
            try { if (r != null) r.close(); } catch (Throwable t) { /* ignore */ }
        }
    }

    static String readRiskLevel() {
        java.io.BufferedReader r = null;
        try {
            r = new java.io.BufferedReader(new java.io.FileReader("/data/local/tmp/dshframe/opmode"));
            String line = r.readLine();
            if (line == null) return "";
            line = line.trim();
            /* 只认 `L0`..`L5` 这种两字符开关。
             * 2026-11-21 用户反馈：之前那行是「屏 38820 · 注入·tap」，一堆看不懂的，
             * 唯一有意义的是风控等级。所以这里只取等级，别的全部丢掉。 */
            /* `?` = AI 还没评估，也要透出去（2026-11-24 同上）。 */
            if ("?".equals(line)) return "?";
            if (line.length() >= 2 && (line.charAt(0) == 'L' || line.charAt(0) == 'l')
                    && Character.isDigit(line.charAt(1))) {
                return "L" + line.charAt(1);
            }
            return "";
        } catch (Throwable t) {
            return "";
        } finally {
            try { if (r != null) r.close(); } catch (Throwable t) { /* ignore */ }
        }
    }

    /** 等级 → 中文短词。用户要能一眼看懂这一档意味着什么。 */
    /** 风控等级的文字说法。用户 2026-11-22：不要显示 L几，要显示「无/低/中/高/很高」这种。
     *
     *  L0 无风控 → 无；L1 弱 → 低；L2 中 → 中；L3 强 → 高；L4 极强 → 很高；L5 特殊 → 极高。
     *  用「极高」而不是「很高」给 L5，因为 L5 是 DRM/活体这种根本不该碰的，和 L4 得分开。
     */
    static String levelWord(String lv) {
        switch (lv) {
            case "L0": return "无";
            case "L1": return "低";
            case "L2": return "中";
            case "L3": return "高";
            case "L4": return "很高";
            case "L5": return "极高";
            /* **`?` = AI 还没评估过。**
             * 用户 2026-11-24 定的：判断由 AI 做，插件只显示。
             * 没评估时显示「未评估」，而不是瞎填一个等级。 */
            case "?":  return "未评估";
            default:   return "";
        }
    }

    /** 等级 → 颜色。越高越红，用户不用读字就知道危险程度。 */
    static int levelColor(String lv) {
        switch (lv) {
            case "L0": return 0xFF34D399;   // 绿
            case "L1": return 0xFFA3E635;   // 黄绿
            case "L2": return 0xFFFACC15;   // 黄
            case "L3": return 0xFFFB923C;   // 橙
            case "L4": return 0xFFEF4444;   // 红
            case "L5": return 0xFFDC2626;   // 深红
            /* **未评估用灰色**，不是白色也不是红 —— 它表示「不知道」，
             * 不能误导成危险或安全。 */
            case "?":  return 0xFF9CA3AF;   // 灰
            default:   return 0xFFFFFFFF;
        }
    }

    int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** 通知：显示当前有几个窗口。 */
    void updateNotification() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.notify(CH_NUM, buildNotification());
        } catch (Throwable t) { /* ignore */ }
    }

    Notification buildNotification() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm.getNotificationChannel(CH_ID) == null) {
                nm.createNotificationChannel(new NotificationChannel(
                        CH_ID, "AI 画面", NotificationManager.IMPORTANCE_LOW));
            }
        }
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);

        int n = wins.size();
        String title = n <= 1 ? "AI 画面正在显示" : "AI 画面 · " + n + " 个窗口";
        String text = n <= 0 ? "等待连接…" : "端口 " + describePorts();
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CH_ID)
                : new Notification.Builder(this);
        return b.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private String describePorts() {
        StringBuilder sb = new StringBuilder();
        for (Integer p : wins.keySet()) {
            if (sb.length() > 0) sb.append(" / ");
            sb.append(p);
        }
        return sb.toString();
    }
}
