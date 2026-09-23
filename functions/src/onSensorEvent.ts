// Cloud Function: onSensorEvent
// Trigger: RTDB onValueCreated on /{projectId}/events/{rfId}/{timestamp}

import { onValueCreated } from "firebase-functions/v2/database";
import { Timestamp } from "firebase-admin/firestore";
import { db, rtdb } from "./admin";
import { AlarmEvent, EventType, Project, Sensor, Rule } from "./types";
import { sendTelegram, formatSensorAlert, formatAlarm } from "./telegram";
import { evaluateRules } from "./alarmLogic";
import { applicableRules } from "./alwaysRules";
import { keruiEventOf, nibbleOf, familyIdOf } from "./keruiEvent";
import { sensorFamilyId } from "./sensorFamily";
import { classifyEvent, eventFromReport } from "./sensorEventPolicy";

export const onSensorEvent = onValueCreated(
  { ref: "/{projectId}/events/{rfId}/{timestamp}", region: "europe-west1" },
  async (event) => {
    const projectId = event.params.projectId;
    const rfId = event.params.rfId;
    const timestamp = Number(event.params.timestamp);
    const data = event.data.val() as { event: string; battery_low: boolean; rssi: number };

    // (a) Look up the sensor by FAMILY — the top 20 bits of the code.
    //
    // Not a `where("rfId", "==", rfId)` query any more: the bottom nibble is
    // an event code, so one physical sensor sends several 24-bit codes and
    // an exact match found only the one it happened to be paired on. A
    // tamper (0x0061DB) did not match its own paired motion code (0x0061DA)
    // and was logged as an unpaired sensor, invisible to rules and alerts.
    //
    // Firestore cannot query "top 20 bits equal", so this reads the sensors
    // collection and matches in memory. That is a dozen docs, already the
    // shape onAlarm and buildConfig use, and it removes an index dependency.
    const family = familyIdOf(rfId);
    const allSensorsSnap = await db
      .collection(`projects/${projectId}/sensors`)
      .get();
    const matching = allSensorsSnap.docs.filter(
      (d) =>
        family !== null &&
        sensorFamilyId({
          rfId: String(d.data().rfId ?? ""),
          familyId: d.data().familyId,
        }) === family
    );
    const sensorSnap = { empty: matching.length === 0, docs: matching };

    if (sensorSnap.empty) {
      // Deliberately NOT mirrored to Firestore: an unpaired sensor has no
      // name, no profile membership and no rules, so there is nothing
      // meaningful to write to the timeline. The RTDB event itself is left
      // in place, which is what makes pairing possible — the web UI's
      // Sensors tab reads /{projectId}/events directly and lists any rfId
      // with no matching Firestore sensor as "unrecognised", ready to pair
      // (see web/src/features/configure/unknownSensors.ts). Dropping the
      // RTDB node here would make new sensors impossible to discover.
      console.log(
        `Unpaired sensor rfId=${rfId} in project=${projectId}: kept in RTDB ` +
          `for pairing, not mirrored to Firestore.`
      );
      return;
    }

    const sensorDoc = sensorSnap.docs[0];
    const sensor = { id: sensorDoc.id, ...sensorDoc.data() } as Sensor;

    // Determine the event from the CODE'S OWN NIBBLE, with the device's
    // reported string as an override.
    //
    // Previously this read `data.event === "tamper"` — but the firmware
    // hardcodes "trigger", so the tamper branch had never once run and the
    // `tamper` type existed end to end while nothing emitted it. The nibble
    // is the actual evidence, and it works for events the firmware does not
    // yet distinguish, which is why the cloud half of this ships first and
    // delivers tamper/water/battery-low alerting on its own.
    const nibble = nibbleOf(rfId);
    const keruiEvent = eventFromReport(
      data.event,
      nibble === null ? "unknown" : keruiEventOf(nibble)
    );
    const policy = classifyEvent(keruiEvent);
    // battery_low as a FLAG still wins over a plain trigger, so a sensor
    // that sets the flag on an ordinary packet is not downgraded.
    const eventType: EventType =
      policy.eventType === "trigger" && data.battery_low
        ? "battery_low"
        : policy.eventType;

    // (b) Mirror to Firestore events. Every event type is mirrored,
    // including `close` — the timeline is the complete history even of
    // events that drive nothing.
    const alarmEvent: Omit<AlarmEvent, "id"> = {
      sensorId: sensor.id,
      rfId,
      sensorName: sensor.name,
      eventType,
      batteryLow: data.battery_low,
      rssi: data.rssi,
      timestamp: Timestamp.fromMillis(timestamp),
    };

    const eventRef = await db
      .collection(`projects/${projectId}/events`)
      .add(alarmEvent);

    // (c) Update sensor.lastSeen, batteryStatus, and clear any dead-sensor
    // alert. Also backfill familyId on a doc that predates the migration, so
    // matching stops depending on the rfId-derived fallback over time.
    const updates: Record<string, unknown> = {
      lastSeen: Timestamp.fromMillis(timestamp),
      deadAlertSentAt: null,
    };
    if (data.battery_low) updates.batteryStatus = "low";
    if (!sensor.familyId && family !== null) updates.familyId = family;

    // A normal trigger means the condition that caused a once-only alert is
    // over: the sensor is dry again, or its battery was replaced. Clearing
    // the markers here is what makes "once" mean ONCE PER CONDITION rather
    // than once ever — the same shape deadAlertSentAt already uses.
    if (keruiEvent === "trigger" || keruiEvent === "unknown") {
      if (!data.battery_low) updates.batteryAlertSentAt = null;
      updates.waterAlertSentAt = null;
    }

    // Whether a once-only alert has already been sent for this condition.
    // Read BEFORE the update, or the write below would clear the very marker
    // being tested and every packet would notify.
    const alreadyAlerted =
      policy.onceMarker !== null && sensor[policy.onceMarker] != null;
    if (policy.onceMarker !== null && !alreadyAlerted) {
      updates[policy.onceMarker] = Timestamp.fromMillis(timestamp);
    }

    await sensorDoc.ref.update(updates);

    // (d) Get project for Telegram config
    const projectDoc = await db.doc(`projects/${projectId}`).get();
    if (!projectDoc.exists) return;
    const project = { id: projectDoc.id, ...projectDoc.data() } as Project;

    // Send a Telegram alert, only if enabled for this project. Safety events
    // (tamper, water, battery-low) always notify regardless of the toggle:
    // notifyEverySensorTrigger exists to silence routine motion, not to hide
    // a tampered sensor or a leak.
    //
    // `close` is never notified (policy.notify === false), and water /
    // battery_low are suppressed once their marker is set, so a leaking
    // sensor sends one message rather than one every few seconds.
    const alwaysNotify =
      policy.alwaysNotify || eventType === "battery_low";
    if (
      policy.notify &&
      !alreadyAlerted &&
      (project.notifyEverySensorTrigger !== false || alwaysNotify) &&
      project.telegramBotToken &&
      project.telegramChatId
    ) {
      const msg = formatSensorAlert(sensor.name, eventType);
      await sendTelegram(project.telegramBotToken, project.telegramChatId, msg);
    }

    // (d2) TAMPER SIRENS EVEN WHILE DISARMED, and never goes through rule
    // evaluation.
    //
    // That is the threat: an intruder disabling sensors before a break-in
    // does it while the house is empty and the system may well be disarmed.
    // This mirrors the existing `always` rule semantics (smoke, gas) rather
    // than inventing a second mechanism, and it applies ONLY to a PAIRED
    // sensor — an unpaired tamper returned above, left for pairing exactly
    // as an unpaired trigger is.
    //
    // Accepted cost: changing a PIR battery sounds the siren. There is no
    // suppression mechanism by design — silence it with Disarm, which also
    // reaches the device over the LAN.
    //
    // Honours serverActions.triggerSiren, which is the project's "may the
    // server sound the siren at all" switch; the device-side sirenEnabled is
    // its own gate on the firmware path.
    if (keruiEvent === "tamper") {
      await rtdb
        .ref(`${projectId}/state/alarm_cause`)
        .set({ label: `${sensor.name} tampered`, at: Date.now() });
      if (project.serverActions.triggerSiren) {
        await rtdb.ref(`${projectId}/state/siren_active`).set(true);
      }
      // No rule evaluation for tamper — return before it.
      return;
    }

    // Events that drive nothing stop here: close, water and battery_low are
    // recorded and (for the latter two) notified, but never fed to the alarm
    // rules. Only a trigger can raise an alarm.
    if (!policy.evaluateRules) return;

    // (e) Server-side alarm evaluation.
    //
    // Disarmed no longer means "evaluate nothing": always-rules (smoke, gas)
    // fire regardless. Arm state now selects WHICH rules apply, and the
    // evaluation below is shared between both cases.
    const serverArmed = project.serverArmed === true;

    let activeProfileRules: Rule[] = [];
    if (serverArmed) {
      const profileSnap = await db
        .collection(`projects/${projectId}/profiles`)
        .where("isActiveOnServer", "==", true)
        .limit(1)
        .get();
      if (!profileSnap.empty) {
        const rulesSnap = await db
          .collection(`projects/${projectId}/profiles/${profileSnap.docs[0].id}/rules`)
          .get();
        activeProfileRules = rulesSnap.docs.map(
          (d) => ({ id: d.id, ...d.data() } as Rule)
        );
      }
    }

    // Always-rules come from every profile — when disarmed there is no active
    // profile to read them from.
    const allProfilesSnap = await db
      .collection(`projects/${projectId}/profiles`)
      .get();
    const alwaysRules: Rule[] = [];
    for (const prof of allProfilesSnap.docs) {
      const rs = await db
        .collection(`projects/${projectId}/profiles/${prof.id}/rules`)
        .where("always", "==", true)
        .get();
      for (const d of rs.docs) {
        alwaysRules.push({ id: d.id, ...d.data() } as Rule);
      }
    }

    const rules = applicableRules(serverArmed, activeProfileRules, alwaysRules);

    // Nothing applies — skip the event query entirely, preserving today's
    // cost for a disarmed project with no always-rules.
    if (rules.length === 0) return;

    // Get recent events for evaluation (last 5 minutes). Query on timestamp
    // only (single-field, auto-indexed) and filter by sensor in memory to
    // avoid needing a composite index. For multi_sensor rules we need other
    // sensors' events too, so we do NOT filter by sensorId in the query.
    const fiveMinAgo = Timestamp.fromMillis(timestamp - 5 * 60 * 1000);
    const recentSnap = await db
      .collection(`projects/${projectId}/events`)
      .where("timestamp", ">=", fiveMinAgo)
      .orderBy("timestamp", "desc")
      .limit(100)
      .get();

    const recentEvents: AlarmEvent[] = recentSnap.docs
      .filter((d) => d.id !== eventRef.id) // exclude the event we just wrote
      .map((d) => ({ id: d.id, ...d.data() } as AlarmEvent));

    const fullEvent: AlarmEvent = { id: eventRef.id, ...alarmEvent };
    const result = evaluateRules(rules, fullEvent, recentEvents, timestamp);

    if (result.triggered) {
      // Use the rule/condition name; fall back to the sensor name when
      // the rule is unnamed.
      const label = result.ruleName || sensor.name;

      // Record what caused the alarm BEFORE flipping siren_active, so
      // onAlarm can name it. onAlarm is the notifier whenever the siren
      // fires — for device-side alarms too — so we do not also send here
      // and duplicate the message.
      await rtdb
        .ref(`${projectId}/state/alarm_cause`)
        .set({ label, at: Date.now() });

      // If entry_delay, we note it but still fire (server doesn't implement delay timer in v1)
      if (project.serverActions.triggerSiren) {
        await rtdb.ref(`${projectId}/state/siren_active`).set(true);
      } else if (
        // Siren suppressed, so onAlarm never runs — send the alarm
        // notification directly instead. These two toggles are
        // independent, so Telegram-without-siren must still notify.
        project.serverActions.sendTelegram &&
        project.telegramBotToken &&
        project.telegramChatId
      ) {
        await sendTelegram(
          project.telegramBotToken,
          project.telegramChatId,
          formatAlarm(label)
        );
      }
    }
  }
);
