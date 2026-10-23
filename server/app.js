/**
 * Express application: static assets, SSE endpoint and SPA fallback.
 */
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

export const SSE_PATH = '/event';

const silentLogger = { info() { }, warn() { }, log() { }, error() { } };

/** Format one Server-Sent Event frame. */
export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * @param {object} options
 * @param {import('./simulation.js').Simulation} options.sim
 * @param {string} options.rootDir    project root
 * @param {string} [options.glyphDir] directory of SVG icons for the optional glyph stream
 * @param {number} [options.glyphIntervalMs]
 * @param {number} [options.keepAliveMs]
 */
/** Build the Express app. The simulation is injected so tests can use a stub. */
export function createApp({ sim, rootDir, glyphDir, glyphIntervalMs = 200, keepAliveMs = 15_000, logger = silentLogger }) {
  const app = express();
  const distDir = path.join(rootDir, 'dist/planets/browser');
  const resourcesDir = path.join(rootDir, 'resources');

  let glyphNames = null;
  const loadGlyphNames = () => {
    if (glyphNames === null) {
      try { glyphNames = glyphDir ? fs.readdirSync(glyphDir).filter((f) => f.endsWith('.svg')) : []; } catch { glyphNames = []; }
    }
    return glyphNames;
  };

  app.disable('x-powered-by');
  app.use(cors());
  app.use(compression({ filter: (req, res) => req.path !== SSE_PATH && compression.filter(req, res) }));

  app.get(SSE_PATH, (req, res) => {
    res.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const snapshot = sim.snapshot();
    logger.log(`[SSE] Initial data sent: ${snapshot.planets.length} bodies`);
    res.write(sseFrame('planets', snapshot));

    const timers = [setInterval(() => res.write(': keep-alive\n\n'), keepAliveMs)];

    // Optional decorative glyph stream (opt-in with ?glyphs=1).
    if (req.query.glyphs === '1') {
      const names = loadGlyphNames();
      if (names.length) {
        timers.push(setInterval(() => {
          const glyph = names[Math.floor(Math.random() * names.length)];
          fs.readFile(path.join(glyphDir, glyph), 'utf8', (err, svg) => {
            if (err || res.writableEnded) return;
            res.write(sseFrame('update', { id: `${Math.floor(Math.random() * 128)},${Math.floor(Math.random() * 64)}`, glyph: svg }));
          });
        }, glyphIntervalMs));
      }
    }

    req.on('close', () => {
      timers.forEach(clearInterval);
      res.end();
    });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, star: sim.star?.name ?? null, simulationTime: sim.simulationTime, simulationSpeed: sim.speed });
  });

  // Built client first, then raw resources (textures and body JSON) for dev and direct access.
  app.use(express.static(distDir, { index: false }));
  app.use('/images', express.static(path.join(resourcesDir, 'images')));
  app.use('/resources', express.static(resourcesDir));
  app.use('/stars', express.static(path.join(resourcesDir, 'stars')));
  app.use('/planets', express.static(path.join(resourcesDir, 'planets')));
  app.use('/moons', express.static(path.join(resourcesDir, 'moons')));

  // SPA fallback: extension-less GET requests that accept HTML get index.html.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || path.extname(req.path) || !req.accepts('html')) return next();
    const distIndex = path.join(distDir, 'index.html');
    res.sendFile(fs.existsSync(distIndex) ? distIndex : path.join(rootDir, 'view/index.html'));
  });

  return app;
}
