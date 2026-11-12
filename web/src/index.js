/**
 * index.js — 插件入口，只做注册。
 *
 * 六个工具：web_ensure / web_open / web_read / web_click / web_fill / web_shot / web_close
 * （是七个——close 也算一个。）
 *
 * 解析 defineTool 要五级回退：插件装在 profile 的 node_modules 下，那里没有 dsh-tools，
 * 引擎自带的那份在 /opt/dsh/node_modules。只写裸包名会让 apply 直接失败、工具一个都不注册。
 */

import { attachSpec, browserSpec, clickSpec, closeSpec, ensureSpec, fillSpec, openSpec, readSpec, shotSpec, tabsSpec } from './tool-spec.js';
import * as T from './tools.js';

export const name = 'dsh-go-plugin-web';
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
  // Cordis 规定：没通过 ctx.inject 声明依赖之前，**碰 ctx 的任何属性都会抛**
  // （"cannot get property X without inject"）。所以所有 ctx 访问都放进 inject 回调里。
  // 这个坑让三个插件在真实引擎里全部加载失败过，工具一个都没出现。
  const disposers = [];
  try {
    ctx.inject(['tools'], (c) => {
      loadDefineTool()
        .then((defineTool) => {
          const defs = [
            [ensureSpec, (a) => T.ensure(a)],
            [openSpec, (a) => T.open(a)],
            [readSpec, (a) => T.read(a)],
            [clickSpec, (a) => T.click(a)],
            [fillSpec, (a) => T.fill(a)],
            [shotSpec, (a) => T.shot(a)],
            [tabsSpec, () => T.tabs()],
            [attachSpec, (a) => T.attach(a)],
            [closeSpec, (a) => T.close(a)],
            [browserSpec, (a) => T.browser(a)],
          ];
          for (const [spec, exec] of defs) {
            try {
              disposers.push(c.tools.register(defineTool({ ...spec(), execute: exec })));
            } catch (e) {
              console.error('[dsh-go-plugin-web] register failed:', e?.message || e);
            }
          }
        })
        .catch((e) => console.error('[dsh-go-plugin-web] apply failed, plugin disabled:', e?.message || e));
    });
  } catch (e) {
    console.error('[dsh-go-plugin-web] inject failed:', e?.message || e);
  }
  return () => { for (const d of disposers) { try { d?.(); } catch {} } };
}
