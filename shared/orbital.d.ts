export interface KeplerianElements {
  /** Sidereal period in days. */
  period?: number;
  /** Mean anomaly at J2000 in radians. */
  M0?: number;
  eccentricity?: number;
}

export interface Vec3 { x: number; y: number; z: number; }

export declare const TWO_PI: number;
export declare const MS_PER_DAY: number;
export declare const DAYS_PER_YEAR: number;
export declare const J2000_MS: number;
export declare const MAX_DATE_MS: number;
export declare const MAX_ECCENTRICITY: number;

export declare function normalizeAngle(rad: number): number;
export declare function clampEccentricity(e: number): number;
export declare function solveEccentricAnomaly(meanAnomaly: number, eccentricity: number, tolerance?: number, maxIterations?: number): number;
export declare function trueAnomalyFromEccentric(E: number, eccentricity: number): number;
export declare function solveKepler(meanAnomaly: number, eccentricity: number): number;
export declare function meanAnomalyFromTrue(trueAnomaly: number, eccentricity: number): number;
export declare function periodFromSemiMajorAxis(au: number): number;
export declare function daysSinceJ2000(timeMs: number): number;
export declare function meanAnomalyAt(body: KeplerianElements | null | undefined, timeMs: number): number;
export declare function trueAnomalyAt(body: KeplerianElements | null | undefined, timeMs: number): number;
export declare function orbitalRadius(a: number, eccentricity: number, nu: number): number;
export declare function orbitalPosition(a: number, eccentricity: number, nu: number, inclinationDeg?: number, longitudeOfPerihelionDeg?: number, longitudeOfAscendingNodeDeg?: number): Vec3;
export declare function eclipticLongitude(nu: number, longitudeOfPerihelionDeg?: number): number;
export declare function clampDateMs(ms: number): number;
export declare function computeTrueAnomalies(star: unknown, timeMs: number, defaultRingPeriodDays?: number): Record<string, number>;
