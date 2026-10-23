# Changelog

## 2.0.0 — 2026-10-23

### Review & cleanup

- Removed the Claude / DeepSeek / Grok interference-manifold **sims** (components, `resources/sims`, the gh-pages deploy workflow) and their leftovers: the `/sims` static route, the `resources/sims` build asset and the now-unused `lil-gui` dependency.
- Removed dead code: unused `HttpService`, the unused `Waypoint`/`RingRenderMode` types and `PLANNING`/`TRAVEL`/`TETHERED` navigation modes, deprecated aliases (`CelestialBody.validate`, `clearWaypoints`, `setVisibile`), no-op `revolve()`/`handleResize()`, unused `ready$`/`simulationTime$` streams, duplicated speed constants and stray UTF-8 BOMs.
- Removed alternate texture files that nothing references (`earthcloudmaptrans-2`, `jupiter2_1k`, `mars_1k_*`).
- Stopped tracking generated files that were already git-ignored: `certs/*.pem` and `resources/universe.json`.
- Fixed: tilted planetary rings precessed around the ecliptic normal every frame (and star belts spun at the Sun's rotation rate) because `rotate()` also spun the untilted ring group.
- Fixed: `+` *lowered* the simulation speed to 10,000× when the slider had set it higher.
- Fixed: a system build still loading when a `universeTransition` arrived could finish and briefly show the old universe.
- Fixed: the WebSocket size limit counted UTF-16 characters rather than bytes; `ws` now also rejects oversized frames via `maxPayload`.
- The harvester's retry back-off is configurable, so its test no longer sleeps for 14 s (server suite: ~15 s → ~1 s).

### Upgrades

- Angular 21 → **22.2** (official `ng update` migrations), builder `@angular-devkit/build-angular` → **`@angular/build`**.
- TypeScript 5.9 → **6.0**, three.js 0.183 → **0.186**, Express 5.3, ws 8.22, concurrently 10, compodoc 2, npm-check-updates 23.
- `dat.gui` (unmaintained) → **lil-gui**. Google-Fonts `@import` (fails offline builds) → self-hosted **@fontsource** fonts.
- Removed unused dependencies: `@ng-bootstrap/ng-bootstrap`, `@popperjs/core`, `@angular/localize`, `@angular/animations`, `@angular/platform-browser-dynamic`, `express-sse`, `zone.js`.

### Modernisation

- Zoneless change detection, signals, `inject()`, built-in control flow (`@if`/`@for`), `viewChild()`, OnPush everywhere, lazy-loaded routes (three.js no longer in the initial bundle: ~119 kB transferred).
- `strict` TypeScript and `strictTemplates`; typed WebSocket protocol; no `baseUrl` path hacks.
- Server split into small testable modules; orbital maths shared between server and client (`shared/orbital.js`).
- Explicit disposal of three.js geometries/materials/textures everywhere.
- Vitest for both server and Angular (`@angular/build:unit-test`), GitHub Actions CI.

### Bug fixes

**Server**
- Planet positions jumped after the first tick: initial anomalies used one M0 table, the tick loop used another (always 0).
- The Wikipedia harvester ran on every server start inside a worker and could never download anything (`fsp` and `pageUrl` were undefined in the worker; no User-Agent, so Wikimedia rejects requests). Now an explicit `npm run harvest` CLI with back-off.
- Comet periods were stored in years but treated as days (Halley orbited every 75 days).
- Planet M0 values were wrong/missing (Saturn, Uranus, Neptune at 0); replaced with JPL J2000 elements plus longitude of perihelion.
- Random comet colours could be invalid hex (no zero padding); random belts were generated inside the star; random planet rings were always discarded by the client as "inside the planet".
- Moons with their orbital period copied into `spin` spun up to ~16 rad per frame; duplicate moon names (Saturn: Hati, Farbauti) collided.
- Simulation time could run past the range of `Date` at high speeds; `jumpToDate(0)` jumped to "now" instead of 1970.
- Expired (2021), SAN-less TLS certificate and its private key were committed; certificates are now generated locally.
- Kepler solver could fail to converge for very eccentric orbits; `normalizeAngle` could return exactly 2π.
- `/images` was proxied by the dev server but never served by the backend.
- SSE re-read the whole icon directory every 200 ms per client; client order of bodies differed between SSE and WebSocket.

**WebGL / dashboard**
- Random-system stars and comets were built as *planets* (comets were detected by the names "Halley"/"Hale-Bopp" only).
- Every jump added another 500k-point galaxy and leaked comet orbit lines and ring meshes; `attachRings` wasn't awaited.
- The galaxy backdrop collapsed onto four thin spiral lines (radius passed in scene units).
- Planet rings were tilted by the Sun's axis instead of the planet's (Uranus' rings at 7° instead of 98°); washer rings stood vertically; textured particle rings failed to compile (`uv` redeclared).
- Bodies sat at the origin until the first server update; random systems offset the star but not the camera/orbit lines.
- Comet tails were drawn at twice the comet's distance (attached to the moving group).
- Verify mode read the planet-orbit storage key; `+`/`-` always sent 2× / 0.5×; Ctrl+Alt+Tab could never find a ring; route navigation crashed when a waypoint body disappeared; minimap waypoints were placed in the vertical plane; the minimap camera marker used height instead of depth.
- The loader never disappeared when returning to the dashboard; intervals, listeners and animation loops leaked across visits; the date picker was off by the UTC offset; date jumps reset the speed and teleported the camera.
- Magnetic field toggle did nothing (no visualisation existed); lat/long meridians were drawn twice.
- Stuck keys after leaving pointer lock; velocity readout froze outside flight mode; two different camera-speed slider formulas.
