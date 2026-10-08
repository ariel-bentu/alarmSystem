#pragma once

// The running firmware's version, e.g. "2026.10.08-1432-abc1234". Defined in
// fw_version_gen.cpp, which fw_version.py regenerates on every esp32s3 build
// (see its header for the format and why it is a generated file).
//
// Reported to /{projectId}/state/boot as `fw` and compared against OTA
// requests, so it must match the version publishFirmware.ts publishes.
extern const char kFirmwareVersion[];
