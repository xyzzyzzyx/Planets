import * as THREE from 'three';
import { LunarPhase, Moon, lunarPhaseFromAngle } from './moon.model';
import { Planet } from './planet.model';

const deg = (d: number) => (d * Math.PI) / 180;

describe('lunarPhaseFromAngle', () => {
  it.each([
    [0, LunarPhase.NEW_MOON], [10, LunarPhase.NEW_MOON], [350, LunarPhase.NEW_MOON],
    [45, LunarPhase.WAXING_CRESCENT], [90, LunarPhase.FIRST_QUARTER], [135, LunarPhase.WAXING_GIBBOUS],
    [180, LunarPhase.FULL_MOON], [225, LunarPhase.WANING_GIBBOUS], [270, LunarPhase.LAST_QUARTER],
    [315, LunarPhase.WANING_CRESCENT], [-90, LunarPhase.LAST_QUARTER], [720 + 180, LunarPhase.FULL_MOON],
  ])('%i° → %s', (d, phase) => {
    expect(lunarPhaseFromAngle(deg(d))).toBe(phase);
  });
});

describe('Moon.getLunarPhase', () => {
  function system(moonAngle: number) {
    const planet = new Planet({ name: 'Earth', type: 'planet', diameter: 1, au: 1, period: 365 });
    const moon = new Moon({ name: 'Moon', type: 'moon', diameter: 0.3, semiMajorAxis: 3, period: 27, resource: '/moons/moon.json' });
    planet.addSatellite(moon);
    planet.setAngle(0); // planet on +X, star at origin
    moon.setAngle(moonAngle);
    planet.group.updateMatrixWorld(true);
    return moon;
  }

  it('is new when the moon sits between planet and star', () => {
    expect(system(Math.PI).getLunarPhase(new THREE.Vector3())).toBe(LunarPhase.NEW_MOON);
  });

  it('is full when the moon is opposite the star', () => {
    expect(system(0).getLunarPhase(new THREE.Vector3())).toBe(LunarPhase.FULL_MOON);
  });

  it('is a quarter at right angles', () => {
    expect([LunarPhase.FIRST_QUARTER, LunarPhase.LAST_QUARTER]).toContain(system(Math.PI / 2).getLunarPhase(new THREE.Vector3()));
  });

  it('keeps its resource path', () => {
    expect(system(0).resource).toBe('/moons/moon.json');
  });
});
