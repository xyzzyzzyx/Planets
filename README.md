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

The home system is read from `resources/stars`, `resources/planets` and `resources/moons`. Planets carry J2000 elements: `period` (days), `eccentricity`, `inclination`, `longitudeOfPerihelion` and `longitudeOfAscendingNode` (degrees) and `M0` (mean anomaly at J2000, radians), from JPL's approximate planetary elements. Earth's heliocentric longitude matches the equinoxes/solstices to within 1°, the 2025–26 oppositions of Mars to Neptune are reproduced to within 1°, and Halley/Hale-Bopp reach perihelion on their historical dates. Moons carry `semiMajorAxis` (100,000 km), `referencePlane`, `laplacePole`, `argumentOfPeriapsis`, `apsidalPeriod`/`nodalPeriod` (years) and an anomalistic `period` (days; the sidereal one is kept as `siderealPeriod`).

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
app/galaxy/galactic-orbit.ts    the system's revolution around the galactic core
app/galaxy/black-hole.ts        black hole + accretion disk at the centre of the spiral
app/webgl/tools/tracer.ts       Tracer trails
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
| T | Toggle the Tracer |
| Tab, Ctrl+Tab, Ctrl+Alt+Tab | Cycle planets, moons, rings |
| Ctrl+click, right-drag | Multi-select, box-select |
| Esc | Leave flight / disengage a route |

# Galactic orbit

The whole star system revolves around the supermassive black hole at the centre of the spiral galaxy (`app/galaxy/galactic-orbit.ts`), with the measured geometry of the Milky Way:

- **Orientation.** The galactic plane is tilted **60.19°** to the ecliptic; the planets' orbits are *not* parallel to the Sun's galactic orbit. The centre lies toward Sagittarius (ecliptic λ 266.84°, β −5.54°) and the north galactic pole at λ 180.02°, β +29.81° (IAU galactic axes rotated into J2000 ecliptic coordinates).
- **Motion.** Clockwise seen from the north galactic pole (the arms trail), heading toward Cygnus (galactic longitude 90°, which is 59.6° above the ecliptic), at the Sun's real **247 km/s** (Θ0 ≈ 236 km/s plus the Sun's own 12 km/s lead; Reid et al. 2019). The Sun also bobs through the disk: 20.8 pc above the mid-plane, rising at 7.25 km/s, with an ~84 Myr period. The 11 km/s radial (epicyclic) component is left out.
- **Scale.** The rendered galaxy is ~50 million times smaller than the real one (8.15 kpc becomes 33 AU). Galactic distances *and* times are compressed by that same factor, so speeds stay true: the Sun's path past the planets, and the Tracer's helices, are drawn at true scale. A galactic year takes ~4 simulated years instead of ~203 million.

The active star stays at the scene origin: the camera rides along with the system, and the galaxy backdrop, black hole and tracer trails are moved the opposite way. That keeps camera presets, the minimap and orbit lines star-relative.

# Accuracy and scale

| What | Model | Source |
| --- | --- | --- |
| Planet orbits | Keplerian J2000 elements incl. the ascending node Ω; periods from the mean motions | JPL "Approximate Positions of the Planets" (Standish), 1800–2050 |
| Comets | Elements incl. Ω (Halley 58.42°, Hale-Bopp 282.47°) | |
| Body orientation | Pole RA/Dec and prime meridian W(t) from the clock: Greenwich faces the Sun at 12:00 UT, seasons follow the 23.44° tilt, Venus and Uranus spin backwards | IAU WGCCRE 2015 (Archinal et al. 2018): Sun, planets, Moon |
| Other moons | Synchronous rotation, the prime meridian toward the planet | |
| Moon orbits | Mean elements in the right reference plane (local Laplace plane, ecliptic, or planet equator), Moon and prograde moons with nodal and apsidal precession | JPL SSD satellite mean elements; NASA NSSDC for Uranus/Neptune (no node/phase there: set to 0) |
| Rings | Real radii (Saturn's C, B and A rings, Jupiter's main ring, Uranus's and Neptune's rings) in the planet's equator, orbiting at the Keplerian rate for the planet's mass, in its sense of rotation | |
| Belts | Asteroid and Kuiper belts in the ecliptic plane, prograde, Keplerian rate per zone from the clock | |

Distances between the Sun and planets are at true scale. **Bodies, rings and moon distances are drawn 40× enlarged** (one scene unit is 100,000 km between planets but 2,500 km within a planet's system), so each planet system is a true-proportion miniature. Without that, every planet would be smaller than a pixel. Spins are exact at every frame; at high simulation speeds they alias (a planet can appear to turn slowly or backwards).

The scene frame is J2000 ecliptic with **ecliptic north at −Y** (`shared/orbital.js`). The default camera views look from the +Y side, i.e. from south of the ecliptic, where orbits run clockwise.

# Tracer

**〰️ Tracer** (or `T`) draws fading trails behind the star, planets and comets as they travel through space: the star leaves an arc around the black hole and the planets leave helices around it. Moon trails are added when the 🌙 Moons toggle is on. Trails are sampled from the shared Kepler model at evenly spaced simulated times (`app/webgl/tools/tracer.ts`), so they are back-filled instantly when switched on or after a time jump and rewind when time runs backwards.

# Modes

## Discovery

Top-down framing of the selection; overview of every orbit.

## Cinematic

Flies to the selected body and keeps following it.

## Navigation

Build a route from bodies (body list) and coordinates (click the minimap), optionally as a circuit, then **Engage**: the camera flies to each waypoint and orbits it for the configured time.

# Testing

- `npm run test:server` — 168 tests (orbital maths, ephemeris accuracy and oppositions, universe building, random systems, simulation clock/persistence, WebSocket protocol, HTTP/SSE app, certificates, harvester).
- `npm run test:app` — 270 tests (models, accuracy spot checks (Greenwich noon, solstice, lunar near side, full moon, ring and moon planes), factories, WebGL engine with a stub renderer, services with fake sockets, dashboard and shell components).
