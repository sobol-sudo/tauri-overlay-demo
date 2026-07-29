# Overlay Demo — Tauri 2 + Vue 3 + TypeScript

A small desktop overlay: a translucent frameless window that floats above every
other application, is summoned by a global shortcut, and receives its answer as a
stream over a WebSocket.

A weekend project built to explore how far the privileged core / web UI split can be
pushed in Tauri 2 — and what breaks along the way.

## Running it

Build a real application bundle and launch it like anything else — no terminal
attached:

```bash
pnpm install
pnpm tauri build
open "src-tauri/target/release/bundle/macos/Overlay Demo.app"
```

Or run it in development mode with hot reload:

```bash
pnpm tauri dev
```

The first build fetches and compiles the Rust dependencies, which takes a few
minutes. After that it is incremental and fast.

### Lifecycle

The window is frameless, so it has no close button of its own. Instead:

| Action | Result |
| --- | --- |
| `Cmd/Ctrl+Shift+Space` | show / hide the overlay, from anywhere |
| Tray icon → **Show / Hide** | the same, without the shortcut |
| `Cmd+W` | hides the overlay, does not quit |
| Tray icon → **Quit**, or `Cmd+Q` | quits for good |

Closing an overlay puts it away rather than ending the session — the shortcut is
expected to bring it straight back. Quitting stays explicit, which is why the tray
icon exists: it is the one control that is always reachable, even when the window is
hidden.

In a second terminal you can start the mock streaming backend:

```bash
pnpm mock
```

Without it the app still works — the indicator reads `no server` and the stream runs
locally. That is deliberate: a demo should not require two terminals just to open.
Once the server comes up the client reconnects on its own and the source in the
status bar switches to `websocket`.

## What is in here

| Area | Where |
| --- | --- |
| Overlay window configuration | [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json) |
| Rust core: commands and events | [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) |
| Vue 3 + TypeScript UI | [`src/App.vue`](src/App.vue) |
| Pinia store | [`src/stores/overlay.ts`](src/stores/overlay.ts) |
| WebSocket client with reconnect | [`src/lib/streamClient.ts`](src/lib/streamClient.ts) |

### The Rust core

- **Global shortcut** `Cmd/Ctrl+Shift+Space` shows and hides the overlay. It fires
  while the window is hidden and the app has no focus, which is why visibility state
  belongs to the core rather than to the frontend.
- **`set_content_protection`** excludes the window from screen capture:
  `NSWindowSharingNone` on macOS, `WDA_EXCLUDEFROMCAPTURE` on Windows. A person sees
  the window; screen sharing and recording do not.
- **`set_click_through`** lets clicks pass through. The overlay floats above
  everything, and while it captures the cursor you cannot work underneath it.
- **The `overlay://visibility` event** is a core-to-UI push — the second direction of
  IPC: not a reply to a frontend request, but a message the native side initiates.
- **A tray icon and a close handler** give the app a normal lifecycle. `CloseRequested`
  is intercepted and turned into a hide, so a frameless window with no close button
  cannot strand the user; quitting is left to the tray menu and `Cmd+Q`.

### The frontend

- **Chunk batching.** Tokens accumulate in a buffer and are flushed into state once
  per frame rather than one at a time. On long answers the difference is visible:
  without batching Vue re-renders the node on every token.
- **TTFT.** Time to first token is measured and shown in the status bar — on a
  streaming UI that is the metric users actually perceive, not total duration.
- **An explicit socket state machine** — `offline / connecting / online` instead of a
  `connected` boolean. Otherwise "reconnecting" and "no server at all" are
  indistinguishable and the UI starts lying to the user.
- **Cancellation** stops the stream and keeps the text received so far.

## Architecture

```
┌──────────────────────────────┐
│  renderer (WebView)          │   Vue 3 + TypeScript + Pinia
│  renders, holds no privilege │
└───────────┬──────────────────┘
            │  IPC: invoke() ──▶ commands
            │       listen() ◀── events
┌───────────┴──────────────────┐
│  core (Rust)                 │   window, shortcut, OS permissions
│  everything privileged       │
└──────────────────────────────┘
            │
            │  WebSocket ──▶ answer backend
```

The model is the same one Electron uses: UI in a web view, privileged core kept
separate, an asynchronous channel of commands and events between them. What Tauri
changes is the core language — Rust instead of Node — a system WebView instead of a
bundled Chromium, and explicit permissions in
[`capabilities/default.json`](src-tauri/capabilities/default.json): a command is not
reachable from the frontend until it is granted in config.

## One bug worth writing down

Batching was first implemented with `requestAnimationFrame` alone. That is wrong for
an overlay, and the reason is easy to miss: **`requestAnimationFrame` does not fire
while the window is hidden**. Hide the overlay with the shortcut in the middle of a
generation and the chunks pile up in the buffer, landing all at once when the stream
ends — the text appears frozen.

The fix is to keep the frame as the primary trigger and back it with a timer, so the
batch drains on a bounded schedule even when no frames are produced.

Measured length of the rendered text during a stream after the fix:

```
0 → 15 → 43 → 86 → 111 → 160 → 208 → 259 → 274 characters
```

Before the fix the same measurement reads `0` throughout and `274` in one jump.

## What is verified

- The Rust core compiles; the app launches and runs without panics.
- The WebSocket path is verified end to end: TTFT of roughly 350 ms matches the mock
  server's configured delay, and chunks render incrementally.
- Reconnection is verified: starting the mock server moves the client from
  `no server` to `websocket` on its own.

The window commands — click-through and capture protection — compile and are wired to
the UI, but have not been verified by eye on macOS. Windows behaviour is stated from
the Tauri documentation rather than tested.

## What is not here

This is a demo, not a product. Deliberately missing:

- no screen or audio capture — a large topic of its own, tangled up in system permissions;
- no real LLM backend, just a mock that replays a canned answer token by token;
- no signing, notarization or auto-update — none of which are needed to run from source.
