/**
 * target.js — 统一解析 adb 目标地址（本插件自带一份，跨包不互相 import）。
 *
 * 为什么不再硬编码 127.0.0.1:5555：
 * adb 插件（dsh-go-plugin-adb）在 5555 不通时会把 adbd 迁到 6555/7555/8555/9555，
 * 并把当前可用端口记在 $DSH_HOME/plugin-adb/state.json。这里硬编码 5555 的话，
 * 一旦 adb 插件完成迁移，本插件所有工具都会"连不上"，而且报错看不出原因。
 *
 * 取值优先级：ADB_TARGET 环境变量 > adb 插件记的 state.port > 5555。
 * 每次调用现读一次状态文件：文件很小（百来字节），走 page cache，成本可忽略；
 * 换来的是 adb 插件换端口后本插件自动跟上，不需要重启引擎。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function adbTarget() {
  if (process.env.ADB_TARGET) return process.env.ADB_TARGET;
  try {
    const dir = process.env.DSH_ADB_STATE_DIR
      || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugin-adb');
    const st = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    const port = Number(st?.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) return `127.0.0.1:${port}`;
  } catch {
    /* 没有状态文件或读不出来：用默认端口 */
  }
  return '127.0.0.1:5555';
}
