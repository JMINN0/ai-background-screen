# dsh-go-plugin-web

Control the phone's browser over the Chrome DevTools Protocol — **without touching the screen or stealing focus**.

English ｜ [中文](README.md)

| Item | Value |
|---|---|
| Version | 2026.1105.1908 (year.monthday.hourminute) |
| Verified on | nubia REDMAGIC NX809J / Android 16 / Chromium 156 (Edge & Chrome) |
| Tools | 8 |
| Root required | **No** |
| Accessibility required | No |

---

## 1. What this is

The usual approach is "screenshot → look at it → compute coordinates → tap the screen". Slow, brittle, and it interrupts the user.

This plugin takes a different route: **it talks to the browser directly**.

Chromium browsers expose a DevTools service over a Unix socket, speaking CDP. The plugin forwards that socket to a local TCP port via adb, then speaks CDP over WebSocket.

| | Screenshot + tap | CDP |
|---|---|---|
| read text | OCR / vision model guessing | exact, from the DOM |
| click element | computed coordinates, breaks when a dialog appears | selector-based, auto-scrolls into view |
| type text | synthetic key events, frameworks may miss them | `Input.insertText`, React/Vue both fire |
| user's screen | gets occupied | never touched |

---

## 2. Prerequisites

1. A **Chromium-based browser** on the phone: Chrome, Edge, or the Nubia browser (vendored Chinese browsers do not work — no CDP)

2. **Working adb — a hard dependency, not optional.** Every operation goes through `adb forward`, so without adb nothing works.

   ```bash
   apt-get update && apt-get install -y android-tools-adb
   adb version   # should print 1.0.41 or newer
   ```

   **Connect the phone** — loopback 5555 is **not** what adbd listens on by default, so a cold start needs this sequence (order matters):

   ```bash
   # phone: Developer options -> Wireless debugging -> Pair device with pairing code
   # note the pairing port (e.g. 192.168.1.100:37123) and the 6-digit code
   adb pair 192.168.1.100:37123        # enter the code

   # note the "IP address & Port" on the Wireless debugging screen (e.g. :41000 — not the pairing port)
   adb connect 192.168.1.100:41000     # required, or the next line fails
   adb tcpip 5555
   adb connect 127.0.0.1:5555
   adb -s 127.0.0.1:5555 shell echo ok   # must print ok
   ```

   Pairing needs Wi-Fi; afterwards Wi-Fi can be off. After a phone reboot, redo `adb tcpip 5555`.

3. The browser **must already be running** — this plugin will **not** launch it (section 5, Rule 1)

Check the environment:

```bash
adb -s 127.0.0.1:5555 shell pm list packages | grep -E "com.android.chrome|com.microsoft.emmx|cn.nubia.browser"
adb -s 127.0.0.1:5555 shell ps -A | grep -E "chrome|emmx|cn.nubia.browser"
```

---

## 3. Install

**Where the package comes from** (both steps matter, or you get `package not found`):

```bash
# 1. clone the repo
git clone https://github.com/JMINN0/dsh-go-plugin-web.git
cd dsh-go-plugin-web

# 2. install from the current directory (note the trailing dot)
dsh plugin --profile web add .
```

This package is **not published to npm**, so passing the bare name (`add dsh-go-plugin-web`) fails.

**Nothing to build after cloning**: plain ESM JS, no `npm install` step.

**Restart the engine afterwards**: app → Settings → Engine → Restart engine. Without this the tools do not appear.

**When are they usable?** The restart interrupts the engine for the current conversation. Once the app accepts input again (a few to ~15 s), speak in the **same** conversation — tools are registered globally. If the agent still says no tools, open a new conversation.

**Verify the install**:

```bash
python3 -c "
import json
d=json.load(open('$HOME/.dsh/profiles/web/package.json'))
print([b for b in d['dsh']['profile']['bundles'] if 'plugin-web' in b])"
# expected: ['dsh-go-plugin-web']

grep -i "apply failed" ~/.dsh/dsh-app/diagnostics.md 2>/dev/null | grep web || echo "no load errors ✅"
```

---

## 4. The eight tools

### `web_browser`

View or switch the target browser.

| Parameter | Type | Description |
|---|---|---|
| `select` | string | `edge` / `chrome` / `nubia`; omit to just view |

| key | package | name |
|---|---|---|
| `edge` | `com.microsoft.emmx` | Edge (**default**) |
| `chrome` | `com.android.chrome` | Chrome |
| `nubia` | `cn.nubia.browser` | Nubia browser |

The selection lasts for the current engine process; after an engine restart it defaults back to Edge. If the chosen browser is not installed, `web_ensure` reports that the browser is not running.

> ⚠️ All Chromium browsers share the same devtools socket name `chrome_devtools_remote`, and **only one process may bind it at a time**. Close the unused one before switching. Note that closing the browser is itself governed by Rule 1 — ask the user rather than killing it silently.

### `web_ensure`

Check the CDP channel and repair it (remove stale forwards, reconnect).

| Parameter | Type | Description |
|---|---|---|
| `allowForeground` | boolean | **default false**. Pass true to allow launching the browser (occupies foreground 1–2 s) |

```
web_ensure {}
→ 通道就绪：EdgA/156.0.4314.43（端口 9360）
```

**If the browser is not running**, follow these four steps — the only sanctioned path:

```
1. web_ensure {}                          -> returns "通道未就绪"
2. check whether the browser is running (use the full-package ps command above)
3. if not -> ask the user: "I need to open the browser; it will take the screen for 1-2 s. OK?"
4. consent given -> web_ensure { allowForeground: true }
   consent refused -> stop here. Do not invent a workaround. There is no second path.
```

It launches whichever browser `web_browser` currently selects. On failure the returned text says why (package missing, adb down).

**If the user refuses and the task must proceed**: tell the user to open the browser manually, then call `web_ensure {}` again once it is up. That is the only legal fallback.

### `web_open`

Open a tab.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | ✅ | full http(s) URL |
| `reuse` | boolean | | reuse the tab this plugin opened last time, default true. **Reuse means navigating that tab to the new URL** — the previous page is replaced |

**Returns** `{ targetId: "ABC123" }`, or `{ needsUserConfirm: true, hint }` on failure (see Rule 3 in section 5).

**Important limitation**: on Android, **a new tab cannot be created while the browser is in the background**. So `web_open` may fail when the user is not using the browser. This is a system limitation, not a bug. Either ask the user to foreground the browser, or use `reuse: true`.

### `web_read`

Read page text without spending image tokens.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `targetId` | string | ✅ | from `web_open` |
| `maxChars` | integer | | characters to return, default 4000, max 20000 |

Returns url, title and body text.

**The plugin does not wait for page load.** Right after `web_open` the page may still be loading, so an immediate `web_read` can catch a half-rendered page. If the result looks incomplete, wait 1–2 s and read again (no need to re-open). To wait for a specific condition, read repeatedly and compare.

### `web_click`

Click by CSS selector or **visible text**.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `targetId` | string | ✅ | tab id |
| `selector` | string | one of | CSS selector, e.g. `#submit` |
| `text` | string | one of | visible text, e.g. `Create repository` |

```
web_click { targetId: "ABC123", selector: "#submit" }
web_click { targetId: "ABC123", text: "创建仓库" }
```

The element is scrolled into view before clicking, so page scrolling cannot make it hit the wrong thing.

**Matching semantics**:

- `text` is a **substring, case-insensitive** match; when several elements match, the innermost wins
- `selector` follows standard `querySelector` semantics; the first match is used
- neither given → error; both given → `selector` wins

**"Returned success but nothing happened"**: `web_click` returning success only means the event was dispatched, not that the page reacted. Verify with a follow-up `web_read` (did the content change?) or `web_shot`. Usual causes: an overlay covers the element, the match was an unclickable parent, or the page is still loading.

### `web_fill`

Type into an input.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `targetId` | string | ✅ | tab id |
| `selector` | string | ✅ | input's CSS selector |
| `text` | string | ✅ | text to type |

**Append or replace?** `Input.insertText` **inserts at the caret** and does not clear existing content. To replace, focus first and select-all (Ctrl+A), or clear the field beforehand — but do not clear it with plain JS assignment, see below.

**Why not plain assignment**: setting `element.value = "x"` makes React/Vue's value tracker think nothing changed, so `onChange` never fires and the field still looks empty. `Input.insertText` goes through the browser's native input path, so frameworks receive the event.

### `web_shot`

Save a PNG screenshot.

| Parameter | Type | Description |
|---|---|---|
| `targetId` | string | tab id |
| `dir` | string | local (proot) directory, default `/tmp` |

Captures the visible viewport (not the full scrollable page) at device pixel size. Use it only when layout matters; to learn what the page says, use `web_read`.

### `web_close`

Close every tab this plugin opened and remove the adb forward. No parameters.

Under `reuse: true` there is normally only one tab; with `reuse: false` several may accumulate, and all of them carrying the marker are closed. Only tabs tagged `#dsh-<marker>` are touched — **the user's own tabs are never closed**.

---

## 5. Three hard rules

### Rule 1: never launch the browser on your own

The user may have **just closed it themselves**. Waking it with `monkey` would interrupt them and create a new window; Chromium then overwrites its "last closed session" record and their tabs are lost. That actually happened once.

- `web_ensure` by default only probes and repairs the forward
- launching requires an explicit `allowForeground: true` **and** prior user consent
- test scripts must never pass that flag

### Rule 2: close only your own tabs

Opened tabs get a `#dsh-<marker>` fragment. Closing matches on marker plus the recorded targetId — double protection. Tabs not on that list are never touched.

### Rule 3: never create a new window

On Android, `Target.createTarget` fails while the browser is in the background. Instead of silently falling back to `newWindow: true`, the plugin returns `needsUserConfirm: true` so the caller asks the user.

---

## 6. Typical usage

### Read a page

```
1. web_ensure {}
2. web_open { url: "https://example.com" }     → targetId: "ABC123"
3. web_read { targetId: "ABC123" }             → page text
4. web_close {}
```

### Fill and submit a form

```
1. web_open { url: "https://github.com/new" }  → targetId: "ABC123"
2. web_fill { targetId:"ABC123", selector:"#repository_name", text:"my-repo" }
3. web_click { targetId:"ABC123", text:"Create repository" }
4. web_read { targetId:"ABC123" }              → confirm the result
```

### Inspect layout (when you need an image)

```
1. web_open { url: "https://example.com" }
2. web_shot { targetId: "ABC123", dir: "/tmp" } → /tmp/xxx.png
```

---

## 7. Stability and compatibility

| Item | Result |
|---|---|
| Tool contract (host `defineTool` compile) | 8/8 pass |
| Fake-context load (catches `ctx` misuse) | pass, zero errors |
| Real engine load | pass (safe-mode trial: started in 13 s, ran stable 30 s) |
| Manual end-to-end | channel, open, read, click, fill, shot, close — all work |

**Verified**: Edge / Chrome / Nubia browser, Chromium 156, Android 16, randomized port 9300–9500 to avoid multi-instance conflicts.

**Not verified** (with symptoms, so you can self-diagnose):

| Not verified | What it looks like |
|---|---|
| non-Chromium browsers | `web_ensure` keeps saying "通道未就绪" and `/proc/net/unix` has no `devtools_remote` — the browser has no CDP; switch browsers |
| other Android versions | `Target.createTarget` returns odd error codes, or `screencap` sizes look wrong |
| browser killed by low memory | mid-task "通道未就绪" and the browser is gone from `ps` — ask the user to reopen it |
| ports 9300–9500 all taken | `web_ensure` cannot establish a forward — free the port or restart the engine |

---

## 8. Troubleshooting

**Channel not ready**

```bash
# 1. is the browser running?
adb -s 127.0.0.1:5555 shell ps -A | grep -E "chrome|emmx|cn.nubia.browser"

# 2. does the socket exist?
adb -s 127.0.0.1:5555 shell cat /proc/net/unix | grep devtools_remote

# 3. clear stale forwards and retry
adb -s 127.0.0.1:5555 forward --remove-all
```

If the browser is not running at all, go back to Rule 1: ask the user, then `web_ensure { allowForeground: true }`.

**Browser running but CDP unreachable** — stale forward. Either call the `adb_reconnect` tool from [dsh-go-plugin-adb](https://github.com/JMINN0/dsh-go-plugin-adb) (a **different plugin**), or run `adb forward --remove-all` in the proot shell and retry.

**Tab creation fails** — the browser is in the background. Ask the user to foreground it, or use `reuse: true`.

**Two browsers open, odd behaviour** — they fight over one devtools socket. Close one (with the user's consent).

**Clicked but nothing changed** — see the `web_click` section: verify with `web_read` or `web_shot`, and check for overlays.

---

## 9. Uninstall and rollback

```bash
# 1. remove from the profile
dsh plugin --profile web remove dsh-go-plugin-web

# 2. restart the engine (app -> Settings -> Engine -> Restart)
```

Verify removal with the section-3 command; expected output is `[]`. Also `adb forward --remove-all` to clear forwards.

**If the engine fell into safe mode**, the plugin prevented startup. The app auto-starts with a clean profile and shows a banner.

```bash
/var/lib/dsh-app/safe-mode/bin/dsh-app-plugins list      # which plugins
/var/lib/dsh-app/safe-mode/bin/dsh-app-plugins blame     # who touched what
/var/lib/dsh-app/safe-mode/bin/dsh-app-plugins disable dsh-go-plugin-web   # reversible
/var/lib/dsh-app/safe-mode/bin/dsh-app-plugins trial     # boot test; wait for PASS
```

A common cause of safe mode: a tool definition whose `description` is an array instead of a string. It passes packaging checks but makes every conversation fail to send in the real engine. The current version is validated by compiling every tool with the host's `defineTool`.

---

## 10. What it can and cannot do

| Scenario | Support |
|---|---|
| Read text from ordinary pages | ✅ DOM text |
| Click by selector or text | ✅ |
| Fill forms (including React/Vue pages) | ✅ native input path |
| Screenshot for layout | ✅ |
| Several tabs in parallel | ✅ each targetId independent |
| Read inside iframes | ⚠️ **same-origin iframes only**; cross-origin content is not reachable |
| Elements inside Shadow DOM | ⚠️ the selector must pierce the shadow root explicitly; plain CSS selectors cannot |
| Pure-canvas pages (e.g. web games) | ❌ no DOM text; screenshot only |
| Native IME interaction | ❌ not supported |
| File upload | ❌ no such tool |
| Handling alert / confirm dialogs | ❌ not implemented — the page will hang |

| Limitation | Why |
|---|---|
| Useless when the browser is not running | the plugin never launches it (Rule 1) |
| Cannot create tabs while the browser is backgrounded | Android system restriction |
| Two Chromium browsers conflict | they share one devtools socket |
| Firefox / vendored Chinese browsers | no CDP support |

---

## 11. Return-value contract

Every tool returns `{ text: string }` and never throws. Some also carry structured fields.

| Tool | Success | Failure |
|---|---|---|
| `web_ensure` | `{ text: "通道就绪：<version>（端口 <port>）" }` | `{ text: "通道未就绪：...", hint }` |
| `web_open` | `{ targetId }` | `{ needsUserConfirm: true, hint }` or an error reason |
| `web_read` | `{ text }` with url / title / body | `hint` |
| `web_click` | success message | `hint` explaining whether nothing matched or something else |
| `web_fill` | success message | `hint` |
| `web_shot` | `{ text: "截图：<path>" }` | `hint` |
| `web_browser` | current browser + options | unknown name lists valid values |
| `web_close` | how many tabs closed | — |

**How to tell success from failure**: look for `未就绪`, `失败`, `不是`, or a `hint` field. Note that runtime messages are Chinese; search for those strings, not translations.

**What `needsUserConfirm` means**: only `web_open` returns it. It means "the user must consent before continuing" — not an error to work around.

---

## 12. How it works

```
Agent
  ↓ CDP over WebSocket
local TCP port (random 9300–9500)
  ↓ adb forward tcp:<port> localabstract:chrome_devtools_remote
the browser's DevTools Unix socket
  ↓
Chromium's DevTools service
```

No accessibility, no screenshot recognition, no synthetic key injection. Everything goes through the browser's own debugging protocol.

---

## License

MIT. See [LICENSE](LICENSE).
