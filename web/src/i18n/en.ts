/** English strings — the source of truth for the key set.
 *  he.ts is typed against these keys, so a missing translation fails the
 *  typecheck rather than showing up as a raw key in the UI.
 *
 *  Placeholders use {name} and are filled by t(key, { name: ... }). */

export const en = {
  // ---- Common ----
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.edit": "Edit",
  "common.add": "Add",
  "common.close": "Close",
  "common.yes": "Yes",
  "common.no": "No",
  "common.never": "Never",
  "common.none": "None",
  "common.loading": "Loading…",
  "common.dismiss": "Dismiss",
  "common.signOut": "Sign out",
  "common.saved": "Saved.",
  "common.saving": "Saving…",

  // ---- Relative time ----
  "time.justNow": "just now",
  "time.minuteAgo": "a minute ago",
  "time.minutesAgo": "{count} minutes ago",
  "time.hourAgo": "an hour ago",
  "time.hoursAgo": "{count} hours ago",
  "time.today": "Today",

  // ---- App shell ----
  "app.title": "Alarm",
  "app.deviceOnline": "Device online",
  "app.deviceOffline": "Device offline or no heartbeat yet",
  "app.account": "Account",
  "app.projectId": "Active project id — RTDB paths are namespaced under this",
  "app.switchProject": "Switch project",
  "app.language": "Language",
  "app.offline": "Offline — showing last known state",
  "app.updateAvailable": "A new version is available.",
  "app.reload": "Reload",

  // ---- Navigation ----
  "nav.operations": "Operations",
  "nav.configure": "Configure",
  "nav.explore": "Events",
  "nav.members": "Members",
  "nav.settings": "Settings",
  "nav.simulator": "Simulator",

  // ---- Auth / gate ----
  "auth.signInWithGoogle": "Sign in with Google",
  "auth.checkingAccess": "Checking access…",
  "auth.accessDenied": "Access denied",
  "auth.accessDeniedBody":
    "This account isn’t authorised for the alarm system. Ask an administrator to invite {email}.",
  "auth.noProjects": "No projects yet",
  "auth.noProjectsBody":
    "You don’t have access to any project yet. Ask an administrator to invite you.",

  // ---- Operations ----
  "ops.title": "Operations",
  "ops.loadingDeviceState": "Loading device state…",
  "ops.noProject": "No project selected.",
  "ops.device": "Device",
  "ops.server": "Server",
  "ops.armed": "Armed",
  "ops.disarmed": "Disarmed",
  "ops.disarm": "Disarmed",
  "ops.alarm": "Alarm",
  "ops.alarmCauseUnknown": "cause unknown",
  "ops.alarmAt": "at {time}",
  // Shown when the device rebooted itself rather than being restarted by a
  // person — otherwise a crash-and-recover is completely invisible.
  "ops.deviceRestarted": "Device restarted",
  "ops.bootAt": "at {time}",
  "ops.bootPowerOn": "Powered on normally",
  "ops.bootExternal": "Reset externally",
  "ops.bootSwRestart": "Restarted by the firmware",
  "ops.bootPanic": "Recovered from a crash",
  "ops.bootWatchdog": "Recovered from a freeze",
  "ops.bootBrownout": "Recovered from a power dip",
  "ops.bootDeepSleep": "Woke from deep sleep",
  "ops.bootUnknown": "Restarted for an unknown reason",
  "ops.sos": "SOS",
  "ops.sosConfirm": "Press again to sound",
  "ops.sosCancel": "Cancel",
  "ops.sosTitle": "Sound the siren now",
  "ops.sosDisabled": "Siren is disabled in settings",
  "ops.siren": "Siren",
  "ops.sirenDisabled": "Disabled — alarms will not sound the siren",
  "ops.sirenSounding": "Sounding",
  "ops.sirenEnabledQuiet": "Enabled — not sounding",
  "ops.forceSilence": "Force Silence",
  "ops.offlineCannotArm": "Offline — arming is unavailable",

  // ---- Configure ----
  "cfg.title": "Configure",
  "cfg.tab.sensors": "Sensors",
  "cfg.tab.profiles": "Profiles",
  "cfg.tab.siren": "Siren",
  "cfg.tab.remotes": "Remotes",

  // Remotes tab
  "cfg.remotes.intro":
    "Remote controls arm, disarm and trigger SOS. They work even when the device is offline.",
  "cfg.remotes.none": "No remotes paired yet.",
  "cfg.remotes.paired": "Paired remotes",
  "cfg.remotes.unrecognised": "Unrecognised remotes",
  "cfg.remotes.pressHint":
    "Press any button on a remote — it appears here within a few seconds. Any one button pairs the whole remote.",
  "cfg.remotes.noCandidates": "Nothing heard yet. Press a button on the remote.",
  "cfg.remotes.buttonsSeen": "Buttons",
  "cfg.remotes.lastSeen": "Last seen",
  "cfg.remotes.events": "Events",
  "cfg.remotes.pairTitle": "Pair remote: {identity}",
  "cfg.remotes.namePlaceholder": "e.g. Ariel’s keyfob",
  "cfg.remotes.pair": "Pair remote",
  "cfg.remotes.name": "Name",
  "cfg.remotes.identity": "Identity",
  "cfg.remotes.unpair": "Unpair",
  "cfg.remotes.legend": "What the buttons do",
  "cfg.remotes.armedBlocked":
    "Disarm the system before pairing a remote.",

  // Sensors tab
  "cfg.sensors.loading": "Loading sensors…",
  "cfg.sensors.paired": "Paired Sensors",
  "cfg.sensors.nonePaired": "No paired sensors yet.",
  "cfg.sensors.name": "Name",
  "cfg.sensors.rfId": "RF ID",
  "cfg.sensors.battery": "Battery",
  "cfg.sensors.pairedAt": "Paired",
  "cfg.sensors.lastSeen": "Last Seen",
  "cfg.sensors.firstSeen": "First Seen",
  "cfg.sensors.events": "Events",
  "cfg.sensors.alertAfterDays": "Alert after (days)",
  "cfg.sensors.alertAfterDaysHelp":
    "Days without a trigger before sending a Telegram alert. -1 = never.",
  "cfg.sensors.neverAlert": "-1 = never alert",
  "cfg.sensors.unpair": "Unpair",
  "cfg.sensors.pair": "Pair",
  "cfg.sensors.pairTitle": "Pair Sensor: {rfId}",
  "cfg.sensors.namePlaceholder": "e.g. Front door",
  "cfg.sensors.addToProfiles": "Add an immediate rule to every profile",
  "cfg.sensors.addToProfilesHelp":
    "Creates one rule per profile ({count}) so the sensor is active as soon as it is paired. Without this it triggers nothing until you add a rule yourself.",
  "cfg.sensors.addToProfilesNone":
    "No profiles yet — create one in the Profiles tab to give this sensor a rule.",
  "cfg.sensors.unrecognised": "Unrecognised Sensors",
  "cfg.sensors.unrecognisedHint":
    "Trigger a physical sensor and watch its “Last Seen” update to identify it.",
  "cfg.sensors.noneSeen": "None seen.",
  "cfg.sensors.noneSeenBody":
    "Unpaired sensors appear here as soon as they transmit — they are read live from this project’s events, so nothing needs to be set up first.",
  "cfg.sensors.wrongProjectHint":
    "If a sensor is transmitting, check that the project shown in the header ({projectId}) is the one your device reports to — each project reads a separate events path.",
  "cfg.sensors.olderSensors": "Older sensors ({count})",
  "cfg.sensors.unpairConfirm":
    "Unpair “{name}” ({rfId})?{impact}\n\nPast events stay in the timeline. The sensor will reappear as unrecognised if it keeps transmitting.",
  "cfg.sensors.unpairImpact":
    "\n\n{updates} rule(s) will be updated and {deletes} rule(s) deleted.",
  "cfg.sensors.batteryOk": "ok",
  "cfg.sensors.batteryLow": "low",

  // Profiles tab
  "cfg.profiles.loading": "Loading profiles…",
  "cfg.profiles.namePlaceholder": "Profile name (e.g. Away)",
  "cfg.profiles.addProfile": "Add profile",
  "cfg.profiles.enabled": "Enabled",
  "cfg.profiles.activeOnDevice": "Active on device",
  "cfg.profiles.activeOnServer": "Active on server",
  "cfg.profiles.rename": "Rename",
  "cfg.profiles.renameLabel": "Profile name",
  "cfg.profiles.rules": "Rules",
  "cfg.profiles.noRules": "No rules.",
  "cfg.profiles.addRule": "Add rule",
  "cfg.profiles.editRule": "Edit Rule",
  "cfg.profiles.deleteProfileConfirm":
    "Delete profile “{name}” and all its rules?",
  "cfg.profiles.createProfile": "Create Profile",
  "cfg.profiles.disabledSuffix": "(disabled)",
  "cfg.profiles.enabledHelp": "Enabled (available to arm in Operations)",
  "cfg.profiles.unnamedRule": "(unnamed)",
  "cfg.profiles.addRuleTo": "Add Rule to {profile}",
  "cfg.profiles.nameRequired": "Name (required)",
  "cfg.profiles.nameOptional": "Name",
  "cfg.profiles.requiredForMulti": "Required for multi-sensor rules",
  "cfg.profiles.optionalLabel": "Optional label",
  "cfg.profiles.selectSensors": "Select Sensors:",

  // Rule editor
  "cfg.rule.name": "Rule name",
  "cfg.rule.namePlaceholder": "e.g. Night watch",
  "cfg.rule.condition": "Condition",
  "cfg.rule.type.immediate": "Immediate",
  "cfg.rule.type.count_in_window": "Count in window",
  "cfg.rule.type.entry_delay": "Entry delay",
  "cfg.rule.type.multi_sensor": "Multiple sensors",
  "cfg.rule.count": "Trigger count",
  "cfg.rule.windowSec": "Window (seconds)",
  "cfg.rule.delaySec": "Delay (seconds)",
  "cfg.rule.triggersPerSensor": "Triggers required per sensor",
  "cfg.rule.conditionType": "Condition Type",
  "cfg.rule.multiHint": "Two or more sensors — the rule is a Multi Sensor condition.",
  "cfg.rule.allMustReach": "All sensors must reach their count within the window.",
  // Quorum ("2 of 3"). Offered only for 3+ sensors: with two, the only valid
  // value is the AND the rule already has.
  "cfg.rule.sensorsRequired": "Sensors required",
  "cfg.rule.ofSensors": "of {count}",
  "cfg.rule.quorumMustReach":
    "Any {quorum} of the {count} sensors must reach their count within the window.",
  "cfg.rule.invalid": "Invalid condition parameters.",
  "cfg.rule.noSensors": "Select at least one sensor.",

  // Siren tab
  "cfg.siren.enabled": "Siren enabled",
  "cfg.siren.enabledHelp":
    "When off, alarms are recorded and notified but the siren never sounds.",
  "cfg.siren.currentAddress": "Current paired address:",
  "cfg.siren.notGenerated": "Not generated yet",
  "cfg.siren.sendPairing": "Send pairing signal",
  "cfg.siren.pairingSent": "Pairing signal sent.",
  "cfg.siren.beepTwice": "Did the siren beep twice?",
  "cfg.siren.pairFailed": "Pairing did not succeed. Likely causes:",
  "cfg.siren.pairFailOutOfRange":
    "The siren may be out of range of the alarm device.",
  "cfg.siren.pairFailNotLearning":
    "The siren may not have been in learn mode — press its SET button three times, then retry.",
  "cfg.siren.disabledWarn": "Siren is disabled — the device will evaluate alarm rules but never sound the siren or fire the relay.",
  "cfg.siren.pressSet": "Press SET on the siren until its lights come on, then click Send pairing signal.",
  "cfg.siren.deafWhileTx": "The alarm cannot detect sensors while it is transmitting (about 10 seconds).",
  "cfg.siren.sending": "Sending pairing command to device…",
  "cfg.siren.transmitting": "Waiting for device (up to 30 s), then transmitting for 10 s — the siren should beep twice.",
  "cfg.siren.noTryAgain": "No, try again",
  "cfg.siren.pairedOk": "Siren paired successfully. Address:",
  "cfg.siren.pairAgain": "Pair again",
  "cfg.siren.retry": "Retry",
  "cfg.siren.learnTimedOut": "Learn mode may have timed out — press SET again immediately before retrying.",
  "cfg.siren.pairInstructions":
    "Press the SET button on the siren three times, then send the pairing signal within 10 seconds. Two beeps mean success.",

  // ---- Explore ----
  "explore.title": "Events",
  "explore.loading": "Loading events…",
  "explore.noEvents": "No events today or yesterday.",
  "explore.timestamp": "Timestamp",
  "explore.sensor": "Sensor",
  "explore.event": "Event",
  "explore.batteryLow": "Battery Low",
  "explore.rssi": "RSSI",
  "explore.system": "System",
  "explore.loadMore": "Load 100 older",
  "explore.loadAll": "Load all",
  "explore.loadingMore": "Loading older events…",
  "explore.allLoaded": "All events loaded.",
  "explore.loadedCount": "{count} events",
  "explore.eventType.trigger": "Trigger",
  "explore.eventType.tamper": "Tamper",
  "explore.eventType.battery_low": "Battery low",
  "explore.eventType.alarm": "Alarm",
  "explore.eventType.armed": "Armed",
  "explore.eventType.disarmed": "Disarmed",
  // Names WHICH remote armed/disarmed. {name} is the remote's user-given
  // name; the word around it is translated so the database can stay
  // language-neutral.
  "explore.remoteSubject": "Remote {name}",
  // Shown when the identity matched no paired remote (e.g. one removed in the
  // UI but still transmitting).
  "explore.eventSource.remote": "Remote",
  // Names WHAT armed/disarmed when the change came from the cloud rather than
  // the hardware. {name} here is the PROFILE, not a remote — these rows used
  // to render as "Remote <profile>", claiming a remote was used.
  "explore.armSubject": "{source} — {name}",
  "explore.eventSource.app": "App",
  "explore.eventSource.schedule": "Schedule",
  "explore.eventSource.telegram": "Telegram",
  // Controller lifecycle, not sensor activity.
  "explore.eventType.device_restart": "Restarted",
  "explore.eventType.device_offline": "Went offline",
  "explore.eventType.device_online": "Back online",

  // ---- Members ----
  "members.title": "Members",
  "members.loading": "Loading members…",
  "members.email": "Email",
  "members.role": "Role",
  "members.role.admin": "Admin",
  "members.role.user": "User",
  "members.invite": "Invite",
  "members.invitePlaceholder": "email@example.com",
  "members.inviteSent": "Invited {email}.",
  "members.remove": "Remove",
  "members.removeConfirm": "Remove {email} from this project?",
  "members.currentMembers": "Current Members",
  "members.addMember": "Add a Member",
  "members.emailPlaceholder": "Email address",
  "members.adding": "Adding…",
  "members.addButton": "Add Member",
  "members.granted": "{email} now has {role} access.",
  "members.grantFailed": "Failed to grant access.",
  "auth.signInSubtitle": "Sign in to manage your alarm system.",
  "members.adminRequired": "Admin access required.",

  // ---- Settings ----
  "settings.title": "Project Settings",
  "settings.adminRequired": "Admin access required.",
  "settings.projectName": "Project Name",
  "settings.telegramBotToken": "Telegram Bot Token",
  "settings.telegramChatId": "Telegram Chat ID",
  "settings.notifyEveryTrigger":
    "Send Telegram on every sensor trigger (battery-low and tamper always notify)",
  "settings.sirenAndAlarm": "Siren & Server Alarm",
  "settings.sirenDuration": "Siren Duration (seconds)",
  "settings.serverSendsTelegram": "Server sends Telegram alerts on alarm",
  "settings.serverTriggersSiren": "Server triggers siren on alarm",
  "settings.telegram": "Telegram",
  "settings.botTokenHelp":
    "In Telegram, message @BotFather, send /newbot, follow the prompts, and copy the token it gives you (looks like 123456789:ABCdef...). Leave blank to disable Telegram alerts.",
  "settings.chatIdHelp":
    "The chat that receives alerts. For a direct message to you: open @userinfobot and it replies with your numeric ID (a positive number) — use that. For a group: add your bot to the group, send a message there, then open the getUpdates API URL and read chat.id (group IDs are negative, e.g. -1001234567890).",
  "settings.help": "Help",
  "settings.saveSettings": "Save Settings",
  "settings.unsavedWarning": "You have unsaved changes. Leave without saving?",
  "settings.unsavedBadge": "Unsaved changes",
  "settings.noChanges": "No changes to save",
  "settings.saveFailed": "Failed to save settings.",

  // ---- Create project ----
  "create.title": "Create Project",
  "create.projectName": "Project name",
  "create.create": "Create",
  "create.creating": "Creating…",
  "create.projectCreated": "Project Created",
  "create.saveKeyNow": "Save this API key now.",
  "create.notShownAgain": "It will not be shown again.",
  "create.copy": "Copy",
  "create.copied": "Copied ✓",
  "create.useKeyIn": "Use this key in your edge device firmware configuration.",
  "create.savedContinue": "I’ve saved it — continue",
  "create.botTokenOptional": "Telegram Bot Token (optional)",
  "create.chatIdOptional": "Telegram Chat ID (optional)",
  "create.failed": "Failed to create project.",
  "create.apiKeyTitle": "Device API key",
  "create.apiKeyWarning":
    "Copy this now — it is shown once and cannot be recovered.",

  // ---- Simulator ----
  "sim.title": "Simulator",
  "sim.rfId": "RF ID",
  "sim.fire": "Fire event",
  "sim.fired": "Event sent.",
  "cfg.rule.always": "Always active — fires even when disarmed",
  "cfg.rule.alwaysHelp":
    "For smoke or gas detectors. Ignores arm state, but still respects the siren setting. Applies to one sensor with an immediate trigger.",
  "cfg.rule.alwaysMultiHint":
    "Always active applies to a single sensor. Remove the extra sensors to enable it.",
  "cfg.rule.alwaysCleared":
    "Always active was turned off: it applies to a single sensor, and this rule now covers several.",
  "cfg.rule.alwaysBadge": "always",
  "ops.alwaysRules": "{count} always-on rule(s) fire even while disarmed",
  "settings.timezone": "Time zone",
  "settings.timezoneHelp":
    "Schedules resolve their times in this zone. Daylight saving is handled automatically.",

  // ---- Schedules ----
  "sched.title": "Schedules",
  "sched.none": "No schedules yet.",
  "sched.add": "Add schedule",
  "sched.edit": "Edit schedule",
  "sched.name": "Name",
  "sched.side": "Side",
  "sched.side.device": "device",
  "sched.side.server": "server",
  "sched.profile": "Profile",
  "sched.armTime": "Arm at",
  "sched.disarmTime": "Disarm at",
  "sched.armOptional": "Leave empty to arm manually",
  "sched.disarmOnly": "disarm only",
  "sched.repeat": "Repeat",
  "sched.repeat.weekly": "Weekly",
  "sched.repeat.once": "Once",
  "sched.date": "Date",
  "sched.everyDay": "every day",
  "sched.next": "Next: {what}",
  "sched.nextArm": "{side} arms {when}",
  "sched.nextDisarm": "{side} disarms {when}",
  "sched.nextNone": "nothing scheduled",
  "sched.overlapWarning":
    "This overlaps another schedule on the same side. Both will run; the later edge wins.",
  "sched.disabledProfile":
    "This profile is disabled — the arm step will be skipped.",
  "sched.enable": "Enable schedule",
  "sched.disable": "Disable schedule",
  "sched.day.0": "Sun",
  "sched.day.1": "Mon",
  "sched.day.2": "Tue",
  "sched.day.3": "Wed",
  "sched.day.4": "Thu",
  "sched.day.5": "Fri",
  "sched.day.6": "Sat",
} as const;

export type TranslationKey = keyof typeof en;
