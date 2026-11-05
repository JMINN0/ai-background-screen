# dsh-go-second-screen

Give an Android phone **a screen the user cannot see**. An AI operates any app on it, and you can peek at it whenever you want.

English ｜ [中文](README.md)

> **Status: experimental (v0.1.0).** The core pipeline works and has been measured, but the known issues at the bottom are still open. **Not recommended for general use yet.**

---

## 1. What this is

The usual approach is "screenshot → look at it → compute coordinates → tap the screen". Slow, easy to miss, and it interrupts whatever you were doing.

This project creates a **virtual display that is never drawn on the physical screen**, launches apps onto it, and lets the AI operate there.

| | The screen you see | This screen |
|---|---|---|
| Visible to the user | yes | **no** (never drawn on the physical panel) |
| Steals focus | yes | **no** (`FLAG_OWN_FOCUS`) |
| Steals the keyboard | yes | **no** (IME focus stays on your main screen) |
| Which apps | — | any app (WeChat, Xiaohongshu, games, Settings…) |
| When you want to watch | — | tap the capsule to see the live frames |

Measured: the AI browsed Xiaohongshu, read comments and paged through notes on the virtual display while the main screen stayed yours, and the keyboard was never taken away.

---

## 2. Why two packages

The feature is **split in half and runs in two different places**. Both halves are required:

| Package | Type | Does | Installed into |
|---|---|---|---|
| `screen/` | Cordis plugin | creates the display, launches apps, taps, screenshots, streams | the profile (registers tools for the engine) |
| `watch/` | dsh-go native plugin | the capsule above the composer and the frame panel | `$DSH_HOME/dsh-go/plugins/` (draws app UI) |

**Why they are not merged**: the app only loads native plugins to draw UI, and the engine only loads Cordis plugins to register tools. "AI works in the background while you can watch" therefore needs both.

---

## 3. Install

### Prerequisites

1. **adb must work** — hard dependency; `screen` uses it for everything.
   ```bash
   apt-get update && apt-get install -y android-tools-adb
   adb connect 127.0.0.1:5555
   adb -s 127.0.0.1:5555 shell echo ok   # must print ok
   ```
   If that fails, follow the pairing steps in [dsh-go-plugin-adb](https://github.com/JMINN0/dsh-go-plugin-adb).

2. **The phone needs `ADD_TRUSTED_DISPLAY`**
   ```bash
   adb shell dumpsys package com.android.shell | grep "ADD_TRUSTED_DISPLAY: granted=true"
   ```
   No output means this device cannot create the display (Pixel and some Android 15 builds lack it).

3. **`ffmpeg`** for the streaming transcode:
   ```bash
   apt-get update && apt-get install -y ffmpeg
   ```

### Install `screen/`

```bash
git clone https://github.com/JMINN0/dsh-go-second-screen.git
cd dsh-go-second-screen
dsh plugin --profile web add ./screen
```

### Install `watch/`

```bash
# It must live in the dsh-go plugin directory, otherwise the capsule never appears.
# Putting it in the wrong place does not error -- it just does nothing.
mkdir -p "$HOME/.dsh/dsh-go/plugins"
cp -r "$(pwd)/watch" "$HOME/.dsh/dsh-go/plugins/local-screen-watch"
dsh plugin --profile web add ~/.dsh/dsh-go/plugins/local-screen-watch
```

### Restart the engine

In the app: **Settings → Engine → Restart engine**.

### Verify

```bash
python3 -c "
import json
d=json.load(open('$HOME/.dsh/profiles/web/package.json'))
b=d['dsh']['profile']['bundles']
print('screen:', 'dsh-go-plugin-screen' in b)
print('watch :', 'local-screen-watch' in b)"
# both must be True

grep -i "apply failed" "$HOME/.dsh/dsh-app/diagnostics.md" | grep -E "screen|watch" || echo "no load errors ✅"
```

Then ask the agent to run `vdisplay_status`. A capsule reading "AI 未操作" should appear above the composer.

---

## 4. For an AI installing this (read this section)

This repository contains **two packages**. If you dropped them in the wrong place, use this table:

| Package | How to recognise it | Correct location |
|---|---|---|
| `screen/` | `package.json` has a `dsh.bundle.patch` field | `dsh plugin --profile web add ./screen` |
| `watch/` | `package.json` has a `dshGo` field | **must** go into `$DSH_HOME/dsh-go/plugins/<name>/`, then `dsh plugin add` that path |

**The test**: look for `dshGo` in `package.json`.
- present → native plugin (draws UI); **do not `add` it straight from the repo**, copy it into `dsh-go/plugins/` first
- absent → Cordis plugin; `add` the directory directly

**Symptom of a wrong install**: no error, but either the capsule never appears (native half not loaded) or the agent reports no `vdisplay_*` tools (Cordis half not loaded).

---

## 5. The ten tools (`screen/`)

| Tool | Purpose |
|---|---|
| `screen_modes` | lists the available approaches with their costs |
| `vdisplay_start` | create a private virtual display |
| `vdisplay_launch` | launch an app onto it (force-stops first, so it cannot hijack a main-screen task) |
| `vdisplay_input` | inject tap / swipe / text / key into the display |
| `vdisplay_shot` | screenshot the display, returns a local file path |
| `screen_shot_main` | screenshot the main display (read-only) to check you did not disturb the user |
| `vdisplay_status` | display state, what is running on it, main-screen focus |
| `vdisplay_stop` | destroy the display |
| `vdisplay_stream` | push frames as 2fps JPEG to the capsule (about 0.30 core) |
| `vdisplay_stream_stop` | stop streaming |

---

## 6. Typical usage

```
1. vdisplay_start {}                                  → displayId=81
2. vdisplay_launch { pkg: "com.xingin.xhs", activity: ".index.v2.IndexActivityV2" }
3. vdisplay_shot {}                                   → /tmp/vd-xxx.png, open with read_image
4. vdisplay_input { kind: "tap", x: 360, y: 1042 }
5. vdisplay_input { kind: "key", key: "KEYCODE_BACK" }
6. vdisplay_stop {}
```

**To watch live**: `vdisplay_stream { fps: 2, width: 360 }`, then tap the capsule above the composer.

---

## 7. Known issues (why this is not published yet)

| Issue | Current state | Impact |
|---|---|---|
| **Typing works only in some apps** | `input text` works in Settings and standard fields; custom-drawn search boxes (e.g. JD) ignore it | fall back to deep links that carry the query |
| **Clipboard paste not finished** | `KEYCODE_PASTE` verified and worked on the Settings field, but not exposed as a tool | no `paste` input kind yet |
| **Deep links are unreliable** | both attempts on Xiaohongshu were rejected (`SecurityException: not exported`) | luck, not a strategy |
| **A CLI call creates its own display** | each node process builds a display and it dies when the process exits | must be driven from a resident process or from inside the plugin |
| **Reading the screen is slow** | one "screenshot → look → tap" cycle is 19.4 s median | unsuitable for rapid interaction |
| **Each screenshot costs ~1.1k tokens** | and stays in context permanently | long tasks fill the context |
| **Coordinate taps can silently fail** | post-action verification added (returns `ok:false` when nothing changed), but 17.6% of taps still did nothing | read the return value |
| **Verified on one device only** | nubia NX809J / Android 16 | other models untested |

---

## 8. Known limits (by design)

| Limit | Reason |
|---|---|
| needs `ADD_TRUSTED_DISPLAY` | some models lack it, and the display cannot be created |
| no soft keyboard on the virtual display | `display_ime_policy=hide`, so your keyboard is never taken |
| the display dies with its process | by design, nothing is left behind |
| cannot read other apps' `/data/data` | SELinux, no root |
| idling display costs ~0.28 core | 2fps streaming adds ~0.02 core |

---

## 9. How it works

```
screen/ (Cordis plugin, inside the engine)
  ↓ drives scrcpy-server's new_display
DisplayManager.createNewVirtualDisplay(OWN_CONTENT_ONLY | OWN_FOCUS | TRUSTED)
  ↓ never drawn on the physical panel, never takes focus
virtual display (dynamic displayId)
  ↓ am start --display, input -d, screencap -d
target app

watch/ (native plugin, inside the app)
  ← fetches one frame every 500ms from screen's loopback HTTP endpoint
  → draws the capsule / panel above the composer
```

No accessibility service, and no public overlay display (that one covers the screen, eats touches and takes the IME).

---

## License

MIT. See [LICENSE](LICENSE).
