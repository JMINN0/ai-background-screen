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
      orientation: { type: 'string', description: '方向："portrait"（竖屏，确保高>宽）、"landscape"（横屏，确保宽>高）。省略时按给定的 width/height 创建。landscape 时如果 width<height 会自动交换。' },
      systemDecorations: { type: 'boolean', description: '默认 false。false 时虚拟屏上不含二级桌面、导航栏和权限弹窗，AI 截图更干净（scrcpy ≥3.1）。改这个值会重建屏。' },
      hwc: { type: 'string', description: '是否让硬件合成器（HWC）参与虚拟屏合成。"auto"（默认）：仅当本机 vendor.display.vds_allow_hwc=1 时自动开启；"on"：强制尝试；"off"：不碰。开启后 3D 游戏（SurfaceView 渲染）能正常出画面，否则全黑。这是全局 SurfaceFlinger 属性，stop 时会恢复原值。' },
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
      '  带 text 时插件会先写剪贴板再粘，支持中文；不带 text 则粘用户剪贴板里现有的内容。',
      '- kind:"key"：发按键，如 KEYCODE_BACK / KEYCODE_ENTER。',
    ].join('\n'),
    parameters: {
      kind: { type: 'string', required: true, description: 'tap | swipe | text | key | paste' },
      verify: { type: 'boolean', description: '默认 true：动作前后各取一次画面哈希，没变就返回"可能没生效"。传 false 跳过校验，实测省约 2 秒（两次 screencap 各约 1 秒），适合连续点同一界面。' },
      settleMs: { type: 'integer', description: '动作后等画面稳定的毫秒数，默认 500。' },
      shotAfter: { type: 'boolean', description: '动作后顺手截一张并返回路径（省掉单独调 vdisplay_shot 的一轮往返）。默认 false。' },
      width: { type: 'integer', description: 'shotAfter 时的截图宽度，默认 540。' },
      text: { type: 'string', description: 'kind:"text" 要注入的 ASCII 文字；或 kind:"paste" 要粘贴的文字（**支持中文**，插件会先写剪贴板再粘）。paste 不带 text 时粘现有剪贴板内容。注意剪贴板是系统全局的，写它会覆盖用户自己的剪贴板。' },
      x: { type: 'integer', description: 'tap 的 x 像素坐标（和 nx 二选一）。' },
      y: { type: 'integer', description: 'tap 的 y 像素坐标（和 ny 二选一）。' },
      nx: { type: 'number', description: '归一化横坐标 0..1，按屏宽换算。比算像素省心，推荐用它。' },
      ny: { type: 'number', description: '归一化纵坐标 0..1，按屏高换算。' },
      x1: { type: 'integer', description: 'swipe 起点 x。' },
      y1: { type: 'integer', description: 'swipe 起点 y。' },
      x2: { type: 'integer', description: 'swipe 终点 x。' },
      y2: { type: 'integer', description: 'swipe 终点 y。' },
      ms: { type: 'integer', description: 'swipe 时长毫秒，默认 300。' },
      key: { type: 'string', description: 'kind=key 时的按键名，例如 KEYCODE_BACK。' },
    },
    output: out('注入结果。'),
  };
}

export function shotSpec() {
  return {
    name: 'vdisplay_shot',
    description: [
      '看虚拟屏。frames=1 给一张静态截图；frames>1 连拍几张拼成网格，用来看「在动吗、往哪动、变成什么样」。',
      '',
      'frames=1（默认）：一张截图，能读屏幕上的字和数字。720x1592 竖屏缩到 420 宽约 230 token、540 宽约 377。',
      '',
      'frames>1：抓 N 帧拼成网格，从左到右、从上到下是时间顺序。',
      '九格缩到每格 262 宽后，原图 26px 的字只剩 9px —— 只能看结构、位置、有没有动，读不出小字。',
      '形状会按屏幕真实比例自动算：竖屏画布是竖的，横屏（游戏）画布是横的。',
      '',
      '成本（720x1592 竖屏、9 帧 3x3 实测）：每格 160 → 312 token；180 → 377；200 → 480；262 → 798；300 → 1056。',
      '只想判断动没动用 160-180（312-377 token）；想顺便看清大字用 262（798 token）。',
      '',
      '看不清某个按钮或数字时，用 region 只截那一块 —— 比调大 width 更划算：'
        + '同样 420 宽，局部 1.167x（放大），全屏 0.583x（缩小），而且局部只要 180 token、全屏要 684。',
    ].join('\n'),
    parameters: {
      frames: {
        type: 'integer',
        description: '抓几帧。1（默认）= 单张截图；2/4/6/9/12/16 = 拼成网格。会被规整成能拼成矩形的数。',
      },
      width: {
        type: 'integer',
        description: '每帧宽度。frames=1 时默认 540（读字用）；frames>1 时默认 262（看运动用）。范围 240-720。',
      },
      intervalMs: {
        type: 'integer',
        description: 'frames>1 时的帧间隔毫秒，默认 300。抓快动作调小（最小 0），抓慢变化调大。',
      },
      format: { type: 'string', description: 'frames=1 时有效："jpeg"（默认，省 token）或 "png"。' },
      region: {
        type: 'object',
        description: '只看屏幕的一块：{x,y,w,h}，坐标用显示逻辑像素（跟 x/y 点按同一套坐标）。把这块按 width 交付，等于放大。'
          + '实测：取 360×796 的局部交付到 420 宽，只要 180 token（全屏要 684），而线性分辨率是全屏的 2 倍。'
          + '看不清某个按钮/数字时用这个，比调大 width 划算。',
      },
      crop: {
        type: 'string',
        description: '已废弃，传了也不裁。原因：浏览器壳在顶部还是底部拿不到可靠信号（实测顶部还会有翻译条），'
          + '自动裁会把真实内容切掉。想看细节请用 region。',
      },
      dir: { type: 'string', description: '输出目录，默认 /tmp。' },
    },
    output: out('图片路径、格数、每格大小、是否和上次一样。'),
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
    parameters: {
      dir: { type: 'string', description: '本地保存目录，默认 /tmp。' },
      width: { type: 'integer', description: '输出宽度，默认 540（实测文字仍清晰，token 省约 44%）。范围 240–1080。' },
      format: { type: 'string', description: '"jpeg"（默认，省 token）或 "png"（需要无损时）。' },
    },
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
    parameters: {
      forceStopApps: { type: 'boolean', description: '默认 false。传 true 会 force-stop 投上去过的 App，清掉后台占用；DSH 和 Shizuku 会被自动跳过（杀了会影响用户）。' },
    },
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

export function textSpec() {
  return {
    name: 'vdisplay_text',
    description: [
      '把虚拟屏上的文字识别成文本，带坐标返回。**这是读数字和文字最可靠的方式，而且不花图片 token。**',
      '',
      '什么时候该用：要读屏幕上的数字、金额、时间、列表文字、按钮文字、输入框内容时。',
      '实测：把截图缩成九格后，原图 26px 的字只剩 5px，模型读不出还会编造 —— 所以数字一律走这个工具。',
      '',
      '返回每行文字 + 像素坐标 + 归一化坐标（nx/ny，可直接给 vdisplay_input 点按）+ 置信度。',
      '图像没变化时会直接复用上次结果，不重新识别。',
      '',
      '成本：约 1.6 秒（首次要 3-5 秒加载模型），**0 图片 token**。',
    ].join('\n'),
    parameters: {
      minConf: {
        type: 'number',
        description: '置信度下限，默认 0.45。调高（如 0.8）只留很确定的，调低会带噪声进来。',
      },
      maxLines: {
        type: 'integer',
        description: '最多返回几行，默认 80。屏幕文字多时截断（按从上到下、从左到右）。',
      },
      fresh: {
        type: 'boolean',
        description: '强制重新识别，默认 false（画面没变就复用缓存）。',
      },
    },
    output: out('识别到的文字行（含坐标和置信度）。'),
  };
}

export function appsSpec() {
  return {
    name: 'vdisplay_apps',
    description: [
      '列出手机上的第三方 App（名称 + 包名），投屏前拿来查包名。',
      '',
      '为什么要这个工具：vdisplay_launch 要包名，但之前没有任何工具能告诉你包名是什么，',
      '模型只能靠猜。这个工具补上这一环 —— 列的是 `pm list packages -3`（第三方），',
      '系统应用不列，因为投系统应用基本没意义。',
    ].join('\n'),
    parameters: {},
    output: out('已安装第三方 App 的包名列表。'),
  };
}
