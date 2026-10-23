import * as THREE from 'three';
import { MoonConfig, OrbitingBody } from './celestial.model';

export type { MoonConfig } from './celestial.model';

export enum LunarPhase {
  NEW_MOON = 'New Moon',
  WAXING_CRESCENT = 'Waxing Crescent',
  FIRST_QUARTER = 'First Quarter',
  WAXING_GIBBOUS = 'Waxing Gibbous',
  FULL_MOON = 'Full Moon',
  WANING_GIBBOUS = 'Waning Gibbous',
  LAST_QUARTER = 'Last Quarter',
  WANING_CRESCENT = 'Waning Crescent',
}

/** Classify a Sun–Moon elongation angle (radians) into one of the eight named phases. */
export function lunarPhaseFromAngle(phaseAngleRad: number): LunarPhase {
  const a = ((phaseAngleRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const deg = (a * 180) / Math.PI;
  if (deg < 22.5 || deg >= 337.5) return LunarPhase.NEW_MOON;
  if (deg < 67.5) return LunarPhase.WAXING_CRESCENT;
  if (deg < 112.5) return LunarPhase.FIRST_QUARTER;
  if (deg < 157.5) return LunarPhase.WAXING_GIBBOUS;
  if (deg < 202.5) return LunarPhase.FULL_MOON;
  if (deg < 247.5) return LunarPhase.WANING_GIBBOUS;
  if (deg < 292.5) return LunarPhase.LAST_QUARTER;
  return LunarPhase.WANING_CRESCENT;
}

/** A moon orbiting a planet (semi-major axis in scene "moon units", see OrbitingBody.getSemiMajorAxis). */
export class Moon extends OrbitingBody {
  declare readonly config: MoonConfig;
  readonly resource?: string;

  constructor(config: MoonConfig) {
    super(config);
    this.resource = config.resource;
  }

  /**
   * Phase as seen from the parent planet: the angle between the directions
   * planet→star and planet→moon (0 = new moon, π = full moon).
   */
  getLunarPhase(starWorldPosition: THREE.Vector3 = new THREE.Vector3()): LunarPhase {
    const moonWorld = this.getWorldPosition();
    const planetWorld = new THREE.Vector3();
    (this.group.parent ?? this.group).getWorldPosition(planetWorld);
    const toStar = starWorldPosition.clone().sub(planetWorld);
    const toMoon = moonWorld.sub(planetWorld);
    toStar.y = 0;
    toMoon.y = 0;
    if (toStar.lengthSq() === 0 || toMoon.lengthSq() === 0) return LunarPhase.NEW_MOON;
    const angle = Math.atan2(toStar.x * toMoon.z - toStar.z * toMoon.x, toStar.dot(toMoon));
    return lunarPhaseFromAngle(angle);
  }
}
