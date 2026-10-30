# Changelog

## Unreleased

- **Galactic orbit**: the entire solar system revolves around the black hole at the centre of the spiral galaxy. A black hole with an accretion disk and photon ring marks the galactic core. The galactic plane is tilted 60.19° to the ecliptic with its centre toward Sagittarius, and the Sun moves toward Cygnus at its true 247 km/s while bobbing through the disk. The galaxy is compressed ~50 million× in both size and time, so the motion past the planets is at true scale.
- **Tracer** (〰️ button, `T`): fading trails behind the star, planets and comets as they move through space — helices around the star's galactic path. Moon trails follow the 🌙 Moons toggle.
- **Accuracy pass** (see README → Accuracy and scale):
  - Planet elements replaced with the JPL table (Mercury's period was 88 instead of 87.969 days, so it drifted ~14° by 2026; Saturn's eccentricity was 0.0565 instead of 0.0539, among others). The orbital model now includes the **longitude of the ascending node**, without which every orbital plane was turned the wrong way.
  - Body orientation from **IAU rotational elements**: real pole directions and prime meridians tied to the clock (spin used to be a fixed angle per rendered frame, independent of simulation speed). Textures were upside down relative to ecliptic north; clouds and magnetic fields now follow the pole.
  - **Moons rebuilt from JPL/NSSDC data**: many irregular moons had negative or shifted values, so they sat still (negative periods) or had the wrong orbits. Moon orbits now lie in the correct reference plane: Uranus's moons circle in its 98°-tilted equator, and Triton is retrograde. Removed 15 fabricated duplicate moons from Saturn ("Hati-2" etc.) and two duplicates, and moved Aitne to Jupiter, where it belongs. The Moon has nodal (18.6 yr) and apsidal precession. Moon distances use the same 40× enlargement as body sizes (they used 30×).
  - **Rings** at their real radii (Saturn's were 2–3× too wide; Uranus's and Neptune's sat at 3–5 planet radii), split into Saturn's C/B/A rings, orbiting at the Keplerian rate for the planet's mass.
  - **Belts** now lie in the ecliptic (they followed the Sun's 7.25°-tilted equator) and orbit prograde (they turned backwards).
- Fixed: planets appeared upside down. The scene frame had ecliptic north at −Y while every camera used +Y as up and looked from south of the ecliptic, so Earth's north pole pointed down on screen. Ecliptic north is now +Y (the whole system turned 180° about the equinox axis): views are north-up, orbits run counter-clockwise from above, and the minimap, HUD bearings and the edge-on Ecliptic view follow.
- Fixed: star belts (asteroid and Kuiper belts) had effectively stopped moving. Their rotation was limited to 500 simulated ms per frame (meant for planetary-ring spin), while 1× advances a simulated day per second. Belts now take their Keplerian angle from the simulation clock.

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
