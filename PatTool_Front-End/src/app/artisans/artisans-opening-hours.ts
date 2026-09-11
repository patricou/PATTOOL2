/** OSM opening_hours: true when the place is closed right now. Unknown specs stay open. */

const DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const;
const TIME_RANGE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;
const DAY_RANGE = /(mo|tu|we|th|fr|sa|su)\s*-\s*(mo|tu|we|th|fr|sa|su)/g;
const DAY_ONE = /\b(mo|tu|we|th|fr|sa|su)\b/g;
const ALL_DAYS = 0b1111111;

export function isEstablishmentClosed(
  item: { closed?: boolean; openingHours?: string } | null | undefined,
  now = new Date()
): boolean {
  if (!item) {
    return false;
  }
  if (item.closed === true) {
    return true;
  }
  return isClosedByHours(item.openingHours, now);
}

export function isClosedByHours(spec: string | undefined | null, now = new Date()): boolean {
  if (!spec || !spec.trim()) {
    return false;
  }
  const folded = spec.trim().toLowerCase().replace(/[\u2013\u2014]/g, '-');
  if (folded === 'closed' || folded === 'off' || folded.includes('permanently closed')) {
    return true;
  }
  if (folded.includes('24/7')) {
    return false;
  }
  const closed = evaluate(folded, now);
  return closed === true;
}

function evaluate(spec: string, now: Date): boolean | null {
  const todayIdx = (now.getDay() + 6) % 7;
  const minutes = now.getHours() * 60 + now.getMinutes();
  let parsed = false;
  let open = false;
  let todayRule = false;
  for (const raw of spec.split(';')) {
    const rule = raw.trim();
    if (!rule || rule.startsWith('ph') || rule.startsWith('sh')) {
      continue;
    }
    parsed = true;
    const days = parseDays(rule);
    if ((days & (1 << todayIdx)) === 0) {
      continue;
    }
    todayRule = true;
    if (/\boff\b/.test(rule) || (/\bclosed\b/.test(rule) && !/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/.test(rule))) {
      open = false;
      continue;
    }
    TIME_RANGE.lastIndex = 0;
    let hasTime = false;
    let inRange = false;
    let match: RegExpExecArray | null;
    while ((match = TIME_RANGE.exec(rule))) {
      hasTime = true;
      const start = toMinutes(match[1], match[2]);
      const end = toMinutes(match[3], match[4]);
      if (start == null || end == null) {
        continue;
      }
      if (inTimeRange(minutes, start, end)) {
        inRange = true;
        break;
      }
    }
    if (hasTime) {
      open = inRange;
    }
  }
  if (!parsed) {
    return null;
  }
  if (!todayRule) {
    return true;
  }
  return !open;
}

function parseDays(rule: string): number {
  let mask = 0;
  DAY_RANGE.lastIndex = 0;
  let range: RegExpExecArray | null;
  while ((range = DAY_RANGE.exec(rule))) {
    const from = DAYS.indexOf(range[1] as typeof DAYS[number]);
    const to = DAYS.indexOf(range[2] as typeof DAYS[number]);
    if (from < 0 || to < 0) {
      continue;
    }
    let d = from;
    while (true) {
      mask |= 1 << d;
      if (d === to) {
        break;
      }
      d = (d + 1) % 7;
    }
  }
  DAY_ONE.lastIndex = 0;
  let one: RegExpExecArray | null;
  while ((one = DAY_ONE.exec(rule))) {
    const idx = DAYS.indexOf(one[1] as typeof DAYS[number]);
    if (idx >= 0) {
      mask |= 1 << idx;
    }
  }
  return mask === 0 ? ALL_DAYS : mask;
}

function toMinutes(hour: string, minute: string): number | null {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    return null;
  }
  if (h === 24 && m === 0) {
    return 24 * 60;
  }
  return h * 60 + m;
}

function inTimeRange(clock: number, start: number, end: number): boolean {
  if (end <= start) {
    return clock >= start || clock < end;
  }
  return clock >= start && clock < end;
}
