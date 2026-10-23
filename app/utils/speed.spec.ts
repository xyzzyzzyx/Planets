import {
  CAM_SPEED_DEFAULT, CAM_SPEED_MAX, CAM_SPEED_MIN, SIM_SPEED_MAX, SIM_SPEED_MIN,
  formatSpeed, logSliderToValue, snapSimSpeed, valueToLogSlider,
} from './speed';

describe('log slider mapping', () => {
  it('maps the ends of the slider to min and max', () => {
    expect(logSliderToValue(0, SIM_SPEED_MIN, SIM_SPEED_MAX)).toBeCloseTo(SIM_SPEED_MIN);
    expect(logSliderToValue(100, SIM_SPEED_MIN, SIM_SPEED_MAX)).toBeCloseTo(SIM_SPEED_MAX, -3);
  });

  it('clamps out-of-range positions and values', () => {
    expect(logSliderToValue(-10, 1, 100)).toBe(1);
    expect(logSliderToValue(500, 1, 100)).toBe(100);
    expect(valueToLogSlider(0.0001, 1, 100)).toBe(0);
    expect(valueToLogSlider(1e9, 1, 100)).toBe(100);
  });

  it('is invertible (camera speed uses one consistent mapping)', () => {
    for (const v of [CAM_SPEED_MIN, 10, CAM_SPEED_DEFAULT, 12_345, CAM_SPEED_MAX]) {
      expect(logSliderToValue(valueToLogSlider(v, CAM_SPEED_MIN, CAM_SPEED_MAX), CAM_SPEED_MIN, CAM_SPEED_MAX)).toBeCloseTo(v, 6);
    }
  });
});

describe('snapSimSpeed', () => {
  it.each([
    [0.1, 0.25], [0.3, 0.25], [0.5, 0.5], [0.8, 1], [1, 1], [2.9, 1], [3.3, 10], [30, 10], [40, 100], [600, 1000], [0, SIM_SPEED_MIN], [NaN, SIM_SPEED_MIN],
  ])('%f → %f', (input, expected) => {
    expect(snapSimSpeed(input)).toBe(expected);
  });
});

describe('formatSpeed', () => {
  it.each([
    [0.25, '0.25×'], [1, '1×'], [999, '999×'], [5000, '5K×'], [3e6, '3M×'], [1e9, '1B×'], [2e12, '2T×'], [Infinity, '—'],
  ])('%f → %s', (input, expected) => {
    expect(formatSpeed(input)).toBe(expected);
  });
});
