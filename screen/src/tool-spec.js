/** 六个工具的契约。 */
const out = (d) => ({
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true, description: d } } },
  render(_a, v) { return [{ type: 'text', text: v.text }]; },
});

const MODES = [
  '四种操作方式，按任务选（都不许影响主屏）：',
  '1) shell  —— adb 直接执行，最快最稳，零打扰。装包、看日志、查状态、改设置都用它。',
  '2) browser —— 走 CDP 操作浏览器，不点屏幕。只在需要网页交互时用。',
  '3) vdisplay —— 私有虚拟屏，App 跑在用户看不见的屏上，可以截图+定向点击。需要"看界面再点"的 App 操作用它。',
  '4) watch  —— 用户想看你操作时，把虚拟屏截图发上来。',
].join('\n');

export function modesSpec() {
  return {
    name: 'screen_modes',
    description: ['列出目前可用的操作方式以及各自的代价与适用场景，供你选择。', '', MODES].join('\n'),
    parameters: {},
    output: out('四种方式的对比表与选择建议。'),
  };
}

export function startSpec() {
  return {
    name: 'vdisplay_start',
    description: [
      '创建一块用户看不见的私有虚拟屏（headless virtual display），App 可以跑在上面。',
      '',
      '关键性质（都实测过）：不画在物理屏幕上、不抢主屏焦点、不弹输入法。',
      '需要这台机器的 com.android.shell 拥有 ADD_TRUSTED_DISPLAY 权限（一部分机型有，Pixel 默认没有）。',
      '',
      '屏与插件进程同生共死：客户端断开或引擎重启，屏自动消失，不会留垃圾。',
    ].join('\n'),
    parameters: {
      width: { type: 'integer', description: '宽度，默认 720。' },
      height: { type: 'integer', description: '高度，默认 1280。' },
      dpi: { type: 'integer', description: '密度，默认 320。' },
    },
    output: out('displayId、SurfaceFlinger id、是否具备托管 App 的能力标志。'),
  };
}

export function launchSpec() {
  return {
    name: 'vdisplay_launch',
    description: [
      '把一个 App 投到虚拟屏上，而不是主屏。',
      '',
      '内部会先 force-stop 该 App：如果它已经在主屏后台跑着，直接投屏只会把旧任务拉到前台，',
      '就会顶掉用户正在看的东西（实测踩过）。投完还会校验主屏焦点没变，变了立刻切回去。',
    ].join('\n'),
    parameters: {
      pkg: { type: 'string', required: true, description: '包名，例如 com.tencent.mm。' },
      activity: { type: 'string', description: 'Activity 名，例如 .ui.LauncherUI。省略则只给包名。' },
    },
    output: out('是否成功落在虚拟屏上、主屏前后焦点对比。'),
  };
}

export function inputSpec() {
  return {
    name: 'vdisplay_input',
    description: [
      '往虚拟屏定向注入输入：点击、滑动、输入文字、按键。',
      '',
      '这些事件只发给虚拟屏，不会落到主屏上。虚拟屏上不弹软键盘（为了不抢你的键盘），所以：',
      '',
      '- kind:"text"：往标准输入框注入文字。系统设置、原生控件一般有效；',
      '  自绘输入框（京东、部分 App 的搜索框）可能注不进去。',
      '- kind:"paste"：发 KEYCODE_PASTE，把**剪贴板**内容粘进当前输入框。',
      '  这条路不经过输入法，对自绘输入框也有效，是 text 失败时的首选替代。',
      '  注意：剪贴板内容要靠外部准备（用户自己复制，或用宿主 App 的剪贴板工具写）。插件内部写不了剪贴板。',
      '- kind:"key"：发按键，如 KEYCODE_BACK / KEYCODE_ENTER。',
    ].join('\n'),
    parameters: {
      kind: { type: 'string', required: true, description: 'tap | swipe | text | key | paste' },
      verify: { type: 'boolean', description: '默认 true：动作前后各取一次画面哈希，没变就返回"可能没生效"。传 false 省两次截图（约 0.3 秒），适合连续点同一界面。' },
      settleMs: { type: 'integer', description: '动作后等画面稳定的毫秒数，默认 500。' },
      x: { type: 'integer', description: 'tap 的 x 坐标。' },
      y: { type: 'integer', description: 'tap 的 y 坐标。' },
      x1: { type: 'integer', description: 'swipe 起点 x。' },
      y1: { type: 'integer', description: 'swipe 起点 y。' },
      x2: { type: 'integer', description: 'swipe 终点 x。' },
      y2: { type: 'integer', description: 'swipe 终点 y。' },
      ms: { type: 'integer', description: 'swipe 时长毫秒，默认 300。' },
      text: { type: 'string', description: 'kind=text 时要输入的文字。' },
      key: { type: 'string', description: 'kind=key 时的按键名，例如 KEYCODE_BACK。' },
    },
    output: out('注入结果。'),
  };
}

export function shotSpec() {
  return {
    name: 'vdisplay_shot',
    description: [
      '截虚拟屏的画面，存成 PNG 并返回路径，你可以直接读这张图看界面。',
      '',
      '这是"看 AI 在操作什么"的主要方式：不占用户屏幕，随时可以截图。',
    ].join('\n'),
    parameters: { dir: { type: 'string', description: '本地保存目录，默认 /tmp。' } },
    output: out('截图本地路径与 displayId。'),
  };
}

export function mainShotSpec() {
  return {
    name: 'screen_shot_main',
    description: [
      '截主屏（用户正在看的屏幕）。只读操作，不会改变任何东西。',
      '',
      '用途：确认用户现在在看什么，或核对"我刚才的操作有没有影响主屏"。',
    ].join('\n'),
    parameters: { dir: { type: 'string', description: '本地保存目录，默认 /tmp。' } },
    output: out('截图路径，以及当前主屏焦点是哪个 App。'),
  };
}

export function statusSpec() {
  return {
    name: 'vdisplay_status',
    description: ['查看虚拟屏状态：是否在跑、displayId、上面跑着哪个 App、主屏现在是什么。'].join('\n'),
    parameters: {},
    output: out('状态摘要。'),
  };
}

export function stopSpec() {
  return {
    name: 'vdisplay_stop',
    description: ['销毁虚拟屏，释放资源。收工时应调用——虽然是自动生命周期的，但显式停更干净。'].join('\n'),
    parameters: {},
    output: out('销毁结果。'),
  };
}

export function streamStartSpec() {
  return {
    name: 'vdisplay_stream',
    description: [
      '把虚拟屏的画面以低帧率 JPEG 推给 DSH Go 的「AI 画面」胶囊，用户点它就能实时看到 AI 在操作什么。',
      '',
      '实测成本：360x640 @2fps 约 0.30 核、29 KB/s，全程不写任何文件。帧率上限 4fps（桥接协议硬限）。',
      '不看的时候胶囊不显示画面；调 vdisplay_stream_stop 或 vdisplay_stop 就会完全停掉。',
    ].join('\n'),
    parameters: {
      fps: { type: 'integer', description: '帧率，1–4，默认 2。' },
      width: { type: 'integer', description: 'JPEG 宽度，240–720，默认 360。' },
    },
    output: out('端口、帧率与打开方式。'),
  };
}

export function streamStopSpec() {
  return {
    name: 'vdisplay_stream_stop',
    description: '停止推流。',
    parameters: {},
    output: out('结果。'),
  };
}
