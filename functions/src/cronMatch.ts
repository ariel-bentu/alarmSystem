// Pure cron-style field matching for the single scheduled dispatcher.
//
// One Cloud Scheduler job (doSchedule, every 1 minute) fans out to every
// periodic task via a declarative table, instead of one onSchedule() per
// task. Cloud Scheduler allows only 3 free jobs per BILLING ACCOUNT, so the
// per-task shape put a hard ceiling on how much periodic work this project
// could ever have. With a dispatcher the ceiling is gone and adding a task
// is a table row, not a deployment decision.

/** "*" = every value; a number matches exactly; an array matches any member. */
export type CronField = "*" | number | number[];

/**
 * True when `value` satisfies `field`.
 *
 * Loose (==) comparison is deliberate: table entries are hand-written and a
 * weekDay of "0" should behave like 0. Everything here is small integers
 * from Date getters, so there is no surprising coercion to guard against.
 */
export function matchField(field: CronField | undefined, value: number): boolean {
  if (field === undefined) return false;
  if (field === "*") return true;
  if (Array.isArray(field)) return field.some((v) => Number(v) === value);
  return Number(field) === value;
}

export interface CronSpec {
  min: CronField;
  hour: CronField;
  weekDay: CronField;
}

/** True when all three fields match — i.e. this task is due this minute. */
export function isDue(
  spec: CronSpec,
  now: { minute: number; hour: number; weekDay: number }
): boolean {
  return (
    matchField(spec.min, now.minute) &&
    matchField(spec.hour, now.hour) &&
    matchField(spec.weekDay, now.weekDay)
  );
}
