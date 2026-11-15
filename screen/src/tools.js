/** 工具的执行体。全部返回 { text }，失败给原因和下一步，不抛异常。 */
import * as vd from './vd.js';
import * as stream from './stream.js';
import * as timeline from './timeline.js';

export async function modes() {
  return {
    text: [
      '可用操作方式（都保证不动主屏）：',
      '',
      '| 方式 | 用什么 | 适用 | 代价 |',
      '| shell | adb_shell 那套 | 装包、看日志、查状态、改设置 | 零打扰，最快 |',
      '| browser | web_* 那套（CDP） | 网页交互、填表、读页面 | 需要浏览器在跑 |',
      '| vdisplay | vdisplay_* | 需要"看界面再点"的 App | 多占约 0.28 核 |',
      '| watch | vdisplay_shot | 用户想看你操作时的证据 | 一次截图 |',
      '',
      '选择顺序：能用 shell 就别开屏；能读文本就别截图；必须操作 App 界面时才用 vdisplay。',
    ].join('\n'),
  };
}

export async function start(args) {
  const r = await vd.start({
    width: Number(args?.width) || 0,       // 0 = 自动按物理屏比例
    height: Number(args?.height) || 0,
    dpi: Number(args?.dpi) || 320,
    systemDecorations: args?.systemDecorations === true,   // 默认 false：屏上不带二级桌面/导航栏
    orientation: args?.orientation,                        // portrait / landscape
    hwc: args?.hwc || 'auto',                              // 3D 游戏需要 HWC 参与合成
  });
  if (!r.ok) return { text: `建屏失败：${r.hint}` };
  return {
    text: `虚拟屏已就绪：displayId=${r.displayId}，SurfaceFlinger id=${r.sfId || '(未取到)'}\n`
      + `能托管 App：${r.canHost ? '是 ✅' : '否（缺 OWN_CONTENT_ONLY 或 OWN_FOCUS）'}\n`
      + `硬件合成（HWC）：${r.hwc ? '已开启 ✅ 3D 游戏可正常渲染' : '未开启（3D 游戏会黑屏，轻量 App 不受影响）'}\n`
      + `标志位：${r.flags || '(无)'}\n`
      + '这块屏用户看不见，不占主屏焦点。',
  };
}

export async function launch(args) {
  const pkg = String(args?.pkg || '').trim();
  if (!/^[a-z][\w.]*$/i.test(pkg)) return { text: 'pkg 看起来不是合法包名。' };
  const act = args?.activity ? String(args.activity).trim() : '';
  const r = await vd.launch(pkg, act);
  if (!r.displayId) return { text: `投屏失败：${r.hint}` };
  const lines = [
    `投到虚拟屏 display=${r.displayId}`,
    `落在虚拟屏上：${r.landedOnVd ? '是 ✅' : '否 ❌'}`,
    `主屏前后：${r.mainFocusBefore || '(未测到)'} → ${r.mainFocusAfter || '(未测到)'}`,
  ];
  if (r.restoredMain) lines.push('⚠ 主屏本来被抢了，已经切回原来的 App。');
  if (!r.ok) lines.push(`原始输出：${r.out}`);
  return { text: lines.join('\n') };
}

export async function input(args) {
  const kind = String(args?.kind || '').trim();
  if (!['tap', 'swipe', 'text', 'key', 'paste'].includes(kind)) return { text: 'kind 只能是 tap / swipe / text / key / paste。' };
  const r = await vd.input(kind, args || {});

  // shotAfter：动作后顺手截一张，省掉「再调一次 vdisplay_shot」的整轮模型往返。
  // 实测一轮往返 6–9 秒，占"点一下看结果"总耗时的绝大部分。
  let shotInfo = '';
  if (r.ok !== false && args?.shotAfter === true) {
    const shot = await vd.shot('/tmp', { width: Number(args?.width) || 540 });
    if (shot.ok) {
      shotInfo = shot.unchanged
        ? `\n画面和上次完全一样（${shot.path}），可以直接复用那张图。`
        : `\n动作后的画面：${shot.path}（${shot.width}x${shot.height}）——用 read_image 打开它。`;
    }
  }

  // changed 必须透传：false 表示"动作发出去了但画面没变"，这是有效信息，
  // 不是"注入失败"。早期把它包成"注入失败"会让调用方以为工具坏了。
  if (r.changed === false && r.hint) return { text: `${r.hint}\n（display=${r.displayId}，${kind} 已发出）${shotInfo}` };
  if (!r.ok && r.hint) return { text: `注入失败：${r.hint}` };
  const tail = r.out ? `（${r.out}）` : '';
  return { text: `已在 display=${r.displayId} 注入 ${kind}${tail}${shotInfo}` };
}

export async function shot(args) {
  const frames = Number(args?.frames) || 1;

  // frames=1 → 单张截图（读字用）
  if (frames <= 1) {
    // crop=content 时问浏览器要内容区高度，裁掉地址栏+导航栏。
    // 实测 720x1592 里内容只有 1372（壳 220px = 13%，这些像素照样按 token 收）。
    let cropPx = 0;
    if (args?.crop === 'content') {
      try {
        const ch = await timeline.contentHeight();
        if (ch && ch.height > 200) {
          const st0 = await vd.status();
          if (st0.running && st0.height > ch.height + 20) cropPx = st0.height - ch.height;
        }
      } catch { /* 拿不到就不裁 */ }
    }
    const r = await vd.shot(String(args?.dir || '/tmp'), {
      width: Number(args?.width) || 540,
      format: args?.format === 'png' ? 'png' : 'jpeg',
      cropPx,
      region: args?.region && typeof args.region === 'object' ? args.region : null,
    });
    if (!r.ok) return { text: `截图失败：${r.hint}` };
    const lines = [`虚拟屏截图：${r.path}（displayId=${r.displayId}，屏 ${r.width}x${r.height}）`];
    if (r.unchanged) lines.push('画面和上次完全一样，可以直接复用这张，不用再看一次。');
    else lines.push('用 read_image 打开它就能看到界面。');
    lines.push('点坐标时可以用 nx/ny（0..1 归一化）代替 x/y，不用自己算像素。');
    lines.push('');
    lines.push('想看"在动吗、往哪动"就传 frames=9 再调一次。');
    return { text: lines.join('\n') };
  }

  // frames>1 → 连拍拼网格（看运动用）
  const st = await vd.status();
  if (!st.running) return { text: '虚拟屏没在运行。先 vdisplay_start 建屏、vdisplay_launch 投 App。' };
  if (!st.sfId) return { text: '没拿到 SurfaceFlinger id，先 vdisplay_status 确认屏状态。' };

  const r = await timeline.capture({
    sfId: st.sfId,
    frames,
    intervalMs: args?.intervalMs === undefined ? 300 : Math.max(0, Number(args.intervalMs) || 0),
    cellWidth: Number(args?.width) || 262,
    dir: String(args?.dir || '/tmp'),
    crop: args?.crop === 'content' ? 'content' : 'none',
  });
  if (!r.ok) return { text: `抓时间线失败：${r.hint}` };

  const spanSec = ((r.cells - 1) * r.intervalMs / 1000).toFixed(1);
  const shape = r.canvasW > r.canvasH ? '横屏' : '竖屏';
  const lines = [
    `时间线拼图：${r.path}`,
    `${r.cols}×${r.rows} = ${r.cells} 格（实际抓到 ${r.captured} 帧），每格 ${r.cellW}×${r.cellH}，画布 ${r.canvasW}×${r.canvasH}（${shape}）`,
    `覆盖约 ${spanSec} 秒（间隔 ${r.intervalMs}ms），抓帧+拼图共 ${(r.elapsedMs / 1000).toFixed(1)} 秒`,
    '用 read_image 打开它，从左到右、从上到下就是时间顺序。',
    '',
    '这个尺寸只能看「结构、位置、有没有动」，读不出屏幕上的小字和数字。要读数字请用 frames=1 单帧。',
  ];
  if (r.captured < r.cells) lines.push(`⚠️ 有 ${r.cells - r.captured} 帧没抓到，画面可能不完整。`);
  return { text: lines.join('\n') };
}

export async function mainShot(args) {
  const focus = await vd.mainFocus();
  const r = await vd.mainShot(String(args?.dir || '/tmp'));
  if (!r.ok) return { text: `主屏截图失败：${r.hint}` };
  return { text: `主屏截图：${r.path}\n主屏当前焦点：${focus || '(未测到)'}` };
}

export async function status() {
  const st = await vd.status();
  const focus = await vd.mainFocus();
  return {
    text: st.running
      ? `虚拟屏运行中：displayId=${st.displayId}，SF id=${st.sfId}，已运行 ${st.uptimeSec} 秒\n上面的 App：${st.focusedApp || '(未知)'}\n主屏焦点：${focus || '(未测到)'}\n所有屏：${st.allDisplays.join(', ')}`
      : `虚拟屏没有在运行。\n主屏焦点：${focus || '(未测到)'}\n所有屏：${st.allDisplays.join(', ')}`,
  };
}

export async function stop(args) {
  // 先停推流：否则胶囊会永远显示"AI 正在操作"+ 冻在最后一帧（复核实测）。
  await stream.stop().catch(() => {});
  const r = await vd.stop({ forceStopApps: args?.forceStopApps === true });
  const lines = ['虚拟屏已销毁。'];
  if (r.killed?.length) lines.push(`已清理后台 App：${r.killed.join('、')}`);
  if (r.hint) lines.push(r.hint);
  return { text: lines.join('\n') };
}

/** 开始把虚拟屏画面推给原生胶囊插件。 */
export async function streamStart(args) {
  const s = await vd.start();
  if (!s.ok) return { text: `建屏失败：${s.hint}` };
  const fps = Math.min(Math.max(Number(args?.fps) || 2, 1), 4);
  const width = Math.min(Math.max(Number(args?.width) || 360, 240), 720);
  // 传真实的 focusedApp：以前这里写死空串，导致胶囊永远只显示"操作中 12s"。
  const focus = await vd.focusedApp();
  const r = await stream.start({ sfId: s.sfId, displayId: s.displayId, fps, width, focusedApp: focus });
  if (!r.ok) return { text: `推流启动失败：${r.hint}` };
  return {
    text: `推流已开启：127.0.0.1:${r.port}，${fps} fps，宽度 ${width}\n`
      + '打开 DSH Go 输入框上方的「AI 画面」胶囊，点它就能看到虚拟屏。\n'
      + '实测这个档位约 0.30 核、29 KB/s，不写任何文件。',
  };
}

export async function streamStop() {
  await stream.stop();
  return { text: '推流已停止（胶囊不再显示画面）。' };
}

export async function closeAll() {
  await stream.shutdown();
  await vd.stop();
  return { text: '虚拟屏与推流都已关闭。' };
}

export async function text(args) {
  const st = await vd.status();
  if (!st.running) return { text: '虚拟屏没在运行。先 vdisplay_start 建屏、vdisplay_launch 投 App。' };

  const ocr = await import('./ocr.js');
  const fresh = args?.fresh === true;

  // 拿一张原生分辨率的截图（OCR 要在原生尺度上跑，缩小会丢小字）
  const shot = await vd.shot(String(args?.dir || '/tmp'), {
    width: Math.min(1080, Math.max(360, st.width || 720)),
    format: 'png',
  });
  if (!shot.ok) return { text: `截图失败：${shot.hint}` };

  const r = await ocr.recognize(shot.path, {
    minConf: args?.minConf === undefined ? 0.45 : Number(args.minConf),
    maxLines: Number(args?.maxLines) || 80,
    hash: fresh ? null : shot.hash,
  });

  if (!r.ok) return { text: r.hint };

  const W = shot.width || 720;
  const H = shot.height || 1280;
  const lines = [
    `识别到 ${r.count} 行文字${r.total > r.count ? `（共 ${r.total}，已截断）` : ''}`
      + `，耗时 ${r.cached ? '0（画面没变，复用上次）' : `${(r.elapsedMs / 1000).toFixed(1)} 秒`}`,
    `屏 ${W}x${H}，下面每行的 nx/ny 是归一化坐标，可直接传给 vdisplay_input。`,
    '',
  ];
  for (const l of r.lines) {
    const nx = ((l.x + l.w / 2) / W).toFixed(3);
    const ny = ((l.y + l.h / 2) / H).toFixed(3);
    lines.push(`  [${l.conf.toFixed(2)}] (${String(l.x).padStart(4)},${String(l.y).padStart(4)}) ${l.w}x${l.h}  nx=${nx} ny=${ny}  ${l.text}`);
  }
  lines.push('');
  lines.push('要读的位置画面对不上？用 vdisplay_shot(frames=1) 看实际画面。');
  lines.push('要看清某个按钮长什么样？用 vdisplay_shot 配合坐标自己判断。');
  return { text: lines.join('\n') };
}
