/** Logarithmic slider ↔ value mappings used by the dashboard speed controls. */

export const SIM_SPEED_MIN = 0.25;
export const SIM_SPEED_MAX = 1e12;
export const CAM_SPEED_MIN = 3;
export const CAM_SPEED_MAX = 50_000;
export const CAM_SPEED_DEFAULT = 3000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Map slider position [0,100] onto [min,max] logarithmically. */
export function logSliderToValue(position: number, min: number, max: number): number {
  return min * Math.pow(max / min, clamp(position, 0, 100) / 100);
}

/** Inverse of {@link logSliderToValue}. */
export function valueToLogSlider(value: number, min: number, max: number): number {
  return (Math.log(clamp(value, min, max) / min) / Math.log(max / min)) * 100;
}

/** Snap a simulation speed to ¼, ½, 1 or a power of ten. */
export function snapSimSpeed(value: number): number {
  if (!(value > 0)) return SIM_SPEED_MIN;
  if (value < 1) {
    if (value < 0.375) return 0.25;
    if (value < 0.75) return 0.5;
    return 1;
  }
  return Math.pow(10, Math.round(Math.log10(value)));
}

/** Human-readable speed multiplier: 0.25×, 10×, 5K×, 3M×, 1B×, 2T×. */
export function formatSpeed(speed: number): string {
  if (!Number.isFinite(speed)) return '—';
  if (speed < 1) return `${speed.toFixed(2)}×`;
  const units: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) if (speed >= size) return `${(speed / size).toFixed(0)}${suffix}×`;
  return `${speed.toFixed(0)}×`;
}
