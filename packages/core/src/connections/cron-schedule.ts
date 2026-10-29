/**
 * Five-field cron schedules (`minute hour day-of-month month day-of-week`) in
 * an IANA timezone, for `cron()` (spec 35 § Triggers). Each field takes `*`,
 * numbers, lists (`1,15`), ranges (`1-5`) and steps (`*\/15`, `0-30/10`).
 * Day-of-week runs 0–6 from Sunday (7 is Sunday too). When both day fields
 * are restricted, a time matches if either does, as in classic cron.
 */

import { invalidConnectionError } from './errors';

//#region Types

/** A parsed schedule. */
export interface CronSchedule {
  readonly source: string;
  readonly timezone: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  readonly anyDay: boolean;
  readonly anyWeekday: boolean;
}

interface ZonedParts {
  readonly minute: number;
  readonly hour: number;
  readonly day: number;
  readonly month: number;
  readonly weekday: number;
}

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

//#endregion

//#region Constants

const MINUTE_FIELD: FieldSpec = {
  name: 'minute',
  min: 0,
  max: 59,
};
const HOUR_FIELD: FieldSpec = {
  name: 'hour',
  min: 0,
  max: 23,
};
const DAY_FIELD: FieldSpec = {
  name: 'day-of-month',
  min: 1,
  max: 31,
};
const MONTH_FIELD: FieldSpec = {
  name: 'month',
  min: 1,
  max: 12,
};
const WEEKDAY_FIELD: FieldSpec = {
  name: 'day-of-week',
  min: 0,
  max: 7,
};
const FIELD_COUNT = 5;

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const MINUTE_MS = 6e4;
/** How far ahead `nextRun` searches before giving up (a little over four years, for Feb 29). */
const SEARCH_LIMIT_MS = 4 * 366 * 24 * 3600e3;

//#endregion

//#region Helpers

function badSchedule(source: string, detail: string): Error {
  return invalidConnectionError(
    `cron schedule '${source}' is invalid: ${detail}.`,
    "Use five fields — minute hour day-of-month month day-of-week — e.g. '0 8 * * 1-5'.",
  );
}

function parseNumber(text: string, field: FieldSpec, source: string): number {
  if (!/^\d+$/.test(text)) {
    throw badSchedule(source, `'${text}' in the ${field.name} field is not a number`);
  }
  const value = Number(text);
  if (value < field.min || value > field.max) {
    throw badSchedule(source, `${value} is outside ${field.min}-${field.max} for ${field.name}`);
  }
  return value;
}

function parsePart(part: string, field: FieldSpec, source: string): number[] {
  const [rangeText = '', stepText] = part.split('/');
  const step =
    stepText === undefined
      ? 1
      : parseNumber(
          stepText,
          {
            ...field,
            min: 1,
            max: field.max,
          },
          source,
        );
  let start = field.min;
  let end = field.max;
  if (rangeText !== '*') {
    const [from = '', to] = rangeText.split('-');
    start = parseNumber(from, field, source);
    end =
      to === undefined
        ? stepText === undefined
          ? start
          : field.max
        : parseNumber(to, field, source);
  }
  if (start > end) {
    throw badSchedule(source, `range ${start}-${end} in ${field.name} runs backwards`);
  }
  const values: number[] = [];
  for (let v = start; v <= end; v += step) {
    values.push(v);
  }
  return values;
}

function parseField(text: string, field: FieldSpec, source: string): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    for (const value of parsePart(part, field, source)) {
      values.add(field.name === 'day-of-week' && value === 7 ? 0 : value);
    }
  }
  return values;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    minute: 'numeric',
    hour: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
  });
  formatters.set(timezone, formatter);
  return formatter;
}

function zonedParts(ms: number, timezone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timezone).formatToParts(ms)) {
    parts[part.type] = part.value;
  }
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAYS[parts.weekday ?? 'Sun'] ?? 0,
  };
}

function dayMatches(schedule: CronSchedule, parts: ZonedParts): boolean {
  const dayOk = schedule.days.has(parts.day);
  const weekdayOk = schedule.weekdays.has(parts.weekday);
  if (schedule.anyDay) {
    return weekdayOk;
  }
  if (schedule.anyWeekday) {
    return dayOk;
  }
  return dayOk || weekdayOk;
}

/** Minutes to skip from a non-matching time: to the next hour or the next day where possible. */
function skipMinutes(schedule: CronSchedule, parts: ZonedParts): number {
  if (!schedule.months.has(parts.month) || !dayMatches(schedule, parts)) {
    return (23 - parts.hour) * 60 + (60 - parts.minute);
  }
  if (!schedule.hours.has(parts.hour)) {
    return 60 - parts.minute;
  }
  return 1;
}

//#endregion

//#region Public API

/**
 * Parses a five-field cron schedule.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` for a malformed schedule or timezone.
 */
export function parseCronSchedule(source: string, timezone = 'UTC'): CronSchedule {
  const fields = source.trim().split(/\s+/);
  if (fields.length !== FIELD_COUNT) {
    throw badSchedule(source, `expected 5 fields, got ${fields.length}`);
  }
  try {
    formatterFor(timezone);
  } catch {
    throw invalidConnectionError(
      `cron timezone '${timezone}' is not a known IANA timezone.`,
      "Use a timezone such as 'UTC' or 'America/New_York'.",
    );
  }
  const [minute = '', hour = '', day = '', month = '', weekday = ''] = fields;
  return {
    source,
    timezone,
    minutes: parseField(minute, MINUTE_FIELD, source),
    hours: parseField(hour, HOUR_FIELD, source),
    days: parseField(day, DAY_FIELD, source),
    months: parseField(month, MONTH_FIELD, source),
    weekdays: parseField(weekday, WEEKDAY_FIELD, source),
    anyDay: day === '*',
    anyWeekday: weekday === '*',
  };
}

/** Whether the minute starting at `ms` matches the schedule. */
export function cronMatches(schedule: CronSchedule, ms: number): boolean {
  const parts = zonedParts(ms, schedule.timezone);
  return (
    schedule.minutes.has(parts.minute) &&
    schedule.hours.has(parts.hour) &&
    schedule.months.has(parts.month) &&
    dayMatches(schedule, parts)
  );
}

/**
 * The first scheduled minute strictly after `afterMs`, as epoch ms.
 * @returns `undefined` when nothing matches within four years.
 */
export function nextCronRun(schedule: CronSchedule, afterMs: number): number | undefined {
  let ms = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = afterMs + SEARCH_LIMIT_MS;
  while (ms <= limit) {
    const parts = zonedParts(ms, schedule.timezone);
    if (
      schedule.minutes.has(parts.minute) &&
      schedule.hours.has(parts.hour) &&
      schedule.months.has(parts.month) &&
      dayMatches(schedule, parts)
    ) {
      return ms;
    }
    ms += skipMinutes(schedule, parts) * MINUTE_MS;
  }
  return undefined;
}

//#endregion
