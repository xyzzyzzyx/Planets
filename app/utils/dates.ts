/**
 * Interpret a number as a date using its digit count:
 *  - 0                → Unix epoch
 *  - 1–4 digits       → year (Jan 1, local time)
 *  - 5–7 digits       → Unix seconds
 *  - 8 digits         → YYYYMMDD
 *  - 9–10 digits      → Unix seconds
 *  - 11–12 digits     → YYYYMMDDHHMM
 *  - 13 digits        → Unix milliseconds
 *  - 14+ digits       → YYYYMMDDHHMMSS
 * Negative numbers use their absolute value.
 */
export function parseFlexibleDate(value: number): Date {
  const n = Math.trunc(Math.abs(value));
  if (!Number.isFinite(n) || n === 0) return new Date(0);
  const digits = n.toString().length;
  const local = (y: number, mo = 0, d = 1, h = 0, mi = 0, s = 0): Date => {
    const date = new Date(0);
    date.setFullYear(y, mo, d); // setFullYear avoids the two-digit-year quirk
    date.setHours(h, mi, s, 0);
    return date;
  };

  if (digits <= 4) return local(n);
  if (digits <= 7) return new Date(n * 1000);
  if (digits === 8) return local(Math.trunc(n / 1e4), Math.trunc((n % 1e4) / 100) - 1, n % 100);
  if (digits <= 10) return new Date(n * 1000);
  if (digits <= 12) {
    return local(Math.trunc(n / 1e8), Math.trunc((n % 1e8) / 1e6) - 1, Math.trunc((n % 1e6) / 1e4), Math.trunc((n % 1e4) / 100), n % 100);
  }
  if (digits === 13) return new Date(n);
  return local(
    Math.trunc(n / 1e10), Math.trunc((n % 1e10) / 1e8) - 1, Math.trunc((n % 1e8) / 1e6),
    Math.trunc((n % 1e6) / 1e4), Math.trunc((n % 1e4) / 100), n % 100,
  );
}

/** Format a date for an `<input type="datetime-local">` in the user's local time zone. */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (v: number, len = 2) => String(v).padStart(len, '0');
  const year = date.getFullYear();
  const yyyy = year < 0 ? `-${pad(-year, 6)}` : year > 9999 ? `+${pad(year, 6)}` : pad(year, 4);
  return `${yyyy}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parse the value of a `datetime-local` input as local time; null when invalid. */
export function parseDateTimeLocalValue(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}
