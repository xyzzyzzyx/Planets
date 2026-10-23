import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeTrueAnomalies, MAX_DATE_MS, MS_PER_DAY } from '../shared/orbital.js';
import { BASE_RATE, MAX_SPEED, Simulation, STATE_SCHEMA_VERSION } from './simulation.js';

const HOME = () => ({
  stars: [{
    name: 'Sun', type: 'star', period: 0,
    planets: [{ name: 'Earth', period: 365.25, M0: 6.24, eccentricity: 0.0167, moons: [{ name: 'Moon', period: 27.3 }] }],
    comets: [{ name: 'Halley', period: 27563, eccentricity: 0.967, M0: 1.15 }],
    rings: [{ name: 'Belt', keplerianRotation: true }],
  }],
});

function setup({ stateFile, now = 1_700_000_000_000 } = {}) {
  const clock = { t: now };
  const builder = { buildFromResources: vi.fn(HOME) };
  const logger = { info: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() };
  const sim = new Simulation({ builder, stateFile, now: () => clock.t, random: () => 0.5, logger });
  return { sim, clock, builder, logger };
}

describe('Simulation', () => {
  let dir;
  let stateFile;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planets-sim-'));
    stateFile = path.join(dir, 'universe.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('requires a builder', () => {
    expect(() => new Simulation({})).toThrow(/builder/);
  });

  describe('load/save', () => {
    it('builds from resources and persists when no state file exists', () => {
      const { sim, builder, clock } = setup({ stateFile });
      sim.load();
      expect(builder.buildFromResources).toHaveBeenCalledOnce();
      expect(sim.star.name).toBe('Sun');
      expect(sim.simulationTime).toBe(clock.t);
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(saved.schemaVersion).toBe(STATE_SCHEMA_VERSION);
      expect(saved.stars[0].name).toBe('Sun');
      expect(fs.existsSync(`${stateFile}.tmp`)).toBe(false);
    });

    it('round-trips time, speed and universe through the state file', () => {
      const a = setup({ stateFile });
      a.sim.load();
      a.sim.setSpeed(42);
      a.sim.jumpTo(Date.UTC(2061, 6, 28));
      a.sim.save();

      const b = setup({ stateFile, now: 5 });
      b.sim.load();
      expect(b.builder.buildFromResources).not.toHaveBeenCalled();
      expect(b.sim.simulationTime).toBe(Date.UTC(2061, 6, 28));
      expect(b.sim.speed).toBe(42);
      expect(b.sim.trueAnomalies).toEqual(computeTrueAnomalies(b.sim.star, b.sim.simulationTime));
    });

    it('rebuilds a stale-schema cache but keeps the simulated date', () => {
      fs.writeFileSync(stateFile, JSON.stringify({ simulationTime: 123456, stars: [{ name: 'Old' }] }));
      const { sim, builder, logger } = setup({ stateFile });
      sim.load();
      expect(builder.buildFromResources).toHaveBeenCalledOnce();
      expect(sim.star.name).toBe('Sun');
      expect(sim.simulationTime).toBe(123456);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('stale'));
    });

    it('recovers from a corrupt state file', () => {
      fs.writeFileSync(stateFile, '{ not json');
      const { sim, builder } = setup({ stateFile });
      sim.load();
      expect(builder.buildFromResources).toHaveBeenCalledOnce();
      expect(sim.star.name).toBe('Sun');
    });

    it('handles a BOM-prefixed state file', () => {
      const a = setup({ stateFile });
      a.sim.load();
      fs.writeFileSync(stateFile, '﻿' + fs.readFileSync(stateFile, 'utf8'));
      const b = setup({ stateFile });
      b.sim.load();
      expect(b.builder.buildFromResources).not.toHaveBeenCalled();
    });

    it('save() is a no-op without a state file and reports failures', () => {
      const { sim } = setup();
      expect(sim.save()).toBe(false);
      const bad = setup({ stateFile: path.join(dir, 'missing-dir', 'x.json') });
      expect(bad.sim.save()).toBe(false);
      expect(bad.logger.error).toHaveBeenCalled();
    });
  });

  describe('time', () => {
    it('advances one simulated day per real second at 1×', () => {
      const { sim, clock } = setup();
      sim.load();
      const start = sim.simulationTime;
      clock.t += 1000;
      sim.tick();
      expect(sim.simulationTime - start).toBe(BASE_RATE);
      expect(BASE_RATE).toBe(MS_PER_DAY);
    });

    it('scales with speed and stands still at 0×', () => {
      const { sim, clock } = setup();
      sim.load();
      sim.setSpeed(10);
      const start = sim.simulationTime;
      clock.t += 500;
      sim.tick();
      expect(sim.simulationTime - start).toBe(5 * MS_PER_DAY);
      sim.setSpeed(0);
      const paused = sim.simulationTime;
      clock.t += 10_000;
      sim.tick();
      expect(sim.simulationTime).toBe(paused);
    });

    it('banks elapsed time at the previous speed when the speed changes', () => {
      const { sim, clock } = setup();
      sim.load();
      const start = sim.simulationTime;
      clock.t += 1000;
      sim.setSpeed(1000);
      expect(sim.simulationTime - start).toBe(MS_PER_DAY);
    });

    it('ignores clocks that go backwards', () => {
      const { sim, clock } = setup();
      sim.load();
      const start = sim.simulationTime;
      clock.t -= 5000;
      sim.tick();
      expect(sim.simulationTime).toBe(start);
    });

    it('never runs past the range a Date can represent', () => {
      const { sim, clock } = setup();
      sim.load();
      sim.setSpeed(MAX_SPEED);
      clock.t += 3_600_000;
      sim.tick();
      expect(sim.simulationTime).toBe(MAX_DATE_MS);
      expect(Number.isNaN(new Date(sim.simulationTime).getTime())).toBe(false);
    });

    it('updates true anomalies on every tick', () => {
      const { sim, clock } = setup();
      sim.load();
      const before = sim.trueAnomalies['Earth'];
      clock.t += 1000;
      const angles = sim.tick();
      expect(angles['Earth']).not.toBe(before);
      expect(Object.keys(angles)).toEqual(expect.arrayContaining(['Sun', 'Earth', 'Moon', 'Halley', 'Belt']));
    });
  });

  describe('setSpeed', () => {
    it.each([
      [5, 5],
      ['2.5', 2.5],
      [-3, 0],
      [1e20, MAX_SPEED],
    ])('accepts %p as %p', (input, expected) => {
      const { sim } = setup();
      expect(sim.setSpeed(input)).toBe(true);
      expect(sim.speed).toBe(expected);
    });

    it.each([NaN, 'fast', undefined, null, Infinity])('rejects %p', (input) => {
      const { sim } = setup();
      expect(sim.setSpeed(input)).toBe(false);
      expect(sim.speed).toBe(1);
    });
  });

  describe('jumpTo', () => {
    it('jumps to an absolute date and recomputes positions', () => {
      const { sim } = setup({ stateFile });
      sim.load();
      const target = Date.UTC(1986, 1, 9);
      expect(sim.jumpTo(target)).toBe(target);
      expect(sim.trueAnomalies).toEqual(computeTrueAnomalies(sim.star, target));
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).simulationTime).toBe(target);
    });

    it('accepts the Unix epoch (0) instead of treating it as "now"', () => {
      const { sim } = setup();
      sim.load();
      expect(sim.jumpTo(0)).toBe(0);
    });

    it('falls back to now for invalid dates and clamps huge ones', () => {
      const { sim, clock } = setup();
      sim.load();
      expect(sim.jumpTo('garbage')).toBe(clock.t);
      expect(sim.jumpTo(1e30)).toBe(MAX_DATE_MS);
      expect(sim.jumpTo('1700000000000')).toBe(1_700_000_000_000);
    });
  });

  describe('travelToRandom / reset', () => {
    it('replaces the universe with a seeded random system', () => {
      const { sim, clock } = setup({ stateFile });
      sim.load();
      sim.setSpeed(50);
      clock.t += 1234;
      const star = sim.travelToRandom(42);
      expect(sim.star).toBe(star);
      expect(star.name).toBe('Star-2A');
      expect(star.galaxyPosition).toBeDefined();
      expect(sim.speed).toBe(1);
      expect(sim.simulationTime).toBe(clock.t);
      expect(sim.trueAnomalies[star.planets[0].name]).toBeTypeOf('number');
    });

    it('is deterministic for a given seed and random for none', () => {
      const a = setup();
      const b = setup();
      expect(a.sim.travelToRandom(7).planets).toEqual(b.sim.travelToRandom(7).planets);
      expect(a.sim.travelToRandom(undefined).name).toBe(`Star-${(500_000_001).toString(16).toUpperCase()}`);
    });

    it('reset() restores the home system and real time', () => {
      const { sim, builder, clock } = setup();
      sim.load();
      sim.travelToRandom(9);
      sim.setSpeed(99);
      clock.t += 777;
      sim.reset();
      expect(builder.buildFromResources).toHaveBeenCalledTimes(2);
      expect(sim.star.name).toBe('Sun');
      expect(sim.speed).toBe(1);
      expect(sim.simulationTime).toBe(clock.t);
    });
  });

  it('snapshot() returns bodies with star first', () => {
    const { sim } = setup();
    sim.load();
    const snap = sim.snapshot();
    expect(snap.planets.map((b) => b.name)).toEqual(['Sun', 'Earth', 'Halley']);
    expect(snap).toMatchObject({ simulationTime: sim.simulationTime, simulationSpeed: 1 });
  });

  it('star is null for an empty universe', () => {
    const { sim } = setup();
    expect(sim.star).toBeNull();
    expect(sim.getBodies()).toEqual([]);
  });
});
