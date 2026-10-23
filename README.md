# Planets

WebGL space exploration: an Angular + three.js client driven by a Node simulation server that propagates Keplerian orbits in real time.

## Requirements

- Node.js **22.22.3+** or **24.15+** (required by Angular 22)
- npm 10+

## Startup

```bash
npm install
npm start          # backend (https://localhost:3000, wss://localhost:3001) + Angular dev server (http://localhost:4200)
```

A self-signed TLS certificate for `localhost` is generated into `certs/` on first start (regenerate with `npm run certs`). Open https://localhost:3000 once and accept the certificate so the browser trusts the backend.

Production-style run:

```bash
npm run build
npm run server     # serves dist/ on https://localhost:3000
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm start` | Backend (nodemon) + `ng serve` with the proxy in `proxy.conf.json` |
| `npm run build` | Production build into `dist/planets` |
| `npm test` | Server tests, then Angular tests |
| `npm run test:server` | Vitest suite for `server/`, `shared/`, `scripts/` |
| `npm run test:app` | Angular unit tests (`ng test`, Vitest + jsdom) |
| `npm run test:coverage` | Both suites with V8 coverage |
| `npm run typecheck` | Strict TypeScript check of app and specs |
| `npm run certs` | Regenerate the dev TLS certificate |
| `npm run harvest [-- Name …]` | Download Wikipedia infobox data/images for historical scientists into `dist/harvest/` |
| `npm run reset` | Delete the persisted simulation state (`resources/universe.json`) |

Environment variables for the server: `PORT` (3000), `WS_PORT` (3001), `SAVE_INTERVAL_MS` (15000), `VERBOSE=1` for per-body build logs.

# Server

```
server.js               entry point: TLS, HTTPS/SSE app, WSS, 80 ms tick loop, autosave, graceful shutdown
server/simulation.js    clock, speed, true anomalies, load/save of resources/universe.json
server/universe.js      builds star → planets/comets → moons from resources/*.json (CSV moons, texture checks)
server/random-system.js seeded procedural star systems
server/websocket.js     message protocol
server/app.js           Express: static assets, /event (SSE), /api/health, SPA fallback
server/certs.js         self-signed localhost certificate management
shared/orbital.js       Kepler solver & orbit geometry shared with the client
scripts/harvest.js      Wikipedia harvester CLI
```

## Milky way

The home system is read from `resources/stars`, `resources/planets` and `resources/moons`. Planets carry J2000 elements: `period` (days), `eccentricity`, `inclination` and `longitudeOfPerihelion` (degrees) and `M0` (mean anomaly at J2000, radians), from JPL's approximate planetary elements. Earth's heliocentric longitude matches the equinoxes/solstices to within 1°, and Halley/Hale-Bopp reach perihelion on their historical dates.

The built hierarchy is cached in `resources/universe.json` (git-ignored). The cache is versioned and rebuilt automatically when the format changes; the simulated date is preserved.

## Random generated

"Jump" asks the server for `travelToRandom` with a seed; the same seed always produces the same system (1–9 planets, 2–6 comets, 2–6 belts, Kepler-consistent periods).

## SSE

`GET /event` sends the current universe snapshot (`event: planets`) on connect, then keep-alives. A decorative icon stream is available with `?glyphs=1`.

## Websockets

| Client → server | Server → client |
| --- | --- |
| `setSpeed {speed}` | `orbitSync` (on connect) / `orbitUpdate` every 80 ms: `{simulationTime, simulationSpeed, trueAnomalies}` |
| `jumpToDate {date}` | `universeTransition {reason: jump\|travel\|reset}` followed by `planetsData` and `orbitUpdate` |
| `travelToRandom {seed}` | `planetsData {planets, simulationTime, simulationSpeed}` |
| `getPlanets` | `error {message}` for invalid input |
| `resetSimulation` | |

At 1× the simulation advances one day per real second.

# Client

Angular 22 (standalone, zoneless, signals, lazy-loaded routes) and three.js r186.

```
app/webgl/webgl.service.ts      scene, system building, server messages, selection, camera & route navigation
app/webgl/heliocentric.controls.ts  pointer-lock flight controls
app/galaxy/*                    body models and factories (planets, moons, comets, rings, galaxy backdrop)
app/utils/websocket.service.ts  queued, auto-reconnecting WebSocket client
app/utils/sse.service.ts        SSE client
app/dashboard.component.*       HUD, minimap, panels
```

# Controls

## Heliocentric

| Input | Action |
| --- | --- |
| Click viewport / Space | Enter or leave flight mode |
| W A S D / arrows, R / F | Move, up/down (Shift = 10×) |
| Mouse | Look (in flight) |
| Mouse wheel | Camera speed (in flight); zoom while following in Cinematic mode |
| `[` / `]` | Camera speed −/+ 10% |
| `+` / `-` | Double / halve simulation speed |
| Tab, Ctrl+Tab, Ctrl+Alt+Tab | Cycle planets, moons, rings |
| Ctrl+click, right-drag | Multi-select, box-select |
| Esc | Leave flight / disengage a route |

# Modes

## Discovery

Top-down framing of the selection; overview of every orbit.

## Cinematic

Flies to the selected body and keeps following it.

## Navigation

Build a route from bodies (body list) and coordinates (click the minimap), optionally as a circuit, then **Engage**: the camera flies to each waypoint and orbits it for the configured time.

# Testing

- `npm run test:server` — 162 tests (orbital maths and ephemeris accuracy, universe building, random systems, simulation clock/persistence, WebSocket protocol, HTTP/SSE app, certificates, harvester).
- `npm run test:app` — 241 tests (models, factories, WebGL engine with a stub renderer, services with fake sockets, dashboard and shell components).
