// Cloud Function: doSchedule — THE ONLY scheduled function in this project.
//
// Runs every minute and fans out to the task table below. Cloud Scheduler
// allows only 3 free jobs per BILLING ACCOUNT, and one onSchedule() per task
// burned that budget fast enough that adding any periodic work became a
// deployment decision rather than a code change. With a dispatcher there is
// one job forever and a new task is one table row.
//
// ADD PERIODIC WORK HERE. Do not create another onSchedule().
//
// Fields are cron-style: "*" = every, a number = exactly, an array = any of.
//   min: 0,        hour: 12,       weekDay: "*"   -> daily at 12:00
//   min: "*",      hour: "*",      weekDay: "*"   -> every minute
//   min: [0, 30],  hour: "*",      weekDay: "*"   -> twice an hour
//   min: 0,        hour: 20,       weekDay: 6     -> Saturdays at 20:00
//
// Times resolve in Asia/Jerusalem (timeZone below), so a "daily at noon"
// task runs at local noon year-round, across DST, without conversion.
// weekDay is 0=Sunday..6=Saturday, matching Date.getDay().

import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { CronSpec, isDue } from "./cronMatch";
import { scheduleTick } from "./scheduleTick";
import { deadSensorCheck } from "./deadSensorCheck";
import { checkDeviceLiveness } from "./deviceLiveness";

const TIME_ZONE = "Asia/Jerusalem";

interface ScheduledTask extends CronSpec {
  desc: string;
  callback: () => Promise<void>;
}

const schedules: ScheduledTask[] = [
  {
    desc: "Fire due arm/disarm schedule edges",
    min: "*",
    hour: "*",
    weekDay: "*",
    callback: scheduleTick,
  },
  {
    desc: "Device offline / back-online alerts",
    min: "*",
    hour: "*",
    weekDay: "*",
    // Every minute because the armed threshold is 5 minutes — a coarser
    // cadence would blunt the alert that matters most.
    callback: () => checkDeviceLiveness(Date.now()),
  },
  {
    desc: "Dead sensor + stale battery alerts, RTDB event retention",
    min: 0,
    hour: 12,
    weekDay: "*",
    callback: deadSensorCheck,
  },
];

/** Local wall-clock parts in TIME_ZONE, so the table reads as local time. */
function nowParts(at: Date): { minute: number; hour: number; weekDay: number } {
  // Intl rather than a date library: this codebase already resolves zones
  // with Intl (see nextOccurrence.ts) and adding dayjs for three integers
  // would be the only reason it exists here.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(at);

  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";

  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")),
    weekDay: weekdayNames.indexOf(get("weekday")),
  };
}

export const doSchedule = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: TIME_ZONE,
    region: "europe-west1",
    timeoutSeconds: 300,
  },
  async () => {
    const now = nowParts(new Date());

    // Every task is isolated: one failing task must never prevent the others
    // from running this minute. allSettled rather than all — a rejection
    // from, say, a Telegram outage must not skip a due arm/disarm edge.
    const results = await Promise.allSettled(
      schedules
        .filter((task) => isDue(task, now))
        .map(async (task) => {
          logger.info("Scheduled Task", task.desc);
          try {
            await task.callback();
          } catch (err) {
            logger.error(`Scheduled task failed: ${task.desc}`, err);
            throw err;
          }
        })
    );

    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      logger.error(`doSchedule: ${failed} task(s) failed this minute`);
    }
  }
);
