/**
 * Mock streaming backend. Emits an answer token by token, the way an LLM gateway
 * does, so the UI can be exercised against a real WebSocket instead of setTimeout.
 *
 *   pnpm mock
 */
import { WebSocketServer } from 'ws';

const PORT = 8787;
const TTFT_DELAY = 350; // "thinking" time before the first token
const TOKEN_DELAY = 40;

const ANSWER =
  'The event loop runs synchronous code to completion, then drains the microtask queue, ' +
  'and only then picks up a single macrotask. That is why a promise resolved inside a ' +
  'setTimeout callback runs before the next timer: microtasks are exhausted entirely ' +
  'between macrotasks.';

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (socket) => {
  let timer = null;

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type !== 'ask') {
      return;
    }

    stop();

    const tokens = ANSWER.split(' ');
    let i = 0;

    const tick = () => {
      if (socket.readyState !== socket.OPEN) {
        return;
      }
      if (i >= tokens.length) {
        socket.send(JSON.stringify({ type: 'done' }));
        timer = null;
        return;
      }
      socket.send(JSON.stringify({ type: 'chunk', chunk: (i === 0 ? '' : ' ') + tokens[i] }));
      i += 1;
      timer = setTimeout(tick, TOKEN_DELAY);
    };

    timer = setTimeout(tick, TTFT_DELAY);
  });

  socket.on('close', stop);
});

console.log(`mock streaming server: ws://127.0.0.1:${PORT}`);
