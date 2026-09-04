// Cloud Functions entry point — exports all functions.

export { onSensorEvent } from "./onSensorEvent";
export { onAlarm } from "./onAlarm";
export { onProfileChange, onRuleChange, onProjectConfigChange, onRemoteChange } from "./onProfileChange";
export { onScheduleChange } from "./onScheduleChange";
export { onArmStateChange } from "./onArmStateChange";
export { onDeviceArmStateChange } from "./onDeviceArmStateChange";
export { onServerArmChange } from "./onServerArmChange";
export { onHeartbeat } from "./onHeartbeat";
export { onBoot } from "./onBoot";
// The ONLY scheduled function. scheduleTick, deadSensorCheck and the device
// liveness check are plain functions dispatched from its table — see
// doSchedule.ts before adding any periodic work.
export { doSchedule } from "./doSchedule";
export { telegramWebhook } from "./telegramWebhook";
export { provisionUser } from "./provisionUser";
export { grantTenantAccess } from "./grantTenantAccess";
export { deviceIngest } from "./deviceIngest";
export { mintDeviceToken } from "./mintDeviceToken";
export { onSirenAddress } from "./onSirenAddress";
