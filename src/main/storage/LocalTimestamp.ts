/** One user-local business timestamp persisted alongside a sortable instant. */
export interface LocalStorageTimestamp {
  localDateTime: string;
  epochMilliseconds: number;
  timeZone: string;
}

/** Formats one instant in the operating system's current local timezone. */
export function localTimestampForEpochMilliseconds(epochMilliseconds: number): LocalStorageTimestamp {
  if (!Number.isFinite(epochMilliseconds) || epochMilliseconds <= 0) {
    throw new TypeError('A local storage timestamp requires a positive millisecond timestamp.');
  }

  const date = new Date(epochMilliseconds);
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    ?? `UTC${offsetSign}${twoDigits(Math.floor(absoluteOffsetMinutes / 60))}:${twoDigits(absoluteOffsetMinutes % 60)}`;

  return {
    localDateTime: [
      `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`,
      `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}.${threeDigits(date.getMilliseconds())}`
    ].join('T') + `${offsetSign}${twoDigits(Math.floor(absoluteOffsetMinutes / 60))}:${twoDigits(absoluteOffsetMinutes % 60)}`,
    epochMilliseconds,
    timeZone
  };
}

/** Parses a SQLite timestamp value that may be legacy epoch data or local ISO text. */
export function epochMillisecondsFromStoredTimestamp(
  value: unknown,
  legacyUnit: 'milliseconds' | 'seconds'
): number | null {
  if (typeof value === 'number') {
    return normalizeEpochMilliseconds(value, legacyUnit);
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    return normalizeEpochMilliseconds(Number(trimmed), legacyUnit);
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Returns true when a value has the format written by this module. */
export function isLocalStorageTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(value);
}

function normalizeEpochMilliseconds(value: number, legacyUnit: 'milliseconds' | 'seconds'): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const epochMilliseconds = legacyUnit === 'seconds' ? Math.round(value * 1_000) : Math.round(value);
  return epochMilliseconds > 0 ? epochMilliseconds : null;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function threeDigits(value: number): string {
  return String(value).padStart(3, '0');
}
