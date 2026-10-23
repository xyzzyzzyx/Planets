/** Typed messages exchanged with the simulation server (see server/websocket.js). */

/** A celestial body as serialised by the server (star, planet, moon or comet). */
export interface BodyData {
  name: string;
  type: 'star' | 'planet' | 'moon' | 'comet';
  [key: string]: unknown;
}

export interface PlanetsSnapshot {
  planets: BodyData[];
  simulationTime: number;
  simulationSpeed: number;
}

export type TransitionReason = 'jump' | 'travel' | 'reset';

interface OrbitMessage<T extends string> {
  type: T;
  simulationTime: number;
  simulationSpeed?: number;
  /** True anomaly (radians) per body name; ring rotation angles are included too. */
  trueAnomalies: Record<string, number>;
}

export type ServerMessage =
  | OrbitMessage<'orbitSync'>
  | OrbitMessage<'orbitUpdate'>
  | ({ type: 'planetsData' } & PlanetsSnapshot)
  | { type: 'universeTransition'; reason: TransitionReason; simulationTime: number }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'setSpeed'; speed: number }
  | { type: 'jumpToDate'; date: number }
  | { type: 'travelToRandom'; seed: number }
  | { type: 'getPlanets' }
  | { type: 'resetSimulation' };

const SERVER_TYPES = new Set(['orbitSync', 'orbitUpdate', 'planetsData', 'universeTransition', 'error']);

/** Parse and minimally validate a raw server frame; returns null for anything unexpected. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const data = JSON.parse(raw) as { type?: unknown };
    return data && typeof data.type === 'string' && SERVER_TYPES.has(data.type) ? (data as ServerMessage) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a configured WebSocket URL against the page location:
 *  - `wss://host:port/path` → unchanged
 *  - `/ws`                  → `wss://<page host>/ws` (dev-server proxy)
 *  - `:3001`                → `wss://<page hostname>:3001`
 */
export function resolveWebSocketUrl(url: string, location: Pick<Location, 'protocol' | 'host' | 'hostname'>): string {
  if (/^wss?:\/\//i.test(url)) return url;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (url.startsWith(':')) return `${scheme}//${location.hostname}${url}`;
  return `${scheme}//${location.host}${url.startsWith('/') ? url : `/${url}`}`;
}
