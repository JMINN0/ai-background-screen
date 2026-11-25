/**
 * index.js — 插件入口，只做注册。
 *
 * 40 个工具（下面只列开头几个）：screen_modes / vdisplay_start / vdisplay_launch / vdisplay_input /
 *          vdisplay_shot / screen_shot_main / vdisplay_status / vdisplay_stop
 *
 * defineTool 要五级回退：插件装在 profile 的 node_modules 下，那里没有 dsh-tools，
 * 引擎自带的那份在 /opt/dsh/node_modules。只写裸包名会让 apply 直接失败。
 */
import {
  inputSpec, launchSpec, mainShotSpec, modesSpec, riskSetSpec, riskCheckSpec, windowStateSpec, returnSpec, uiSpec, shotSpec, startSpec, statusSpec,
  stopSpec, userStateSpec,
  streamStartSpec, streamStopSpec, textSpec, appsSpec, edgeSpec,
  poolSpec, newScreenSpec, useScreenSpec, closeScreenSpec, checkAppSpec,
  claimAppSpec, releaseAppSpec, leasesSpec,
  // 感知层（2026-11-16）：常驻解码、实时帧、等稳定、自动 ROI、黑屏探针
  liveSpec, liveShotSpec, waitStableSpec, roiSpec, probeSecureSpec,
  // 按文字找/点（2026-11-19）：消掉模型自己算坐标的 点空率
  findTextSpec, tapTextSpec, keepAliveSpec,
  findImageSpec, tapImageSpec, fingerprintSpec, screenDiffSpec, probeScreenSpec,
  findColorSpec, tapColorSpec, chooseMethodSpec,
  waitForSpec,
} from './tool-spec.js';
import * as T from './tools.js';

export const name = 'ai-background-screen';
export const inject = ['tools'];

async function loadDefineTool() {
  const tryImport = async (spec) => {
    const mod = await import(spec);
    return mod?.defineTool ? mod.defineTool : null;
  };
  try { const d = await tryImport('@deepseek-ai/dsh-tools'); if (d) return d; } catch {}
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    try {
      const { pathToFileURL } = await import('node:url');
      const d = await tryImport(pathToFileURL(override).href);
      if (d) return d;
    } catch {}
  }
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  for (const root of [process.env.DSH_ROOT, '/opt/dsh', '/usr/local/lib/dsh', '/app'].filter(Boolean)) {
    const entry = `${root}/node_modules/@deepseek-ai/dsh-tools/lib/index.js`;
    if (!existsSync(entry)) continue;
    try { const d = await tryImport(pathToFileURL(entry).href); if (d) return d; } catch {}
  }
  for (const seed of [process.argv?.[1], process.cwd()].filter(Boolean)) {
    let dir = dirname(seed);
    for (let i = 0; i < 8; i += 1) {
      const entry = join(dir, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js');
      if (existsSync(entry)) {
        try { const d = await tryImport(pathToFileURL(entry).href); if (d) return d; } catch {}
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  throw new Error('cannot resolve @deepseek-ai/dsh-tools');
}

export async function apply(ctx) {
  // 启动时修一次假状态（见 stream.js 的 reconcileStreamState）
  import('./stream.js').then(m => m.reconcileStreamState?.()).catch(() => {});
  // **启动空闲看门狗**：AI 不调工具就自动放掉虚拟屏和推流（省电）。
  // 实测不关的话 framesrv 持续 10.3% CPU —— 悬浮窗连着 MJPEG，
  // framesrv 就以为「有人在看」，一直编码。
  try { T.startIdleWatchdog(); } catch { /* ignore */ }

    /* **边缘光效的收尾 —— 插件形态下也要有。**
     *
     * 2026-11-23 审查抓到：settleIfIdle（8 秒没操作 → 闪 4 秒绿再收回 idle）
     * 只有 daemon 会调（vdisplayd.mjs 的 tick），插件入口从来没调过。
     * 而用户装的就是插件 —— 于是 flushAutoEdge("working") 写的 ttl=0
     * 让青色边框一直亮到用户手动 clear，而 tool-spec 又明确叫 AI 不要手动调。
     * 结果就是永久青边。
     *
     * 这里补一个 10 秒的定时器，和 daemon 那套行为一致。
     */
    let edgeSettleTimer = null;
    try {
      edgeSettleTimer = setInterval(async () => {
        try {
          const v = await import("./vd.js");
          await v.settleIfIdle?.(8000);
        } catch { /* ignore */ }
        /* **处理浮窗红色按钮的「停止请求」。**
         *
         * 2026-11-23 产品审查抓到：这个逻辑原来只写在 bin/vdisplayd.mjs 里，
         * 而**插件从不启动 daemon** —— 所以装机配置下用户按红条根本没反应，
         * 那个「关闭并停后台屏」一直是假的（修在了一个不运行的组件上）。
         *
         * 现在接到这个 10 秒定时器上，插件形态也能真停。
         */
        try {
          const v = await import("./vd.js");
          const reqPort = await v.takeStopRequest?.();
          if (!reqPort) return;
          const T = await import("./tools.js");
          // 按 framesrv 端口反查 displayId
          let targetDisp = null;
          try {
            for (const [disp, pt] of (T.screenPorts || new Map())) {
              if (Number(pt) === Number(reqPort)) { targetDisp = Number(disp); break; }
            }
          } catch { /* ignore */ }
          console.error("[dsh-screen] 收到停止请求 port=" + reqPort
            + " displayId=" + (targetDisp ?? "?"));
          if (targetDisp) {
            try { await T.overlayStop(reqPort); } catch { /* 窗口可能已经没了 */ }
            try {
              const f = await import("./framesrv.js");
              await f.stop(targetDisp);
            } catch { /* ignore */ }
            try {
              const poolMod = await import("./pool.js");
              const pi = poolMod.info ? poolMod.info() : null;
              const match = (pi?.screens || []).find(
                (x) => Number(x.displayId) === Number(targetDisp));
              if (match && poolMod.destroy) await poolMod.destroy(match.screenId);
              else await v.stop({ forceStopApps: false });
            } catch { /* ignore */ }
            console.error("[dsh-screen] 停止请求已执行");
          }
        } catch { /* 处理失败不影响定时器 */ }
      }, 10_000);
      if (edgeSettleTimer.unref) edgeSettleTimer.unref();
    } catch { /* ignore */ }
  // Cordis 规定：没通过 ctx.inject 声明依赖之前，**碰 ctx 的任何属性都会抛**
  // （"cannot get property X without inject"）。所以所有 ctx 访问都放进 inject 回调里。
  // 这个坑让三个插件在真实引擎里全部加载失败过，工具一个都没出现。
  const disposers = [];
  try {
    ctx.inject(['tools'], (c) => {
      loadDefineTool()
        .then((defineTool) => {
          const defs = [
            [modesSpec, () => T.modes()],
            [startSpec, (a) => T.start(a)],
            [launchSpec, (a) => T.launch(a)],
            [inputSpec, (a) => T.input(a)],
            [shotSpec, (a) => T.shot(a)],
            [textSpec, (a) => T.text(a)],
            [appsSpec, () => T.apps()],
            [poolSpec, () => T.poolInfo()],
            [newScreenSpec, (a) => T.newScreen(a)],
            [useScreenSpec, (a) => T.useScreen(a)],
            [closeScreenSpec, (a) => T.closeScreen(a)],
            [checkAppSpec, (a) => T.checkApp(a)],
            [claimAppSpec, (a) => T.claimApp(a)],
            [releaseAppSpec, (a) => T.releaseApp(a)],
            [leasesSpec, () => T.leases()],
            [mainShotSpec, (a) => T.mainShot(a)],
            [statusSpec, () => T.status()],
            [stopSpec, (a) => T.stop(a)],   // 以前写成 () => T.stop()，把 args 丢了，forceStopApps 永远无效
            [streamStartSpec, (a) => T.streamStart(a)],
            [edgeSpec, (a) => T.edge(a)],
            [streamStopSpec, () => T.streamStop()],
            // 感知层（2026-11-16）：常驻解码、实时帧、等稳定、自动 ROI、黑屏探针
            [liveSpec, (a) => T.live(a)],
            [liveShotSpec, (a) => T.liveShot(a)],
            [waitStableSpec, (a) => T.waitStable(a)],
            [roiSpec, (a) => T.roi(a)],
            [probeSecureSpec, (a) => T.probeSecure(a)],
              // 安全闸门（2026-11-19 对抗审查发现）：这两个能力一直缺
              [userStateSpec, () => T.userState()],
              [riskSetSpec, (a) => T.riskSet(a)],
              [returnSpec, (a) => T.returnToMain(a)],
              [uiSpec, (a) => T.ui(a)],
              [windowStateSpec, async (a) => {
                const w = await T.windowState(a?.port);
                if (!w.exists) return { text: '没有悬浮窗在跑。' };
                const lines = [
                  `悬浮窗：${w.shown ? '可见 ✅' : '被隐藏 ⚠️'}`,
                  `状态：${w.collapsed === null ? '判断不了' : (w.collapsed ? '已最小化（用户在少挡主屏，**不要重建**）' : '展开中')}`,
                  `位置：(${w.x}, ${w.y})　尺寸：${w.w}x${w.h}`,
                  `端口：${w.port}`,
                ];
                if (!w.shown) lines.push('', '被隐藏的原因通常是某个 App 带 HIDE_NON_SYSTEM_OVERLAY 标志（比如文件管理器）。');
                return { text: lines.join('\n') };
              }],
              [riskCheckSpec, (a) => T.riskCheck(a?.pkg)],
              // 按文字找/点（2026-11-19）：消掉模型自己算坐标的 点空率
              [findTextSpec, (a) => T.findText(a)],
              [tapTextSpec, (a) => T.tapText(a)],
              // 后台屏生命周期（2026-11-19）：让 AI 按任务预估空闲超时
              [keepAliveSpec, (a) => T.keepAlive(a)],
              // 视觉方法（2026-11-19）：模板/指纹/差分/探测，全部基于常驻 OpenCV
              [findImageSpec, (a) => T.findImage(a)],
              [tapImageSpec, (a) => T.tapImage(a)],
              [fingerprintSpec, (a) => T.fingerprint(a)],
              [screenDiffSpec, (a) => T.screenDiff(a)],
              [probeScreenSpec, (a) => T.probeScreen(a)],
              // 颜色检测 + 方法自动选择（2026-11-19）
              [findColorSpec, (a) => T.findColor(a)],
              [tapColorSpec, (a) => T.tapColor(a)],
              [chooseMethodSpec, (a) => T.chooseMethod(a)],
              // 条件等待（2026-11-19）：替代固定 sleep，每步省 1-2 秒
              [waitForSpec, (a) => T.waitFor(a)],
          ];
          for (const [spec, exec] of defs) {
            try {
              // **每次工具调用都刷新空闲计时**，看门狗据此判断「AI 还在干活」。
              const wrapped = async (a) => {
                try { T.touchActivity(); } catch { /* ignore */ }
                return exec(a);
              };
              disposers.push(c.tools.register(defineTool({ ...spec(), execute: wrapped })));
            } catch (e) {
              console.error('[ai-background-screen] register failed:', e?.message || e);
            }
          }
        })
        .catch((e) => console.error('[ai-background-screen] apply failed, plugin disabled:', e?.message || e));
    });
  } catch (e) {
    console.error('[ai-background-screen] inject failed:', e?.message || e);
  }
  return async () => {
      if (edgeSettleTimer) { try { clearInterval(edgeSettleTimer); } catch { /* ignore */ } }
    for (const d of disposers) { try { d?.(); } catch { /* 单个工具 dispose 失败不影响其他 */ } }
    // **卸载时把常驻子进程关掉。** 不关的话 OCR 的 python3 会变成孤儿，
    // 带着 15MB 模型一直占内存，重载一次多一个（对抗审查第三轮 S3）。
    try { const ocr = await import('./ocr.js'); ocr.shutdown(); } catch { /* 没加载过就算了 */ }
    // **视觉助手同样要关。** OpenCV 常驻进程占 80-150MB，不关就是孤儿
    // （和 OCR 同款泄漏，视觉功能是后加的，当时漏了 —— 对抗审查 S4）。
    try { const vis = await import('./vision.js'); vis.shutdown(); } catch { /* 没加载过就算了 */ }
    try {
      const vd = await import('./vd.js');
      /* **卸载时只停推流，不销毁虚拟屏。**
       *
       * 2026-11-23 产品审查抓到：这里原来调 vd.stop()，把屏连同上面的 App 一起销毁。
       * 后果：引擎重启、插件热重载、DSH 升级 —— 任何一次都会让用户的屏和任务消失。
       * 而 vd.js 里明明有完整的「复用已有屏 + 重连控制通道」逻辑（reconnectControl），
       * **因为这里先 stop 了，那条路径永远走不到**。
       *
       * 产品意图要求「随时能瞄一眼」「不打断用户」—— 插件重启不该把任务清掉。
       * 所以：只停浮窗推流（省 CPU），屏留着，下个进程能直接复用。
       * 真要销毁，用户/AI 显式调 vdisplay_stop。
       */
      try {
        const vd = await import('./vd.js');
        const st = await vd.status().catch(() => null);
        if (st?.running) {
          /* **只停推流和浮窗，不动屏。**
           * streamStop 在 tools.js，不在 vd.js —— 写 vd.streamStop 是个不存在的函数，
           * 用 `?.` 调它会静默什么都不做（这类「看着对实际没生效」是本项目最常见的坑）。
           */
          try {
            const T = await import('./tools.js');
            await T.streamStop({});
          } catch { /* ignore */ }
        }
      } catch { /* 清理失败不阻塞卸载 */ }
    } catch { /* 清理失败不阻塞卸载 */ }
  };
}
