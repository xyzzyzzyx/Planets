/**
 * Test doubles shared by the Angular unit tests (jsdom has no WebSocket server,
 * EventSource, WebGL or 2D canvas implementation).
 */
import * as THREE from 'three';
import { vi } from 'vitest';
import type { BodyData, PlanetsSnapshot } from '../utils/protocol';

/** Minimal controllable WebSocket. */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void { this.sent.push(data); }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new Event('close') as CloseEvent);
  }

  /** Simulate the server accepting the connection. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
  /** Simulate an incoming frame (objects are JSON-encoded). */
  receive(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) }));
  }
  /** Simulate the connection dropping. */
  drop(): void { this.close(); }
  sentJson(): unknown[] { return this.sent.map((s) => JSON.parse(s)); }
}

/** Minimal controllable EventSource. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private readonly listeners = new Map<string, ((e: Event) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (e: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void { this.closed = true; this.readyState = 2; }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: typeof data === 'string' ? data : JSON.stringify(data) });
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
  fail(permanently = false): void {
    if (permanently) this.readyState = 2;
    this.onerror?.(new Event('error'));
  }
}

/** A no-op CanvasRenderingContext2D good enough for drawing code under jsdom. */
export function fake2dContext(canvas?: HTMLCanvasElement): CanvasRenderingContext2D {
  const calls: string[] = [];
  const target: Record<string | symbol, unknown> = { canvas, calls };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'getImageData' || prop === 'createImageData') return (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      return (...args: unknown[]) => { calls.push(String(prop)); return args.length ? undefined : undefined; };
    },
    set(t, prop, value) { t[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

/** Make `canvas.getContext('2d')` return a fake context for the duration of a test file. */
export function installCanvasStub(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string) {
    return kind === '2d' ? fake2dContext(this) : null;
  } as HTMLCanvasElement['getContext']);
}

/** WebGLRenderer stand-in: a real canvas plus spies for the methods WebGl uses. */
export function createRendererStub(): THREE.WebGLRenderer {
  const domElement = document.createElement('canvas');
  return {
    domElement,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap },
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    setClearColor: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  } as unknown as THREE.WebGLRenderer;
}

/** Texture loader that resolves instantly with an image-backed texture (or rejects for URLs containing "missing"). */
export function fakeTextureLoader() {
  return {
    loadAsync: vi.fn(async (url: string) => {
      if (url.includes('missing')) throw new Error(`404 ${url}`);
      const texture = new THREE.Texture();
      texture.image = { width: 1, height: 1, url };
      return texture;
    }),
  };
}

export const SUN: BodyData = {
  name: 'Sun', type: 'star', diameter: 139.2, color: '#ffc94a', period: 0, tilt: 7.25, spin: 0.002, map: '/images/stars/sunmap.png',
  magneticField: { strength: 100, radius: 2.5, tilt: 0, polarity: 1 },
  rings: [{ name: 'AsteroidBelt', inner: 2992, outer: 4787, thickness: 0.4, particleCount: 300, keplerianRotation: true }],
};

export const EARTH: BodyData = {
  name: 'Earth', type: 'planet', diameter: 1.2756, color: '#4a9eff', au: 1, period: 365.25, eccentricity: 0.0167, inclination: 0,
  longitudeOfPerihelion: 102.937682, M0: 6.240021, tilt: 23.44, mass: 5.97, pow: 24,
  moons: [{ name: 'Moon', type: 'moon', diameter: 0.3474, period: 27.3, eccentricity: 0.0549, inclination: 5.145, semiMajorAxis: 3.844, color: '#c0c0c0' }],
};

export const SATURN: BodyData = {
  name: 'Saturn', type: 'planet', diameter: 12.0536, color: '#e4d09a', au: 9.537, period: 10759, eccentricity: 0.0565, inclination: 2.484, tilt: 26.73,
  rings: [{ name: 'SaturnMain', inner: 72.3, outer: 120.5, thickness: 0.08, particleCount: 200, rotationSpeed: 0.02 }],
  moons: [],
};

export const HALLEY: BodyData = {
  name: 'Halley', type: 'comet', diameter: 0.000011, color: '#d4c9a8', au: 17.8, period: 27563, eccentricity: 0.967, inclination: 162.3, M0: 1.156769,
};

export function snapshot(overrides: Partial<PlanetsSnapshot> = {}): PlanetsSnapshot {
  return {
    planets: [structuredClone(SUN), structuredClone(EARTH), structuredClone(SATURN), structuredClone(HALLEY)],
    simulationTime: Date.UTC(2026, 9, 23),
    simulationSpeed: 1,
    ...overrides,
  };
}

/** A minimal random-star payload (star not named "Sun", comets identified by type only). */
export function randomSnapshot(): PlanetsSnapshot {
  return {
    planets: [
      { name: 'Star-2A', type: 'star', diameter: 1, color: '#ffffaa', period: 0, galaxyPosition: { x: 10000, y: 0, z: -5000 }, rings: [] },
      { name: 'Star-2A-Planet1', type: 'planet', diameter: 2, au: 1.2, period: 480, eccentricity: 0.1, moons: [] },
      { name: 'Star-2A-Comet1', type: 'comet', diameter: 0.0001, au: 40, period: 92000, eccentricity: 0.8 },
    ],
    simulationTime: Date.UTC(2030, 0, 1),
    simulationSpeed: 1,
  };
}
