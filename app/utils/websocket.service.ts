import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Observable, Subject, filter } from 'rxjs';
import { APP_CONFIG } from '../app.config';
import { ClientMessage, ServerMessage, parseServerMessage, resolveWebSocketUrl } from './protocol';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

/** Factory seam so tests can substitute a fake socket. */
export const createWebSocket = (url: string): WebSocket => new WebSocket(url);

/**
 * Resilient WebSocket client for the simulation protocol.
 *  - connects lazily on first use
 *  - queues outgoing messages until the socket is open (previously they were dropped)
 *  - reconnects with exponential back-off
 */
@Injectable({ providedIn: 'root' })
export class WebSocketService {
  private readonly config = inject(APP_CONFIG);

  private socket: WebSocket | null = null;
  private readonly outbox: string[] = [];
  private readonly incoming = new Subject<ServerMessage>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private disposed = false;

  static readonly MAX_QUEUE = 100;
  static readonly MAX_BACKOFF_MS = 15_000;

  /** Factory used to open sockets; overridable in tests. */
  socketFactory: (url: string) => WebSocket = createWebSocket;

  readonly state = signal<ConnectionState>('idle');
  /** Time (performance.now) of the last message received. */
  readonly lastMessageAt = signal(0);

  /** Every valid message from the server. */
  readonly messages$: Observable<ServerMessage> = this.incoming.asObservable();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.dispose());
  }

  /** Messages of one type, narrowed. */
  on<T extends ServerMessage['type']>(type: T): Observable<Extract<ServerMessage, { type: T }>> {
    this.connect();
    return this.messages$.pipe(filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type));
  }

  connect(): void {
    if (this.disposed || this.socket) return;
    const url = resolveWebSocketUrl(this.config.wsUrl, globalThis.location ?? { protocol: 'https:', host: 'localhost', hostname: 'localhost' });
    this.state.set('connecting');
    const socket = this.socketFactory(url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.state.set('open');
      for (const msg of this.outbox.splice(0)) socket.send(msg);
    };
    socket.onmessage = (event: MessageEvent) => {
      const message = parseServerMessage(event.data);
      if (!message) return;
      this.lastMessageAt.set(performance.now());
      if (message.type === 'error') console.warn('[WebSocket] Server error:', message.message);
      this.incoming.next(message);
    };
    socket.onerror = () => console.warn('[WebSocket] Connection error');
    socket.onclose = () => {
      this.socket = null;
      this.state.set('closed');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = Math.min(WebSocketService.MAX_BACKOFF_MS, 500 * 2 ** this.attempts++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(message: ClientMessage): void {
    const payload = JSON.stringify(message);
    this.connect();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(payload);
    } else {
      // Keep at most one pending speed update; cap the queue otherwise.
      if (message.type === 'setSpeed') {
        const idx = this.outbox.findIndex((m) => m.includes('"type":"setSpeed"'));
        if (idx >= 0) this.outbox.splice(idx, 1);
      }
      if (this.outbox.length >= WebSocketService.MAX_QUEUE) this.outbox.shift();
      this.outbox.push(payload);
    }
  }

  get pendingCount(): number {
    return this.outbox.length;
  }

  sendSpeed(speed: number): void { this.send({ type: 'setSpeed', speed }); }
  sendJumpToDate(date: number): void { this.send({ type: 'jumpToDate', date }); }
  sendGetPlanets(): void { this.send({ type: 'getPlanets' }); }
  sendReset(): void { this.send({ type: 'resetSimulation' }); }
  sendTravelToRandom(seed = Math.floor(Math.random() * 1_000_000_000) + 1): void { this.send({ type: 'travelToRandom', seed }); }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    this.state.set('closed');
    this.incoming.complete();
  }
}
