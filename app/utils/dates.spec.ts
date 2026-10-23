import { parseDateTimeLocalValue, parseFlexibleDate, toDateTimeLocalValue } from './dates';

describe('parseFlexibleDate', () => {
  const local = (y: number, mo = 0, d = 1, h = 0, mi = 0, s = 0) => {
    const date = new Date(0);
    date.setFullYear(y, mo, d);
    date.setHours(h, mi, s, 0);
    return date.getTime();
  };

  it.each([
    [0, 0],
    [1974, local(1974)],
    [99, local(99)], // no two-digit-year quirk
    [-2050, local(2050)],
    [20241215, local(2024, 11, 15)],
    [12_345, 12_345_000], // 5-digit seconds
    [1_700_000_000, 1_700_000_000_000], // 10-digit seconds
    [202412151430, local(2024, 11, 15, 14, 30)],
    [1_700_000_000_123, 1_700_000_000_123],
    [20241215143045, local(2024, 11, 15, 14, 30, 45)],
  ])('parseFlexibleDate(%d)', (input, expected) => {
    expect(parseFlexibleDate(input).getTime()).toBe(expected);
  });

  it('treats non-finite input as the epoch', () => {
    expect(parseFlexibleDate(NaN).getTime()).toBe(0);
  });
});

describe('datetime-local helpers', () => {
  it('formats in local time (not UTC) and round-trips', () => {
    const date = new Date(2061, 6, 28, 9, 5);
    const value = toDateTimeLocalValue(date);
    expect(value).toBe('2061-07-28T09:05');
    expect(parseDateTimeLocalValue(value)).toBe(date.getTime());
  });

  it('pads small and extended years', () => {
    const early = new Date(0);
    early.setFullYear(5, 0, 2);
    early.setHours(3, 4);
    expect(toDateTimeLocalValue(early)).toBe('0005-01-02T03:04');
    const far = new Date(0);
    far.setFullYear(12345, 0, 1);
    far.setHours(0, 0);
    expect(toDateTimeLocalValue(far)).toBe('+012345-01-01T00:00');
  });

  it('rejects empty or invalid input', () => {
    expect(parseDateTimeLocalValue('')).toBeNull();
    expect(parseDateTimeLocalValue('not-a-date')).toBeNull();
  });
});
