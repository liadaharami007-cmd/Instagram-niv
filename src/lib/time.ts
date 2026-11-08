export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    fmtCache.set(tz, f);
  }
  return f;
}

function parts(ts: number, tz: string) {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

/** YYYY-MM-DD of a timestamp in the given IANA time zone. */
export const dayKey = (ts: number, tz: string) => parts(ts, tz).day;
export const hourIn = (ts: number, tz: string) => parts(ts, tz).hour;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Adds n days to a YYYY-MM-DD key (calendar arithmetic, tz-independent). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** UTC timestamp of local midnight that starts `day` in `tz`. */
export function startOfDay(day: string, tz: string): number {
  // Start from UTC midnight and correct by the zone offset (two passes handle DST edges).
  let guess = Date.parse(`${day}T00:00:00Z`);
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, tz);
    const hh = String(p.hour).padStart(2, '0');
    const mm = String(p.minute).padStart(2, '0');
    const localAsUtc = Date.parse(`${p.day}T${hh}:${mm}:00Z`) + (guess % MINUTE);
    guess -= localAsUtc - Date.parse(`${day}T00:00:00Z`);
  }
  return guess;
}

export function daysBetween(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) out.push(d);
  return out;
}
