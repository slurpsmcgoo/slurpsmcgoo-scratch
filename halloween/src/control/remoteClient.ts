// The show page's link to the local server: receives operator commands from
// the phone remote and config pushes, sends heartbeats, perception log lines
// and error reports. Reconnects on its own; the show keeps running without it.

import type { OperatorCommand } from '../types.ts';

export interface ServerLinkHandlers {
  onCommand(cmd: OperatorCommand): void;
  onConfig(raw: unknown): void;
}

export class ServerLink {
  private ws: WebSocket | null = null;
  private retryTimer: number | null = null;

  constructor(private handlers: ServerLinkHandlers) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws?role=show`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      let msg: { type?: string; command?: OperatorCommand; config?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'command' && msg.command) this.handlers.onCommand(msg.command);
      else if (msg.type === 'config') this.handlers.onConfig(msg.config);
    };
    ws.onclose = () => {
      this.ws = null;
      this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, 2000);
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  heartbeat(payload: unknown): void {
    this.send({ type: 'heartbeat', payload });
  }

  startLog(): void {
    this.send({ type: 'logStart' });
  }

  stopLog(): void {
    this.send({ type: 'logStop' });
  }

  logLine(line: string): void {
    this.send({ type: 'log', line });
  }

  reportError(message: string): void {
    this.send({ type: 'error', message });
  }
}
