/**
 * Deterministic (seeded) procedural star-system generator used by the
 * "Jump" / travelToRandom feature.
 */
import { periodFromSemiMajorAxis } from '../shared/orbital.js';

/** Must match SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU on the client. */
export const SCENE_UNITS_PER_AU = 1496;

/** Mulberry32 PRNG — returns a function yielding floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `#rrggbb` from an integer, always 6 hex digits. */
export function hexColor(value) {
  const clamped = Math.max(0, Math.min(0xffffff, Math.floor(value)));
  return `#${clamped.toString(16).padStart(6, '0')}`;
}

/** Random colour whose channels lie in [base, base + spread). */
function channelColor(rng, base, spread) {
  return `#${base.map((c) => Math.min(255, Math.floor(c + rng() * spread)).toString(16).padStart(2, '0')).join('')}`;
}

export const STAR_TYPES = Object.freeze([
  { name: 'Red Dwarf', color: '#ffaa88', diameter: 0.4, mass: 0.3, temp: 3500 },
  { name: 'Orange Dwarf', color: '#ffcc88', diameter: 0.9, mass: 0.8, temp: 4800 },
  { name: 'Yellow Dwarf', color: '#ffffaa', diameter: 1.0, mass: 1.0, temp: 5800 },
  { name: 'White Dwarf', color: '#aaccff', diameter: 0.03, mass: 0.6, temp: 10000 },
  { name: 'Blue Giant', color: '#99bbff', diameter: 4.0, mass: 8.0, temp: 12000 },
]);

/** Planetary ring in client "visual" units (planet visual radius = diameter × 2). */
export function generateRandomRing(rng, bodyDiameter) {
  const visualRadius = bodyDiameter * 2;
  const inner = visualRadius * (1.3 + rng() * 1.2);
  return {
    name: `Ring-${Math.floor(rng() * 10000)}`,
    type: 'ring',
    inner,
    outer: inner * (1.3 + rng() * 0.8),
    thickness: 0.01 + rng() * 0.15,
    color: hexColor(rng() * 0xffffff),
    particleCount: Math.floor(rng() * 3000) + 500,
    rotationSpeed: 0.001 + rng() * 0.02,
    texture: '',
  };
}

export function generateRandomMoon(rng, planet, moonIndex) {
  const diameter = 0.01 + rng() * (planet.diameter * 0.15);
  return {
    name: `${planet.name}-Moon${moonIndex}`,
    type: 'moon',
    map: '',
    diameter,
    atmosphere: 0,
    widthSegments: 24,
    heightSegments: 24,
    mass: diameter ** 3 * 0.5,
    pow: 20,
    color: hexColor(rng() * 0xcccccc + 0x333333),
    period: 1 + rng() * 80,
    tilt: rng() * 10 - 5,
    spin: 0.005 + rng() * 0.03,
    eccentricity: rng() * 0.15,
    inclination: rng() * 8,
    M0: rng() * Math.PI * 2,
    semiMajorAxis: planet.diameter * (3 + rng() * 12),
    resource: '',
  };
}

export function generateRandomPlanet(rng, star, planetIndex) {
  const types = ['rocky', 'gas_giant', 'ice_giant'];
  const kind = types[Math.floor(rng() * types.length)];

  let diameter, mass, color, au;
  if (kind === 'rocky') {
    diameter = 0.4 + rng() * 2.0;
    mass = diameter ** 3 * (3 + rng() * 2);
    color = channelColor(rng, [0xa0, 0x90, 0x80], 0x60);
    au = 0.3 + planetIndex * (0.4 + rng() * 0.8);
  } else if (kind === 'gas_giant') {
    diameter = 6 + rng() * 8;
    mass = diameter ** 3 * (0.5 + rng() * 0.5);
    color = channelColor(rng, [0xd0, 0xb0, 0x80], 0x30);
    au = 1.5 + planetIndex * (1.0 + rng() * 1.5);
  } else {
    diameter = 3.5 + rng() * 4;
    mass = diameter ** 3 * (0.8 + rng() * 0.7);
    color = channelColor(rng, [0x80, 0xb0, 0xd0], 0x30);
    au = 2.5 + planetIndex * (1.2 + rng() * 1.8);
  }

  const planet = {
    name: `${star.name}-Planet${planetIndex + 1}`,
    type: 'planet',
    kind,
    map: '', bumpMap: '', specMap: '', cloudMap: '', alphaMap: '',
    diameter,
    atmosphere: rng() > 0.7 ? 0.005 : 0,
    widthSegments: 32,
    heightSegments: 32,
    mass,
    pow: 24,
    x: 0, y: 0, z: 0,
    au,
    color,
    period: periodFromSemiMajorAxis(au),
    tilt: rng() * 30 - 15,
    spin: 0.005 + rng() * 0.02,
    eccentricity: rng() * 0.25,
    inclination: rng() * 10,
    longitudeOfPerihelion: rng() * 360,
    M0: rng() * Math.PI * 2,
    moons: [],
    rings: [],
    resource: '',
  };

  const moonCount = Math.floor(rng() * 5);
  for (let m = 0; m < moonCount; m++) planet.moons.push(generateRandomMoon(rng, planet, m + 1));

  if ((kind === 'gas_giant' || kind === 'ice_giant') && rng() > 0.6) {
    planet.rings.push(generateRandomRing(rng, planet.diameter));
  }
  return planet;
}

export function generateRandomComet(rng, star, index) {
  const au = 5 + rng() * 200;
  return {
    name: `${star.name}-Comet${index + 1}`,
    type: 'comet',
    diameter: 0.00001 + rng() * 0.0001,
    mass: 1e12 + rng() * 1e14,
    pow: 14,
    color: hexColor(rng() * 0xffffff),
    au,
    // Kepler's third law keeps comet periods consistent with their orbit size.
    period: periodFromSemiMajorAxis(au),
    eccentricity: 0.5 + rng() * 0.49,
    inclination: rng() * 180,
    longitudeOfPerihelion: rng() * 360,
    M0: rng() * Math.PI * 2,
    tailLength: 0.3 + rng() * 1.5,
    tailColor: '#aaccff',
    comaSize: 2 + rng() * 6,
  };
}

/**
 * Generate a full star system from a numeric seed. The same seed always
 * yields the same system.
 */
export function generateRandomStarSystem(seed) {
  const safeSeed = Number.isFinite(seed) ? Math.abs(Math.floor(seed)) : 1;
  const rng = mulberry32(safeSeed);
  const type = STAR_TYPES[Math.floor(rng() * STAR_TYPES.length)];

  const star = {
    name: `Star-${safeSeed.toString(16).toUpperCase()}`,
    type: 'star',
    spectralClass: type.name,
    temperature: type.temp,
    map: '', bumpMap: '', specMap: '',
    diameter: type.diameter * (0.8 + rng() * 0.5),
    atmosphere: 0,
    widthSegments: 128,
    heightSegments: 128,
    mass: type.mass * (0.8 + rng() * 0.4),
    pow: 30,
    x: 0, y: 0, z: 0,
    au: 0,
    color: type.color,
    period: 0,
    tilt: rng() * 20 - 10,
    spin: 0.001 + rng() * 0.008,
    planets: [],
    rings: [],
    comets: [],
    resource: '',
  };
  if (rng() > 0.4) {
    star.magneticField = {
      strength: rng() * 20,
      radius: 1.5 + rng() * 4,
      tilt: rng() * 15,
      polarity: rng() > 0.5 ? 1 : -1,
    };
  }

  const planetCount = Math.floor(rng() * 9) + 1;
  for (let p = 0; p < planetCount; p++) star.planets.push(generateRandomPlanet(rng, star, p));
  star.planets.sort((a, b) => a.au - b.au);

  const cometCount = Math.floor(rng() * 5) + 2; // 2–6
  for (let c = 0; c < cometCount; c++) star.comets.push(generateRandomComet(rng, star, c));

  // Belts are in scene units (AU × 1496) like the Sun's asteroid and Kuiper belts.
  const beltCount = Math.floor(rng() * 5) + 2; // 2–6
  for (let b = 0; b < beltCount; b++) {
    const inner = (0.5 + rng() * 30) * SCENE_UNITS_PER_AU;
    star.rings.push({
      name: `${star.name}-Belt${b + 1}`,
      type: 'ring',
      inner,
      outer: inner * (1.2 + rng() * 0.8),
      thickness: 0.1 + rng() * 0.5,
      color: hexColor(rng() * 0xaaaaaa + 0x555555),
      particleCount: Math.floor(rng() * 12000) + 3000,
      period: 0,
      keplerianRotation: true,
    });
  }
  return star;
}

/** Random position in the galactic disc (scene units). */
export function randomGalaxyPosition(rng = Math.random) {
  const r = (3 + rng() * 12) * 5000;
  const angle = rng() * Math.PI * 2;
  return { x: Math.cos(angle) * r, y: 0, z: Math.sin(angle) * r };
}
