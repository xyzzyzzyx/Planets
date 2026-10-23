import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Simulation } from './simulation.js';
import { createProtocol, MAX_MESSAGE_BYTES } from './websocket.js';

class FakeClient extends EventEmitter {
  constructor(readyState = WebSocket.OPEN) {
    super();
    this.readyState = readyState;
    this.sent = [];
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  types() { return this.sent.map((m) => m.type); }
}

const HOME = () => ({ stars: [{ name: 'Sun', type: 'star', period: 0, planets: [{ name: 'Earth', period: 365.25 }], comets: [{ name: 'Halley', period: 27563, eccentricity: 0.967 }] }] });

describe('createProtocol', () => {
  let sim;
  let wss;
  let protocol;
  let me;
  let other;
  let closed;
  let logger;

  beforeEach(() => {
    sim = new Simulation({ builder: { buildFromResources: HOME }, now: () => 1_700_000_000_000, random: () => 0.25 }).load();
    me = new FakeClient();
    other = new FakeClient();
    closed = new FakeClient(WebSocket.CLOSED);
    wss = { clients: new Set([me, other, closed]) };
    logger = { info: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() };
    protocol = createProtocol(sim, wss, logger);
  });

  const send = (msg, ws = me) => protocol.handleMessage(ws, typeof msg === 'string' || Buffer.isBuffer(msg) ? msg : JSON.stringify(msg));

  it('sends orbitSync on connection and wires message handling', () => {
    protocol.onConnection(me);
    expect(me.sent[0]).toMatchObject({ type: 'orbitSync', simulationTime: sim.simulationTime, simulationSpeed: 1 });
    expect(me.sent[0].trueAnomalies).toHaveProperty('Earth');
    me.emit('message', Buffer.from(JSON.stringify({ type: 'getPlanets' })));
    expect(me.types()).toEqual(['orbitSync', 'planetsData']);
    me.emit('error', new Error('boom'));
    expect(logger.error).toHaveBeenCalledWith('[ws] Client error:', 'boom');
  });

  it('getPlanets replies only to the requester, star first', () => {
    expect(send({ type: 'getPlanets' })).toBe('getPlanets');
    expect(me.sent).toHaveLength(1);
    expect(me.sent[0].planets.map((p) => p.name)).toEqual(['Sun', 'Earth', 'Halley']);
    expect(other.sent).toEqual([]);
  });

  it('setSpeed updates the simulation and broadcasts the new speed', () => {
    send({ type: 'setSpeed', speed: 8 });
    expect(sim.speed).toBe(8);
    expect(other.sent[0]).toMatchObject({ type: 'orbitUpdate', simulationSpeed: 8 });
    expect(closed.sent).toEqual([]);
  });

  it('setSpeed rejects invalid values with an error to the sender only', () => {
    send({ type: 'setSpeed', speed: 'warp' });
    expect(sim.speed).toBe(1);
    expect(me.sent).toEqual([{ type: 'error', message: 'Invalid speed' }]);
    expect(other.sent).toEqual([]);
  });

  it.each([
    ['jumpToDate', { date: Date.UTC(2061, 6, 28) }, 'jump'],
    ['travelToRandom', { seed: 42 }, 'travel'],
    ['resetSimulation', {}, 'reset'],
  ])('%s broadcasts universeTransition → planetsData → orbitUpdate', (type, extra, reason) => {
    send({ type, ...extra });
    for (const client of [me, other]) {
      expect(client.types()).toEqual(['universeTransition', 'planetsData', 'orbitUpdate']);
      expect(client.sent[0].reason).toBe(reason);
    }
  });

  it('jumpToDate moves the clock', () => {
    send({ type: 'jumpToDate', date: Date.UTC(1986, 1, 9) });
    expect(sim.simulationTime).toBe(Date.UTC(1986, 1, 9));
  });

  it('travelToRandom uses the provided seed', () => {
    send({ type: 'travelToRandom', seed: 42 });
    expect(sim.star.name).toBe('Star-2A');
    expect(me.sent[1].planets[0].name).toBe('Star-2A');
  });

  it.each([
    ['{bad json', 'Malformed JSON'],
    [JSON.stringify({ type: 'selfDestruct' }), 'Unknown message type: selfDestruct'],
    [JSON.stringify({ type: '__proto__' }), 'Unknown message type: __proto__'],
    [JSON.stringify({ type: 'toString' }), 'Unknown message type: toString'],
    [JSON.stringify(null), 'Unknown message type: undefined'],
    ['x'.repeat(MAX_MESSAGE_BYTES + 1), 'Message too large'],
    // Multi-byte text: under the limit in characters, over it in bytes.
    ['é'.repeat(MAX_MESSAGE_BYTES / 2 + 1), 'Message too large'],
    [Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x20), 'Message too large'],
  ])('rejects %#', (raw, message) => {
    expect(send(raw)).toBeNull();
    expect(me.sent).toEqual([{ type: 'error', message }]);
  });

  it('accepts binary frames under the limit', () => {
    expect(send(Buffer.from(JSON.stringify({ type: 'getPlanets' })))).toBe('getPlanets');
  });

  it('reports handler exceptions without crashing', () => {
    vi.spyOn(sim, 'reset').mockImplementation(() => { throw new Error('disk full'); });
    send({ type: 'resetSimulation' });
    expect(logger.warn).toHaveBeenCalledWith('[ws] Error handling message:', 'disk full');
    expect(me.sent.at(-1)).toEqual({ type: 'error', message: 'Internal error' });
  });

  it('broadcastOrbitUpdate reaches every open client', () => {
    protocol.broadcastOrbitUpdate();
    expect(me.types()).toEqual(['orbitUpdate']);
    expect(other.types()).toEqual(['orbitUpdate']);
    expect(closed.sent).toEqual([]);
  });
});
