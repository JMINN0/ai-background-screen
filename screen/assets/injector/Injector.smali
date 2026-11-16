.class public final Lcom/dsh/inject/Injector;
.super Ljava/lang/Object;
.source "Injector.java"

# app_process 注入器。补齐 scrcpy 控制通道修不掉的三个破绽：
#   deviceId（借真实触摸屏）/ PointerCoords.size（自填）/ getHistorySize（addBatch）
#
# 关键设计（都是从 framework.jar 反编译确认过的事实）：
#   1. MotionEvent.obtain 的 14 参重载是 **whitelist（公开 API）**，参数里就有
#      deviceId / source / displayId —— 不需要反射，不需要黑盒绕过。
#   2. 注入用 InputManagerGlobal.injectInputEvent(InputEvent, int mode) 两参版本，
#      displayId 由事件自带。**不要用三参版本** —— 它的第三参是 targetUid 不是
#      displayId，传错不抛异常，会静默注入到别的 uid 窗口或主屏。
#   3. shell（uid 2000）有 INJECT_EVENTS 权限（dumpsys 确认 granted=true）。
#
# 协议（stdin 逐行）：
#   T x y p s     点按
#   D x y p s     按下
#   M x y p s     移动（会带历史采样）
#   U x y p s     抬起
#   I             打印当前状态
#   Q             退出
# 参数：x/y 是目标 display 的坐标（设备像素），p 压力 0-1，s 接触面积 0-1

.field private static sDisplay:I
.field private static sDevice:I
.field private static sMgr:Ljava/lang/Object;
.field private static sInject:Ljava/lang/reflect/Method;
.field private static sDown:J
.field private static sT:J
.field private static sAct:I
.field private static sX:F
.field private static sY:F
.field private static sP:F
.field private static sS:F
.field private static sTapMode:I
.field private static sLegacy:I
.field private static sArgc:I
.field private static sTapX:F
.field private static sTapY:F
.field private static sTapP:F
.field private static sTapS:F

.method public constructor <init>()V
    .locals 0
    invoke-direct {p0}, Ljava/lang/Object;-><init>()V
    return-void
.end method

# ============ main ============
.method public static main([Ljava/lang/String;)V
    .locals 6

    # **先建 Looper。** InputManagerGlobal 是客户端单例，
    # 它在没有 Looper 的线程上 getInstance() 可能拿到一个不可用的实例，
    # 导致 injectInputEvent 静默返回 false（实测现象：事件字段全对但注入被拒）。
    # 这里只 prepare 不 loop()，避免阻塞。
    :try_looper
    invoke-static {}, Landroid/os/Looper;->myLooper()Landroid/os/Looper;
    move-result-object v0
    if-eqz v0, :looper_ok
    invoke-static {}, Landroid/os/Looper;->prepareMainLooper()V
    :looper_ok
    :try_looper_end
    .catch Ljava/lang/Throwable; {:try_looper .. :try_looper_end} :catch_looper
    goto :looper_done
    :catch_looper
    # 建不起来就算了，继续走老路

    :looper_done
    const/4 v0, 0x0
    sput v0, Lcom/dsh/inject/Injector;->sDisplay:I
    const/4 v0, -0x1
    sput v0, Lcom/dsh/inject/Injector;->sDevice:I
    const/4 v0, 0x0
    sput v0, Lcom/dsh/inject/Injector;->sAct:I
    const/4 v0, 0x0
    sput v0, Lcom/dsh/inject/Injector;->sTapMode:I
    const/4 v0, 0x0
    sput v0, Lcom/dsh/inject/Injector;->sLegacy:I
    const/4 v0, 0x0
    sput v0, Lcom/dsh/inject/Injector;->sX:F
    sput v0, Lcom/dsh/inject/Injector;->sY:F
    const/high16 v0, 0x3f000000
    sput v0, Lcom/dsh/inject/Injector;->sP:F
    const v0, 0x3d4ccccd
    sput v0, Lcom/dsh/inject/Injector;->sS:F
    const-wide/16 v0, 0x0
    sput-wide v0, Lcom/dsh/inject/Injector;->sDown:J
    sput-wide v0, Lcom/dsh/inject/Injector;->sT:J

    # 解析参数
    const/4 v1, 0x0
    :argloop
    array-length v2, p0
    if-ge v1, v2, :argdone
    aget-object v2, p0, v1
    add-int/lit8 v1, v1, 0x1

    const-string v3, "--display="
    invoke-virtual {v2, v3}, Ljava/lang/String;->startsWith(Ljava/lang/String;)Z
    move-result v3
    if-eqz v3, :chkdev
    const/16 v3, 0xa
    invoke-virtual {v2, v3}, Ljava/lang/String;->substring(I)Ljava/lang/String;
    move-result-object v3
    invoke-static {v3}, Ljava/lang/Integer;->parseInt(Ljava/lang/String;)I
    move-result v3
    sput v3, Lcom/dsh/inject/Injector;->sDisplay:I
    goto :argloop

    :chkdev
    const-string v3, "--device="
    invoke-virtual {v2, v3}, Ljava/lang/String;->startsWith(Ljava/lang/String;)Z
    move-result v3
    if-eqz v3, :argnext
    const/16 v3, 0x9
    invoke-virtual {v2, v3}, Ljava/lang/String;->substring(I)Ljava/lang/String;
    move-result-object v3
    invoke-static {v3}, Ljava/lang/Integer;->parseInt(Ljava/lang/String;)I
    move-result v3
    sput v3, Lcom/dsh/inject/Injector;->sDevice:I

    :argnext
    const-string v3, "--tap="
    invoke-virtual {v2, v3}, Ljava/lang/String;->startsWith(Ljava/lang/String;)Z
    move-result v3
    if-eqz v3, :argnext2
    const/4 v3, 0x1
    sput v3, Lcom/dsh/inject/Injector;->sTapMode:I
    const/4 v3, 0x6
    invoke-virtual {v2, v3}, Ljava/lang/String;->substring(I)Ljava/lang/String;
    move-result-object v3
    const-string v4, ","
    invoke-virtual {v3, v4}, Ljava/lang/String;->split(Ljava/lang/String;)[Ljava/lang/String;
    move-result-object v3
    const/4 v4, 0x0
    aget-object v4, v3, v4
    invoke-static {v4}, Ljava/lang/Float;->parseFloat(Ljava/lang/String;)F
    move-result v4
    sput v4, Lcom/dsh/inject/Injector;->sTapX:F
    const/4 v4, 0x1
    aget-object v4, v3, v4
    invoke-static {v4}, Ljava/lang/Float;->parseFloat(Ljava/lang/String;)F
    move-result v4
    sput v4, Lcom/dsh/inject/Injector;->sTapY:F
    const/4 v4, 0x2
    aget-object v4, v3, v4
    invoke-static {v4}, Ljava/lang/Float;->parseFloat(Ljava/lang/String;)F
    move-result v4
    sput v4, Lcom/dsh/inject/Injector;->sTapP:F
    const/4 v4, 0x3
    aget-object v4, v3, v4
    invoke-static {v4}, Ljava/lang/Float;->parseFloat(Ljava/lang/String;)F
    move-result v4
    sput v4, Lcom/dsh/inject/Injector;->sTapS:F
    goto :argloop

    :argnext2
    const-string v3, "--legacy"
    invoke-virtual {v2, v3}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z
    move-result v3
    if-eqz v3, :argnext3
    const/4 v3, 0x1
    sput v3, Lcom/dsh/inject/Injector;->sLegacy:I
    goto :argloop

    :argnext3
    const-string v3, "--list"
    invoke-virtual {v2, v3}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z
    move-result v3
    if-eqz v3, :argloop
    invoke-static {}, Lcom/dsh/inject/Injector;->dumpDevices()V

    goto :argloop

    :argdone
    # **先找设备再判断模式。** 原来把一次性模式放在前面，导致 sDevice 还是 -1
    # 就去 obtain，MotionEvent 拿非法 deviceId 会返回 null（实测踩过）。
    sget v0, Lcom/dsh/inject/Injector;->sDevice:I
    if-gez v0, :havedev
    invoke-static {}, Lcom/dsh/inject/Injector;->findTouchscreen()I
    move-result v0
    sput v0, Lcom/dsh/inject/Injector;->sDevice:I
    :havedev

    # 一次性模式：--tap x,y,p,s，注入完直接退出（不依赖 stdin）
    sget v0, Lcom/dsh/inject/Injector;->sTapMode:I
    if-eqz v0, :noton
    invoke-static {}, Lcom/dsh/inject/Injector;->doOneShotTap()V
    return-void

    :noton

    # 解析注入入口
    invoke-static {}, Lcom/dsh/inject/Injector;->resolveInject()Z
    move-result v0
    # **if-nez 不是 if-eqz**：resolveInject 成功返回 1（非 0），
    # 写反了就变成"成功反而报 FATAL no inject entry point"。
    if-nez v0, :ready

    const-string v0, "FATAL no inject entry point"
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    const/4 v0, 0x3
    invoke-static {v0}, Ljava/lang/System;->exit(I)V
    return-void

    :ready
    const-string v0, "READY"
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    invoke-static {}, Lcom/dsh/inject/Injector;->sayInfo()V

    # 主循环
    new-instance v0, Ljava/io/BufferedReader;
    new-instance v1, Ljava/io/InputStreamReader;
    sget-object v2, Ljava/lang/System;->in:Ljava/io/InputStream;
    invoke-direct {v1, v2}, Ljava/io/InputStreamReader;-><init>(Ljava/io/InputStream;)V
    invoke-direct {v0, v1}, Ljava/io/BufferedReader;-><init>(Ljava/io/Reader;)V

    :loop
    invoke-virtual {v0}, Ljava/io/BufferedReader;->readLine()Ljava/lang/String;
    move-result-object v1
    if-nez v1, :end
    invoke-static {v1}, Lcom/dsh/inject/Injector;->handle(Ljava/lang/String;)Z
    move-result v2
    # handle 返回 true=继续读下一行，false=退出
    if-nez v2, :loop

    :end
    invoke-static {}, Lcom/dsh/inject/Injector;->cleanup()V
    return-void
.end method

# ============ 找真实触摸屏 ============
.method private static findTouchscreen()I
    .locals 10

    invoke-static {}, Landroid/view/InputDevice;->getDeviceIds()[I
    move-result-object v0
    const/4 v1, -0x1
    const/4 v2, 0x0

    :loop
    array-length v3, v0
    if-ge v2, v3, :done
    aget v3, v0, v2
    invoke-static {v3}, Landroid/view/InputDevice;->getDevice(I)Landroid/view/InputDevice;
    move-result-object v4
    # if-eqz = "等于 0 就跳"。设备为 null 才跳过，非 null 要继续看它的 sources。
    # 写成 if-nez 会变成"非 null 就跳过"，把所有设备都跳掉（实测踩过）。
    if-eqz v4, :next
    invoke-virtual {v4}, Landroid/view/InputDevice;->getSources()I
    move-result v5
    and-int/lit16 v6, v5, 0x1002
    const/16 v5, 0x1002
    # **if-ne 不是 if-eq**：这里是"位没匹配上就跳过"，
    # 写成 if-eq 就变成"匹配上了反而跳过"，永远找不到（实测踩过）。
    if-ne v6, v5, :next
    # 已经找到过就不再覆盖（if-gez = v1 >= 0 才跳）
    if-gez v1, :next
    move v1, v3
    :next
    add-int/lit8 v2, v2, 0x1
    goto :loop

    :done
    return v1
.end method

# ============ 解析注入入口 ============
.method private static resolveInject()Z
    .locals 7

    sget v0, Lcom/dsh/inject/Injector;->sLegacy:I
    if-eqz v0, :try_legacy

    # 候选 1：InputManagerGlobal（Android 14+）
    :try_global
    const-string v0, "android.hardware.input.InputManagerGlobal"
    invoke-static {v0}, Ljava/lang/Class;->forName(Ljava/lang/String;)Ljava/lang/Class;
    move-result-object v0

    const-string v1, "getInstance"
    const/4 v2, 0x0
    new-array v2, v2, [Ljava/lang/Class;
    invoke-virtual {v0, v1, v2}, Ljava/lang/Class;->getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;
    move-result-object v1

    const/4 v2, 0x0
    invoke-virtual {v1, v2, v2}, Ljava/lang/reflect/Method;->invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;
    move-result-object v1

    # 三参 injectInputEvent(InputEvent, mode, targetUid) —— 显式传 targetUid
    const/4 v3, 0x3
    new-array v3, v3, [Ljava/lang/Class;
    const/4 v4, 0x0
    const-string v5, "android.view.InputEvent"
    invoke-static {v5}, Ljava/lang/Class;->forName(Ljava/lang/String;)Ljava/lang/Class;
    move-result-object v5
    aput-object v5, v3, v4
    const/4 v4, 0x1
    sget-object v5, Ljava/lang/Integer;->TYPE:Ljava/lang/Class;
    aput-object v5, v3, v4

    const/4 v4, 0x2
    sget-object v5, Ljava/lang/Integer;->TYPE:Ljava/lang/Class;
    aput-object v5, v3, v4

    const-string v4, "injectInputEvent"
    invoke-virtual {v0, v4, v3}, Ljava/lang/Class;->getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;
    move-result-object v3

    sput-object v1, Lcom/dsh/inject/Injector;->sMgr:Ljava/lang/Object;
    sput-object v3, Lcom/dsh/inject/Injector;->sInject:Ljava/lang/reflect/Method;
    const/4 v4, 0x3
    sput v4, Lcom/dsh/inject/Injector;->sArgc:I

    const-string v0, "ENTRY InputManagerGlobal(ev,mode,targetUid)"
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    const/4 v0, 0x1
    return v0
    :try_global_end
    .catch Ljava/lang/Throwable; {:try_global .. :try_global_end} :catch_global

    goto :try_legacy

    :catch_global
    move-exception v6

    # 候选 2：InputManager（旧版）
    :try_legacy
    const-string v0, "android.hardware.input.InputManager"
    invoke-static {v0}, Ljava/lang/Class;->forName(Ljava/lang/String;)Ljava/lang/Class;
    move-result-object v0

    const-string v1, "getInstance"
    const/4 v2, 0x0
    new-array v2, v2, [Ljava/lang/Class;
    invoke-virtual {v0, v1, v2}, Ljava/lang/Class;->getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;
    move-result-object v1

    const/4 v2, 0x0
    invoke-virtual {v1, v2, v2}, Ljava/lang/reflect/Method;->invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;
    move-result-object v1

    const/4 v3, 0x2
    new-array v3, v3, [Ljava/lang/Class;
    const/4 v4, 0x0
    const-string v5, "android.view.InputEvent"
    invoke-static {v5}, Ljava/lang/Class;->forName(Ljava/lang/String;)Ljava/lang/Class;
    move-result-object v5
    aput-object v5, v3, v4
    const/4 v4, 0x1
    sget-object v5, Ljava/lang/Integer;->TYPE:Ljava/lang/Class;
    aput-object v5, v3, v4

    const-string v4, "injectInputEvent"
    invoke-virtual {v0, v4, v3}, Ljava/lang/Class;->getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;
    move-result-object v3

    sput-object v1, Lcom/dsh/inject/Injector;->sMgr:Ljava/lang/Object;
    sput-object v3, Lcom/dsh/inject/Injector;->sInject:Ljava/lang/reflect/Method;

    const-string v0, "ENTRY InputManager(ev,mode)"
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    const/4 v0, 0x1
    return v0
    :try_legacy_end
    .catch Ljava/lang/Throwable; {:try_legacy .. :try_legacy_end} :catch_legacy

    goto :gofail

    :catch_legacy
    move-exception v6

    :gofail
    const/4 v0, 0x0
    return v0
.end method

# ============ 造事件 ============
# 用 statics 传参，避免长参数列表
# sX sY sP sS sT sAct sDown 都已经设好
.method private static doOne()Z
    .registers 16

    sget-wide v0, Lcom/dsh/inject/Injector;->sDown:J
    sget-wide v2, Lcom/dsh/inject/Injector;->sT:J
    sget v4, Lcom/dsh/inject/Injector;->sAct:I
    sget v5, Lcom/dsh/inject/Injector;->sX:F
    sget v6, Lcom/dsh/inject/Injector;->sY:F
    sget v7, Lcom/dsh/inject/Injector;->sP:F
    sget v8, Lcom/dsh/inject/Injector;->sS:F
    const/4 v9, 0x0
    const/high16 v10, 0x3f800000
    const/high16 v11, 0x3f800000
    sget v12, Lcom/dsh/inject/Injector;->sDevice:I
    const/4 v13, 0x0
    const/16 v14, 0x1002
    sget v15, Lcom/dsh/inject/Injector;->sDisplay:I

    invoke-static/range {v0 .. v15}, Landroid/view/MotionEvent;->obtain(JJIFFFFIFFIIII)Landroid/view/MotionEvent;
    move-result-object v0

    sget v1, Lcom/dsh/inject/Injector;->sDisplay:I
    invoke-static {v0, v1}, Lcom/dsh/inject/Injector;->forceDisplayId(Landroid/view/InputEvent;I)V

    if-eqz v0, :built
    const-string v1, "ERR obtain-null"
    invoke-static {v1}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    const/4 v0, 0x0
    return v0

    :built
    invoke-static {v0}, Lcom/dsh/inject/Injector;->addHist(Landroid/view/MotionEvent;)V
    invoke-static {v0}, Lcom/dsh/inject/Injector;->doInject(Landroid/view/MotionEvent;)Z
    move-result v1

    invoke-virtual {v0}, Landroid/view/MotionEvent;->recycle()V

    return v1
.end method

# 只在 MOVE 上加历史采样。addBatch 只允许挂在 MOVE 上。
.method private static addHist(Landroid/view/MotionEvent;)V
    .locals 12

    sget v0, Lcom/dsh/inject/Injector;->sAct:I
    const/4 v1, 0x2
    if-ne v0, v1, :ret

    move-object v0, p0

    # 历史点 1：t-2ms，坐标偏一点
    sget-wide v1, Lcom/dsh/inject/Injector;->sT:J
    const-wide/16 v3, 0x2
    sub-long/2addr v1, v3

    sget v3, Lcom/dsh/inject/Injector;->sX:F
    const/high16 v4, 0x3f800000
    sub-float/2addr v3, v4
    sget v4, Lcom/dsh/inject/Injector;->sY:F
    const/high16 v5, 0x3f800000
    sub-float/2addr v4, v5
    sget v5, Lcom/dsh/inject/Injector;->sP:F
    const v6, 0x3f666666
    mul-float/2addr v5, v6
    sget v6, Lcom/dsh/inject/Injector;->sS:F
    const v7, 0x3f666666
    mul-float/2addr v6, v7
    const/4 v7, 0x0
    invoke-virtual/range {v0 .. v7}, Landroid/view/MotionEvent;->addBatch(JFFFFI)V

    # 历史点 2：t-1ms
    sget-wide v1, Lcom/dsh/inject/Injector;->sT:J
    const-wide/16 v3, 0x1
    sub-long/2addr v1, v3
    sget v3, Lcom/dsh/inject/Injector;->sX:F
    const/high16 v4, 0x40000000
    sub-float/2addr v3, v4
    sget v4, Lcom/dsh/inject/Injector;->sY:F
    const/high16 v5, 0x40000000
    sub-float/2addr v4, v5
    sget v5, Lcom/dsh/inject/Injector;->sP:F
    const v6, 0x3f4ccccd
    mul-float/2addr v5, v6
    sget v6, Lcom/dsh/inject/Injector;->sS:F
    const v7, 0x3f4ccccd
    mul-float/2addr v6, v7
    const/4 v7, 0x0
    invoke-virtual/range {v0 .. v7}, Landroid/view/MotionEvent;->addBatch(JFFFFI)V

    :ret
    return-void
.end method

.method private static forceDisplayId(Landroid/view/InputEvent;I)V
    .locals 6

    if-eqz p0, :ret

    :try_sd
    invoke-virtual {p0}, Ljava/lang/Object;->getClass()Ljava/lang/Class;
    move-result-object v0

    const-string v1, "setDisplayId"
    const/4 v2, 0x1
    new-array v2, v2, [Ljava/lang/Class;
    const/4 v3, 0x0
    sget-object v4, Ljava/lang/Integer;->TYPE:Ljava/lang/Class;
    aput-object v4, v2, v3

    invoke-virtual {v0, v1, v2}, Ljava/lang/Class;->getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;
    move-result-object v0

    const/4 v1, 0x1
    new-array v1, v1, [Ljava/lang/Object;
    const/4 v2, 0x0
    invoke-static {p1}, Ljava/lang/Integer;->valueOf(I)Ljava/lang/Integer;
    move-result-object v3
    aput-object v3, v1, v2

    invoke-virtual {v0, p0, v1}, Ljava/lang/reflect/Method;->invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;
    :try_sd_end
    .catch Ljava/lang/Throwable; {:try_sd .. :try_sd_end} :catch_sd
    return-void

    :catch_sd
    move-exception v0
    new-instance v1, Ljava/lang/StringBuilder;
    invoke-direct {v1}, Ljava/lang/StringBuilder;-><init>()V
    const-string v2, "WARN setDisplayId "
    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v0}, Ljava/lang/Object;->toString()Ljava/lang/String;
    move-result-object v0
    invoke-virtual {v1, v0}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v1}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;
    move-result-object v0
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V

    :ret
    return-void
.end method

.method private static doInject(Landroid/view/MotionEvent;)Z
    .locals 5

    sget-object v0, Lcom/dsh/inject/Injector;->sInject:Ljava/lang/reflect/Method;
    if-nez v0, :noentry
    const/4 v0, 0x0
    return v0

    :noentry
    sget-object v1, Lcom/dsh/inject/Injector;->sMgr:Ljava/lang/Object;

    const/4 v2, 0x3
    new-array v2, v2, [Ljava/lang/Object;
    const/4 v3, 0x0
    aput-object p0, v2, v3
    const/4 v3, 0x1
    const/4 v4, 0x0
    invoke-static {v4}, Ljava/lang/Integer;->valueOf(I)Ljava/lang/Integer;
    move-result-object v4
    aput-object v4, v2, v3
    const/4 v3, 0x2
    # targetUid：传 -1 = 不限定目标（和两参版本等价）
    const/4 v4, -0x1
    invoke-static {v4}, Ljava/lang/Integer;->valueOf(I)Ljava/lang/Integer;
    move-result-object v4
    aput-object v4, v2, v3

    :try_inj
    invoke-virtual {v0, v1, v2}, Ljava/lang/reflect/Method;->invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;
    move-result-object v3
    :try_inj_end
    .catch Ljava/lang/Throwable; {:try_inj .. :try_inj_end} :catch_inj

    sget-object v0, Ljava/lang/Boolean;->TRUE:Ljava/lang/Boolean;
    invoke-virtual {v0, v3}, Ljava/lang/Boolean;->equals(Ljava/lang/Object;)Z
    move-result v0
    return v0

    :catch_inj
    move-exception v3
    new-instance v0, Ljava/lang/StringBuilder;
    invoke-direct {v0}, Ljava/lang/StringBuilder;-><init>()V
    const-string v1, "ERR inject "
    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v3}, Ljava/lang/Object;->toString()Ljava/lang/String;
    move-result-object v1
    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v0}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;
    move-result-object v0
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    const/4 v0, 0x0
    return v0
.end method

# ============ 命令处理 ============
.method private static handle(Ljava/lang/String;)Z
    .locals 9

    invoke-virtual {p0}, Ljava/lang/String;->trim()Ljava/lang/String;
    move-result-object v0
    invoke-virtual {v0}, Ljava/lang/String;->length()I
    move-result v1
    # 长度非 0 才继续解析；空行直接返回 true 跳过
    if-eqz v1, :parsed
    const/4 v0, 0x1
    return v0

    const/4 v1, 0x0
    invoke-virtual {v0, v1}, Ljava/lang/String;->charAt(I)C
    move-result v1
    const/16 v2, 0x23
    # 不是 '#' 才继续解析；是注释就返回 true 跳过
    if-ne v1, v2, :parsed
    const/4 v0, 0x1
    return v0
    const/4 v0, 0x1
    return v0

    :parsed
    const-string v1, "\\s+"
    invoke-virtual {v0, v1}, Ljava/lang/String;->split(Ljava/lang/String;)[Ljava/lang/String;
    move-result-object v1
    const/4 v2, 0x0
    aget-object v2, v1, v2

    const-string v3, "Q"
    invoke-virtual {v2, v3}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z
    move-result v3
    if-eqz v3, :notq
    const/4 v0, 0x0
    return v0

    :notq
    const-string v3, "I"
    invoke-virtual {v2, v3}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z
    move-result v3
    if-eqz v3, :noti
    invoke-static {}, Lcom/dsh/inject/Injector;->sayInfo()V
    const/4 v0, 0x1
    return v0

    :noti
    # T / D / M / U
    const-string v3, "T"
    invoke-virtual {v2, v3}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z
    move-result v3
    if-eqz v3, :nott
    const/4 v0, 0x7
    invoke-static {v1, v0}, Lcom/dsh/inject/Injector;->runSeq([Ljava/lang/String;I)Z
    move-result v0
    return v0

    :nott
    const-string v3, "D"
    invoke-virtual {v2, v3}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z
    move-result v3
    if-eqz v3, :notd
    const/4 v0, 0x0
    invoke-static {v1, v0}, Lcom/dsh/inject/Injector;->runOne([Ljava/lang/String;I)Z
    move-result v0
    return v0

    :notd
    const-string v3, "M"
    invoke-virtual {v2, v3}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z
    move-result v3
    if-eqz v3, :notm
    const/4 v0, 0x2
    invoke-static {v1, v0}, Lcom/dsh/inject/Injector;->runOne([Ljava/lang/String;I)Z
    move-result v0
    return v0

    :notm
    const-string v3, "U"
    invoke-virtual {v2, v3}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z
    move-result v3
    if-eqz v3, :notu
    const/4 v0, 0x1
    invoke-static {v1, v0}, Lcom/dsh/inject/Injector;->runOne([Ljava/lang/String;I)Z
    move-result v0
    return v0

    :notu
    const-string v3, "B"
    invoke-virtual {v2, v3}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z
    move-result v3
    if-eqz v3, :notb
    const-string v0, "B dispatch ok"
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    invoke-static {v1}, Lcom/dsh/inject/Injector;->buildOnly([Ljava/lang/String;)Z
    move-result v0
    return v0

    :notb
    new-instance v3, Ljava/lang/StringBuilder;
    invoke-direct {v3}, Ljava/lang/StringBuilder;-><init>()V
    const-string v4, "ERR unknown "
    invoke-virtual {v3, v4}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v3, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v3}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;
    move-result-object v3
    invoke-static {v3}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    const/4 v0, 0x1
    return v0
.end method

# 解析 "x y p s" 到 statics，然后发一个事件
.method private static parseArgs([Ljava/lang/String;I)Z
    .locals 4

    array-length v0, p0
    add-int/lit8 v1, p1, 0x2
    if-le v0, v1, :ok
    const-string v0, "ERR need x y"
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    const/4 v0, 0x0
    return v0

    :ok
    aget-object v0, p0, p1
    invoke-static {v0}, Ljava/lang/Float;->parseFloat(Ljava/lang/String;)F
    move-result v0
    sput v0, Lcom/dsh/inject/Injector;->sX:F

    add-int/lit8 v1, p1, 0x1
    aget-object v0, p0, v1
    invoke-static {v0}, Ljava/lang/Float;->parseFloat(Ljava/lang/String;)F
    move-result v0
    sput v0, Lcom/dsh/inject/Injector;->sY:F

    # 压力（可选）
    array-length v0, p0
    add-int/lit8 v1, p1, 0x3
    if-gt v0, v1, :nop
    add-int/lit8 v1, p1, 0x2
    aget-object v0, p0, v1
    invoke-static {v0}, Ljava/lang/Float;->parseFloat(Ljava/lang/String;)F
    move-result v0
    sput v0, Lcom/dsh/inject/Injector;->sP:F
    :nop

    # 面积（可选）
    array-length v0, p0
    add-int/lit8 v1, p1, 0x4
    if-gt v0, v1, :nos
    add-int/lit8 v1, p1, 0x3
    aget-object v0, p0, v1
    invoke-static {v0}, Ljava/lang/Float;->parseFloat(Ljava/lang/String;)F
    move-result v0
    sput v0, Lcom/dsh/inject/Injector;->sS:F
    :nos

    const/4 v0, 0x1
    return v0
.end method

.method private static now()J
    .locals 2
    invoke-static {}, Landroid/os/SystemClock;->uptimeMillis()J
    move-result-wide v0
    return-wide v0
.end method

# 单个事件
.method private static runOne([Ljava/lang/String;I)Z
    .locals 3

    invoke-static {p0, p1}, Lcom/dsh/inject/Injector;->parseArgs([Ljava/lang/String;I)Z
    move-result v0
    # parseArgs 失败就返回
    if-nez v0, :ok
    const/4 v0, 0x1
    return v0

    :ok
    sput p1, Lcom/dsh/inject/Injector;->sAct:I

    invoke-static {}, Lcom/dsh/inject/Injector;->now()J
    move-result-wide v0
    sget-wide v2, Lcom/dsh/inject/Injector;->sT:J
    cmp-long v2, v0, v2
    # cmp-long 结果 -1/0/1，和零比：>0 表示 now 已经大于 sT，直接用 now
    if-gtz v2, :t_ok
    # 否则取 sT + 1，保证严格递增
    sget-wide v0, Lcom/dsh/inject/Injector;->sT:J
    const-wide/16 v2, 0x1
    add-long/2addr v0, v2
    :t_ok
    sput-wide v0, Lcom/dsh/inject/Injector;->sT:J

    if-nez p1, :notdown
    sput-wide v0, Lcom/dsh/inject/Injector;->sDown:J
    :notdown

    invoke-static {}, Lcom/dsh/inject/Injector;->doOne()Z
    move-result v0
    # doOne 返回 false 才报错
    if-nez v0, :rep
    const-string v0, "ERR inject-false"
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    :rep
    const-string v0, "OK"
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    const/4 v0, 0x1
    return v0
.end method

# 完整点按序列：DOWN → MOVE（带历史）→ UP
.method private static runSeq([Ljava/lang/String;I)Z
    .locals 6

    invoke-static {p0, p1}, Lcom/dsh/inject/Injector;->parseArgs([Ljava/lang/String;I)Z
    move-result v0
    if-nez v0, :ok
    const/4 v0, 0x1
    return v0

    :ok
    # DOWN
    const/4 v0, 0x0
    sput v0, Lcom/dsh/inject/Injector;->sAct:I
    const/4 v0, 0x0
    sput v0, Lcom/dsh/inject/Injector;->sTapMode:I
    const/4 v0, 0x0
    sput v0, Lcom/dsh/inject/Injector;->sLegacy:I
    invoke-static {}, Lcom/dsh/inject/Injector;->now()J
    move-result-wide v0
    sput-wide v0, Lcom/dsh/inject/Injector;->sDown:J
    sput-wide v0, Lcom/dsh/inject/Injector;->sT:J
    invoke-static {}, Lcom/dsh/inject/Injector;->doOne()Z
    move-result v0

    const-wide/16 v1, 0x14
    invoke-static {v1, v2}, Ljava/lang/Thread;->sleep(J)V

    # MOVE（带历史采样）
    const/4 v0, 0x2
    sput v0, Lcom/dsh/inject/Injector;->sAct:I
    invoke-static {}, Lcom/dsh/inject/Injector;->now()J
    move-result-wide v0
    sget-wide v2, Lcom/dsh/inject/Injector;->sT:J
    cmp-long v2, v0, v2
    if-gtz v2, :t2ok
    sget-wide v0, Lcom/dsh/inject/Injector;->sT:J
    const-wide/16 v2, 0x1
    add-long/2addr v0, v2
    :t2ok
    sput-wide v0, Lcom/dsh/inject/Injector;->sT:J
    invoke-static {}, Lcom/dsh/inject/Injector;->doOne()Z

    const-wide/16 v1, 0x1e
    invoke-static {v1, v2}, Ljava/lang/Thread;->sleep(J)V

    # UP
    const/4 v0, 0x1
    sput v0, Lcom/dsh/inject/Injector;->sAct:I
    invoke-static {}, Lcom/dsh/inject/Injector;->now()J
    move-result-wide v0
    sget-wide v2, Lcom/dsh/inject/Injector;->sT:J
    cmp-long v2, v0, v2
    if-gtz v2, :t3ok
    sget-wide v0, Lcom/dsh/inject/Injector;->sT:J
    const-wide/16 v2, 0x1
    add-long/2addr v0, v2
    :t3ok
    sput-wide v0, Lcom/dsh/inject/Injector;->sT:J
    invoke-static {}, Lcom/dsh/inject/Injector;->doOne()Z
    move-result v0

    const-wide/16 v1, 0x0
    sput-wide v1, Lcom/dsh/inject/Injector;->sDown:J

    if-nez v0, :rep
    const-string v0, "ERR seq-false"
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V

    :rep
    const-string v0, "OK"
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    const/4 v0, 0x1
    return v0
.end method

# 还有没抬起的 DOWN 就补一个 UP，别把按下状态留在屏上
.method private static cleanup()V
    .locals 4

    sget-wide v0, Lcom/dsh/inject/Injector;->sDown:J
    const-wide/16 v2, 0x0
    cmp-long v0, v0, v2
    if-nez v0, :skip

    const/4 v0, 0x1
    sput v0, Lcom/dsh/inject/Injector;->sAct:I
    invoke-static {}, Lcom/dsh/inject/Injector;->now()J
    move-result-wide v0
    sput-wide v0, Lcom/dsh/inject/Injector;->sT:J
    invoke-static {}, Lcom/dsh/inject/Injector;->doOne()Z

    const-wide/16 v0, 0x0
    sput-wide v0, Lcom/dsh/inject/Injector;->sDown:J
    :skip
    return-void
.end method

.method private static sayInfo()V
    .locals 3

    new-instance v0, Ljava/lang/StringBuilder;
    invoke-direct {v0}, Ljava/lang/StringBuilder;-><init>()V
    const-string v1, "INFO display="
    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    sget v1, Lcom/dsh/inject/Injector;->sDisplay:I
    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;
    const-string v1, " device="
    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    sget v1, Lcom/dsh/inject/Injector;->sDevice:I
    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;
    const-string v1, " src=0x1002"
    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v0}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;
    move-result-object v0
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    return-void
.end method

.method private static doOneShotTap()V
    .locals 6

    sget v0, Lcom/dsh/inject/Injector;->sTapX:F
    sput v0, Lcom/dsh/inject/Injector;->sX:F
    sget v0, Lcom/dsh/inject/Injector;->sTapY:F
    sput v0, Lcom/dsh/inject/Injector;->sY:F
    sget v0, Lcom/dsh/inject/Injector;->sTapP:F
    sput v0, Lcom/dsh/inject/Injector;->sP:F
    sget v0, Lcom/dsh/inject/Injector;->sTapS:F
    sput v0, Lcom/dsh/inject/Injector;->sS:F

    # DOWN
    const/4 v0, 0x0
    sput v0, Lcom/dsh/inject/Injector;->sAct:I
    invoke-static {}, Landroid/os/SystemClock;->uptimeMillis()J
    move-result-wide v0
    sput-wide v0, Lcom/dsh/inject/Injector;->sDown:J
    sput-wide v0, Lcom/dsh/inject/Injector;->sT:J
    invoke-static {}, Lcom/dsh/inject/Injector;->buildEvent()Landroid/view/MotionEvent;
    move-result-object v0
    # if-nez = "非 null 才跳去注入"。写成 if-eqz 会变成"造成功了反而报错返回"
    if-nez v0, :d1
    const-string v1, "ONESHOT obtain-null"
    invoke-static {v1}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    return-void

    :d1
    # 调试：打印事件实际字段
    new-instance v2, Ljava/lang/StringBuilder;
    invoke-direct {v2}, Ljava/lang/StringBuilder;-><init>()V
    const-string v3, "EV act="
    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v0}, Landroid/view/MotionEvent;->getAction()I
    move-result v3
    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;
    const-string v3, " dev="
    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v0}, Landroid/view/MotionEvent;->getDeviceId()I
    move-result v3
    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;
    const-string v3, " disp="
    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v0}, Landroid/view/InputEvent;->getDisplayId()I
    move-result v3
    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;
    const-string v3, " src=0x"
    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v0}, Landroid/view/InputEvent;->getSource()I
    move-result v3
    invoke-static {v3}, Ljava/lang/Integer;->toHexString(I)Ljava/lang/String;
    move-result-object v3
    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    const-string v3, " size="
    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    const/4 v3, 0x0
    invoke-virtual {v0, v3}, Landroid/view/MotionEvent;->getSize(I)F
    move-result v3
    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(F)Ljava/lang/StringBuilder;
    invoke-virtual {v2}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;
    move-result-object v2
    invoke-static {v2}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V

    invoke-static {v0}, Lcom/dsh/inject/Injector;->doInject(Landroid/view/MotionEvent;)Z
    move-result v1
    invoke-virtual {v0}, Landroid/view/MotionEvent;->recycle()V
    const-string v0, "ONESHOT down done"
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V

    # UP
    const/4 v0, 0x1
    sput v0, Lcom/dsh/inject/Injector;->sAct:I
    invoke-static {}, Landroid/os/SystemClock;->uptimeMillis()J
    move-result-wide v0
    sput-wide v0, Lcom/dsh/inject/Injector;->sT:J
    invoke-static {}, Lcom/dsh/inject/Injector;->buildEvent()Landroid/view/MotionEvent;
    move-result-object v0
    if-nez v0, :u1
    const-string v1, "ONESHOT up obtain-null"
    invoke-static {v1}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    return-void

    :u1
    invoke-static {v0}, Lcom/dsh/inject/Injector;->doInject(Landroid/view/MotionEvent;)Z
    move-result v1
    invoke-virtual {v0}, Landroid/view/MotionEvent;->recycle()V

    new-instance v0, Ljava/lang/StringBuilder;
    invoke-direct {v0}, Ljava/lang/StringBuilder;-><init>()V
    const-string v2, "ONESHOT done ok="
    invoke-virtual {v0, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(Z)Ljava/lang/StringBuilder;
    invoke-virtual {v0}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;
    move-result-object v0
    invoke-static {v0}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    return-void
.end method

.method private static buildOnly([Ljava/lang/String;)Z
    .locals 10

    const/4 v0, 0x1
    invoke-static {p0, v0}, Lcom/dsh/inject/Injector;->parseArgs([Ljava/lang/String;I)Z
    move-result v0
    if-nez v0, :ok
    const/4 v0, 0x1
    return v0

    :ok
    const/4 v0, 0x0
    sput v0, Lcom/dsh/inject/Injector;->sAct:I
    const/4 v0, 0x0
    sput v0, Lcom/dsh/inject/Injector;->sTapMode:I
    const/4 v0, 0x0
    sput v0, Lcom/dsh/inject/Injector;->sLegacy:I
    invoke-static {}, Landroid/os/SystemClock;->uptimeMillis()J
    move-result-wide v0
    sput-wide v0, Lcom/dsh/inject/Injector;->sDown:J
    sput-wide v0, Lcom/dsh/inject/Injector;->sT:J

    invoke-static {}, Lcom/dsh/inject/Injector;->buildEvent()Landroid/view/MotionEvent;
    move-result-object v0
    if-eqz v0, :built
    const-string v1, "BUILD null"
    invoke-static {v1}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V
    const/4 v0, 0x1
    return v0

    :built
    new-instance v1, Ljava/lang/StringBuilder;
    invoke-direct {v1}, Ljava/lang/StringBuilder;-><init>()V
    const-string v2, "BUILD ok dev="
    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v0}, Landroid/view/MotionEvent;->getDeviceId()I
    move-result v2
    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;
    const-string v2, " disp="
    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v0}, Landroid/view/InputEvent;->getDisplayId()I
    move-result v2
    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;
    const-string v2, " size="
    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    const/4 v2, 0x0
    invoke-virtual {v0, v2}, Landroid/view/MotionEvent;->getSize(I)F
    move-result v2
    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(F)Ljava/lang/StringBuilder;
    const-string v2, " pressure="
    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    const/4 v2, 0x0
    invoke-virtual {v0, v2}, Landroid/view/MotionEvent;->getPressure(I)F
    move-result v2
    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(F)Ljava/lang/StringBuilder;
    const-string v2, " hist="
    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v0}, Landroid/view/MotionEvent;->getHistorySize()I
    move-result v2
    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;
    invoke-virtual {v1}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;
    move-result-object v1
    invoke-static {v1}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V

    invoke-virtual {v0}, Landroid/view/MotionEvent;->recycle()V
    const/4 v0, 0x1
    return v0
.end method

.method private static buildEvent()Landroid/view/MotionEvent;
    .registers 16

    # 参数正好 16 个寄存器（v0..v15），结果回 v0 ——
    # 这个 smali 实现里寄存器超过 15 会报错，所以塞满就走，
    # downTime 用完就被结果覆盖，无所谓。
    # 参数顺序（对照 whitelist 14 参重载）：
    #   downTime(J) eventTime(J) action(I) x(F) y(F) pressure(F) size(F)
    #   metaState(I) xPrecision(F) yPrecision(F) deviceId(I) edgeFlags(I)
    #   source(I) displayId(I)
    sget-wide v0, Lcom/dsh/inject/Injector;->sDown:J
    sget-wide v2, Lcom/dsh/inject/Injector;->sT:J
    sget v4, Lcom/dsh/inject/Injector;->sAct:I
    sget v5, Lcom/dsh/inject/Injector;->sX:F
    sget v6, Lcom/dsh/inject/Injector;->sY:F
    sget v7, Lcom/dsh/inject/Injector;->sP:F
    sget v8, Lcom/dsh/inject/Injector;->sS:F
    const/4 v9, 0x0
    const/high16 v10, 0x3f800000
    const/high16 v11, 0x3f800000
    sget v12, Lcom/dsh/inject/Injector;->sDevice:I
    const/4 v13, 0x0
    const/16 v14, 0x1002
    sget v15, Lcom/dsh/inject/Injector;->sDisplay:I

    invoke-static/range {v0 .. v15}, Landroid/view/MotionEvent;->obtain(JJIFFFFIFFIIII)Landroid/view/MotionEvent;
    move-result-object v0

    # 显式设 displayId（scrcpy 也是这么干的）
    sget v1, Lcom/dsh/inject/Injector;->sDisplay:I
    invoke-static {v0, v1}, Lcom/dsh/inject/Injector;->forceDisplayId(Landroid/view/InputEvent;I)V

    return-object v0
.end method

.method private static dumpDevices()V
    .locals 8

    invoke-static {}, Landroid/view/InputDevice;->getDeviceIds()[I
    move-result-object v0
    const-string v1, "DEVICES"
    invoke-static {v1}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V

    array-length v1, v0
    new-instance v2, Ljava/lang/StringBuilder;
    invoke-direct {v2}, Ljava/lang/StringBuilder;-><init>()V
    const-string v3, "COUNT "
    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v2, v1}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;
    invoke-virtual {v2}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;
    move-result-object v2
    invoke-static {v2}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V

    const/4 v2, 0x0
    :loop
    if-ge v2, v1, :done
    aget v3, v0, v2
    invoke-static {v3}, Landroid/view/InputDevice;->getDevice(I)Landroid/view/InputDevice;
    move-result-object v4
    new-instance v5, Ljava/lang/StringBuilder;
    invoke-direct {v5}, Ljava/lang/StringBuilder;-><init>()V
    const-string v6, "DEV id="
    invoke-virtual {v5, v6}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v5, v3}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;
    const-string v6, " src=0x"
    invoke-virtual {v5, v6}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    if-eqz v4, :nonull
    invoke-virtual {v4}, Landroid/view/InputDevice;->getSources()I
    move-result v6
    invoke-static {v6}, Ljava/lang/Integer;->toHexString(I)Ljava/lang/String;
    move-result-object v6
    invoke-virtual {v5, v6}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    const-string v6, " name="
    invoke-virtual {v5, v6}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v4}, Landroid/view/InputDevice;->getName()Ljava/lang/String;
    move-result-object v6
    invoke-virtual {v5, v6}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    goto :emit

    :nonull
    const-string v6, "null"
    invoke-virtual {v5, v6}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    :emit
    invoke-virtual {v5}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;
    move-result-object v5
    invoke-static {v5}, Lcom/dsh/inject/Injector;->say(Ljava/lang/String;)V

    add-int/lit8 v2, v2, 0x1
    goto :loop

    :done
    return-void
.end method

.method private static say(Ljava/lang/String;)V
    .locals 2
    sget-object v0, Ljava/lang/System;->out:Ljava/io/PrintStream;
    invoke-virtual {v0, p0}, Ljava/io/PrintStream;->println(Ljava/lang/String;)V
    invoke-virtual {v0}, Ljava/io/PrintStream;->flush()V
    return-void
.end method
