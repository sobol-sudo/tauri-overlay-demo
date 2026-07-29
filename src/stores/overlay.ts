import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { StreamClient, type StreamStatus } from '../lib/streamClient';

const WS_URL = 'ws://127.0.0.1:8787';

type OverlayStatus = {
  platform: string;
  toggleShortcut: string;
  clickThroughShortcut: string;
  clickThrough: boolean;
  contentProtected: boolean;
};

type State = {
  answer: string;
  streaming: boolean;
  status: StreamStatus;
  source: 'websocket' | 'local' | null;
  ttft: number | null;
  platform: string;
  toggleShortcut: string;
  clickThroughShortcut: string;
  clickThrough: boolean;
  contentProtected: boolean;
  visible: boolean;
};

let client: StreamClient | null = null;

/** Batched chunks: the DOM is touched once per frame, not once per token. */
let pending = '';
let flushRaf: number | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let askStartedAt = 0;
let localTimer: ReturnType<typeof setTimeout> | null = null;

/** Upper bound on latency when there are no frames and a timer drains the batch. */
const FLUSH_FALLBACK_MS = 60;

function clearFlushHandles() {
  if (flushRaf !== null) {
    cancelAnimationFrame(flushRaf);
    flushRaf = null;
  }
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export const useOverlayStore = defineStore('overlay', {
  state: (): State => ({
    answer: '',
    streaming: false,
    status: 'offline',
    source: null,
    ttft: null,
    platform: '',
    toggleShortcut: '',
    clickThroughShortcut: '',
    clickThrough: false,
    contentProtected: false,
    visible: true,
  }),

  actions: {
    /** The core is the source of truth for overlay flags; the UI mirrors it. */
    async syncStatus() {
      const status = await invoke<OverlayStatus>('overlay_status');
      this.platform = status.platform;
      this.toggleShortcut = status.toggleShortcut;
      this.clickThroughShortcut = status.clickThroughShortcut;
      this.clickThrough = status.clickThrough;
      this.contentProtected = status.contentProtected;
    },

    async init() {
      // The transport must not depend on whether the core answered: these are
      // separate subsystems, and one failing is no reason to leave the user
      // without the other.
      try {
        await this.syncStatus();

        // An event from the core: the shortcut fired without the UI asking.
        // The core may also have changed flags on its own — showing the overlay
        // drops click-through — so the UI resyncs instead of guessing.
        await listen<boolean>('overlay://visibility', async (event) => {
          this.visible = event.payload;
          if (event.payload) {
            await this.syncStatus();
          }
        });

        // Flags can also change without the UI: the tray toggles click-through
        // precisely when the window is unclickable and the buttons are useless.
        await listen('overlay://flags', () => this.syncStatus());
      } catch (error) {
        console.warn('overlay core unavailable', error);
      }

      client = new StreamClient(WS_URL, {
        onStatus: (status) => {
          this.status = status;
        },
        onChunk: (chunk) => this.pushChunk(chunk),
        onDone: () => this.finishStream(),
      });
      client.connect();
    },

    ask(prompt: string) {
      const trimmed = prompt.trim();
      if (!trimmed || this.streaming) {
        return;
      }

      this.cancel();
      this.answer = '';
      this.ttft = null;
      this.streaming = true;
      askStartedAt = performance.now();

      if (client?.send(trimmed)) {
        this.source = 'websocket';
        return;
      }

      // The mock server is not running — the app still has to work.
      this.source = 'local';
      this.streamLocally(trimmed);
    },

    cancel() {
      if (localTimer) {
        clearTimeout(localTimer);
        localTimer = null;
      }
      this.flush();
      this.streaming = false;
    },

    pushChunk(chunk: string) {
      if (this.ttft === null) {
        this.ttft = Math.round(performance.now() - askStartedAt);
      }

      pending += chunk;
      if (flushRaf !== null || flushTimer !== null) {
        return;
      }

      // The frame is the primary trigger, but requestAnimationFrame does not
      // fire while the window is hidden — and an overlay gets hidden by the
      // shortcut mid-generation. Without the timer as a backstop, the text
      // would freeze until the stream ends.
      const run = () => {
        clearFlushHandles();
        this.flush();
      };
      flushRaf = requestAnimationFrame(run);
      flushTimer = setTimeout(run, FLUSH_FALLBACK_MS);
    },

    flush() {
      clearFlushHandles();
      if (!pending) {
        return;
      }
      this.answer += pending;
      pending = '';
    },

    finishStream() {
      this.flush();
      this.streaming = false;
    },

    streamLocally(prompt: string) {
      const words = [
        `The Rust core owns the window and the shortcut, the Vue UI only renders.`,
        `"${prompt}" would travel over the WebSocket, but the mock server is not running,`,
        `so this stream is local. Run pnpm mock and the source switches to websocket.`,
      ]
        .join(' ')
        .split(' ');

      let i = 0;
      const tick = () => {
        if (i >= words.length) {
          this.finishStream();
          return;
        }
        this.pushChunk((i === 0 ? '' : ' ') + words[i]);
        i += 1;
        localTimer = setTimeout(tick, 45);
      };
      localTimer = setTimeout(tick, 120);
    },

    async toggleClickThrough() {
      // The core emits overlay://flags and the listener resyncs — the UI does
      // not assume the write succeeded.
      await invoke('set_click_through', { enabled: !this.clickThrough });
    },

    async hide() {
      await invoke('hide_overlay');
    },

    async quit() {
      await invoke('quit_app');
    },

    async toggleContentProtection() {
      const next = !this.contentProtected;
      await invoke('set_content_protection', { enabled: next });
      this.contentProtected = next;
    },
  },
});
