import { TestBed } from '@angular/core/testing';
import { APP_CONFIG } from '../app.config';
import { FakeWebSocket } from '../testing/fakes';
import { ServerMessage, resolveWebSocketUrl } from './protocol';
import { WebSocketService } from './websocket.service';

describe('WebSocketService', () => {
  let service: WebSocketService;
  const socket = () => FakeWebSocket.instances.at(-1)!;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    TestBed.configureTestingModule({ providers: [{ provide: APP_CONFIG, useValue: { wsUrl: ':3001', sseUrl: '/event' } }] });
    service = TestBed.inject(WebSocketService);
    service.socketFactory = (url) => new FakeWebSocket(url) as unknown as WebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('connects lazily to the resolved URL', () => {
    expect(FakeWebSocket.instances).toHaveLength(0);
    service.connect();
    expect(socket().url).toBe(resolveWebSocketUrl(':3001', location));
    expect(socket().url).toMatch(/^wss?:\/\/[^/]+:3001$/);
    expect(service.state()).toBe('connecting');
    service.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('queues messages until open, then flushes in order (they used to be dropped)', () => {
    service.sendGetPlanets();
    service.sendJumpToDate(123);
    expect(socket().sent).toEqual([]);
    expect(service.pendingCount).toBe(2);
    socket().open();
    expect(service.state()).toBe('open');
    expect(socket().sentJson()).toEqual([{ type: 'getPlanets' }, { type: 'jumpToDate', date: 123 }]);
    service.sendReset();
    expect(socket().sentJson().at(-1)).toEqual({ type: 'resetSimulation' });
  });

  it('keeps only the latest queued speed change and caps the queue', () => {
    service.sendSpeed(2);
    service.sendSpeed(4);
    expect(service.pendingCount).toBe(1);
    for (let i = 0; i < WebSocketService.MAX_QUEUE + 20; i++) service.sendGetPlanets();
    expect(service.pendingCount).toBe(WebSocketService.MAX_QUEUE);
    socket().open();
    expect(socket().sentJson()).not.toContainEqual({ type: 'setSpeed', speed: 2 });
  });

  it('sendTravelToRandom sends a positive integer seed', () => {
    service.connect();
    socket().open();
    service.sendTravelToRandom();
    service.sendTravelToRandom(42);
    const [a, b] = socket().sentJson() as { type: string; seed: number }[];
    expect(a.type).toBe('travelToRandom');
    expect(Number.isInteger(a.seed) && a.seed > 0).toBe(true);
    expect(b.seed).toBe(42);
  });

  it('emits parsed, validated messages and filters by type', () => {
    const all: ServerMessage[] = [];
    const updates: unknown[] = [];
    service.messages$.subscribe((m) => all.push(m));
    service.on('orbitUpdate').subscribe((m) => updates.push(m.simulationTime));
    socket().open();
    socket().receive({ type: 'orbitUpdate', simulationTime: 5, trueAnomalies: {} });
    socket().receive({ type: 'planetsData', planets: [], simulationTime: 1, simulationSpeed: 1 });
    socket().receive('{garbage');
    socket().receive({ type: 'nope' });
    expect(all.map((m) => m.type)).toEqual(['orbitUpdate', 'planetsData']);
    expect(updates).toEqual([5]);
    expect(service.lastMessageAt()).toBeGreaterThan(0);
  });

  it('logs server errors', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.connect();
    socket().receive({ type: 'error', message: 'Invalid speed' });
    expect(warn).toHaveBeenCalledWith('[WebSocket] Server error:', 'Invalid speed');
  });

  it('reconnects with exponential back-off and resets it after a successful open', () => {
    service.connect();
    socket().drop();
    expect(service.state()).toBe('closed');
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    socket().drop();
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    socket().open();
    socket().drop();
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('dispose() closes the socket, stops reconnecting and completes the stream', () => {
    let completed = false;
    service.messages$.subscribe({ complete: () => (completed = true) });
    service.connect();
    const s = socket();
    service.dispose();
    expect(s.readyState).toBe(FakeWebSocket.CLOSED);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(completed).toBe(true);
    service.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
