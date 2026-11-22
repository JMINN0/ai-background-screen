package com.dsh.framesrv;

import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Surface;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 常驻取帧服务 —— 用 ImageReader 镜像虚拟屏，自己当 HTTP 服务器。
 *
 * ## 为什么需要它
 *
 * `screencap` 每次 141ms 的 Surface 回读是不可优化的（实测：裸截图 141ms，PNG 再加 98ms）。
 * ImageReader 从合成器直接拿 buffer，实测能到 67fps。
 *
 * ## 架构
 *
 * ```
 * 虚拟屏（scrcpy 建的）
 *    ↓ 镜像
 * ImageReader（本进程，15ms/帧）
 *    ↓ HTTP（本进程自己 serve，不经 Node）
 * Overlay APK / 胶囊
 * ```
 *
 * 这样 Overlay 直接连这个服务，Node 只负责启动它和传端口。
 *
 * ## 用法
 *
 * ```
 * CLASSPATH=/data/local/tmp/dshframe/frame.dex app_process / com.dsh.framesrv.Main \
 *     --display=416 --port=38810 --width=400
 * ```
 *
 * 端点：
 *   /frame.jpg    当前帧（JPEG）
 *   /status       状态（running/frames/fps/aspect）
 *   /stream.mjpg  MJPEG 长连接
 *   /quit         退出
 */
public class Main {

    static final long createdAt = System.currentTimeMillis();
    static int displayId = 0;
    static int port = 38810;
    static int outWidth = 400;
    static volatile int srcW = 720, srcH = 1592;   // volatile：/status 在连接线程里读

    static ImageReader reader;
    static VirtualDisplay vd;
    static volatile byte[] latest = null;

    /** 帧回调（建 reader 时挂上；重建时复用同一个对象，避免重复写匿名类）。 */
    static volatile ImageReader.OnImageAvailableListener frameListener = null;

    /**
     * **回调用的 Handler，必须显式传。**
     *
     * ImageReader.setOnImageAvailableListener(listener, null) 在 handler 为 null 时
     * 会用 `Looper.myLooper()`。首建发生在 main 里（已 prepareMainLooper）所以没事，
     * 但**旋转重建是从 size-watch 线程发起的，那个线程没有 Looper** →
     * 抛 `IllegalArgumentException: handler is null but the current thread is not a looper`。
     * 正好是最需要它的那条路会炸。所以把 main 里的 Handler 存下来，重建时显式传。
     */
    static volatile Handler cbHandler = null;

    /** 当前镜像的 ImageReader / VirtualDisplay，尺寸变化时会重建。 */
    // reader/vd 的声明在上面（行 67-68）已有，不重复声明

    /**
     * **建一块镜像：ImageReader + VirtualDisplay，尺寸由参数决定。**
     *
     * 单独抽出来是因为要能重建：虚拟屏带 FLAG_ROTATES_WITH_CONTENT，
     * App 强制横屏时屏会从 720×1592 变成 1592×720，
     * 而原来这里尺寸是建的时候定死的、永不更新 ——
     * 结果投横屏游戏时画面只出现在顶部一条，其余全黑（2026-11-20 实测）。
     */
    /**
     * 建镜像：ImageReader + VirtualDisplay。
     *
     * **顺序很重要：先建新的，成功了再拆旧的。**
     * 反过来（先 closeMirror 再建）的话，一旦新建失败（尺寸非法、binder 拒绝、
     * OOM），一块本来好好工作的镜像就被毁了 —— /frame.jpg 503、
     * MJPEG 没有新帧，直到下一次重试成功。实测踩过。
     *
     * @return true = 新镜像已生效
     */
    static synchronized boolean openMirror(int w, int h) {
        // 防御：异常尺寸会把 ImageReader 撑爆
        if (w < 64 || h < 64 || w > 4096 || h > 4096) return false;
        if ((long) w * h > 4_000_000L) return false;

        startWriter();   // 幂等；写线程从 pendingJpg 取帧发 MJPEG

        ImageReader nr = null;
        VirtualDisplay nvd = null;
        try {
            nr = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2);
            nr.setOnImageAvailableListener(frameListener, cbHandler);   // 显式 Handler
            /* **第 4 个参数是 displayIdToMirror，传错了会静默镜像到主屏。**
             *
             * 2026-11-20 踩到：为了"修 dpi"，把这里改成传 mDpi(320)，
             * 结果 createVirtualDisplay 拿到一个不存在的 displayId → 回退镜像 display 0
             * → 悬浮窗显示的是用户主屏（DSH Go 对话界面），不是后台屏。
             * 表现极具迷惑性：进程活着、帧数在涨、画面在动，只是内容错了。
             *
             * 镜像屏的 dpi 由框架按源屏算，我们控制不了也不该控制。
             */
            Method m = DisplayManager.class.getDeclaredMethod("createVirtualDisplay",
                    String.class, int.class, int.class, int.class, Surface.class);
            m.setAccessible(true);
            
            nvd = (VirtualDisplay) m.invoke(null, "dsh-frames", w, h, displayId, nr.getSurface());
            if (nvd == null) throw new IllegalStateException("vd == null");

            // —— 到这里新镜像已经能用，才拆旧的 ——
            VirtualDisplay oldVd = vd;
            ImageReader oldReader = reader;
            vd = nvd;
            reader = nr;
            srcW = w;
            srcH = h;
            // 旧方向的一帧不能发出去
            latest = null;
            pendingJpg = null;
            synchronized (bmpLock) {
                if (lastBmp != null) { try { lastBmp.recycle(); } catch (Throwable t) { } lastBmp = null; }
            }
            try { if (oldVd != null) { oldVd.setSurface(null); oldVd.release(); } } catch (Throwable t) { }
            try { if (oldReader != null) oldReader.close(); } catch (Throwable t) { }
            System.out.println("MIRROR_OK true " + w + "x" + h);
            return true;
        } catch (Throwable t) {
            System.out.println("ERR_MIRROR " + t.getClass().getSimpleName() + ": " + t.getMessage());
            Throwable c = t.getCause();
            if (c != null) System.out.println("  cause: " + c);
            // 新建的全回收，**现有镜像保持不动**
            try { if (nvd != null) { nvd.setSurface(null); nvd.release(); } } catch (Throwable t2) { }
            try { if (nr != null) nr.close(); } catch (Throwable t2) { }
            return false;
        }
    }

    /** 拆掉镜像（幂等）。 */
    static synchronized void closeMirror() {
        try { if (vd != null) { vd.setSurface(null); vd.release(); } } catch (Throwable t) { }
        vd = null;
        try { if (reader != null) reader.close(); } catch (Throwable t) { }
        reader = null;
    }

    /**
     * **尺寸看门狗**：每 1.5 秒查一次目标屏的真实尺寸，变了就重建镜像。
     *
     * 用 DisplayManagerGlobal.getDisplayInfo() 拿 logvid 尺寸 ——
     * 这是 app_process 里没有 Context 也能用的路径。
     */
    static volatile long lastRebuildAt = 0;

    /**
     * 尺寸看门狗：每秒查一次，**连续两次读到同一个新尺寸才重建**。
     *
     * 去抖的理由：App 转屏有中间态（窗口重排过程中尺寸会短暂跳变），
     * 看到一次就重建会在动画中间反复拆建。限速 1.5 秒同理。
     * 失败时打印一次，避免"永远不生效但也没人说"。
     */
    static void startSizeWatch() {
        Thread t = new Thread(new Runnable() {
            public void run() {
                int pw = 0, ph = 0, same = 0;
                boolean failLogged = false;
                while (true) {
                    try {
                        Thread.sleep(1000);
                        int[] wh = displaySize();
                        if (wh == null) {
                            same = 0;
                            if (!failLogged) { System.out.println("SIZE_PROBE_FAIL"); failLogged = true; }
                            continue;
                        }
                        failLogged = false;
                        if (wh[0] == srcW && wh[1] == srcH) { same = 0; continue; }
                        if (wh[0] == pw && wh[1] == ph) same++;
                        else { pw = wh[0]; ph = wh[1]; same = 1; }
                        if (same < 2) continue;                      // 连续两次一致才动手
                        if (System.currentTimeMillis() - lastRebuildAt < 1500) continue;
                        lastRebuildAt = System.currentTimeMillis();
                        System.out.println("RESIZE " + srcW + "x" + srcH + " -> " + pw + "x" + ph);
                        openMirror(pw, ph);
                    } catch (Throwable t) { }
                }
            }
        }, "size-watch");
        t.setDaemon(true);
        t.start();
    }

    /**
     * 查目标屏**当前**的真实像素尺寸；查不到返回 null。
     *
     * **不用 DisplayManagerGlobal.logicalWidth/Height。**
     * 项目自己在 `screen/src/vd.js` 里记录过：`dumpsys display` 报的是虚拟屏
     * 初始声明尺寸（比如 720x1592），App 强制横屏后实际是 1592x720 ——
     * 也就是说这类"声明尺寸"会滞后，拿它做看门狗判据可能永远不触发。
     *
     * 改用 `dumpsys window displays` 里的 `cur=WxH`，那个是合成器当前真正在用的。
     * 这条路要走 shell，用 Runtime.exec 跑。
     */
    static int[] displaySize() {
        try {
            Process pr = Runtime.getRuntime().exec(new String[]{
                "sh", "-c",
                "dumpsys window displays 2>/dev/null | grep -A3 \"Display: mDisplayId=" + displayId + "\" | grep -oE 'cur=[0-9]+x[0-9]+' | head -1"
            });
            java.io.BufferedReader br = new java.io.BufferedReader(
                    new java.io.InputStreamReader(pr.getInputStream()));
            String line = br.readLine();
            br.close();
            try { pr.waitFor(); } catch (Throwable t) { }
            if (line == null) return null;
            java.util.regex.Matcher m =
                    java.util.regex.Pattern.compile("cur=(\\d+)x(\\d+)").matcher(line.trim());
            if (!m.find()) return null;
            int w = Integer.parseInt(m.group(1));
            int h = Integer.parseInt(m.group(2));
            if (w <= 0 || h <= 0) return null;
            return new int[]{w, h};
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * **写 MJPEG 必须异步，否则客户端慢会把采集线程堵死。**
     *
     * 原来在 onImageAvailable（ImageReader 回调线程）里直接
     *   encode() + o.write() + o.flush()
     * 客户端（悬浮窗）解码慢一点，socket 缓冲区满了 write 就阻塞，
     * 于是采集回调被卡住 → 帧在队列里堆积 → **延迟越来越大**（用户实测「延迟很多」）。
     *
     * 现在：采集线程只负责编码并放入 pending，立刻返回；
     * 独立线程取出「最新一帧」写给客户端，旧帧直接丢弃（实时预览丢帧是对的）。
     */
    static final Object pendingLock = new Object();
    static volatile byte[] pendingJpg = null;
    static volatile boolean writerRunning = false;

    /** 启动异步写线程（幂等）。 */
    static void startWriter() {
        if (writerRunning) return;
        writerRunning = true;
        Thread t = new Thread(new Runnable() {
            public void run() {
                while (true) {
                    byte[] jpg = null;
                    synchronized (pendingLock) {
                        if (pendingJpg != null) {
                            jpg = pendingJpg;
                            pendingJpg = null;      // **只取最新，旧的自己覆盖掉**
                        }
                    }
                    if (jpg == null) {
                        try { Thread.sleep(8); } catch (Throwable t2) { }
                        continue;
                    }
                    for (Socket s : mjpegClients) {
                        try {
                            OutputStream o = s.getOutputStream();
                            o.write(("--dshframe\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                    + jpg.length + "\r\n\r\n").getBytes());
                            o.write(jpg);
                            o.write("\r\n".getBytes());
                            o.flush();
                        } catch (Throwable t3) {
                            mjpegClients.remove(s);
                            try { s.close(); } catch (Throwable t4) { }
                        }
                    }
                }
            }
        }, "mjpeg-writer");
        t.setDaemon(true);
        t.start();
    }
    // **缓存最后一帧的原始像素**，收到 /mark 时用它重编一张带标记的。
    // 为什么必须：画面静止时 ImageReader 不出新帧，`latest` 永远是标记之前那张，
    // 标记就永远不出现（实机踩到）。收到 /mark 要能自己主动重画一帧。
    static volatile android.graphics.Bitmap lastBmp = null;
    static final Object bmpLock = new Object();
    static final AtomicInteger frames = new AtomicInteger(0);
    static final AtomicInteger lastSecFrames = new AtomicInteger(0);
    static volatile int fps = 0;
    static final Set<Socket> mjpegClients = ConcurrentHashMap.newKeySet();

    // **看门狗：没人看的时候就别再编码了。**
    // 审计发现：原来不管有没有客户端，每帧都在 encode（53.7fps × ~19MB 垃圾/帧
    // = 1.04 GB/s），而且进程永不退出，一直烧 1.0 核。
    static volatile long lastFetchAt = 0;      // 上次有人取帧

    // **点击标记**：让用户看到 AI 点在哪、有没有点偏。
    // 之前标记只画在 stream.js 的 screencap 慢路径里，快路径（本服务）没画，
    // 所以用户看不到点击位置 —— 这是实机反馈的问题。
    static volatile float markNx = -1f, markNy = -1f;
    static volatile long markAt = 0;

    /**
     * **多指点击标记。**
     *
     * 用户 2026-11-22 要求：「显示时间要更长、能看出是多久前点的、
     * 不能太占屏幕、要支持多指触控」。
     *
     * 所以从「单个 markNx/markNy」改成列表：每一根手指/每一次点击都是一个条目，
     * 各自带自己的时间戳，绘制时按年龄算透明度和大小。
     * 上限 8 个 —— 再多屏幕就糊了，而且用户也分不清。
     */
    static final class Mark {
        final float nx, ny;
        final long at;
        Mark(float nx, float ny, long at) { this.nx = nx; this.ny = ny; this.at = at; }
    }
    static final java.util.ArrayDeque<Mark> marks = new java.util.ArrayDeque<>();
    /** 标记最长保留多久。15 秒：够用户看清「刚才点了哪」，又不会堆满屏。 */
    static final long MARK_LIVE_MS = 15_000;
    /** 同时最多几个标记。超了淘汰最老的。 */
    static final int MARK_MAX = 8;

    static void addMark(float nx, float ny) {
        long now = System.currentTimeMillis();
        synchronized (marks) {
            // 同一位置 400ms 内的重复点击合并，避免长按/连点堆成一坨
            for (Mark m : marks) {
                if (Math.abs(m.nx - nx) < 0.02f && Math.abs(m.ny - ny) < 0.02f
                        && now - m.at < 400) {
                    return;
                }
            }
            while (marks.size() >= MARK_MAX) marks.pollFirst();
            marks.addLast(new Mark(nx, ny, now));
        }
    }

    /** 清掉已经过期的标记。 */
    static void pruneMarks(long now) {
        synchronized (marks) {
            while (!marks.isEmpty() && now - marks.peekFirst().at > MARK_LIVE_MS) {
                marks.pollFirst();
            }
        }
    }

    static boolean hasAnyMark(long now) {
        synchronized (marks) {
            for (Mark m : marks) if (now - m.at <= MARK_LIVE_MS) return true;
            return false;
        }
    }
    static volatile long lastCheckAt = 0;
    static final int IDLE_PAUSE_MS = 15_000;   // 15 秒没人取 → 暂停编码
    /** 用户事件日志（悬浮窗写、插件读）：路径固定，双方约定。 */
    static final String EVENTS_FILE = "/data/local/tmp/dshframe/events.log";

    static final int IDLE_EXIT_MS = 120_000;   // 120 秒彻底没人 → 自己退出

    /**
     * **目标屏还在吗？**
     *
     * 实机踩到：虚拟屏死了（建它的进程退出），framesrv 还以为活着，
     * 继续吐最后一帧 → 悬浮窗显示「冻结的旧画面」，用户看到的就是
     * 「一个显示不使用时的最后一个 app」。
     *
     * 所以每次 /status 和被看时都查一下，屏没了就自己退。
     */
    /* **三态：活着 / 死了 / 不知道。**
     *
     * 2026-11-22 复核指出一个真实缺陷：原来反射失败时 `return true`
     * （「保底不误杀」），配上「取消 120 秒空闲自杀」之后，就变成
     * **反射失效的机型上 framesrv 永远活着**，一直占资源，没有兜底。
     *
     * 所以改成三态，让调用方自己决定：不知道的时候不要擅自当作「活着」，
     * 而是看「还有没有人在看」—— 没人看又判断不了，才退。
     */
    static final int DISP_ALIVE = 1;
    static final int DISP_DEAD = 0;
    static final int DISP_UNKNOWN = -1;

    /** @return DISP_ALIVE / DISP_DEAD / DISP_UNKNOWN */
    static int displayState() {
        // **首选 DisplayManagerGlobal.getDisplayInfo()：屏不存在时返回 null。**
        //
        // 实机踩到：scrcpy 那块屏（Node 进程持有）死了之后，
        // framesrv 建的 dsh-frames 镜像还在，继续以 119fps 编码一片空白，
        // 悬浮窗就永远显示冻结画面 —— 用户说「悬浮窗不停留在闲鱼上」就是这个。
        //
        // 原来的实现走 IDisplayManager$Stub 反射，失败时返回 true（保底不误杀），
        // 结果在这种场景下永远不会自杀。改成下面这条路，失败才退到旧判据。
        try {
            Class<?> dmg = Class.forName("android.hardware.display.DisplayManagerGlobal");
            Object inst = dmg.getMethod("getInstance").invoke(null);
            Object info = dmg.getMethod("getDisplayInfo", int.class).invoke(inst, displayId);
            return info != null ? DISP_ALIVE : DISP_DEAD;   // null = 屏已经不存在
        } catch (Throwable t) {
            // 退路：用 ServiceManager 列 id
        }
        try {
            Class<?> sm = Class.forName("android.os.ServiceManager");
            Object dms = sm.getMethod("getService", String.class).invoke(null, "display");
            if (dms == null) return DISP_UNKNOWN;
            Class<?> stub = Class.forName("android.hardware.display.IDisplayManager$Stub");
            Object idm = stub.getMethod("asInterface", Class.forName("android.os.IBinder")).invoke(null, dms);
            int[] arr = (int[]) idm.getClass().getMethod("getDisplayIds").invoke(idm);
            if (arr == null) return DISP_UNKNOWN;
            for (int x : arr) if (x == displayId) return DISP_ALIVE;
            return DISP_DEAD;
        } catch (Throwable t) {
            /* 两条反射路都失败 —— **不要假装「活着」**。
             * 返回 UNKNOWN，让调用方按「有没有人在看」决定。 */
            return DISP_UNKNOWN;
        }
    }

    public static void main(String[] args) {
        for (String a : args) {
            if (a.startsWith("--display=")) displayId = Integer.parseInt(a.substring(10));
            if (a.startsWith("--port=")) port = Integer.parseInt(a.substring(7));
            if (a.startsWith("--width=")) outWidth = Integer.parseInt(a.substring(8));
            if (a.startsWith("--size=")) {
                String[] wh = a.substring(7).split("x");
                if (wh.length == 2) { srcW = Integer.parseInt(wh[0]); srcH = Integer.parseInt(wh[1]); }
            }
        }
        System.out.println("START display=" + displayId + " port=" + port + " size=" + srcW + "x" + srcH);

        Looper.prepareMainLooper();
        HandlerThread th = new HandlerThread("framesrv");
        th.start();
        Handler h = new Handler(th.getLooper());
        cbHandler = h;   // 存下来给 openMirror 重建时用（size-watch 线程没 Looper）

        // 每秒算一次 fps + **空闲自杀**
        new Thread(new Runnable() {
            public void run() {
                while (true) {
                    try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
                    fps = lastSecFrames.getAndSet(0);
                    /* **没人看时不再自杀 —— 屏还在就活着。**
                     *
                     * 2026-11-22 用户报「虚拟屏在后台一直待机就会黑屏或者卡掉」。
                     * 查到的直接原因之一就是这个：原来 120 秒没人取帧就 System.exit(0)。
                     *
                     * 场景很容易复现：用户把浮窗最小化、或者切走去干别的 → 没人取帧
                     * → 2 分钟后推流进程退出 → 虚拟屏还在、App 还在跑，但推流没了
                     * → 用户回来看到的是黑框，要重建屏才能恢复。
                     *
                     * 「怕烧 CPU」这个理由已经不成立了：上面有 IDLE_PAUSE_MS（15 秒）
                     * 的优化 —— 没人看的时候**根本不编码**，只统计帧数，
                     * 空闲成本接近 0。用「退出」来省电是上一版的做法，
                     * 那一版是无条件编码才需要退出。
                     *
                     * 现在保留一个更宽的兜底：只有在「屏都不存在了」的情况下才退出
                     * （由上面的 displayAlive 检查负责，那是真的没用了）。
                     * 长时间无人使用也不再自杀，因为虚拟屏本身还在，用户随时可能回来。
                     */
                    long idle = System.currentTimeMillis() - Math.max(lastFetchAt, createdAt);
                    /* 只有「确定死了」或「判断不了且长时间没人看」才退。
                     * UNKNOWN 不再无条件保活 —— 那正是原来那个「永不退出」的来源。 */
                    final boolean noViewer = mjpegClients.isEmpty();
                    final int ds = displayState();
                    if (idle > IDLE_EXIT_MS && noViewer
                            && (ds == DISP_DEAD || ds == DISP_UNKNOWN)) {
                        // 屏没了 + 没人看 → 才是真的可以退
                        System.out.println("IDLE_EXIT idleMs=" + idle + "（屏已不存在）");
                        System.exit(0);
                    }
                }
            }
        }).start();

        // 建 ImageReader
        // ImageReader 和镜像都由 openMirror() 创建（尺寸变化时会重建）
        frameListener = new ImageReader.OnImageAvailableListener() {
            public void onImageAvailable(ImageReader r) {
                Image img = null;
                try {
                    img = r.acquireLatestImage();
                    if (img == null) return;
                    // **旧 reader 的迟到帧丢掉**：重建后旧 reader 可能还有回调，
                    // 会把旧尺寸的帧写回 latest，造成旋转后闪一帧旧方向画面。
                    if (r != reader) return;
                    frames.incrementAndGet();
                    lastSecFrames.incrementAndGet();
                    // **没人看就不编码** —— 只统计帧数，把 buffer 直接还回去。
                    // 这是审计里最大的一笔浪费：原来无条件编码，1.04 GB/s 的垃圾。
                    long nowMs = System.currentTimeMillis();
                    boolean watching = (nowMs - lastFetchAt) < IDLE_PAUSE_MS;
                    /* **第一帧必须无条件存下来。**
                     *
                     * 2026-11-22 实机踩到：浮窗空白，/frame.jpg 永远 503，
                     * /status 却是 frames=1。原因就是这里的顺序 ——
                     * frames 计数加在前面，编码又在这道「没人看就不编码」的检查之后。
                     *
                     * 于是：服务刚起来、观众还没连上时到达的那一帧 → 计数 +1、帧没存；
                     * 而虚拟屏画面静止时 ImageReader 不再回调 → latest 永远是 null →
                     * 后来连上的观众一次都拿不到帧。第一个观众永远看不到第一帧。
                     *
                     * 现在：latest 为空时无论如何都编码一帧。代价是一帧的编码开销，
                     * 换来的是「任何时刻连上来都能看到当前画面」。
                     */
                    boolean mustPrime = (latest == null);
                    if (!watching && mjpegClients.isEmpty() && !mustPrime) {
                        return;    // finally 会 close
                    }
                    byte[] jpg = encode(img);
                    if (jpg != null) {
                        latest = jpg;
                        // **只放入 pending，立刻返回** —— 写 socket 交给独立线程
                        synchronized (pendingLock) {
                            pendingJpg = jpg;
                        }
                    }
                } catch (Throwable t) {
                    System.out.println("ERR_CB " + t);
                } finally {
                    if (img != null) try { img.close(); } catch (Throwable t3) { }
                }
            }
        };

        // 建 ImageReader + 镜像
        openMirror(srcW, srcH);
        startSizeWatch();   // 尺寸变了就重建镜像

        // ===== HTTP 服务器 =====
        try {
            final ServerSocket ss = new ServerSocket(port, 8, java.net.InetAddress.getByName("127.0.0.1"));
            System.out.println("HTTP_OK port=" + port);
            new Thread(new Runnable() {
                public void run() {
                    while (true) {
                        try {
                            final Socket s = ss.accept();
                            // **必须关掉 Nagle。**
                            // 原来没设：每帧要写「头部 + JPEG + CRLF」三次，
                            // Nagle 会把小包攒着等 ACK，加上对端延迟确认，
                            // 单帧能多出 40-200ms —— 用户实测「延迟很多」就是这个。
                            try { s.setTcpNoDelay(true); } catch (Throwable t0) { }
                            new Thread(new Runnable() { public void run() { handle(s); } }).start();
                        } catch (Throwable t) { return; }
                    }
                }
            }).start();
        } catch (Throwable t) {
            System.out.println("ERR_HTTP " + t);
            System.exit(3);
        }

        Looper.loop();
    }

    /** 把 Image 编码成 JPEG（缩到 outWidth）。 */
    static byte[] encode(Image img) {
        try {
            int w = img.getWidth(), h = img.getHeight();
            ByteBuffer buf = img.getPlanes()[0].getBuffer();
            int stride = img.getPlanes()[0].getRowStride();
            // 拷到紧凑 buffer（处理 stride 对齐）
            byte[] row = new byte[w * 4];
            ByteArrayOutputStream all = new ByteArrayOutputStream(w * h * 4);
            for (int y = 0; y < h; y++) {
                buf.position(y * stride);
                buf.get(row, 0, w * 4);
                all.write(row, 0, w * 4);
            }
            // **必须手动转 RGBA→ARGB 并强制 alpha=255。**
            // ImageReader 给的是 RGBA_8888（内存序 R,G,B,A），而 Bitmap 的
            // ARGB_8888 走 copyPixelsFromBuffer 时按 ARGB 解释 —— alpha 位拿到的是
            // blue 通道值，常常是 0 → 全透明 → JPEG 编码出来全黑。
            // 实测症状：159 帧全是亮度 1.0 的黑图。
            byte[] raw = all.toByteArray();
            int n = w * h;
            int[] argb = new int[n];
            for (int i = 0; i < n; i++) {
                int o = i * 4;
                int r = raw[o] & 0xff;
                int g = raw[o + 1] & 0xff;
                int b = raw[o + 2] & 0xff;
                argb[i] = (0xff << 24) | (r << 16) | (g << 8) | b;   // 强制不透明
            }
            Bitmap bm = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            bm.setPixels(argb, 0, w, 0, 0, w, h);
            byte[] out = null;
            if (w > outWidth) {
                int nh = h * outWidth / w;
                Bitmap small = Bitmap.createScaledBitmap(bm, outWidth, nh, true);
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                small.compress(Bitmap.CompressFormat.JPEG, 70, o);
                out = o.toByteArray();
                small.recycle();
            } else {
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                bm.compress(Bitmap.CompressFormat.JPEG, 70, o);
                out = o.toByteArray();
            }
            // **画点击十字**（5 秒内的标记）
            byte[] marked = out;
            try {
                long nowMs = System.currentTimeMillis();
                pruneMarks(nowMs);
                long age = nowMs - markAt;
                if (marked != null && hasAnyMark(nowMs)) {
                    android.graphics.Bitmap target = null;
                    if (w > outWidth) {
                        // out 是缩放后的，重画一遍
                        int nh2 = h * outWidth / w;
                        target = android.graphics.Bitmap.createScaledBitmap(bm, outWidth, nh2, true);
                    }
                    if (target != null) {
                        android.graphics.Canvas cv = new android.graphics.Canvas(target);
                        android.graphics.Paint pt = new android.graphics.Paint();
                        pt.setAntiAlias(true);
                        float tw = target.getWidth(), th = target.getHeight();
                        // **水滴波纹**（点击动画，不再画十字）
                        // **逐个画所有还活着的标记**，各自按自己的年龄决定样子
                        java.util.List<Mark> snapshot;
                        synchronized (marks) { snapshot = new java.util.ArrayList<>(marks); }
                        for (Mark m : snapshot) {
                            long a = nowMs - m.at;
                            if (a < 0 || a > MARK_LIVE_MS) continue;
                            drawRipple(cv, pt, m.nx * tw, m.ny * th, a, tw, th);
                            drawAgeRing(cv, pt, m.nx * tw, m.ny * th, a, tw, th);
                        }
                        java.io.ByteArrayOutputStream o2 = new java.io.ByteArrayOutputStream();
                        target.compress(Bitmap.CompressFormat.JPEG, 70, o2);
                        marked = o2.toByteArray();
                        target.recycle();
                    }
                }
            } catch (Throwable t) { /* 画失败就用原图 */ }
            // **留一份 bmp 给 /mark 重画用**（不 recycle）
            synchronized (bmpLock) {
                if (lastBmp != null && lastBmp != bm) { try { lastBmp.recycle(); } catch (Throwable t) { } }
                lastBmp = bm;
            }
            return marked;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * **年龄环：一个随时间收缩的圆环，像倒计时。**
     *
     * 为什么需要：用户要求「能知道是多久前点的」。光靠淡出不够 ——
     * 淡到一半时看不出是 3 秒前还是 10 秒前。收缩的环把「剩余寿命」直接画出来：
     * 环大 = 刚点的，环小 = 快过期了，环消失 = 即将移除。
     *
     * 只画一个细环，不占地方（半径最大约 min(宽,高) 的 4%）。
     */
    static void drawAgeRing(android.graphics.Canvas cv, android.graphics.Paint pt,
                            float cx, float cy, long age, float tw, float th) {
        float life = age / (float) MARK_LIVE_MS;          // 0..1
        if (life >= 1f) return;
        float maxR = Math.max(18f, Math.min(tw, th) * 0.040f);
        float r = maxR * (1f - life);                      // 越来越小
        if (r < 3f) return;
        float alpha = 0.55f * (1f - life) + 0.12f;         // 越老越淡，但还看得见
        pt.setStyle(android.graphics.Paint.Style.STROKE);
        pt.setStrokeWidth(Math.max(1.6f, maxR * 0.10f));
        pt.setColor(((int) (255 * alpha) << 24) | 0xFF3B30);
        cv.drawCircle(cx, cy, r, pt);
    }


    /** 用缓存的最后一帧重编一张带标记的（/mark 时调）。 */
    /**
     * 画「水滴点击波纹」。
     *
     * 用户要的是「明显一点，像真的点击到了那个地方」。
     * 所以不用十字准星，改用触屏反馈那种扩散圆环：
     *   · 中心实心圆点（立刻出现，最醒目）
     *   · 3 圈波纹，按 age 依次扩散 + 淡出
     *   · 总时长 900ms
     *
     * @param age  点击后经过的毫秒数（0..900）
     */
    static void drawRipple(android.graphics.Canvas cv, android.graphics.Paint pt,
                           float cx, float cy, long age, float tw, float th) {
        float base = Math.max(14f, Math.min(tw, th) * 0.035f);
        long dur = 900;

        // ① 中心实心点：前 250ms 强，之后随波纹淡出
        float dotAlpha = age < 250 ? 1.0f : Math.max(0f, 1.0f - (age - 250) / 650f);
        pt.setStyle(android.graphics.Paint.Style.FILL);
        pt.setColor(((int) (255 * dotAlpha) << 24) | 0xFF3B30);      // iOS 红
        cv.drawCircle(cx, cy, base * 0.55f, pt);
        // 中心白边，深色背景也清楚
        pt.setStyle(android.graphics.Paint.Style.STROKE);
        pt.setStrokeWidth(Math.max(2f, base * 0.10f));
        pt.setColor(((int) (200 * dotAlpha) << 24) | 0xFFFFFF);
        cv.drawCircle(cx, cy, base * 0.55f, pt);

        // ② 3 圈波纹，错开 200ms 出发
        for (int i = 0; i < 3; i++) {
            long t = age - i * 200L;
            if (t < 0 || t > dur) continue;
            float p = t / (float) dur;                    // 0..1
            float r = base * (0.5f + p * 3.2f);           // 扩散到 3.2 倍
            int a = (int) (255 * (1.0f - p) * (1.0f - p)); // 二次淡出
            pt.setStyle(android.graphics.Paint.Style.STROKE);
            pt.setStrokeWidth(Math.max(1.5f, base * 0.22f * (1.0f - p * 0.6f)));
            pt.setColor((a << 24) | 0xFF6B5B);
            cv.drawCircle(cx, cy, r, pt);
        }
    }

    /** 波纹动画：900ms 内连推 16 帧，让静止画面也能看到扩散效果。 */
    static void startRippleAnim() {
        Thread t = new Thread(new Runnable() {
            public void run() {
                long t0 = System.currentTimeMillis();
                for (int i = 0; i < 16; i++) {
                    long el = System.currentTimeMillis() - t0;
                    if (el > 950) break;
                    reencodeWithMark();
                    try { Thread.sleep(58); } catch (Throwable t2) { }
                }
            }
        }, "ripple-anim");
        t.setDaemon(true);
        t.start();
    }

    /**
     * **标记动画线程：静止画面下也要重绘。**
     *
     * 2026-11-22 独立审计抓到的核心缺陷：ImageReader 只在画面变化时出帧，
     * 所以静止屏上：波纹闪 950ms 后冻住、年龄环从头到尾没画过、
     * 15 秒到期也没人清理 —— 红点永久留在画面上，年龄信息是假的。
     *
     * 这条线程在「有活跃标记」时按节奏重绘：
     *   · 前 1 秒每 60ms 一帧（波纹扩散要顺）
     *   · 之后每 250ms 一帧（年龄环慢慢缩，不需要那么密）
     *   · 所有标记过期后，推一张**干净帧**然后自己退出（不能留着红点）
     *
     * 注意：这是「有标记时才跑」的线程，不是常驻轮询 —— 没标记时零成本。
     */
    static volatile boolean markAnimRunning = false;

    static synchronized void startMarkAnim() {
        if (markAnimRunning) return;
        markAnimRunning = true;
        Thread t = new Thread(new Runnable() {
            public void run() {
                try {
                    long started = System.currentTimeMillis();
                    while (true) {
                        long now = System.currentTimeMillis();
                        pruneMarks(now);
                        boolean any;
                        synchronized (marks) {
                            any = false;
                            for (Mark m : marks) {
                                if (now - m.at <= MARK_LIVE_MS) { any = true; break; }
                            }
                        }
                        if (!any) {
                            // **最后推一张干净帧**，别把红点留在画面里
                            break;
                        }
                        reencodeWithMark();
                        long elapsed = now - started;
                        long sleep = elapsed < 1000 ? 60 : 250;
                        try { Thread.sleep(sleep); } catch (InterruptedException e) { return; }
                    }
                    // 标记全过期 → 推最后一张（此时列表已空 = 干净帧）
                    reencodeWithMark();
                } catch (Throwable t2) {
                    // 动画失败不影响取帧主流程
                } finally {
                    markAnimRunning = false;
                }
            }
        });
        t.setDaemon(true);
        t.start();
    }

    static void reencodeWithMark() {
        try {
            android.graphics.Bitmap src;
            synchronized (bmpLock) { src = lastBmp; }
            if (src == null || src.isRecycled()) return;
            int ow = outWidth;
            int oh = src.getHeight() * ow / src.getWidth();
            android.graphics.Bitmap target = android.graphics.Bitmap.createScaledBitmap(src, ow, oh, true);
            android.graphics.Canvas cv = new android.graphics.Canvas(target);
            android.graphics.Paint pt = new android.graphics.Paint();
            pt.setAntiAlias(true);
            float tw = target.getWidth(), th = target.getHeight();
              /* **画所有还活着的标记，不是只画最新那个。**
               *
               * 2026-11-22 独立审计抓到：原来只画 markNx/markNy 这一个点，
               * 于是连续点击时**后一次会把前一次擦掉** ——
               * 而且静止屏上永远回不来（没有新帧）。
               *
               * 顺带把年龄环也画上：原来 drawAgeRing 只在 encode() 里调，
               * 静止屏不出帧就等于从来没画过，15 秒到期也没人重绘，
               * 波纹会永久停在屏幕上，年龄信息变成假话。
               */
              long nowMs = System.currentTimeMillis();
              pruneMarks(nowMs);
              java.util.List<Mark> snap;
              synchronized (marks) { snap = new java.util.ArrayList<>(marks); }
              for (Mark m : snap) {
                  long age = nowMs - m.at;
                  if (age < 0 || age > MARK_LIVE_MS) continue;
                  drawRipple(cv, pt, m.nx * tw, m.ny * th, age, tw, th);
                  drawAgeRing(cv, pt, m.nx * tw, m.ny * th, age, tw, th);
              }
            java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
            target.compress(Bitmap.CompressFormat.JPEG, 70, o);
            byte[] jpg = o.toByteArray();
            target.recycle();
            latest = jpg;
            // 推给所有 MJPEG 客户端
            for (Socket c2 : mjpegClients) {
                try {
                    OutputStream os = c2.getOutputStream();
                    os.write(("--dshframe\r\nContent-Type: image/jpeg\r\nContent-Length: "
                            + jpg.length + "\r\n\r\n").getBytes());
                    os.write(jpg); os.write("\r\n".getBytes()); os.flush();
                } catch (Throwable t) { mjpegClients.remove(c2); }
            }
        } catch (Throwable t) { /* 画失败就算了 */ }
    }

    static void handle(Socket s) {
        try {
            s.setSoTimeout(30000);
            InputStream in = s.getInputStream();
            // 读请求行
            StringBuilder sb = new StringBuilder();
            int c;
            while ((c = in.read()) >= 0 && c != '\n') { if (c != '\r') sb.append((char) c); }
            String line = sb.toString();
            String path = "/";
            if (line.contains(" ")) path = line.split(" ")[1];
            // 把 header 读完
            int nl = 0;
            while ((c = in.read()) >= 0) { if (c == '\n') { nl++; if (nl >= 2) break; } else if (c != '\r') nl = 0; }

            OutputStream out = s.getOutputStream();
            if (path.startsWith("/frame.jpg")) {
                lastFetchAt = System.currentTimeMillis();   // 有人在看
                byte[] j = latest;
                if (j == null) {
                    out.write("HTTP/1.1 503 No Frame\r\n\r\n".getBytes());
                } else {
                    out.write(("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: "
                            + j.length + "\r\nCache-Control: no-store\r\n\r\n").getBytes());
                    out.write(j);
                }
                out.flush();
                s.close();
            } else if (path.startsWith("/status")) {
                // **running 必须反映「还在被看」的状态，不能写死 true。**
                // 写死的话悬浮窗永远认为推流活着，不会自动关；
                // 审计发现 README 承诺的「推流停了自己消失」因此失效。
                // **活跃 = 最近有人取帧，或者有 MJPEG 长连接挂着。**
                // 只算 lastFetchAt 是错的：悬浮窗用 MJPEG 长连接，只在连上时取一次，
                // 之后一直收推送。120 秒后 lastFetchAt 过期 → running 变 false
                // → 悬浮窗自己 stopSelf 退出（实机玩 MC 时踩到的）。
                boolean alive = !mjpegClients.isEmpty()
                        || (System.currentTimeMillis() - lastFetchAt) < IDLE_EXIT_MS;
                // **屏没了就直接退出**，别再吐冻结的最后一帧
                if (displayState() == DISP_DEAD) {
                    System.out.println("DISPLAY_GONE display=" + displayId);
                    try { Thread.sleep(100); } catch (Throwable t2) { }
                    System.exit(0);
                }
                /* **必须带上 displayId。**
                 *
                 * 2026-11-22 对抗审查 P0-2：端口是按 `38820 + displayId % 20` 推的，
                 * 20 个端口、两块屏 displayId 相差 20 的倍数时 preferred 会撞。
                 * 同进程靠 used 集合错开，但 servers 是模块级 Map ——
                 * 插件和 daemon 是两个进程，跨进程碰撞检测完全失效；进程重启后
                 * servers 为空，第二个 spawn 绑不上端口，probe 却打到第一块屏活着的
                 * server 返回 ok → 两块屏共用一个 framesrv，用户看到别人的画面，
                 * 而自检五项全绿。
                 *
                 * 根因是 /status 以前不返回 displayId，调用方没法校验「我连的这个
                 * server 到底是不是我这块屏的」。加上之后 probe 才能核对。
                 */
                String j = "{\"running\":" + alive + ",\"displayId\":" + displayId
                        + ",\"frames\":" + frames.get()
                        + ",\"fps\":" + fps + ",\"width\":" + outWidth + ",\"srcWidth\":" + srcW + ",\"srcHeight\":" + srcH
                        + ",\"aspect\":" + ((double) srcW / srcH) + "}";
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                        + j.length() + "\r\nCache-Control: no-store\r\n\r\n" + j).getBytes());
                out.flush();
                s.close();
            } else if (path.startsWith("/stream.mjpg")) {
                lastFetchAt = System.currentTimeMillis();   // 长连接 = 有人在看
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=--dshframe\r\n"
                        + "Cache-Control: no-store\r\nConnection: keep-alive\r\n\r\n").getBytes());
                out.flush();
                try { s.setTcpNoDelay(true); } catch (Throwable t0) { }
                mjpegClients.add(s);      // 不关，交给推送循环
                byte[] j = latest;
                if (j != null) {
                    out.write(("--dshframe\r\nContent-Type: image/jpeg\r\nContent-Length: "
                            + j.length + "\r\n\r\n").getBytes());
                    out.write(j); out.write("\r\n".getBytes()); out.flush();
                }
            } else if (path.startsWith("/event")) {
                // **用户事件上报**：悬浮窗删掉某块屏时调这里，
                // 写一行到 events.log，插件侧读它就知道「用户手动关了后台屏」。
                try {
                    String type = "unknown";
                    int q = path.indexOf("type=");
                    if (q >= 0) {
                        int e2 = path.indexOf('&', q);
                        type = e2 > 0 ? path.substring(q + 5, e2) : path.substring(q + 5);
                    }
                    // 用户只关了浮窗，还是连后台屏一起关？这个区别对 AI 很重要：
                    // 只关浮窗 = 嫌挡路；连屏一起关 = 要求停手。
                    String stopScreen = "0";
                    int qs = path.indexOf("stopScreen=");
                    if (qs >= 0) {
                        int e3 = path.indexOf('&', qs);
                        stopScreen = (e3 > 0 ? path.substring(qs + 11, e3) : path.substring(qs + 11)).trim();
                        if (!"1".equals(stopScreen)) stopScreen = "0";
                    }
                    String evLine = System.currentTimeMillis() + "|" + type + "|" + displayId + "|stopScreen=" + stopScreen + "\n";
                    java.io.FileOutputStream fo = new java.io.FileOutputStream(EVENTS_FILE, true);
                    fo.write(evLine.getBytes("UTF-8"));
                    fo.close();
                    byte[] okb = "ok".getBytes("UTF-8");
                    out.write(("HTTP/1.1 200 OK\r\nContent-Length: " + okb.length + "\r\n\r\n").getBytes("UTF-8"));
                    out.write(okb);
                    out.flush();
                } catch (Throwable t) {
                    try {
                        out.write("HTTP/1.1 500 ERR\r\nContent-Length: 0\r\n\r\n".getBytes("UTF-8"));
                        out.flush();
                    } catch (Throwable t2) { }
                }
            } else if (path.startsWith("/mark")) {
                // /mark?nx=0.5&ny=0.3  → 记下点击位置，下一帧画十字
                try {
                    int qi = path.indexOf('?');
                    if (qi > 0) {
                        String q = path.substring(qi + 1);
                        for (String kv : q.split("&")) {
                            String[] p2 = kv.split("=");
                            if (p2.length == 2) {
                                if ("nx".equals(p2[0])) markNx = Float.parseFloat(p2[1]);
                                if ("ny".equals(p2[0])) markNy = Float.parseFloat(p2[1]);
                            }
                        }
                        // **多指：每次 /mark 记一条，不再覆盖上一条**
                        markAt = System.currentTimeMillis();
                        if (markNx >= 0 && markNy >= 0) addMark(markNx, markNy);
                        // **立刻重编一张，然后连播 16 帧形成动画。**
                        // 静止画面时 ImageReader 不出新帧，不主动重绘就只会看到一张静图。
                        reencodeWithMark();
                        startRippleAnim();
                        startMarkAnim();   // 静止画面下也能持续重绘（年龄环、到期清理）
                    }
                    out.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".getBytes());
                } catch (Throwable t) {
                    out.write("HTTP/1.1 400 Bad\r\nContent-Length: 3\r\n\r\nbad".getBytes());
                }
                out.flush();
                s.close();
            } else if (path.startsWith("/quit")) {
                out.write("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbye".getBytes());
                out.flush();
                System.out.println("QUIT");
                System.exit(0);
            } else {
                out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\nno".getBytes());
                out.flush();
                s.close();
            }
        } catch (Throwable t) {
            try { s.close(); } catch (Throwable t2) { }
        }
    }
}
