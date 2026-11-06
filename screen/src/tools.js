/** 工具的执行体。全部返回 { text }，失败给原因和下一步，不抛异常。 */
import * as vd from './vd.js';
import * as stream from './stream.js';

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
  const r = await vd.start({ width: Number(args?.width) || 720, height: Number(args?.height) || 1280, dpi: Number(args?.dpi) || 320 });
  if (!r.ok) return { text: `建屏失败：${r.hint}` };
  return {
    text: `虚拟屏已就绪：displayId=${r.displayId}，SurfaceFlinger id=${r.sfId || '(未取到)'}\n`
      + `能托管 App：${r.canHost ? '是 ✅' : '否（缺 OWN_CONTENT_ONLY 或 OWN_FOCUS）'}\n`
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
  if (!r.ok) return { text: `注入失败：${r.hint || r.out}` };
  return { text: `已在 display=${r.displayId} 注入 ${kind}${r.out ? `（${r.out}）` : ''}` };
}

export async function shot(args) {
  const r = await vd.shot(String(args?.dir || '/tmp'));
  if (!r.ok) return { text: `截图失败：${r.hint}` };
  return { text: `虚拟屏截图：${r.path}（displayId=${r.displayId}）\n用 read_image 打开它就能看到界面。` };
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

export async function stop() {
  await vd.stop();
  return { text: '虚拟屏已销毁。' };
}

/** 开始把虚拟屏画面推给原生胶囊插件。 */
export async function streamStart(args) {
  const s = await vd.start();
  if (!s.ok) return { text: `建屏失败：${s.hint}` };
  const fps = Math.min(Math.max(Number(args?.fps) || 2, 1), 4);
  const width = Math.min(Math.max(Number(args?.width) || 360, 240), 720);
  const r = await stream.start({ sfId: s.sfId, displayId: s.displayId, fps, width, focusedApp: '' });
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
