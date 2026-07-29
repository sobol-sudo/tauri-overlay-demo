/**
 * WebSocket client for streamed answers.
 *
 * The transport is a WebSocket, so the client has to survive a drop: the server
 * restarts, the network blinks, the laptop suspends. Status is an explicit state
 * machine rather than a `connected` boolean — otherwise "reconnecting" and
 * "offline" are indistinguishable and the UI starts lying to the user.
 */

export type StreamStatus = 'offline' | 'connecting' | 'online';

export type StreamEvents = {
  onStatus: (status: StreamStatus) => void;
  onChunk: (chunk: string) => void;
  onDone: () => void;
};

const RETRY_INTERVAL = 2000;

export class StreamClient {
  private ws: WebSocket | null = null;
  private status: StreamStatus = 'offline';
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly url: string,
    private readonly events: StreamEvents,
  ) {}

  get online() {
    return this.status === 'online';
  }

  connect() {
    if (this.disposed || this.ws || this.status === 'connecting') {
      return;
    }

    this.setStatus('connecting');

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.setStatus('offline');
      this.scheduleRetry();
      return;
    }

    this.ws.addEventListener('open', () => this.setStatus('online'));
    this.ws.addEventListener('message', (event) => this.onMessage(event));
    this.ws.addEventListener('error', () => this.ws?.close());
    this.ws.addEventListener('close', () => {
      this.ws = null;
      this.setStatus('offline');
      this.scheduleRetry();
    });
  }

  /** Returns false when the socket is not ready — the caller falls back to a local stream. */
  send(prompt: string): boolean {
    if (!this.online || !this.ws) {
      return false;
    }
    this.ws.send(JSON.stringify({ type: 'ask', prompt }));
    return true;
  }

  dispose() {
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private onMessage(event: MessageEvent) {
    let payload: { type?: string; chunk?: string };
    try {
      payload = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (payload.type === 'chunk' && typeof payload.chunk === 'string') {
      this.events.onChunk(payload.chunk);
      return;
    }

    if (payload.type === 'done') {
      this.events.onDone();
    }
  }

  private setStatus(status: StreamStatus) {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.events.onStatus(status);
  }

  private scheduleRetry() {
    if (this.disposed || this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, RETRY_INTERVAL);
  }
}
