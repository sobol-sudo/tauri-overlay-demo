import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { StreamClient, type StreamStatus } from '../lib/streamClient';

const WS_URL = 'ws://127.0.0.1:8787';

type OverlayStatus = {
  platform: string;
  toggleShortcut: string;
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
  clickThrough: boolean;
  contentProtected: boolean;
  visible: boolean;
};

let client: StreamClient | null = null;

/** Batched chunks: the DOM is touched once per frame, not once per token. */
let pending = '';
let flushHandle: number | null = null;
let askStartedAt = 0;
let localTimer: ReturnType<typeof setTimeout> | null = null;


export const useOverlayStore = defineStore('overlay', {
  state: (): State => ({
    answer: '',
    streaming: false,
    status: 'offline',
    source: null,
    ttft: null,
    platform: '',
    toggleShortcut: '',
    clickThrough: false,
    contentProtected: false,
    visible: true,
  }),

  actions: {
    async init() {
      // The transport must not depend on whether the core answered: these are
      // separate subsystems, and one failing is no reason to leave the user
      // without the other.
      try {
        const status = await invoke<OverlayStatus>('overlay_status');
        this.platform = status.platform;
        this.toggleShortcut = status.toggleShortcut;
        this.clickThrough = status.clickThrough;
        this.contentProtected = status.contentProtected;

        // An event from the core: the shortcut fired without the UI asking.
        await listen<boolean>('overlay://visibility', (event) => {
          this.visible = event.payload;
        });
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
      if (flushHandle !== null) {
        return;
      }
      flushHandle = requestAnimationFrame(() => {
        flushHandle = null;
        this.flush();
      });
    },

    flush() {
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
      const next = !this.clickThrough;
      await invoke('set_click_through', { enabled: next });
      this.clickThrough = next;
    },

    async toggleContentProtection() {
      const next = !this.contentProtected;
      await invoke('set_content_protection', { enabled: next });
      this.contentProtected = next;
    },
  },
});
