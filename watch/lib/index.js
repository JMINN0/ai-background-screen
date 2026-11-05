// local-screen-watch — 在 DSH Go 里看 AI 正在虚拟屏上操作什么。
//
// 分工：本插件（跑在引擎里）只负责**取帧和画界面**；帧由 dsh-go-plugin-screen 的
// 本地回环 HTTP 服务提供（/frame.jpg、/status）。两边同一个引擎进程，走 127.0.0.1 即可，
// 既不用改桥接协议，也不往磁盘写任何图片。
//
// 三个硬限制（都是从桥接源码量出来的，不是猜的）：
//   1. 面板数据推送被限到 4 Hz、每次 ≤32768 字节；连续 5 次超限会让插件降级、原生界面整个关掉。
//   2. image 组件只认 data:image 或同源路径，且 data:image ≤ 64 KiB。
//   3. 360x640 的 JPEG(质量 60) 约 14 KB，base64 后约 19 KB —— 换算上正好塞得进一次推送。
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'local-screen-watch'

const STATE_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugin-screen', 'stream.json')
const POLL_MS = 500          // 2 帧/秒，稳在 4 Hz 限制之内
const FRAME_MAX = 22000      // base64 前的 JPEG 字节上限，留足余量

async function streamInfo() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    const j = JSON.parse(raw)
    if (j && Number(j.port) > 0) return j
  } catch { /* 没有就是没开 */ }
  return null
}

/** 取一帧；失败返回 null，不抛。 */
async function grabFrame(info) {
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/frame.jpg?ts=${Date.now()}`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length === 0 || buf.length > FRAME_MAX) return null
    return buf
  } catch { return null }
}

async function grabStatus(info) {
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/status`, { signal: AbortSignal.timeout(1500) })
    return r.ok ? await r.json() : null
  } catch { return null }
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    const zh = (locale) => !String(locale || '').startsWith('en')

    // 状态条：一行字，最多 24 字。点它打开面板看画面。
    ctx.dshGo.strip('watch', (scope, emit) => {
      let stopped = false
      const tick = async () => {
        if (stopped) return
        const info = await streamInfo()
        if (!info || !info.running) {
          emit({ text: 'AI 未操作', icon: 'image' })
          return
        }
        const sec = Math.max(0, Math.round((Date.now() - (info.startedAt || Date.now())) / 1000))
        // 24 字以内：「操作中 12s」很短，留空间给屏号
        emit({ text: `操作中 ${sec}s`, icon: 'image', tone: 'info' })
      }
      tick()
      const timer = setInterval(tick, 2000)
      return () => { stopped = true; clearInterval(timer) }
    })

    // 面板：一张图 + 状态 + 两个动作。
    ctx.dshGo.panel('live', {
      view: (scope, caps) => {
        const en = !String(caps?.locale || '').startsWith('en')
        return {
          v: 2,
          type: 'stack',
          title: en ? 'AI screen' : 'AI 正在操作',
          children: [
            { type: 'image', src: { $: 'data.frame' }, alt: 'live', aspect: 0.667 },
            { type: 'keyValue', items: [
              [en ? 'Status' : '状态', { $: 'data.status' }],
              [en ? 'Display' : '虚拟屏', { $: 'data.display' }],
            ] },
            { type: 'actions', items: [
              { label: en ? 'Refresh' : '刷新', action: 'refresh', icon: 'refresh' },
            ] },
          ],
        }
      },
      data: (scope, emit) => {
        let stopped = false
        let busy = false
        const tick = async () => {
          if (stopped || busy) return
          busy = true
          try {
            const info = await streamInfo()
            if (!info || !info.running) {
              emit({ frame: '', status: 'AI 未操作', display: '—' })
              return
            }
            const [buf, st] = await Promise.all([grabFrame(info), grabStatus(info)])
            emit({
              frame: buf ? `data:image/jpeg;base64,${buf.toString('base64')}` : '',
              status: st?.focusedApp ? String(st.focusedApp).slice(0, 60) : '取帧中',
              display: st?.displayId ? `display ${st.displayId}` : '—',
            })
          } finally { busy = false }
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        // 面板关掉后桥接会等 30 秒再调用这里 → 停止轮询，不看就不耗电
        return () => { stopped = true; clearInterval(timer) }
      },
      actions: {
        refresh: () => ({ toast: '已刷新', refresh: true }),
      },
    })
  })
}
