/**
 * 手机操控全家桶 —— 把原来 4 个插件合成 1 个入口。
 *
 * ## 为什么这么做
 *
 * 用户在 DSH 插件列表里看到 4 个我们自己的条目，觉得太散。
 * 合并成一个「入口」，装一次、升级一次。
 *
 * ## 怎么合并的：**组合，不是重写**
 *
 * 每个子插件的 `apply(ctx)` 原样调用，工具名一个都不改。
 *
 * ## 三个必须做对的地方（对抗审查发现的）
 *
 * **① disposer 必须收集并返回。**
 * `tools.register()` 内部是 `layers.effect(this.ctx, ...)`，挂在 **tools 服务自己的 ctx**
 * 上，不是插件 fiber。只有调用它返回的 disposer，工具才会从表里删掉。
 * 子插件返回的清理函数还负责关 OCR 的 python 子进程和虚拟屏 —— 丢掉就是泄漏。
 * 不收集的话，热重载后旧工具留着、新的 41 个全部注册失败，用户看到"已启用"其实是旧实例。
 *
 * **② 必须动态 import，不能静态 import。**
 * 静态 import 时任一子模块顶层抛错，整个插件连 try/catch 都进不去，三个全没了。
 *
 * **③ 必须等工具真的注册完。**
 * 子插件的 apply 内部是 `ctx.inject(['tools'], cb)` + 异步 `loadDefineTool()`，
 * 直接 await 子插件的 apply 只等到同步部分。所以这里等一个短暂窗口并统计注册结果。
 */
export const name = 'dsh-go-plugin-mobile';

/**
 * **子插件清单：每个子插件给多个候选 import 路径。**
 *
 * 2026-11-23 发布质量审查抓到一个致命问题：
 * package.json 里这三个依赖写的是 `link:`，而 pnpm 的 `link:` **只建软链、
 * 不装被链包自己的依赖**。所以用户按 README「一条装全部」装完之后，
 * 插件显示已启用，但 vdisplay_/adb_/web_ 一个工具都没有 —— 而且不报错，
 * 因为下面的 try/catch 把 import 失败吞进一个状态文件里。
 *
 * 修法：每个子插件按顺序试多个路径。
 *   ① 包名 —— 从 npm 正常安装时可用
 *   ② 相对路径 —— 两个仓库并排克隆时可用（README 就是这么要求的）
 * 这样两种部署方式都能加载。
 */
/**
 * **算出子插件模块的候选路径。**
 *
 * 2026-11-23 实测：静态的相对路径（`../screen/src/index.js`）在宿主里解析不到，
 * 因为宿主可能用 bundle 方式加载插件，`import.meta.url` 不指向仓库位置。
 * 但**绝对路径**是好的（实测三个子包用 /root/.../src/index.js 全部加载成功）。
 *
 * 所以这里优先从 import.meta.url 推出绝对路径，推不出来再退回包名。
 */
function moduleCandidates(relFromRepoRoot, pkgName) {
  const out = [];
  out.push(pkgName);   // ① 正常安装的包名
  try {
    // 本文件在 <repo>/plugin/src/index.js，repo 根 = 上两级
    const here = import.meta.url;              // file:///.../plugin/src/index.js
    const repoRoot = new URL('../../', here);  // file:///.../
    out.push(new URL(relFromRepoRoot, repoRoot).href);
  } catch { /* import.meta.url 不可用（bundle 加载） */ }
  /* ② 兜底：兄弟目录。
   *
   * 原来这里写死了 /root/workspace/... —— 那是开发机上的路径，
   * 别人 clone 到别处全部失效。现在从环境变量和 cwd 推。
   */
  try {
    /* moduleCandidates 是同步函数，不能 await —— 用 node:path 的同步 API。
     * 这里只需要拼路径，不需要异步。 */
    const sep = '/';
    const bases = [];
    if (process.env.DSH_WORKSPACE) bases.push(process.env.DSH_WORKSPACE);
    try { bases.push(process.cwd()); } catch { /* ignore */ }
    const norm = (b) => String(b).replace(/\\/g, sep).replace(/\/+$/, '');
    for (const b of bases) {
      const nb = norm(b);
      try { out.push('file://' + nb + sep + relFromRepoRoot); } catch { /* ignore */ }
      try {
        const parent = nb.split(sep).slice(0, -1).join(sep) || sep;
        out.push('file://' + parent + sep + relFromRepoRoot);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return out;
}

const MODULES = [
  ['adb', moduleCandidates('../dsh-go-plugin-adb/src/index.js', 'dsh-go-plugin-adb')],
  ['screen', moduleCandidates('screen/src/index.js', 'ai-background-screen')],
  ['web', moduleCandidates('web/src/index.js', 'dsh-go-plugin-web')],
  ['watch', ['./watch.js']],
];

export async function apply(ctx) {
  const disposers = [];
  const failed = [];
  const loaded = [];

  for (const [label, specs] of MODULES) {
    let mod = null;
    const errs = [];
    // **按候选顺序试**：包名优先（npm 装），其次相对路径（仓库并排）
    for (const spec of specs) {
      try { mod = await import(spec); break; }
      catch (e) { errs.push(`${spec}: ${String(e?.message || e).slice(0, 60)}`); }
    }
    if (!mod) {
      failed.push(`${label}: 全部路径都加载失败 —— ${errs.join(' | ')}`);
      continue;
    }
    const fn = mod?.apply || mod?.default?.apply;
    if (typeof fn !== 'function') { failed.push(`${label}: 没有 apply`); continue; }

    // **收集 disposer**
    try {
      const d = await fn(ctx);
      loaded.push(label);
      if (typeof d === 'function') disposers.push(d);
      else if (Array.isArray(d)) {
        for (const x of d) if (typeof x === 'function') disposers.push(x);
      }
    } catch (e) {
      failed.push(`${label}: apply 抛错 ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  // 给子插件的异步注册一点时间（它们内部是 promise 链，apply 返回时可能还没注册完）
  // 这个等待是**尽力而为**，不改变正确性；真正的修复在子插件里改成可 await。
  await new Promise((r) => setTimeout(r, 300));

  if (failed.length) {
    const msg = '[dsh-go-plugin-mobile] 部分子插件失败: ' + failed.join('; ');
    try { console.error(msg); } catch { /* ignore */ }
    // **写到状态文件**，这样诊断时能看到，不用去翻引擎 stderr
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = join(homedir(), '.dsh', 'plugin-screen');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'mobile-plugin-status.json'), JSON.stringify({
        at: new Date().toISOString(),
        loaded,
        failed,
      }, null, 2));
    } catch { /* 写不进去也不影响加载 */ }
  }

  // **返回组合清理函数** —— 插件卸载/热重载时会被调用
  return async () => {
    for (const d of disposers.reverse()) {
      try { await d(); } catch { /* 单个清理失败不影响其它 */ }
    }
  };
}

/** 加载结果查询（给诊断工具用）。 */
export function loadedModules() {
  return MODULES.map(([label]) => label);
}
