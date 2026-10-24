/**
 * Authoritative simulation clock + orbital state. Owns the universe, advances
 * simulation time, computes true anomalies and persists state to disk.
 *
 * Deliberately free of networking so it can be unit-tested in isolation.
 */
import fs from 'node:fs';
import { clampDateMs, computeTrueAnomalies, MS_PER_DAY } from '../shared/orbital.js';
import { generateRandomStarSystem, randomGalaxyPosition } from './random-system.js';
import { listBodies } from './universe.js';

/** Bump when the persisted state shape or resource semantics change; stale caches are rebuilt. */
export const STATE_SCHEMA_VERSION = 3;

/** Simulated milliseconds per real second at speed 1×  (1× = one simulated day per second). */
export const BASE_RATE = MS_PER_DAY;
export const MIN_SPEED = 0;
export const MAX_SPEED = 1e12;

const silentLogger = { info() { }, warn() { }, log() { }, error() { } };

export class Simulation {
  /**
   * @param {object} options
   * @param {{ buildFromResources(): { stars: any[] } }} options.builder universe builder (see universe.js)
   * @param {string} [options.stateFile] where to persist state (omit to disable persistence)
   * @param {() => number} [options.now]  clock, injectable for tests
   * @param {() => number} [options.random] RNG, injectable for tests
   * @param {Console} [options.logger]
   */
  constructor({ builder, stateFile, now = Date.now, random = Math.random, logger = silentLogger }) {
    if (!builder) throw new Error('Simulation: builder is required');
    this.builder = builder;
    this.stateFile = stateFile;
    this.now = now;
    this.random = random;
    this.logger = logger;

    this.simulationTime = now();
    this.speed = 1;
    this.lastUpdateMs = now();
    this.trueAnomalies = {};
    this.universe = { stars: [] };
  }

  get star() {
    return this.universe.stars[0] ?? null;
  }

  /** Bodies in client order: star, planets, comets. */
  getBodies() {
    return listBodies(this.star);
  }

  snapshot() {
    return { planets: this.getBodies(), simulationTime: this.simulationTime, simulationSpeed: this.speed };
  }

  /** Load persisted state, falling back to (and persisting) a fresh build from resources. */
  load() {
    const persisted = this.readStateFile();
    if (persisted && persisted.schemaVersion === STATE_SCHEMA_VERSION && Array.isArray(persisted.stars) && persisted.stars.length) {
      this.universe = { stars: persisted.stars };
      this.simulationTime = Number.isFinite(persisted.simulationTime) ? clampDateMs(persisted.simulationTime) : this.now();
      this.speed = Number.isFinite(persisted.simulationSpeed) ? this.clampSpeed(persisted.simulationSpeed) : 1;
      this.recompute();
      this.logger.log('[universe] Loaded from state file.');
    } else {
      if (persisted) this.logger.warn('[universe] State file is stale or invalid — rebuilding from resources.');
      this.universe = this.builder.buildFromResources();
      // Keep the user's simulated date when only the cached hierarchy was stale.
      this.simulationTime = Number.isFinite(persisted?.simulationTime) ? clampDateMs(persisted.simulationTime) : this.now();
      this.recompute();
      this.save();
      this.logger.log('[universe] Built fresh from resource files.');
    }
    this.lastUpdateMs = this.now();
    return this;
  }

  readStateFile() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return null;
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (err) {
      this.logger.warn(`[universe] Could not read state file: ${err.message}`);
      return null;
    }
  }

  /** Atomically persist state (write temp file, then rename). Returns true on success. */
  save() {
    if (!this.stateFile) return false;
    const tmp = `${this.stateFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({
        schemaVersion: STATE_SCHEMA_VERSION,
        simulationTime: this.simulationTime,
        simulationSpeed: this.speed,
        trueAnomalies: this.trueAnomalies,
        stars: this.universe.stars,
      }, null, 2));
      fs.renameSync(tmp, this.stateFile);
      return true;
    } catch (err) {
      this.logger.error('[universe] Save failed:', err.message);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return false;
    }
  }

  recompute() {
    this.trueAnomalies = computeTrueAnomalies(this.star, this.simulationTime);
    return this.trueAnomalies;
  }

  /** Advance simulation time by the real time elapsed since the previous tick. */
  tick(nowMs = this.now()) {
    const deltaSec = Math.max(0, (nowMs - this.lastUpdateMs) / 1000);
    this.lastUpdateMs = nowMs;
    this.simulationTime = clampDateMs(this.simulationTime + deltaSec * BASE_RATE * this.speed);
    return this.recompute();
  }

  clampSpeed(speed) {
    return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  }

  /** @returns {boolean} whether the speed was accepted */
  setSpeed(rawSpeed) {
    const speed = typeof rawSpeed === 'number' ? rawSpeed : parseFloat(rawSpeed);
    if (!Number.isFinite(speed)) return false;
    this.tick(); // bank elapsed time at the old speed first
    this.speed = this.clampSpeed(speed);
    return true;
  }

  /** Jump to an absolute date (ms since epoch). Invalid input jumps to "now". */
  jumpTo(rawDate) {
    const target = typeof rawDate === 'number' ? rawDate : parseFloat(rawDate);
    this.simulationTime = Number.isFinite(target) ? clampDateMs(target) : this.now();
    this.lastUpdateMs = this.now();
    this.recompute();
    this.save();
    return this.simulationTime;
  }

  /** Replace the current star with a procedurally generated one. */
  travelToRandom(rawSeed) {
    const seed = Number.isFinite(rawSeed) && rawSeed > 0 ? Math.floor(rawSeed) : Math.floor(this.random() * 1_000_000_000) + 1;
    const star = generateRandomStarSystem(seed);
    star.galaxyPosition = randomGalaxyPosition(this.random);
    this.universe = { stars: [star] };
    this.simulationTime = this.now();
    this.speed = 1;
    this.lastUpdateMs = this.now();
    this.recompute();
    this.save();
    this.logger.log(`[universe] Generated "${star.name}" (seed ${seed}): ${star.planets.length} planets, ${star.comets.length} comets, ${star.rings.length} belts.`);
    return star;
  }

  /** Rebuild the home system from resources and reset the clock to now. */
  reset() {
    this.universe = this.builder.buildFromResources();
    this.simulationTime = this.now();
    this.speed = 1;
    this.lastUpdateMs = this.now();
    this.recompute();
    this.save();
    return this.star;
  }
}
