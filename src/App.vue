<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { useOverlayStore } from './stores/overlay';

const store = useOverlayStore();
const prompt = ref('');

onMounted(() => store.init());

const statusLabel = computed(() => {
  if (store.status === 'online') return 'websocket';
  if (store.status === 'connecting') return 'connecting';
  return 'no server';
});

function submit() {
  store.ask(prompt.value);
}

function startDrag(event: MouseEvent) {
  if (event.buttons !== 1) {
    return;
  }
  // The window controls sit inside the drag strip: without this they would be
  // swallowed by the drag and never fire a click.
  if ((event.target as HTMLElement).closest('button')) {
    return;
  }
  getCurrentWindow().startDragging();
}
</script>

<template>
  <div class="overlay">
    <header class="bar" @mousedown="startDrag">
      <span class="dot" :class="store.status" />
      <span class="bar__label">{{ statusLabel }}</span>
      <span class="bar__spacer" />
      <kbd v-if="store.toggleShortcut">{{ store.toggleShortcut }}</kbd>
      <!-- A frameless window has no title bar, so hide and quit need controls
           of their own — otherwise the only way out is a keyboard shortcut. -->
      <button class="win" title="Hide" @click="store.hide()">–</button>
      <button class="win win--close" title="Quit" @click="store.quit()">×</button>
    </header>

    <form class="ask" @submit.prevent="submit">
      <input
        v-model="prompt"
        class="ask__input"
        placeholder="Ask something…"
        :disabled="store.streaming"
      />
      <button v-if="!store.streaming" class="ask__btn" type="submit">→</button>
      <button v-else class="ask__btn ask__btn--stop" type="button" @click="store.cancel()">
        ■
      </button>
    </form>

    <section class="answer">
      <p v-if="!store.answer && !store.streaming" class="answer__empty">
        The Rust core owns the window, the shortcut and capture protection.<br />
        Vue is responsible only for what you see.
      </p>
      <p v-else class="answer__text">
        {{ store.answer }}<span v-if="store.streaming" class="caret" />
      </p>
    </section>

    <footer class="meta">
      <button
        class="chip"
        :class="{ 'chip--on': store.contentProtected }"
        @click="store.toggleContentProtection()"
      >
        hidden from capture
      </button>
      <!-- The shortcut is shown on the chip, not tucked away in the tray: once
           the mode is on, this button is the one thing you can no longer press,
           so the way out has to be readable before you turn it on. -->
      <button
        class="chip"
        :class="{ 'chip--on': store.clickThrough }"
        :title="
          store.clickThroughShortcut
            ? `Toggle click-through (${store.clickThroughShortcut})`
            : 'Toggle click-through'
        "
        @click="store.toggleClickThrough()"
      >
        click-through
        <span v-if="store.clickThroughShortcut" class="chip__key">
          {{ store.clickThroughShortcut }}
        </span>
      </button>
      <span class="meta__stats">
        <template v-if="store.ttft !== null">TTFT {{ store.ttft }} ms</template>
        <template v-if="store.source"> · {{ store.source }}</template>
        <template v-if="store.platform"> · {{ store.platform }}</template>
      </span>
    </footer>
  </div>
</template>

<style scoped>
.overlay {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 10px;
  gap: 10px;
  border-radius: 14px;
  background: rgba(18, 18, 22, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(24px);
  color: #f2f2f4;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}

.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 2px;
  cursor: grab;
  user-select: none;
}
.bar__spacer {
  flex: 1;
}
.bar__label {
  color: rgba(255, 255, 255, 0.55);
  font-size: 12px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #8a8a92;
}
.dot.online {
  background: #3ddc84;
}
.dot.connecting {
  background: #f0b232;
}

.win {
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.65);
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.win:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}
.win--close:hover {
  background: #e5484d;
}

kbd {
  padding: 2px 6px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.09);
  color: rgba(255, 255, 255, 0.6);
  font-size: 11px;
  font-family: inherit;
}

.ask {
  display: flex;
  gap: 6px;
}
.ask__input {
  flex: 1;
  padding: 9px 11px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font: inherit;
  outline: none;
}
.ask__input:focus {
  border-color: rgba(120, 160, 255, 0.55);
}
.ask__btn {
  width: 38px;
  border: none;
  border-radius: 9px;
  background: #4d7cfe;
  color: #fff;
  font-size: 15px;
  cursor: pointer;
}
.ask__btn--stop {
  background: rgba(255, 255, 255, 0.14);
}

.answer {
  flex: 1;
  overflow-y: auto;
  padding: 11px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.24);
}
.answer__empty {
  margin: 0;
  color: rgba(255, 255, 255, 0.42);
}
.answer__text {
  margin: 0;
  white-space: pre-wrap;
}

.caret {
  display: inline-block;
  width: 6px;
  height: 14px;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: #4d7cfe;
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink {
  to {
    visibility: hidden;
  }
}

.meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 4px 9px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: transparent;
  color: rgba(255, 255, 255, 0.5);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.chip--on {
  border-color: rgba(77, 124, 254, 0.7);
  background: rgba(77, 124, 254, 0.18);
  color: #cdd9ff;
}
.chip__key {
  margin-left: 5px;
  opacity: 0.65;
  font-size: 10px;
}
.meta__stats {
  margin-left: auto;
  color: rgba(255, 255, 255, 0.35);
  font-size: 11px;
}
</style>
