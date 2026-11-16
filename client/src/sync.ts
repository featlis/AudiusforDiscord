import type { RoomState, Track } from "./types";

type StateHandler = (state: RoomState) => void;

/** Thin WebSocket client for the sync server. Reconnects automatically. */
export class SyncClient {
  private ws: WebSocket | null = null;
  private handlers: StateHandler[] = [];
  private roomId: string;
  private reconnectTimer: number | undefined;

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  connect() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Through Discord this resolves to <appId>.discordsays.com/ws (URL Mapping "/").
    // In local dev, Vite proxies /ws to the Node server.
    this.ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    this.ws.onopen = () => this.send({ type: "join", roomId: this.roomId });
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "state") this.handlers.forEach((h) => h(msg.state as RoomState));
      } catch { /* ignore malformed frames */ }
    };
    this.ws.onclose = () => {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => this.connect(), 1500);
    };
  }

  onState(handler: StateHandler) { this.handlers.push(handler); }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  enqueue(track: Track) { this.send({ type: "enqueue", track }); }
  playNow(track: Track) { this.send({ type: "playNow", track }); }
  pause() { this.send({ type: "pause" }); }
  resume() { this.send({ type: "resume" }); }
  seek(position: number) { this.send({ type: "seek", position }); }
  skip() { this.send({ type: "skip" }); }
  remove(index: number) { this.send({ type: "remove", index }); }
  clear() { this.send({ type: "clear" }); }
  ended(trackId: string) { this.send({ type: "ended", trackId }); }
}
