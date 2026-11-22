/**
 * 原子写文件 —— 要么读到完整的新内容，要么读到完整的旧内容，不会读到半截。
 *
 * 为什么需要（2026-11-22）：浮窗每 3 秒读一次 `stream.json` 和 `opmode` 来刷新状态行，
 * 而插件侧用 `writeFile` 直接覆盖。两个进程之间没有同步，
 * 读到「写了一半」的 JSON 就 parse 失败：
 *   · stream.json 半截 → 浮窗认为推流没在跑，可能关窗口
 *   · opmode 半截   → readStatus 返回 null，标签退回「屏 38820」，
 *     用户看到的就是「字自己跳来跳去」的另一种成因
 *
 * 做法：写同目录的临时文件，成功后 `rename`。同目录 rename 在 POSIX 上是原子的，
 * 读者看到的永远是某个完整版本。
 *
 * @param {string} file 目标路径
 * @param {string} data 要写入的完整内容
 */
import { writeFile, rename, unlink } from 'node:fs/promises';

export async function atomicWrite(file, data) {
  const tmp = file + '.tmp-' + process.pid;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (e) {
    // 失败时清掉临时文件，别在目录里留垃圾
    try { await unlink(tmp); } catch { /* 本来就没写出来 */ }
    throw e;
  }
}

/**
 * 同步版原子写。给那些在同步上下文里落盘的地方用（比如 vd.js 的 savePersistedState）。
 */
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';

export function atomicWriteSync(file, data) {
  const tmp = file + '.tmp-' + process.pid;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 本来就没写出来 */ }
    throw e;
  }
}
