/**
 * WebSocket protocol between the simulation and browser clients.
 *
 * Client → server: setSpeed, jumpToDate, travelToRandom, getPlanets, resetSimulation
 * Server → client: orbitSync, orbitUpdate, planetsData, universeTransition, error
 *
 * Ring rotation angles are included in `trueAnomalies` (keyed by ring name).
 */
import { WebSocket } from 'ws';

export const MAX_MESSAGE_BYTES = 16 * 1024;

const silentLogger = { info() { }, warn() { }, log() { }, error() { } };

/**
 * @param {import('./simulation.js').Simulation} sim
 * @param {{ clients: Iterable<{ readyState: number, send(data: string): void }> }} wss
 */
export function createProtocol(sim, wss, logger = silentLogger) {
  const sendTo = (client, payload) => {
    if (client.readyState === WebSocket.OPEN) client.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  };
  const broadcast = (payload) => {
    const msg = JSON.stringify(payload);
    for (const client of wss.clients) sendTo(client, msg);
  };

  const planetsData = () => ({ type: 'planetsData', ...sim.snapshot() });
  const orbitUpdate = () => ({ type: 'orbitUpdate', simulationTime: sim.simulationTime, simulationSpeed: sim.speed, trueAnomalies: sim.trueAnomalies });

  /** Tell every client the universe changed, then send the new bodies and positions. */
  const broadcastTransition = (reason) => {
    broadcast({ type: 'universeTransition', reason, simulationTime: sim.simulationTime });
    broadcast(planetsData());
    broadcast(orbitUpdate());
  };

  const handlers = {
    setSpeed(ws, data) {
      if (sim.setSpeed(data.speed)) {
        logger.log(`[ws] Simulation speed → ${sim.speed}×`);
        broadcast(orbitUpdate());
      } else {
        sendTo(ws, { type: 'error', message: 'Invalid speed' });
      }
    },
    jumpToDate(_ws, data) {
      sim.jumpTo(data.date);
      broadcastTransition('jump');
      logger.log(`[ws] Jumped simulation to ${new Date(sim.simulationTime).toISOString()}`);
    },
    travelToRandom(_ws, data) {
      sim.travelToRandom(Number(data.seed));
      broadcastTransition('travel');
    },
    getPlanets(ws) {
      sendTo(ws, planetsData());
    },
    resetSimulation() {
      sim.reset();
      broadcastTransition('reset');
      logger.log('[ws] Simulation reset complete.');
    },
  };

  /** Handle one raw incoming message. Returns the handled message type, or null. */
  function handleMessage(ws, raw) {
    // Measure bytes (not UTF-16 code units) and do it before decoding a large frame.
    const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength ?? raw.length;
    if (bytes > MAX_MESSAGE_BYTES) {
      sendTo(ws, { type: 'error', message: 'Message too large' });
      return null;
    }
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      sendTo(ws, { type: 'error', message: 'Malformed JSON' });
      return null;
    }
    const handler = data && typeof data.type === 'string' && Object.hasOwn(handlers, data.type) ? handlers[data.type] : null;
    if (!handler) {
      sendTo(ws, { type: 'error', message: `Unknown message type: ${data?.type}` });
      return null;
    }
    try {
      handler(ws, data);
    } catch (err) {
      logger.warn('[ws] Error handling message:', err.message);
      sendTo(ws, { type: 'error', message: 'Internal error' });
    }
    return data.type;
  }

  function onConnection(ws) {
    sendTo(ws, { type: 'orbitSync', simulationTime: sim.simulationTime, simulationSpeed: sim.speed, trueAnomalies: sim.trueAnomalies });
    ws.on('message', (raw) => handleMessage(ws, raw));
    ws.on('error', (err) => logger.error('[ws] Client error:', err.message));
  }

  return {
    handleMessage,
    onConnection,
    broadcast,
    broadcastOrbitUpdate: () => broadcast(orbitUpdate()),
  };
}
