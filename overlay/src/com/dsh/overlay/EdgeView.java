package com.dsh.overlay;

import android.content.Context;
import android.graphics.BlurMaskFilter;
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

    EdgeView(Context c) {
        super(c);
        d = c.getResources().getDisplayMetrics().density;

        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(dp(2.5f));
        stroke.setStrokeCap(Paint.Cap.ROUND);

        halo.setStyle(Paint.Style.STROKE);
        halo.setStrokeWidth(dp(8f));
        halo.setMaskFilter(new BlurMaskFilter(dp(7f), BlurMaskFilter.Blur.NORMAL));

        tail.setStyle(Paint.Style.STROKE);
        tail.setStrokeWidth(dp(3.2f));
        tail.setStrokeCap(Paint.Cap.ROUND);

        setWillNotDraw(true);   // idle 时让系统跳过整个绘制通道
    }

    private float dp(float v) { return v * d; }

    void setMode(int m, int col, float inten, long durationMs) {
        boolean wasIdle = (mode == MODE_IDLE);
        mode = m;
        color = col;
        intensity = Math.max(0f, Math.min(1f, inten));
        startedAt = SystemClock.uptimeMillis();
        endsAt = durationMs > 0 ? startedAt + durationMs : 0;
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

        boxPath.reset();
        boxPath.addRoundRect(rect, r, r, Path.Direction.CW);
        measure.setPath(boxPath, false);
        float per = measure.getLength();

        float t = (now - startedAt) / 1000f;
        int alpha = Math.round(255 * intensity * fade);

        switch (mode) {
            case MODE_WORKING:  drawWorking(cv, t, alpha, r, per);  break;
            case MODE_DONE:     drawDone(cv, t, alpha, r);          break;
            case MODE_WARNING:  drawBreath(cv, t, alpha, r, 1.6f, 0.35f, 0.45f); break;
            case MODE_ERROR:    drawBreath(cv, t, alpha, r, 0.62f, 0.45f, 0.50f); break;
            case MODE_CRITICAL: drawCritical(cv, t, alpha, r);      break;
            default: return;
        }
        invalidate();   // 非 idle 继续动
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

    /** done：绿色从左扫到右，然后整框留一会儿再淡出。 */
    private void drawDone(Canvas cv, float t, int alpha, float r) {
        float k = Math.min(1f, t / 0.5f);                  // 0.5 秒扫完
        float sweep = rect.left + rect.width() * ease(k);

        // 已经扫过的部分常亮
        stroke.setColor(color);
        stroke.setAlpha(Math.round(alpha * 0.5f));
        cv.drawRoundRect(rect, r, r, stroke);

        // 扫掠头：一小段更亮
        if (k < 1f) {
            halo.setColor(color);
            halo.setAlpha(Math.round(alpha * 0.85f));
            cv.drawLine(sweep, rect.top + dp(1f), sweep, rect.bottom - dp(1f), halo);
        }
        // 扫完之后整体缓慢淡出
        if (t > 0.5f) {
            float f2 = Math.max(0f, 1f - (t - 0.5f) / 1.6f);
            stroke.setAlpha(Math.round(alpha * 0.5f * f2));
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

    /** critical：粗红边高频闪。这是有意的刺眼 —— 它表示「可能已经出事」。 */
    private void drawCritical(Canvas cv, float t, int alpha, float r) {
        float s = (float) (0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 0.26f));
        stroke.setStrokeWidth(dp(5.5f));
        stroke.setColor(color);
        stroke.setAlpha(Math.round(alpha * (0.55f + 0.45f * s)));
        cv.drawRoundRect(rect, r, r, stroke);
        halo.setStrokeWidth(dp(13f));
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
