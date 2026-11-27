/** 40 个工具的契约。 */
const out = (d) => ({
  /* **additionalProperties 必须是 true。**
     *
     * 2026-11-27 实测：五个工具（tap_text / probe_secure / live /
     * screen_user_state / screen_risk）被宿主报
     * `value.xxx is not a declared property` —— 因为它们返回了
     * clicked / pageChanged / nx / ny 等结构字段，而这里声明
     * additionalProperties:false 只允许 text。
     *
     * 后果很恶劣：tap_text 点击其实生效了，但工具报错，AI 会重复点。
     *
     * 改成 true：text 仍然是主字段（render 只用它），
     * 但不再拒绝实现返回的结构化字段。
     */
    schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true, description: d } } },
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
            '**给 AI 开一块屏，用这个。**（不要用 screen_new —— 那是多屏池接口，会投错屏）',
      '',
'创建一块用户看不见的私有虚拟屏（headless virtual display），App 可以跑在上面。',
      '',
      '关键性质（都实测过）：不画在物理屏幕上、不抢主屏焦点、不弹输入法。',
      '需要这台机器的 com.android.shell 拥有 ADD_TRUSTED_DISPLAY 权限（一部分机型有，Pixel 默认没有）。',
      '',
        '',
        '**这一条命令就是全套**，不需要再单独调推流：',
        '  ① 建虚拟屏',
        '  ② 自动起推流 + 悬浮窗（用户马上能在屏幕上看到这块屏的画面）',
        '  ③ 自动投一个 App 上去（不指定 pkg 时挑一个不会打断用户的，保证屏上有画面而不是黑框）',
        '  ④ 五项自检并逐项报告证据：屏在系统里存在 / 推流在监听且属于这块屏 / 帧能取到且是合法 JPEG /',
        '     画面有内容（亮度 + 对比度，全白崩溃页会被拦下）/ 悬浮窗在屏幕可见范围内 / 前台 App 就是投的那个',
        '  ⑤ 自检不过时**自动修一次**（只修失败项）再复检，仍不过才报告',
        '全部通过才打印「创建完成并自检通过」。',
        '',
        '想只建屏、不要画面：传 overlay:false。想关自动修复：autoRepair:false。只修指定项：repairOnly:[检查项名]。',
    ].join('\n'),
    parameters: {
      pkg: { type: 'string', description: '可选。建完屏直接把这个包名投上去。不传则自动挑一个不会打断用户的 App（不会 force-stop 你正在用的那个）。' },
      overlay: { type: 'boolean', description: '默认 true（建屏同时起推流和悬浮窗）。传 false 只建屏、不推流 —— 比如 AI 只想后台操作、不想在用户屏幕上出现窗口。' },
      autoRepair: { type: 'boolean', description: '默认 true。自检失败时自动修复一次再复检。传 false 只看自检结果不修。' },
      repairOnly: { type: 'array', description: '只自动修复列出的检查项（比如 ["推流在监听"]），其余失败项不碰。' },
      keepMin: { type: 'integer', description: '**按任务预估后台屏要活多久**（分钟，1~360）。不传沿用当前设定（默认 5）。长任务（挂机/轮询/等转盘）先设大，比如 60；点几下就完的设 3。AI 连续这么多分钟没调工具就自动关闭。' },
      maxFps: {
        type: 'integer',
        description: '视频流帧率上限，默认 60。传 0 表示不限。'
          + '以前没这个参数等于无限帧率，实测 3D 游戏会跑到 145fps，白烧 CPU 和带宽。',
      },
      width: { type: 'integer', description: '宽度，默认 720。' },
      height: { type: 'integer', description: '高度，默认 1280。' },
      dpi: { type: 'integer', description: '密度，默认 320。' },
      orientation: { type: 'string', description: '方向，默认 "auto"（按物理屏比例，最接近真机，推荐）。"auto" 不要改；"landscape"/"portrait" 只交换宽高；"square" 正方形（慎用：16:9 的游戏会按高度算出更宽的画布，右边被裁）'  },
      systemDecorations: { type: 'boolean', description: '默认 false。false 时虚拟屏上不含二级桌面、导航栏和权限弹窗，AI 截图更干净（scrcpy ≥3.1）。改这个值会重建屏。' },
      ime: { type: 'string', description: '虚拟屏的输入法策略。**默认 "hide"，不要随意改。** hide：不占用系统输入法，用户在主屏打字完全不受影响；代价是虚拟屏上打不进中文（剪贴板粘贴依赖 IME 的 InputConnection）。 local：中文能输进去，但**会把系统输入法焦点抢到虚拟屏上** —— 2026-11-22 实测确认：用户正在主屏打字时被打断，键盘跑到了虚拟屏那边。 只有确实需要往虚拟屏的 App 里输中文时才用 local，**用完立刻 stop 重建成 hide**，不要长时间挂着。 更安全的替代：能不让用户看到就不输字，或者先问用户「我要在你的虚拟屏里输中文，可能打断你打字，现在方便吗」。' },
      hwc: { type: 'string', description: '是否让硬件合成器（HWC）参与虚拟屏合成。"auto"（默认）：仅当本机 vendor.display.vds_allow_hwc=1 时自动开启；"on"：强制尝试；"off"：不碰。开启后 3D 游戏（SurfaceView 渲染）能正常出画面，否则全黑。这是全局 SurfaceFlinger 属性，stop 时会恢复原值。' },
    },
    output: out('一段逐项播报：建屏结果、推流和悬浮窗状态、投了哪个 App、五项自检的每项证据、'
      + '自动修复了什么（如果发生了）、最后是「创建完成并自检通过」或哪几项没通过。'),
  };
}

export function edgeSpec() {
  return {
    name: 'vdisplay_edge',
    description: [
      '**只在出事时调这里。** 正常工作和你干完活，插件会自己点亮边缘，不需要你操作。',
      '',
      '这个边是**悬浮窗（用户主屏上那块小窗口）的边框**，不是整个手机屏幕的边。',
      '',
      '## 自动的部分（不要调，调了反而有害）',
      '',
      '  · 你调 input / launch / tap_text / tap_image / tap_color → 自动青色环绕（working）',
      '  · 建屏并自检通过 → 自动绿色横扫（done）',
      '  · 一次连续操作停下来 8 秒 → 自动闪 4 秒绿再收回',
      '',
      '**不要手动设 working 或 done。** 理由不是"没必要"，而是有害：',
      '手动设会解除你已经报过的 critical 的保护，让你自己刚示的警被覆盖掉，',
      '用户看到的是一块"一切正常"的绿灯，而实际问题还在。',
      '',
      '## 只有三种情况必须你调',
      '',
      '  · `warning` —— 遇到阻碍但不致命：验证码、按钮找不到、页面超时',
      '  · `error` —— 明确失败，需要用户介入',
      '  · `critical` —— **可能已经出大事**：风控迹象、账号异常、支付/转账前最后确认、',
      '    任何"再操作下去可能不可逆"的时刻。亮起来就**停止操作等用户看**，不要继续试',
      '',
      '## 报完要收',
      '',
      '  问题解决了调 `state:"idle"`，或者等超时（warning 15 秒 / error 20 秒 / critical **永不自动过期，必须你调 idle 清掉**）。',
      '  你设的 warning/error/critical 有闩锁：过期前自动的 working/done 不会把它盖掉。',
      '',
      '## 颜色和运动都是双编码',
      '',
      '  红绿色盲占男性约 8%，所以每个状态除了颜色不同、运动方式也不同：',
      '  working 青·环绕流动 / done 绿·沿边合拢 / warning 黄·不对称呼吸',
      '  / error 红·双拍脉冲 / critical 深红·低频粗边闪',
    ].join('\n'),
    parameters: {
      state: { type: 'string', description: 'warning / error / critical 三种需要你调；idle 清除；working 和 done 是自动的，不要手动设。' },
      reason: { type: 'string', description: '为什么报这个状态，一句话。会写进日志，用户也能在诊断里看到。' },
      color: { type: 'string', description: '可选，一般不用传 —— 颜色就是语义，覆盖它会让用户学到的映射失效。' },
      intensity: { type: 'number', description: '可选，0~1，光效强度。默认 1。想让提示轻一点可以给 0.5。' },
      ttlSec: { type: 'number', description: '可选，多少秒后自动恢复。不传用默认值（warning 15 / error 20；critical 永不自动过期）。' },
    },
    output: out('确认了哪个状态、用了什么颜色、多久后自动恢复。'),
  };
}

export function launchSpec() {
  return {
    name: 'vdisplay_launch',
    description: [
      '把一个 App 投到虚拟屏上，而不是主屏。',
      '',
      '**默认是「接管」不是「重开」**：不 force-stop，用 am start --display 让系统',
      '把已有任务搬过去（AOSP 的 findTask 会遍历所有显示器找已有任务，找到就 reparent）。',
      '实测 2026-11-24：Edge 的 86 个标签、同一个 task ID、同一个进程全程没变 ——',
      '用户说的「后台开过的 app 不需要重开」就是这个机制。',
      '',
      '只有目标 App 正在**主屏前台**时会被拒绝（投过去等于把它从用户眼前搬走）。',
      '如果 App 状态确实坏了，传 mode:"fresh" 强制重开（会杀掉主屏那个实例）。',
      '',
      '投完会校验并报告主屏焦点变没变，但**不会自动还原** —— 自动还原会误判',
      '（用户自己切了 App 时插件反而去改主屏），所以只观察、只报告，由你决定要不要处理。',
    ].join('\n'),
    parameters: {
      pkg: { type: 'string', required: true, description: '包名，例如 com.tencent.mm。' },
      mode: {
        type: 'string',
        description: '投屏方式。move（默认）= 接管已有实例，不 force-stop，进程和状态保住；'
          + 'fresh = 强制重开（会杀掉主屏那个实例）。'
          + '不确定就用默认，只有 App 状态坏了才用 fresh。',
      },
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
      kind: { type: 'string', required: true, description: 'tap | swipe | hold | text | key | paste。hold = 按住不动（游戏摇杆/长按/挖方块），60Hz 连续 MOVE，实测可用。multitouch = 双指（一根按住 + 另一根滑动），实测可用 —— 游戏边走路边转视角、双指缩放。参数用 p1/p2/p2To。' },
      /* **声明这次操作的意图，用来对照 App 的 forbid 列表。**
       *
       * 2026-11-28 对抗审查指出：按等级拦会拦错对象 ——
       * risk.json 里 L4 是游戏/抢购，银行反而在 L3。
       * 真正该拦的是 forbid 里的 pay/write/login/face。
       *
       * 不传 intent 时，对有 forbid 的包**默认当 write**（严格优先）。
       */
      intent: { type: 'string', description: 'read | write | pay | login | face。read = 只翻页/看内容；write = 会改数据；pay = 付钱；login = 登录；face = 人脸。不传时按 write 处理（严格）。' },
      ms: { type: 'integer', description: '时长毫秒。swipe 默认 300；hold 默认 1000（按住的时长）；multitouch 默认 600。' },
      p1: { type: 'object', additionalProperties: false, properties: { nx: { type: 'number', description: '第一指 x 0-1' }, ny: { type: 'number', description: '第一指 y 0-1' } }, description: 'multitouch：第一指位置（通常是摇杆，按住不动）' },
      p2: { type: 'object', additionalProperties: false, properties: { nx: { type: 'number' }, ny: { type: 'number' } }, description: 'multitouch：第二指起点（通常是视角滑动起点）' },
      p2To: { type: 'object', additionalProperties: false, properties: { nx: { type: 'number' }, ny: { type: 'number' } }, description: 'multitouch：第二指终点。省略则第二指不动' },
      jitter: { type: 'integer', description: 'hold：手指位置抖动幅度（逻辑像素），默认 2。真按不会绝对静止，设 0 会变成机器特征。' },
      driftX: { type: 'integer', description: 'hold：按住期间缓慢横向漂移（逻辑像素），默认 0。摇杆往右推就设正数（比如 40）。' },
      driftY: { type: 'integer', description: 'hold：按住期间缓慢纵向漂移，默认 0。摇杆往前推设负数（屏幕坐标 y 向下）。' },
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
        // **必须显式声明 additionalProperties**，否则宿主拒绝整个工具的注册：
        //   register failed: unsupported JSON schema:
        //   parameters.region.additionalProperties must be explicitly true or false
        // 诊断日志 dsh-app/diagnostics.md:62 和 :122 两次报过这个。
        // 后果：vdisplay_shot 这个核心工具一直没注册上，工具列表里少一个。
        additionalProperties: false,
        properties: {
          x: { type: 'integer', description: '左上角 x（显示逻辑像素）' },
          y: { type: 'integer', description: '左上角 y' },
          w: { type: 'integer', description: '宽' },
          h: { type: 'integer', description: '高' },
        },
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
      '把虚拟屏的画面推给悬浮窗 / DSH Go 的「AI 画面」胶囊。',
      '',
      '**这一步可以当第一步用**：没有屏它会自己建一块，然后连带起推流和悬浮窗，',
      '一次调用完成「建屏 + 投画面 + 弹窗」。所以新环境里想给用户看画面，直接调这个就行。',
      '',
      '**反过来也一样**：vdisplay_start / screen_new 建屏时会自动调这个工具',
      '（除非显式传 overlay:false），所以你不需要「先建屏再单独开推流」。',
      '',
      '**没开推流的屏是无头的**：屏建出来了，但没有任何输出通道，',
      '用户看不到、悬浮窗不会出现、你也只能靠 vdisplay_shot 读帧。',
      '',
      '用户点它就能实时看到 AI 在操作什么。',
      '',
      '实测成本：360x640 @2fps 约 0.30 核、29 KB/s，全程不写任何文件。帧率上限 15fps。',
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

export function poolSpec() {
  return {
    name: 'screen_pool',
    description: [
      '看当前有几块后台屏、哪块是活动屏。',
      '',
      '后台屏是这么回事：每个会话可以有自己的屏，屏上跑自己的 App，互不干扰。',
      '实测两块屏可以同时跑不同 App（一块设置、一块文件管理器），切换不打扰对方。',
      '',
      '注意：**所有 vdisplay_* 操作作用在「活动屏」上**，切换用 screen_use。',
    ].join('\n'),
    parameters: {},
    output: out('屏列表、活动屏、每块的 displayId 和 dpi。'),
  };
}

export function newScreenSpec() {
  return {
    name: 'screen_new',
    description: [
      '**⚠️ 大多数人不需要这个 —— 想「给 AI 开一块屏」请用 vdisplay_start。**',
      '',
      '这套 screen_* 是**多屏池**接口：同时开好几块屏、每块跑不同 App、',
      '多 AI 各自占一块时用。日常操作（开一块屏、投 App、截图、点击）全部走',
      'vdisplay_start / vdisplay_launch / vdisplay_shot / vdisplay_input。',
      '',
      '**两套接口的区别**：',
      '  · vdisplay_* —— 只有一块「活动屏」，后面所有 vdisplay 工具都作用于它。简单够用。',
      '  · screen_*   —— 屏池，每块屏有 screenId，要用 screen_use 切换活动屏。',
      '',
      '**混用的后果**（2026-11-26 实测）：screen_new 建了池屏，接着调 vdisplay_launch',
      '投到的是「活动屏」而不是刚建的那块 → App 投错地方、屏是黑的、像插件坏了。',
      '',
      '真要用多屏时：每块屏约 75-185MB 内存，实测两块很轻松。',
    ].join('\n'),
    parameters: {
      orientation: { type: 'string', description: '"portrait" / "landscape" / "square"。省略（默认 auto）按物理屏比例，最接近真机，推荐不要指定。**square 不推荐**：16:9 的游戏会按高度算出更宽的画布，右边被裁。' },
      hwc: { type: 'string', description: '"auto"（默认）/"on"/"off"。3D 游戏要开。' },
    },
    output: out('新建屏的 screenId、displayId、dpi。'),
  };
}

export function useScreenSpec() {
  return {
    name: 'screen_use',
    description: [
      '切换活动屏。之后所有 vdisplay_* 操作都作用在这块屏上。',
      '',
      '**日常不需要这个。** 只有真的要在同一时刻跑多块屏时才用（比如两个 App 各自独立）。',
      ' 单屏场景直接用 vdisplay_start，别走这里 —— 走了会额外多一层 screenId 管理。',
      '切回来不会打扰另一块屏上的 App —— 实测各自状态都保留。',
    ].join('\n'),
    parameters: {
      screenId: { type: 'string', required: true, description: 'screenId，比如 "sd-1"。来自 screen_new 或 screen_pool。' },
    },
    output: out('切换结果。'),
  };
}

export function closeScreenSpec() {
  return {
    name: 'screen_close',
    description: [
      '销毁一块后台屏，释放它的内存和上面的 App。',
      '',
      '注意：**屏一销毁，上面的 App 就没了**，下次要用得重新投。',
      '如果只是想切走，用 screen_use，不用关屏。',
    ].join('\n'),
    parameters: {
      screenId: { type: 'string', required: true, description: '要销毁的 screenId。' },
      forceStopApps: { type: 'boolean', description: '默认 false。true 时同时 force-stop 屏上的 App。' },
    },
    output: out('销毁结果。'),
  };
}

export function checkAppSpec() {
  return {
    name: 'screen_check_app',
    description: [
      '查某个 App 现在被谁占着 —— 主屏用户在用它？还是别的屏上的 AI 在用？还是没人用？',
      '',
      '投屏前先查这个，避免把人正在用的 App 抢走（实测：`am start --display` 对',
      'singleTask 的 App 会把主屏任务直接搬走，用户那一下就没了）。',
      '',
      '返回等级：FREE 没人用 / USER_BG 用户主屏后台有 / USER_ACTIVE 用户正在看着',
      '（**绝对不能碰**）/ AI_HELD 在我们自己屏上 / FOREIGN 外来屏（不碰）。',
    ].join('\n'),
    parameters: {
      pkg: { type: 'string', required: true, description: '包名，比如 "com.android.settings"。用 vdisplay_apps 查。' },
    },
    output: out('占用等级和详细情况。'),
  };
}

export function claimAppSpec() {
  return {
    name: 'screen_claim_app',
    description: [
      '申请占用一个 App。拿到了才能安全地在它上面操作，别人再申请会失败。',
      '',
      '**默认不抢占**（onConflict 默认 fail）。这是故意的：默认抢占会让多 AI 互相抢，',
      '默认失败才逼出「先查再决定」。',
      '',
      '三种冲突处理：',
      "  fail    直接失败，告诉你谁占着（默认）",
      "  wait    返回还要等多久",
      "  preempt 强制接管 —— 原持有者下次调用会收到撤销通知",
      '',
      '**重要**：宽限期只有 5 秒，而一轮 AI 往返 6-9 秒，所以「让原持有者体面收尾」',
      '在物理上做不到。preempt 能保证的只有「它不会继续误操作」。',
      '',
      '登录、支付、发送这类操作请传 preemptible:false，别人就抢不走了。',
    ].join('\n'),
    parameters: {
      pkg: { type: 'string', required: true, description: '包名。用 vdisplay_apps 查。' },
      onConflict: { type: 'string', description: "'fail'（默认）/ 'wait' / 'preempt'" },
      preemptible: { type: 'boolean', description: '默认 true。设 false 表示谁都抢不走（登录取证、支付中）。' },
      nonPreemptibleReason: { type: 'string', description: 'preemptible:false 时说明原因，比如"正在登录"。' },
      priority: { type: 'string', description: "'user' / 'agent'（默认）/ 'subagent'。高优先级能抢低的。" },
      ttlSec: { type: 'integer', description: '租约时长秒数，默认 600（10 分钟）。' },
      mode: { type: 'string', description: "'exclusive'（默认）/ 'readonly'" },
    },
    output: out('租约信息，或者冲突详情。'),
  };
}

export function releaseAppSpec() {
  return {
    name: 'screen_release_app',
    description: [
      '释放 App 占用。干完了主动放，别人就能用了。',
      '',
      '不传 leaseId 时释放自己持有的全部租约。',
    ].join('\n'),
    parameters: {
      leaseId: { type: 'string', description: '要释放的租约 id。省略则释放当前会话全部的。' },
    },
    output: out('释放结果。'),
  };
}

export function leasesSpec() {
  return {
    name: 'screen_leases',
    description: '看当前所有 App 占用凭证（谁占着什么、还剩多久、能不能抢）。',
    parameters: {},
    output: out('租约列表。'),
  };
}

/* ============================================================
 * 感知层工具定义（2026-11-16）
 *
 * 对应的实现在 tools.js：live / liveShot / waitStable / roi / probeSecure。
 * 这些能力在 vd.js 里已经真机验证过，之前只是没暴露给工具层。
 * ============================================================ */

export function liveSpec() {
  return {
    name: 'vdisplay_live',
    description: [
      '视频流的常驻解码器：启动 / 停止 / 看状态。',
      '',
      '为什么值得开：常驻之后读一帧是内存拷贝（<1ms）；不开的话每次都要按需解码（约 244ms）。',
      '',
      '**重要限制**：scrcpy 只在画面变化时发帧。画面静止时一个包都不发，读不到画面是正常的。',
      '要一张确定的静止帧，用 vdisplay_shot（走 screencap）。',
      '',
      '实测：GIF/动画能跑 60fps；但**视频（MediaCodec 输出）在虚拟屏上不刷新**，别指望它看视频。',
    ].join('\n'),
    parameters: {
      action: { type: 'string', description: '"start" | "stop" | "status"（默认 status）' },
      quality: { type: 'integer', description: 'start 时的 MJPEG 质量 2-31，默认 5（越小越好）。' },
    },
    output: out('解码器状态、流宽高、帧数、实测 fps。'),
  };
}

export function liveShotSpec() {
  return {
    name: 'vdisplay_live_shot',
    description: [
      '从视频流里取一张最新帧（比 vdisplay_shot 快得多）。',
      '',
      '前提两条：① 先 vdisplay_live action=start；② 画面要动（静止屏收不到帧）。',
      '满足不了就回退到 vdisplay_shot。',
      '',
      '实测：常驻解码后读一帧 <1ms，按需解码约 244ms，screencap 约 143ms。',
    ].join('\n'),
    parameters: {
      width: { type: 'integer', description: '缩放宽度，0=原生 720。默认 0。' },
      dir: { type: 'string', description: '输出目录，默认 /tmp。' },
    },
    output: out('图片路径、宽高、来源（persistent-decoder / on-demand）、帧龄、实测 fps。'),
  };
}

export function waitStableSpec() {
  return {
    name: 'vdisplay_wait_stable',
    description: [
      '等画面稳定下来再继续（替代固定 sleep）。',
      '',
      '用 32×32 灰度信号判断：连续 stableMs 内变化量低于阈值才算稳。',
      '实测滑动后 121-182ms 就稳了，比固定 sleep(500) 快约 300ms，而且截图不会撞上转场中间态。',
      '',
      '典型用法：vdisplay_input 之后调它，再 vdisplay_shot。',
    ].join('\n'),
    parameters: {
      stableMs: { type: 'integer', description: '要连续稳多久才算稳，默认 120ms。' },
      maxWaitMs: { type: 'integer', description: '最多等多久，超了就用当前帧，默认 2500。' },
      threshold: { type: 'number', description: 'tailMad 低于它算稳，默认 0.5（滑动时 8-9，静止 0）。' },
    },
    output: out('等了多久、是否稳定、当前变化量。'),
  };
}

export function roiSpec() {
  return {
    name: 'vdisplay_roi',
    description: [
      '自动挑一块值得看的区域，拿去做局部放大。',
      '',
      '为什么有用：token 按 ⌈宽/42⌉×⌈高/42⌉ 计费，小于 544² 按地板价收。',
      '所以同样一笔 169 token，裁 420 见方是 1:1 像素，全屏缩到 420 宽只有 0.58x —— 清晰度差近 2 倍。',
      '',
      '区域怎么选：灰度变化包围盒 → 太大就用变化热力图挑最密集的 544² 子区 → 实在没有就用最近点击位置兜底。',
      '',
      '返回的 region 直接传给 vdisplay_shot 的 region 参数。',
    ].join('\n'),
    parameters: {
      outputWidth: { type: 'integer', description: '打算输出的宽度，默认 544。注意 544 以下都是地板价 169，所以 544 比 420 同价多看 68% 面积。' },
      minArea: { type: 'number', description: '区域至少占整屏多少，默认 0.04。太小没信息量。' },
    },
    output: out('region（x/y/w/h）、来源（sensor-bbox / sensor-bbox+hotspot / last-input）、占屏面积。'),
  };
}

export function probeSecureSpec() {
  return {
    name: 'vdisplay_probe_secure',
    description: [
      '黑屏探针：判断这块屏上的内容是不是抓不到（FLAG_SECURE）。',
      '',
      'FLAG_SECURE 是 Android 对受保护内容的保护：任何截屏 API 拿到的都是纯黑，',
      'screencap / 视频流 / MediaProjection 全一样。**这是无 root 的硬边界，绕不过去。**',
      '',
      '判定：',
      '  A  正常出画',
      '  B? 疑似受保护（上半黑、下半可读）—— 会再用 dumpsys 的 FLAG_SECURE 窗口数复核',
      '  C  整屏黑 —— App 拒绝在虚拟屏渲染，或者没起来',
      '  A? 原本疑似但复核为不是受保护（通常是底部弹窗造成的误报）',
      '',
      '投屏之后建议先跑一次，能提前知道这条线能不能做。',
    ].join('\n'),
    parameters: {
      dir: { type: 'string', description: '截图输出目录，默认 /tmp。' },
    },
    output: out('verdict、置信度、判定理由、上下半亮度、dumpsys 里的 FLAG_SECURE 窗口数。'),
  };
}

/**
 * 查用户是否正在用手机。
 *
 * 这是把 `tools/user-busy.sh` 的判据变成工具 —— 那个脚本是对的，但不在工具链路里，
 * 所以模型不知道要调它。2026-11-17 抢键盘事故就是没查这个。
 */
export function userStateSpec() {
  return {
    name: 'screen_user_state',
    description: [
      '查「用户现在在用手机吗」。**动主屏之前必须先调它。**',
      '',
      '判据：前台是 DSH Go（用户正在跟 AI 对话）或输入法正在显示（用户可能在打字）→ BUSY。',
      '',
      '为什么要有：`am start` / `mcp__phone__open` 会让新窗口成为焦点，',
      '输入法的 InputConnection 从用户的输入框 detach —— 键盘被抢走、半截草稿丢失。',
      '更危险的是 `input text` 会把文字拼进用户草稿，`input keyevent 66` 可能把草稿发出去。',
      '',
      '返回 BUSY 时改走：虚拟屏（vdisplay_*）、浏览器 CDP（web_*），或等用户停下来。',
    ].join('\n'),
    parameters: {},
    output: out('BUSY/IDLE 判定、前台包名、输入法状态。'),
  };
}

/** 查某个 App 的风控等级（读 docs/risk.json，44 个 App 已标注）。 */
export function returnSpec() {
  return {
    name: 'vdisplay_return',
    description: [
      '**把一个 App 从虚拟屏还回主屏，但不拉到前台。**',
      '',
      '用 `am start --display 0` 直接还回去会把 App 顶到用户面前，打断他正在做的事。',
      '这个工具会记下用户原来的前台 App，搬完立刻把它拉回来 —— 目标 App 落在主屏后台。',
      '',
      '什么时候用：任务做完了，把投上去的 App 还给用户（比如浏览器），',
      '让他自己决定什么时候点开，而不是啪一下糊在他脸上。',
    ].join('\n'),
    parameters: {
      pkg: { type: 'string', required: true, description: '包名，比如 com.microsoft.emmx' },
      activity: { type: 'string', description: '可选。不传会自动查启动入口。' },
    },
    output: { text: 'string' },
  };
}

export function uiSpec() {
  return {
    name: 'vdisplay_ui',
    description: [
      '**⚠️ 2026-11-26 实测：这个工具不稳定，空返回别当成「没有控件」。**',
      '',
      '同一块屏（虚拟屏上跑原生计算器）连调三次：第一次返回「没找到 activity」，',
      '第二三次正常返回 `com.android.calculator2/.Calculator` 和 151 个控件。',
      '原因是 `dumpsys activity top` 要 dump 所有屏的顶层 activity，',
      '其中任何一个卡住就会整条命令超时或被截断（实测输出里有',
      '`Failure while dumping the activity: IOException: Timeout`）。',
      '',
      '**所以：空返回先重试一次**，别立刻判定「这屏是自绘 UI」。',
      '重试还是空，再退回 OCR / 截图。',
      '',
      '**识别优先级**：`vdisplay_text`（OCR，快且稳）→ `vdisplay_shot`（看图）→ 这个（有控件 id 时最准）。',
      '',
      '---',
      '',
      '',
      '实测：本工具 261ms，`vdisplay_text`（OCR）2000ms+。',
      '返回每个控件的类名、id、文字、中心坐标、宽高、是否可点。',
      '坐标直接就是中心点，可以原样传给 `vdisplay_input` 的 x/y。',
      '',
      '**什么时候用**：',
      '  · 要找按钮/输入框/列表项 → 先调这个，别用 OCR 硬猜',
      '  · 要点某个有 id 或文字的控件 → 从返回里挑，比截图认字准得多',
      '  · 判断页面加载完没 → 看 activity 名变没变',
      '',
      '**什么时候它没用**（会自动提示你退回去）：',
      '  · 游戏、Flutter、Unity、自绘 UI —— 控件树是空的或只有一层壳',
      '  · 这时候用 `vdisplay_text`（OCR）或 `vdisplay_shot`（看图）',
      '',
      '原理：`dumpsys activity top` 的输出带 displayId，能按虚拟屏过滤；',
      '**不需要无障碍权限**（`uiautomator dump` 在很多 ROM 上被禁，这条路能走）。',
    ].join('\n'),
    parameters: {
      displayId: { type: 'number', description: '可选。不传就用当前活动虚拟屏。' },
      onlyClickable: { type: 'boolean', description: '可选。只要可点击的控件，列表更短。' },
      limit: { type: 'number', description: '可选。最多列几个，默认 60。' },
    },
    output: { text: 'string' },
  };
}

export function windowStateSpec() {
  return {
    name: 'vdisplay_window',
    description: [
      '**查悬浮窗现在的状态：还在不在、最小化没有、在哪、多大。**',
      '',
      '为什么需要：用户经常把浮窗最小化来少挡主屏。以前插件不知道最小化和「窗口没了」的区别，',
      '调工具看到没窗口就以为要重建 —— 其实用户只是收起来了。',
      '',
      '返回里关键看两个字段：',
      '  · collapsed=true  → 用户缩到最小了，**不要去展开或重建**，它还在正常工作',
      '  · shown=false     → 被系统或某个 App 藏了（比如文件管理器带 HIDE_NON_SYSTEM_OVERLAY）',
      '',
      '什么时候调：不确定浮窗状态时；用户说「浮窗不见了」时先调这个再决定要不要重建。',
    ].join('\n'),
    parameters: {
      port: { type: 'number', description: '可选。不传就查第一个浮窗。' },
    },
    output: { text: 'string' },
  };
}

export function riskSetSpec() {
  return {
    name: 'vdisplay_risk',
    description: [
      '**告诉插件「这个 App 该按什么风控等级、什么方式操作」。**',
      '',
      '为什么需要你来定：插件只会查表，查不到就瞎猜 —— 之前一个计算器显示「风控 高」，',
      '用户被误导。**判断是判断力的事，不是查表的事。**',
      '',
      '你可以在下列方式里选，注意风险：',
      '  · 上网查这个 App 有没有实名/支付/风控机制',
      '  · 按 App 类型推理（银行/支付/政务 → L4；社交电商 → L3；工具类 → L0-L1）',
      '  · 小规模试一次看有没有验证码（**有风险**，可能触发风控，自己权衡）',
      '',
      '结论通过本工具告诉插件，浮窗会显示你给的等级。判断不了就传 level:"?"。',
    ].join('\n'),
    parameters: {
      pkg: { type: 'string', required: true, description: '包名，例如 com.tencent.mm' },
      level: {
        type: 'string',
        required: true,
        description: 'L0..L5 或 0..5，或 ?（判断不了）。'
          + ' L0 无风控 / L1 轻微 / L2 中等 / L3 严格（只读）/ L4 禁止（银行支付）/ L5 硬边界。',
      },
      mode: {
        type: 'string',
        description: '操作方式，比如「只读观察」「拟人点击」「先问用户」。会显示在浮窗上。',
      },
      reason: {
        type: 'string',
        description: '依据，一句话。比如「银行类，实名+支付，只能交给人」。',
      },
    },
    output: { text: 'string' },
  };
}

export function riskCheckSpec() {
  return {
    name: 'screen_risk',
    description: [
      '查某个 App 的风控等级，决定能用什么操作方式。',
      '',
      'L0 无风控 → 随便操作；L1 控制频率；L2 拟人化；',
      'L3 严格 → 只读，写操作必须问用户；L4 银行/支付 → 只能交给人；L5 技术做不到。',
      '',
      '**操作微信/支付宝/银行/游戏之前先查这个。** 未知 App 按 L3 处理。',
    ].join('\n'),
    parameters: {
      pkg: { type: 'string', required: true, description: '包名，比如 com.tencent.mm。不知道包名先用 vdisplay_apps 查。' },
    },
    output: out('风控等级、中文名、禁止动作列表。'),
  };
}

/**
 * 按文字找位置。
 *
 * 现在模型是「看 OCR 返回的一堆 nx/ny，自己挑坐标去点」—— 这个环节容易点空。
 * （曾经写过「17.6%」，但那个数字的推导有误，已作废；现在不引用具体比例。）
 * 这两个工具把「找文字 → 算坐标」交给代码，模型不碰坐标。
 */
export function findTextSpec() {
  return {
    name: 'vdisplay_find',
    description: [
      '在虚拟屏上找文字，返回坐标（不点击）。',
      '',
      '**比让模型自己看 OCR 坐标再算要准得多** —— 模型自己算坐标是主要的点空来源（这个比例没有可靠测量，别引用具体数字）。',
      '',
      '匹配规则：默认「包含」（找「蓝牙」→ 「蓝牙 已开启」也算命中）；',
      'mode=exact 精确匹配；mode=regex 正则。多个命中时默认取最靠上的，用 nth 指定第几个。',
      '',
      '没找到会给「相近的文字」建议，方便你换词重试。',
      '',
      '要直接点，用 vdisplay_tap_text —— 它一步完成找+点。',
    ].join('\n'),
    parameters: {
      text: { type: 'string', required: true, description: '要找的文字，比如「蓝牙」「立即购买」' },
      mode: { type: 'string', description: 'contains（默认）| exact | regex' },
      nth: { type: 'integer', description: '多个命中时取第几个，从 0 开始，默认 0（最靠上的）' },
      minConf: { type: 'number', description: 'OCR 置信度下限，默认 0.4' },
    },
    output: out('找到几处、目标坐标 nx/ny、命中文字。'),
  };
}

/** 找到文字并点击 —— 一步完成，模型不碰坐标。 */
export function tapTextSpec() {
  return {
    name: 'vdisplay_tap_text',
    description: [
      '找到文字并点击它。**这是最可靠的点击方式，优先用它代替自己算坐标。**',
      '',
      '一步完成：OCR 找文字 → 算中心坐标 → 注入点击 → 校验。',
      '模型只需要说要找什么，不需要看坐标。',
      '',
      '实测价值：模型自己看 OCR 坐标去点容易偏，这个工具把「自己算坐标」那个环节消掉。',
    ].join('\n'),
    parameters: {
      text: { type: 'string', required: true, description: '要点的文字，比如「立即购买」「确定」' },
      mode: { type: 'string', description: 'contains（默认）| exact | regex' },
      nth: { type: 'integer', description: '多个命中时点第几个，从 0 开始' },
      verify: { type: 'boolean', description: '点击后校验画面有没有变化，默认 true' },
    },
    output: out('点到了什么、坐标、校验结果。'),
  };
}

/** 调整后台屏的空闲超时 —— 让 AI 按任务预估生命周期。 */
export function keepAliveSpec() {
  return {
    name: 'screen_keepalive',
    description: [
      '**⚠️ 这个工具目前只做「标记 + 日志」，不会真的自动关屏。**',
      '  （2026-11-26 核对源码：看门狗到点只打一行 console.error，不销毁屏。）',
      '  **省电要自己调 `vdisplay_stop`** —— 不调的话屏会一直开着占内存和电。',
      '',
      '原本的设计意图：设定「AI 停止操作多久后自动关掉后台屏」，让 AI 按任务预估生命周期。',
      '',
      '**开始长任务前先调它**：挂机、等转盘、轮询消息、玩需要时间累积的游戏 → 设大（30-360 分钟）；',
      '点几下就完的短任务 → 设小（2-5 分钟），省电更彻底。',
      '',
      '判据是「AI 连续 N 分钟没有调用任何工具」。**任何工具调用都会重置计时**，',
      '所以只要还在操作就不会被关；真闲着时才关。',
      '',
      '默认 5 分钟。范围 1~360 分钟。',
      '',
      '为什么需要它：实测后台屏不关时 framesrv 持续 10.3% CPU。',
      '设太短会在思考时被关掉，设太长会白白耗电 —— 按任务估是唯一正确的做法。',
    ].join('\n'),
    parameters: {
      minutes: { type: 'integer', required: true, description: '空闲多少分钟后自动关闭，1~360。短任务 2-5，长任务 30-360。' },
    },
    output: out('新的超时设定和含义。'),
  };
}

/** 模板匹配找图 —— 找「没有文字的东西」的唯一快路。 */
export function findImageSpec() {
  return {
    name: 'vdisplay_find_image',
    description: [
      '用模板匹配找图上的图案（不点击）。**这是找「没有文字的东西」的唯一快速方法。**',
      '',
      '适合：图标、开关、返回箭头、技能格、红心、血条、准星、任何纯图形元素。',
      'OCR 读不到这些（它们没有文字），而模板匹配实测只要 **5-30ms**（OCR 是 1600ms）。',
      '',
      '怎么用：**用 vdisplay_shot({format:\'png\'}) 截原分辨率**，把要反复找的那块裁出来存成 PNG。',
      '（默认的 540 宽 JPEG 会得到小 25% 的模板 —— 虽然工具默认多尺度能兜住，但原分辨率更稳。）',
      '模板要选「有特征」的一块：纯色块能匹配（自动切 SQDIFF），有一点纹理更稳，纯黑不行。',
      '',
      '找不到时可以：调低 threshold（0.6-0.7）、换一块更清晰的模板、或改用 vdisplay_find（找文字）。',
    ].join('\n'),
    parameters: {
      template: { type: 'string', required: true, description: '模板图片路径（PNG/JPG，在设备可读的文件系统上）' },
      threshold: { type: 'number', description: '匹配阈值 0-1，默认 0.75。低了误报多，高了漏检' },
      scales: { type: 'array', items: { type: 'number' }, description: '多尺度搜（默认 0.55~1.5 共 8 档）。模板大小和屏幕不一致时靠这个兜住。只在已知精确比例时手动传' },
      region: { type: 'object', additionalProperties: false, properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } }, description: '只在屏幕这一块里找（省时间，也能避免找错地方）' },
    },
    output: out('找到没、score、屏幕坐标、中心 nx/ny。'),
  };
}

/** 找到图并点它。 */
export function tapImageSpec() {
  return {
    name: 'vdisplay_tap_image',
    description: [
      '用模板匹配找到图案并点击它。一步完成找+点，适合点图标类的东西。',
      '',
      '有文字的东西用 vdisplay_tap_text（更准），没文字的东西用这个。',
    ].join('\n'),
    parameters: {
      template: { type: 'string', required: true, description: '模板图片路径' },
      threshold: { type: 'number', description: '匹配阈值，默认 0.75' },
      region: { type: 'object', additionalProperties: false, properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } }, description: '只在这块里找' },
    },
    output: out('点到了没、坐标、匹配分数。'),
  };
}

/** 界面指纹。 */
export function fingerprintSpec() {
  return {
    name: 'vdisplay_fingerprint',
    description: [
      '算当前界面的 64 位指纹，用来判断「还是不是同一个界面」。',
      '',
      '比截图比对便宜（7ms vs 143ms），比 OCR 可靠（不依赖文字 —— 游戏/图片界面也能用）。',
      '两次调用会给出汉明距离：0 = 完全相同，≤10 = 同一界面，>10 = 不同界面。',
      '',
      '用途：判断操作有没有生效、判断页面跳转了没、给方法缓存做键。',
    ].join('\n'),
    parameters: {
      key: { type: 'string', description: '独立记录的槽位名，默认 default。不同任务用不同 key，互不干扰' },
    },
    output: out('指纹、和上次的汉明距离、是否变了界面。'),
  };
}

/** 屏幕差异。 */
export function screenDiffSpec() {
  return {
    name: 'vdisplay_diff',
    description: [
      '算当前画面和上一次的差异（MAD + 最大格差）。',
      '',
      '**maxCell 是关键**：全局 MAD 会被大片静态背景稀释 —— 一个数字变了，MAD 可能只有 0.0012',
      '但 maxCell 有 0.31。只看 MAD 会漏掉小区域变化。',
      '',
      '第一次调用只记录，第二次起才给差异。用来判断「我这一下操作到底有没有生效」。',
    ].join('\n'),
    parameters: {
      before: { type: 'string', description: '指定「之前的图」路径。省略则自动和上一张比' },
    },
    output: out('MAD、maxCell、变没变。'),
  };
}

/** 界面方法探测。 */
export function probeScreenSpec() {
  return {
    name: 'vdisplay_probe',
    description: [
      '探测当前界面适合用什么识别方法，并给出建议。',
      '',
      '量三个东西：边缘密度（5-18% 适合形状/模板）、颜色集中度（色数少才好用）、亮度和对比。',
      '',
      '**什么时候调**：第一次操作某个 App 时先探一次，之后按建议选方法 ——',
      '文字多的界面用 OCR，图形界面用模板匹配，纯色状态用颜色检测。',
      '',
      '也用来识别「画面是不是空白」（FLAG_SECURE 或者还没加载完）。',
    ].join('\n'),
    parameters: {},
    output: out('边缘/颜色/亮度统计 + 方法建议。'),
  };
}

/** 按颜色找色块。 */
export function findColorSpec() {
  return {
    name: 'vdisplay_find_color',
    description: [
      '按颜色找色块（颜色阈值 + 连通域）。找**固定颜色**的东西。',
      '',
      '适合：血条（红/绿）、按钮底色、选中边框、小地图上的敌我点、进度条、生命值/魔法值。',
      '',
      '**和模板匹配的分工**：模板找「形状固定但颜色会变」的（图标）；',
      '颜色找「颜色固定但位置/长度会变」的（血条、点位）。',
      '',
      '内部用 Lab 的 a/b 通道而不是绝对 RGB —— 实测 HDR/色温偏移下 RGB 阈值会全失效。',
      '耗时 6.8ms（实测）。',
    ].join('\n'),
    parameters: {
      color: { type: 'object', additionalProperties: false, properties: { r: { type: 'integer', description: '红 0-255（给了 r/g/b 就不用 l/a/b）' }, g: { type: 'integer' }, b: { type: 'integer' }, l: { type: 'integer', description: 'Lab 亮度 0-255' }, a: { type: 'integer', description: 'Lab a 通道（绿-红）' }, b2: { type: 'integer' } }, required: true, description: '目标颜色。{r,g,b} 或 {l,a,b}' },
      tolerance: { type: 'integer', description: 'Lab 空间容差，默认 20。找不到就调大（30-50）' },
      minArea: { type: 'integer', description: '最小色块面积（像素），默认 200。小目标调小（50）' },
      region: { type: 'object', additionalProperties: false, properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } }, description: '只在这块里找' },
    },
    output: out('找到几个色块、每个的位置和面积、最大的那个。'),
  };
}

/** 找颜色并点最大色块。 */
export function tapColorSpec() {
  return {
    name: 'vdisplay_tap_color',
    description: '按颜色找到最大色块并点击它。适合点「纯色按钮」「纯色图标」。',
    parameters: {
      color: { type: 'object', additionalProperties: false, properties: { r: { type: 'integer' }, g: { type: 'integer' }, b: { type: 'integer' }, l: { type: 'integer' }, a: { type: 'integer' }, b2: { type: 'integer' } }, required: true, description: '目标颜色 {r,g,b} 或 {l,a,b}' },
      tolerance: { type: 'integer', description: 'Lab 容差，默认 20' },
      minArea: { type: 'integer', description: '最小面积，默认 200' },
      region: { type: 'object', additionalProperties: false, properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } }, description: '只在这块里找' },
    },
    output: out('点到没、坐标、色块大小。'),
  };
}

/** 自动判断该用什么识别方法。 */
export function chooseMethodSpec() {
  return {
    name: 'vdisplay_choose_method',
    description: [
      '**第一次操作某个界面时先调这个** —— 它会量一下这个界面，告诉你该用什么识别方法。',
      '',
      '工具多了（OCR / 模板 / 颜色 / 指纹 / 差分），不知道该用哪个时用它。',
      '它测三个东西并给出排序建议：',
      '  · 边缘密度 5-18% + 对比够 → 模板匹配（5.7ms）',
      '  · 颜色 top5 占比高 + 色数少 → 颜色检测（6.8ms）',
      '  · 文字界面 → OCR（1.9-3.3s，唯一能读懂内容的）',
      '',
      '**结果会按界面指纹缓存** —— 同一个界面第二次问直接返回，省 100ms。',
      '换界面（指纹变了）会重新探测。',
    ].join('\n'),
    parameters: {
      key: { type: 'string', description: '缓存槽位名，默认 default。不同 App 用不同 key 互不干扰' },
      fresh: { type: 'boolean', description: '强制重新探测，忽略缓存' },
    },
    output: out('界面统计 + 推荐的方法排序（含理由）。'),
  };
}

/** 条件等待 —— 替代固定 sleep。 */
export function waitForSpec() {
  return {
    name: 'vdisplay_wait_for',
    description: [
      '等某个条件成立，替代「固定等 2 秒再截图」。**这是省时间最多的一个工具。**',
      '',
      '实测对比：固定等 2 秒 + OCR 2-3 秒 = 每步 4-5 秒；',
      '用 wait_for 的门控（先 7ms 指纹看画面变没变，变了才跑 OCR）= 多数 150-400ms。',
      '',
      '判据（从便宜到贵）：',
      '  · stable             — 连续几次画面不变（转场结束，最便宜）',
      '  · fingerprint_changes — 画面变了没（7ms）',
      '  · diff_gt            — 变化超过阈值（2.3ms + 截图）',
      '  · color_present      — 出现某个颜色（6.8ms）',
      '  · text_appears/gone  — 文字出现/消失（OCR，慢但有 cheapFirst 门控）',
      '',
      '**所有「点完等页面加载」的地方都该用它**，不要写固定 sleep。',
      '',
      '失败时会告诉你了多久、轮询几次、跑了几次 OCR —— 便于判断是超时还是判据写错。',
    ].join('\n'),
    parameters: {
      until: { type: 'string', required: true, description: 'text_appears | text_gone | fingerprint_changes | fingerprint_is | diff_gt | color_present | stable' },
      text: { type: 'string', description: 'until=text_appears/text_gone 时要等的文字' },
      hash: { type: 'string', description: 'until=fingerprint_is 时要比对的 16 位指纹（先用 vdisplay_fingerprint 拿）' },
      color: { type: 'object', additionalProperties: false, properties: { r: { type: 'integer' }, g: { type: 'integer' }, b: { type: 'integer' } }, description: 'until=color_present 时等什么颜色 {r,g,b}' },
      threshold: { type: 'number', description: 'until=diff_gt 的阈值（0-1），默认 0.15' },
      timeoutMs: { type: 'integer', description: '最多等多少毫秒，默认 8000，上限 30000' },
      pollMs: { type: 'integer', description: '轮询间隔，默认 150' },
      cheapFirst: { type: 'boolean', description: '先用 7ms 指纹门控，画面没变就跳过 OCR。默认 true，别关' },
      region: { type: 'object', additionalProperties: false, properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } }, description: '只在这块里找（主要给 color_present 用）' },
    },
    output: out('等到了没、等了多久、轮询几次、跑了几次 OCR。'),
  };
}
