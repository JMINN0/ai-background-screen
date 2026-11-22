package com.dsh.overlay;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PathMeasure;
import android.graphics.RectF;
import android.os.SystemClock;
import android.view.View;

/**
 * **悬浮窗边缘光效层。**
 *
 * 只画在悬浮窗自己的边框上，不碰手机主屏的边 —— 这是硬要求：
 * 用户要的是「AI 那块屏现在是什么状态」，不是整个手机的装饰。
 *
 * 设计原则（第一性原理）：
 *
 * 1. **颜色不能是唯一区分手段。** 红绿色盲占男性 8%，只靠颜色区分「完成」和
 *    「出错」等于对这部分人完全失效。所以每种状态的运动模式必须不同：
 *      完成 = 从左到右扫过；出错 = 整框快脉冲；警告 = 整框慢呼吸。
 *    闭着眼看节奏也能分出是哪种。
 *
 * 2. **不工作时一行都不画。** 悬浮窗是常驻的，每帧重绘纯属烧电。
 *    idle 时 setWillNotDraw(true)，系统直接跳过这个 View 的绘制通道。
 *
 * 3. **只画边缘，不遮内容。** 内部是用户要看的画面，任何填充式遮挡都是错的。
 *    只画描边 + 向内很短的羽化。
 */
class EdgeView extends View {

    static final int MODE_IDLE = 0;       // 不画
    static final int MODE_WORKING = 1;    // 环绕流动
    static final int MODE_DONE = 2;       // 完成：横扫 + 淡出
    static final int MODE_WARNING = 3;    // 警告：慢呼吸
    static final int MODE_ERROR = 4;      // 出错：快脉冲
    static final int MODE_CRITICAL = 5;   // 严重：粗红边高频闪

    private int mode = MODE_IDLE;
    private int color = Color.TRANSPARENT;
    private float intensity = 1f;
    private long endsAt = 0;
    private long startedAt = 0;

    private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint halo = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint tail = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF rect = new RectF();
    private final Path boxPath = new Path();
    private final PathMeasure measure = new PathMeasure();
    private final Path segPath = new Path();
    private final float d;
    /** 缓存路径长度：尺寸不变时不重算（原来每帧都算）。 */
    private float cachedPer = 0;
    private int cachedW = -1, cachedH = -1;

    EdgeView(Context c) {
        super(c);
        d = c.getResources().getDisplayMetrics().density;

        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(dp(2.5f));
        stroke.setStrokeCap(Paint.Cap.ROUND);

        /* **不用 BlurMaskFilter。**
         *
         * 2026-11-22 对抗审查指出：蒙版模糊每帧都要真算一遍，
         * 而且这个动画是压在**正在播放的视频**上面的 —— 掉帧风险真实存在。
         * 改成「两层描边」模拟光晕：内层细且亮、外层宽且淡。
         * 视觉上几乎一样，成本从「每帧一次高斯模糊」降到「多画一个圆角矩形」。
         */
        halo.setStyle(Paint.Style.STROKE);
        halo.setStrokeWidth(dp(8f));
        // 不再设 MaskFilter

        tail.setStyle(Paint.Style.STROKE);
        tail.setStrokeWidth(dp(3.2f));
        tail.setStrokeCap(Paint.Cap.ROUND);

        setWillNotDraw(true);   // idle 时让系统跳过整个绘制通道
    }

    private float dp(float v) { return v * d; }

    void setMode(int m, int col, float inten, long durationMs) {
        boolean wasIdle = (mode == MODE_IDLE);
        boolean sameMode = (mode == m);

        /* **同一个状态重复设置时，绝对不重置动画起点。**
         *
         * 2026-11-22 独立复核抓到：这里原来无条件 `startedAt = now()`，
         * 而 refreshEdge() 挂在 3 秒定时器上 —— 于是 working 的光斑每 3 秒
         * 跳回起点重跑一圈，done 会重播两三次，看起来像卡帧。
         * 用户要的是「持续状态」，不是「每 3 秒重播一次」。
         *
         * 只有真的换了状态才重置相位；同状态只更新剩余时长和颜色。
         */
        if (!sameMode) {
            mode = m;
            startedAt = SystemClock.uptimeMillis();
            endsAt = durationMs > 0 ? startedAt + durationMs : 0;
        } else if (durationMs > 0) {
            // 同状态：按这次给的时长续期，但保持原有相位
            endsAt = startedAt + durationMs;
        }
        color = col;
        intensity = Math.max(0f, Math.min(1f, inten));

        boolean nowIdle = (m == MODE_IDLE);
        if (wasIdle == nowIdle) { if (!nowIdle) invalidate(); return; }
        setWillNotDraw(nowIdle);
        invalidate();
    }

    int getMode() { return mode; }

    boolean isIdle() { return mode == MODE_IDLE; }

    @Override
    protected void onDraw(Canvas cv) {
        if (mode == MODE_IDLE) return;

        long now = SystemClock.uptimeMillis();
        if (endsAt > 0 && now >= endsAt) { setMode(MODE_IDLE, Color.TRANSPARENT, 0f, 0); return; }

        // 最后 400ms 淡出，不要突然消失 —— 突然消失看起来像卡了
        float fade = 1f;
        if (endsAt > 0 && endsAt - now < 400) fade = Math.max(0f, (endsAt - now) / 400f);

        int w = getWidth(), h = getHeight();
        if (w <= 0 || h <= 0) return;
        float inset = dp(4f);
        float r = dp(10f);
        rect.set(inset, inset, w - inset, h - inset);

        /* **路径只在尺寸变化时重建。**
         * 原来每帧 setPath + getLength + 16 次 getSegment，
         * 60fps 下就是每秒上千次几何计算。尺寸不变时这些全是浪费。
         */
        if (cachedW != w || cachedH != h) {
            cachedW = w; cachedH = h;
            boxPath.reset();
            boxPath.addRoundRect(rect, r, r, Path.Direction.CW);
            measure.setPath(boxPath, false);
            cachedPer = measure.getLength();
        }
        float per = cachedPer;

        float t = (now - startedAt) / 1000f;
        int alpha = Math.round(255 * intensity * fade);

        switch (mode) {
            case MODE_WORKING:  drawWorking(cv, t, alpha, r, per);  break;
            case MODE_DONE:     drawDone(cv, t, alpha, r);          break;
            case MODE_WARNING:  drawWarning(cv, t, alpha, r); break;
            case MODE_ERROR:    drawError(cv, t, alpha, r);   break;
            case MODE_CRITICAL: drawCritical(cv, t, alpha, r);      break;
            default: return;
        }
        /* **限帧到约 30fps。**
         * 边框光效的位移量很小，30fps 已经够顺；60fps 在视频上白烧一倍。
         * 用 postInvalidateDelayed 估算下一帧时间，而不是立刻 invalidate。
         */
        /* **固定 33ms 延时 = 约 30fps。**
         *
         * wait 恒被钳到 1 → postInvalidateDelayed(1) 等于每个 vsync 都画，
         * 限帧完全没生效，跟改之前一样 60fps。
         *
         * 改成固定 33ms：不依赖任何状态，行为确定。
         */
        postInvalidateDelayed(33);
    }

    /** working：一段光沿边框匀速跑圈 + 很淡的底边（让人知道 AI 在干活）。 */
    private void drawWorking(Canvas cv, float t, int alpha, float r, float per) {
        stroke.setColor(color);
        stroke.setAlpha(Math.round(alpha * 0.16f));
        cv.drawRoundRect(rect, r, r, stroke);

        final int SEG = 16;
        final float LEN = 0.20f;               // 尾迹 + 头，占整圈 20%
        float head = (t * 0.85f) % 1f;         // 一圈约 1.2 秒
        for (int i = 0; i < SEG; i++) {
            float f = i / (float) SEG;
            float a = head - f * LEN;
            if (a < 0) a += 1f;
            int al = Math.round(alpha * (1f - f) * 0.9f);
            if (al <= 4) continue;
            float start = a * per;
            float len = Math.max(per * 0.012f, per * LEN / SEG * 1.4f);
            float end = start + len;
            if (end > per) end = per;
            segPath.reset();
            measure.getSegment(start, end, segPath, true);
            tail.setColor(color);
            tail.setAlpha(al);
            cv.drawPath(segPath, tail);
        }
    }

    /**
     * done：**两束光从底边中点出发，沿左右两侧上行，在顶边中点合拢。**
     *
     * 2026-11-22 复核抓到：原来这里用 `cv.drawLine(sweep, top, sweep, bottom)`
     * 画一条从上到下贯穿的竖线 —— 那是横穿用户正在看的内容，
     * 直接违背本文件开头写的「只画边缘不遮内容」。而且一条竖线扫过
     * 也看不出「完成」这个语义。
     *
     * 改成沿边框的双向合拢：光是贴着边走的，一个字都不挡；
     * 两束在顶边会合，这个动作本身就读作「收尾/完成」，
     * 不依赖颜色也能懂。
     */
    private void drawDone(Canvas cv, float t, int alpha, float r) {
        final float DUR = 0.9f;                       // 合拢用时
        float k = Math.min(1f, t / DUR);
        float e = ease(k);

        // 整框淡底，让「完成」这件事有整体感
        stroke.setColor(color);
        stroke.setAlpha(Math.round(alpha * 0.20f));
        cv.drawRoundRect(rect, r, r, stroke);

        float per = measure.getLength();
        // 半周长：从底边中点沿一侧走到顶边中点
        float half = per * 0.5f;
        float startD = per * 0.5f;                    // 底边中点（周长 50% 处）

        final int N = 12;
        for (int i = 0; i < N; i++) {
            float f = i / (float) N;
            int al = Math.round(alpha * (1f - f * 0.5f) * 0.9f);
            if (al <= 4) continue;
            float len = Math.max(per * 0.008f, per * 0.03f);
            // 左行：底边中点 → 逆时针
            float s1 = startD - half * e - f * len;
            float e1 = s1 + len;
            if (s1 >= 0) {
                segPath.reset();
                measure.getSegment(Math.max(0, s1), Math.min(per, e1), segPath, true);
                tail.setColor(color); tail.setAlpha(al);
                cv.drawPath(segPath, tail);
            }
            // 右行：底边中点 → 顺时针
            float s2 = startD + half * e + f * len;
            float e2 = s2 - len;
            if (s2 <= per) {
                segPath.reset();
                measure.getSegment(Math.max(0, e2), Math.min(per, s2), segPath, true);
                tail.setColor(color); tail.setAlpha(al);
                cv.drawPath(segPath, tail);
            }
        }

        // 合拢之后：整框亮一下再淡出
        if (k >= 1f) {
            float f2 = Math.max(0f, 1f - (t - DUR) / 1.4f);
            stroke.setColor(color);
            stroke.setAlpha(Math.round(alpha * 0.62f * f2));
            cv.drawRoundRect(rect, r, r, stroke);
        }
    }

    /** 呼吸/脉冲通用：整框亮度按正弦变化。period 越小越急。 */
    private void drawBreath(Canvas cv, float t, int alpha, float r,
                            float period, float lo, float hi) {
        float s = (float) (0.5 + 0.5 * Math.sin(t * 2 * Math.PI / period));
        float k = lo + (hi - lo) * s;
        stroke.setColor(color);
        stroke.setAlpha(Math.round(alpha * k));
        cv.drawRoundRect(rect, r, r, stroke);
        halo.setColor(color);
        halo.setAlpha(Math.round(alpha * 0.4f * s));
        cv.drawRoundRect(rect, r, r, halo);
    }

    /**
     * warning：**不对称慢呼吸** —— 吸气快、呼气慢，像深吸一口气。
     *
     * 2026-11-22 复核抓到：原来 warning 和 error 都调 drawBreath，
     * 只是周期不同（1.6s vs 0.62s）。对红绿色盲来说这两个状态
     * **在运动上也无法区分** —— 都是一条正弦，只是快慢。
     * 而「注意」和「失败」是完全不同的意思，必须靠节奏分开：
     *   warning = 不对称呼吸（快起慢落，人放松时就是这种节奏）
     *   error   = 双拍「咚-咚」（机械、警急、不像呼吸）
     */
    private void drawWarning(Canvas cv, float t, int alpha, float r) {
        final float PERIOD = 2.6f;
        float phase = (t % PERIOD) / PERIOD;          // 0..1
        // 快升（0→0.28）慢降（0.28→1）
        float k;
        if (phase < 0.28f) k = phase / 0.28f;
        else k = 1f - (phase - 0.28f) / 0.72f;
        float lvl = 0.28f + 0.52f * k;
        stroke.setColor(color);
        stroke.setAlpha(Math.round(alpha * lvl));
        cv.drawRoundRect(rect, r, r, stroke);
        halo.setColor(color);
        halo.setAlpha(Math.round(alpha * 0.30f * k));
        cv.drawRoundRect(rect, r, r, halo);
    }

    /**
     * error：**双拍「咚-咚」** —— 在一个周期里突然亮两次，然后停一下。
     * 机械、急促、不像呼吸，和 warning 的节奏形态完全不同。
     */
    private void drawError(Canvas cv, float t, int alpha, float r) {
        final float PERIOD = 1.36f;
        float phase = (t % PERIOD) / PERIOD;
        // 两拍：0.00-0.22 亮，0.22-0.34 暗，0.34-0.56 亮，0.56-1.0 暗
        float k = 0.0f;
        if (phase < 0.22f) k = 1f - (phase / 0.22f) * 0.35f;
        else if (phase < 0.34f) k = 0.12f;
        else if (phase < 0.56f) k = 1f - ((phase - 0.34f) / 0.22f) * 0.45f;
        else k = 0.10f;
        stroke.setColor(color);
        stroke.setAlpha(Math.round(alpha * (0.25f + 0.70f * k)));
        cv.drawRoundRect(rect, r, r, stroke);
        halo.setColor(color);
        halo.setAlpha(Math.round(alpha * 0.55f * k));
        cv.drawRoundRect(rect, r, r, halo);
    }

    /** critical：粗红边低频闪（低于 3Hz）。这是有意的刺眼 —— 它表示「可能已经出事」。 */
    private void drawCritical(Canvas cv, float t, int alpha, float r) {
        /* **闪烁频率必须低于 3Hz。**
         *
         * 2026-11-22 复核指出：原来是 0.26 秒一周期 = 3.85Hz，
         * 超过 WCAG 2.3.1 规定的 3Hz 上限 —— 那是光敏性癫痫的触发区间。
         * 提示「可能出事」不该以让人真出事为代价。
         * 改成 0.7 秒（1.43Hz），要更凶就加粗描边和角标，不加频率。
         */
        /* **线宽按窗口大小缩放，别在缩略图上糊死。**
         *
         * 2026-11-22 对抗审查指出：critical 固定 5.5dp 描边 + 13dp 光晕，
         * 在 36dp 的收起缩略图上（可绘制区域只有 28dp）会向内吃满，
         * 左右两边糊在一起 —— 用户看到一个红方块，画面内容完全看不见。
         * 而 critical 恰恰是「出大事了快看一眼」的时候，最需要看清。
         *
         * 按窗口短边取比例，并给下限，保证小窗也能看出是「红边」而不是「红块」。
         */
        float shortSide = Math.min(getWidth(), getHeight());
        float strokeW = Math.min(dp(5.5f), Math.max(dp(1.8f), shortSide * 0.035f));
        float haloW = Math.min(dp(13f), Math.max(dp(3f), shortSide * 0.06f));
        float s = (float) (0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 0.7f));
        stroke.setStrokeWidth(strokeW);
        stroke.setColor(color);
        stroke.setAlpha(Math.round(alpha * (0.55f + 0.45f * s)));
        cv.drawRoundRect(rect, r, r, stroke);
        halo.setStrokeWidth(haloW);
        halo.setColor(color);
        halo.setAlpha(Math.round(alpha * 0.62f * s));
        cv.drawRoundRect(rect, r, r, halo);
        // 恢复默认线宽，下次别的状态复用同一批 Paint
        stroke.setStrokeWidth(dp(2.5f));
        halo.setStrokeWidth(dp(8f));
    }

    /** 缓动：让扫掠不是匀速，观感更自然。 */
    private static float ease(float x) {
        return x * x * (3 - 2 * x);   // smoothstep
    }
}
