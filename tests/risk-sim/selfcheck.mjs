#!/usr/bin/env node
/**
 * selfcheck.mjs — 量「这台手机现在对普通 App 有多暴露」。
 *
 * 为什么需要这个：之前所有靶场都在测「注入的事件像不像人」，
 * 完全没测「设备状态本身有多可疑」。第三方核查指出这是整类空白，
 * 而 ADB_ENABLED / 开发者选项恰恰是银行、微信必查的第一项 ——
 * 它们不需要分析行为，读一个设置就够判定了。
 *
 * 这个脚本只读，不改任何设置。
 *
 * 用法：node selfcheck.mjs [--json]
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const ADB = process.env.ADB_BIN || 'adb';
const TARGET = process.env.ADB_TARGET || '127.0.0.1:5555';

/*
 * **`''` 有两种意思，必须分开：命令跑了但没输出，和命令根本没跑起来。**
 *
 * 原来一律返回 ''，于是 adb 断开时 getSetting 把 '' 当成"这个设置没设"，
 * 9 项检查全部判 ✓，最后打印"没有一票否决级暴露" —— **一个假的清白结论**。
 * 现在命令失败返回 null，跟"空输出"区分开。
 */
function sh(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(ADB, ['-s', TARGET, 'shell', cmd], { timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout || '').trim()));
  });
}

/** adb 到底通不通。不通就别往下测了，不然全是假绿。 */
async function checkAdb() {
  const out = await sh('echo __ok__', 8000);
  if (out === null || !out.includes('__ok__')) {
    console.error(`\n❌ adb 不通（${ADB} -s ${TARGET}）。`);
    console.error('   自检**没有执行**，不是"设备干净"。');
    console.error('   先确认 adb devices 里有这台机器、且能 adb -s <target> shell echo ok。');
    process.exit(2);
  }
}

/** 设置项读取：命令失败 → 'ERROR'；未设置 → null；否则原始字符串 */
async function getSetting(ns, key) {
  const v = await sh(`settings get ${ns} ${key} 2>/dev/null`);
  if (v === null) return 'ERROR';   // 命令失败，跟"没设置"不是一回事
  if (v === '' || v === 'null') return null;
  return v;
}

async function getProp(key) {
  const v = await sh(`getprop ${key} 2>/dev/null`);
  if (v === null) return 'ERROR';
  return v || '(空)';
}

/**
 * 分类：
 *   fatal    只要这一项成立，任何 App 都能判定「这不是正常用户设备」
 *   high     需要一点权限或特定 API，但很直白
 *   medium   需要组合推断
 *   info     只是现象，不构成证据
 */
const CHECKS = [
  {
    id: 'sys.adb_enabled',
    label: 'ADB 调试总开关',
    level: 'fatal',
    // 任何 App 都能读 Settings.Global.ADB_ENABLED（无需权限）
    read: () => getSetting('global', 'adb_enabled'),
    judge: (v) => v === '1',
    why: 'App 读 Settings.Global.ADB_ENABLED 不需要任何权限。银行、微信、支付类普遍把这一项当硬拒条件。'
      + '它比"注入事件像不像人"更早被检查 —— 根本走不到行为分析那一步。',
    fix: '关掉 USB 调试。但 adbd 一关，这套工具就全废了。所以这是「用不用」的前提，不是能优化掉的暴露。',
  },
  {
    id: 'sys.dev_options',
    label: '开发者选项',
    level: 'fatal',
    read: () => getSetting('global', 'development_settings_enabled'),
    judge: (v) => v === '1',
    why: '同上，App 可直接读。开着开发者选项本身就是「这个用户不是普通人」的强信号。',
    fix: '关开发者选项会同时关掉 ADB，同 sys.adb_enabled。',
  },
  {
    id: 'sys.adb_tcp_port',
    label: 'adbd 走 TCP 监听',
    level: 'high',
    read: () => getProp('service.adb.tcp.port'),
    judge: (v) => v && v !== '(空)',
    why: '无线调试的特征。正常用户不开这个。一条 getprop 就能读到。',
    fix: '改用 USB 线时不需要它；但我们要靠回环连接，关掉就得插线。',
  },
  {
    id: 'sys.debuggable',
    label: '系统是 debuggable 构建',
    level: 'fatal',
    read: () => getProp('ro.debuggable'),
    judge: (v) => v === '1',
    why: 'ro.debuggable=1 意味着整个系统是调试版，比开 ADB 更严重。',
    fix: '改不了（ROM 决定）。今天实测是 0，正常。',
  },
  {
    id: 'disp.virtual_exists',
    label: '存在虚拟屏',
    level: 'medium',
    read: async () => {
      const d = await sh('dumpsys display 2>/dev/null | grep -c "DisplayDeviceInfo{\\"scrcpy\\"" ');
      return d || '0';
    },
    judge: (v) => Number(v) > 0,
    why: '虚拟屏没有 FLAG_PUBLIC，所以普通 App 的 getDisplays() 默认看不到；'
      + '但 getDisplays(DISPLAY_CATEGORY_PRESENTATION) 能看到带 FLAG_PRESENTATION 的屏，'
      + '而且名字直接叫 "scrcpy"。实测 scrcpy 5.0.1 只有 vd_destroy_content 和 vd_system_decorations 两个 vd_ 参数，'
      + '**没有改名参数** —— 名字改不掉。',
    fix: '要么接受（多数 App 不会去枚举 presentation display），要么自己写 display host 自定名字。'
      + '后者是子代理正在评估的方案。',
  },
  {
    id: 'disp.scrcpy_name',
    label: '虚拟屏名字里带 scrcpy',
    level: 'high',
    read: async () => {
      const d = await sh('dumpsys display 2>/dev/null | grep -o "DisplayInfo{\\"scrcpy\\"" | head -1');
      return d ? 'scrcpy' : '';
    },
    judge: (v) => v === 'scrcpy',
    why: '名字直接暴露工具身份。uniqueId 里还有 "com.android.shell,2000" —— 连建屏用户的 uid 都写在那里。',
    fix: '同 disp.virtual_exists：scrcpy 5.0.1 改不了，得自己写 host。',
  },
  {
    id: 'disp.overlay_devices',
    label: '模拟副屏设置',
    level: 'fatal',
    read: () => getSetting('global', 'overlay_display_devices'),
    judge: (v) => v !== null && v !== 'ERROR' && String(v).trim() !== '' && v !== 'null',
    why: '开发者选项里"模拟辅助显示设备"。设了就是明摆着的痕迹。',
    fix: '='+'置空即可。今天实测是 null，正常。',
  },
  {
    id: 'input.show_touches',
    label: '显示触摸操作',
    level: 'medium',
    read: () => getSetting('system', 'show_touches'),
    judge: (v) => v === '1',
    why: '开着会在屏幕上画触摸点，普通用户不会开。',
    fix: '关掉（不改用户设置的话，至少别自己开）。今天实测 0。',
  },
  {
    id: 'input.pointer_location',
    label: '指针位置',
    level: 'medium',
    read: () => getSetting('system', 'pointer_location'),
    judge: (v) => v === '1',
    why: '开发者选项里的坐标叠加层，会暴露触控采样细节。',
    fix: '关掉。今天实测 null，正常。',
  },
];

async function main() {
  await checkAdb();          // 不通就直接退出，绝不输出"全绿"
  const wantJson = process.argv.includes('--json');
  const results = [];

  for (const c of CHECKS) {
    let raw;
    try { raw = await c.read(); } catch { raw = 'ERROR'; }
    const hit = raw !== 'ERROR' && c.judge(raw);
    results.push({ id: c.id, label: c.label, level: c.level, raw, hit, why: c.why, fix: c.fix });
  }

  const hits = results.filter((r) => r.hit);
  const fatal = hits.filter((r) => r.level === 'fatal');

  if (wantJson) {
    console.log(JSON.stringify({ at: new Date().toISOString(), device: await getProp('ro.product.model'), results }, null, 2));
    return;
  }

  console.log('设备状态暴露自检（只读）');
  console.log('设备:', await getProp('ro.product.model'), '/', await getProp('ro.build.version.release'));
  console.log('');

  for (const r of results) {
    const mark = r.raw === 'ERROR' ? '?' : (r.hit ? '✗' : '✓');
    const lvl = r.level.toUpperCase().padEnd(6);
    console.log(`  ${mark} [${lvl}] ${r.label.padEnd(22)} = ${String(r.raw).padEnd(12)} ${r.hit ? '← 暴露' : ''}`);
  }

  console.log('');
  if (fatal.length) {
    console.log(`  ⚠️ 有 ${fatal.length} 项「一票否决」级暴露：`);
    for (const f of fatal) console.log(`     · ${f.label}（${f.id}）`);
    console.log('');
    console.log('  这几项不需要任何行为分析，App 读一个设置就能判。');
    console.log('  也就是说：在真实强风控面前，注入操作拟人化到什么程度并不重要 ——');
    console.log('  这一关在前一步就已经过了。');
  } else {
    console.log('  ✅ 没有一票否决级暴露。');
  }

  console.log('');
  const errs = results.filter((r) => r.raw === 'ERROR');
  if (errs.length) {
    console.log(`  ⚠️ 有 ${errs.length} 项**没测到**（命令失败），这几项既不算命中也不算干净：`);
    for (const e of errs) console.log(`     · ${e.label}（${e.id}）`);
    console.log('');
  }
  console.log('  二值统计：命中 ' + hits.length + ' / ' + (results.length - errs.length) +
    ' 项可判（fatal ' + fatal.length + '）' + (errs.length ? `，另有 ${errs.length} 项未测到` : ''));
  console.log('  注意：这只覆盖「设备状态」一类，不含行为层和浏览器指纹。');
}

main().catch((e) => { console.error(e); process.exit(1); });
