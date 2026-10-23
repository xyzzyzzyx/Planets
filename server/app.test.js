import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, sseFrame, SSE_PATH } from './app.js';
import { Simulation } from './simulation.js';

let root;
let app;
let sim;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'planets-app-'));
  fs.mkdirSync(path.join(root, 'view'), { recursive: true });
  fs.writeFileSync(path.join(root, 'view/index.html'), '<html>view</html>');
  fs.mkdirSync(path.join(root, 'resources/images/planets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'resources/images/planets/earth.png'), 'PNG');
  fs.mkdirSync(path.join(root, 'resources/planets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'resources/planets/earth.json'), '{"name":"Earth"}');
  fs.mkdirSync(path.join(root, 'glyphs'));
  fs.writeFileSync(path.join(root, 'glyphs/star.svg'), '<svg/>');

  sim = new Simulation({
    builder: { buildFromResources: () => ({ stars: [{ name: 'Sun', type: 'star', period: 0, planets: [{ name: 'Earth', period: 365.25 }] }] }) },
  }).load();
  app = createApp({ sim, rootDir: root, glyphDir: path.join(root, 'glyphs'), glyphIntervalMs: 10 });
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** Open an SSE connection and collect raw text until `until` matches. */
function readSse(query = '', until = /event: planets/) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.get(`http://127.0.0.1:${port}${SSE_PATH}${query}`, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (until.test(body)) {
            req.destroy();
            server.close();
            resolve({ headers: res.headers, body });
          }
        });
      });
      req.on('error', (err) => { server.close(); if (err.code !== 'ECONNRESET') reject(err); });
    });
  });
}

describe('sseFrame', () => {
  it('formats an event with JSON data', () => {
    expect(sseFrame('planets', { a: 1 })).toBe('event: planets\ndata: {"a":1}\n\n');
  });
});

describe('createApp', () => {
  it('reports health', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ ok: true, star: 'Sun', simulationSpeed: 1 });
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('streams the initial planets snapshot over SSE without compression', async () => {
    const { headers, body } = await readSse();
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache');
    expect(headers['content-encoding']).toBeUndefined();
    const data = JSON.parse(body.split('data: ')[1].split('\n')[0]);
    expect(data.planets.map((p) => p.name)).toEqual(['Sun', 'Earth']);
    expect(data.simulationTime).toBe(sim.simulationTime);
  });

  it('only streams glyph updates when opted in', async () => {
    const { body } = await readSse('?glyphs=1', /event: update/);
    expect(body).toContain('event: update');
    expect(body).toContain('<svg/>');
  });

  it('serves textures under /images and JSON resources', async () => {
    const png = await request(app).get('/images/planets/earth.png').expect(200);
    expect(Buffer.from(png.body).toString()).toBe('PNG');
    const res = await request(app).get('/planets/earth.json').expect(200);
    expect(res.body).toEqual({ name: 'Earth' });
  });

  it('falls back to the SPA index for client-side routes', async () => {
    const res = await request(app).get('/dashboard').set('Accept', 'text/html').expect(200);
    expect(res.text).toBe('<html>view</html>');
  });

  it('prefers the built index.html when it exists', async () => {
    const dist = path.join(root, 'dist/planets/browser');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<html>dist</html>');
    const res = await request(app).get('/dashboard').set('Accept', 'text/html').expect(200);
    expect(res.text).toBe('<html>dist</html>');
  });

  it('404s for missing files and non-HTML requests', async () => {
    await request(app).get('/images/planets/nope.png').expect(404);
    await request(app).get('/dashboard').set('Accept', 'application/json').expect(404);
    await request(app).post('/dashboard').expect(404);
  });
});
