/**
 * Planets backend entry point.
 *
 *   HTTPS + SSE  https://localhost:3000   (static app, /event)
 *   WSS          wss://localhost:3001     (simulation protocol)
 *
 * Configure with PORT, WS_PORT and SAVE_INTERVAL_MS environment variables.
 */
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { createApp } from './server/app.js';
import { loadOrCreateCertificates } from './server/certs.js';
import { Simulation } from './server/simulation.js';
import { createUniverseBuilder } from './server/universe.js';
import { createProtocol, MAX_MESSAGE_BYTES } from './server/websocket.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const WS_PORT = Number(process.env.WS_PORT ?? 3001);
const TICK_MS = 80;
const SAVE_INTERVAL_MS = Number(process.env.SAVE_INTERVAL_MS ?? 15_000);
const VERBOSE = process.env.VERBOSE === '1';

const logger = {
  ...console,
  info: VERBOSE ? console.info.bind(console) : () => { },
};

const tls = await loadOrCreateCertificates(path.join(ROOT, 'certs'), { logger });

const builder = createUniverseBuilder({ resourcesRoot: path.join(ROOT, 'resources'), logger });
const sim = new Simulation({ builder, stateFile: path.join(ROOT, 'resources/universe.json'), logger }).load();

const wsServer = https.createServer(tls);
// maxPayload lets ws reject oversized frames before they are buffered; the protocol re-checks.
const wss = new WebSocketServer({ server: wsServer, maxPayload: MAX_MESSAGE_BYTES });
const protocol = createProtocol(sim, wss, logger);
wss.on('connection', protocol.onConnection);
wsServer.listen(WS_PORT, () => logger.log(`WSS: wss://localhost:${WS_PORT}`));

const app = createApp({ sim, rootDir: ROOT, glyphDir: path.join(ROOT, 'node_modules/bootstrap-icons/icons'), logger });
const httpServer = https.createServer(tls, app).listen(PORT, () => logger.log(`HTTPS/SSE: https://localhost:${PORT}`));

const loop = setInterval(() => {
  sim.tick();
  if (wss.clients.size > 0) protocol.broadcastOrbitUpdate();
}, TICK_MS);
const autosave = setInterval(() => sim.save(), SAVE_INTERVAL_MS);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.log(`[server] ${signal} — saving universe state…`);
  clearInterval(loop);
  clearInterval(autosave);
  sim.save();
  for (const client of wss.clients) client.terminate();
  wss.close();
  wsServer.close();
  httpServer.closeAllConnections?.();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
