import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { buildRtdbConfig } from "./buildConfig";
import { Rule, Sensor } from "./types";

const sensors: Sensor[] = [
  { id: "s1", rfId: "0xA1B2C3", name: "Front door", pairedAt: Timestamp.fromMillis(1000), batteryStatus: "ok", lastSeen: Timestamp.fromMillis(2000) },
  { id: "s2", rfId: "0xD4E5F6", name: "Back window", pairedAt: Timestamp.fromMillis(1000), batteryStatus: "low", lastSeen: Timestamp.fromMillis(3000) },
  { id: "s3", rfId: "0x112233", name: "Garage PIR", pairedAt: Timestamp.fromMillis(1000), batteryStatus: "ok", lastSeen: null },
];

describe("buildRtdbConfig — family ids in r", () => {
  it("emits the 20-bit family, not the full 24-bit rfId", () => {
    // The device matches a packet by its top 20 bits, so `r` must carry
    // families. Wire-compatible: r was already string[], only the contents
    // get shorter — which also shrinks a config the device polls every 5s.
    const rules: Rule[] = [
      { id: "r1", name: "Door", sensors: ["s1"], condition: { type: "immediate" } },
    ];
    expect(buildRtdbConfig(rules, sensors, true, 120).r).toEqual(["0xA1B2C"]);
  });

  it("collapses two sensors' codes into one entry when they share a family", () => {
    // The point of the whole change. A sensor paired on its motion code and
    // (mistakenly) again on its tamper code is ONE device; the device must
    // not be told to watch two, and an index-based config with a duplicated
    // family would mean the second entry's conditions were never evaluated.
    const twoCodes: Sensor[] = [
      { ...sensors[0], id: "m", rfId: "0x0061DA" },
      { ...sensors[0], id: "t", rfId: "0x0061DB" },
    ];
    const rules: Rule[] = [
      { id: "r1", name: "Motion", sensors: ["m"], condition: { type: "immediate" } },
      { id: "r2", name: "Tamper", sensors: ["t"], condition: { type: "entry_delay", delay_sec: 30 } },
    ];
    const config = buildRtdbConfig(rules, twoCodes, true, 120);
    expect(config.r).toEqual(["0x0061D"]);
    // BOTH rules' conditions land on that single entry — neither is lost.
    expect(config.c).toEqual([[{ t: 0 }, { t: 2, y: 30 }]]);
  });

  it("prefers a stored familyId over one derived from rfId", () => {
    const stored: Sensor[] = [
      { ...sensors[0], rfId: "0xA1B2C3", familyId: "0xA1B2C" },
    ];
    const rules: Rule[] = [
      { id: "r1", name: "Door", sensors: ["s1"], condition: { type: "immediate" } },
    ];
    expect(buildRtdbConfig(rules, stored, true, 120).r).toEqual(["0xA1B2C"]);
  });

  it("drops a sensor whose rfId cannot yield a family", () => {
    // Same treatment an unresolvable sensorId already got: dropped, not sent
    // as a key the device could never match.
    const broken: Sensor[] = [{ ...sensors[0], rfId: "not-hex" }];
    const rules: Rule[] = [
      { id: "r1", name: "Door", sensors: ["s1"], condition: { type: "immediate" } },
    ];
    const config = buildRtdbConfig(rules, broken, true, 120);
    expect(config.r).toEqual([]);
    expect(config.c).toEqual([]);
  });

  it("resolves multi_sensor k indices by family too", () => {
    // k is keyed by index into r; if pass 1 keyed r by rfId while pass 2
    // resolved by family, every participant would be dropped from k.
    const rules: Rule[] = [
      {
        id: "r1",
        name: "Both",
        sensors: ["s1", "s2"],
        condition: { type: "multi_sensor", window_sec: 60 },
      },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 120);
    expect(config.r).toEqual(["0xA1B2C", "0xD4E5F"]);
    expect(config.c[0][0]).toEqual({ t: 3, w: 60, k: { "0": 1, "1": 1 } });
  });
});

describe("buildRtdbConfig", () => {
  it("builds config with an immediate rule", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Door rule", sensors: ["s1"], condition: { type: "immediate" } },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 120);

    expect(config.a).toBe(true);
    expect(config.d).toBe(120);
    expect(config.r).toEqual(["0xA1B2C"]);
    expect(config.c).toEqual([[{ t: 0 }]]);
  });

  it("builds config with multiple sensors and conditions, index-aligned", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Door", sensors: ["s1", "s2"], condition: { type: "immediate" } },
      { id: "r2", name: "Garage", sensors: ["s3"], condition: { type: "count_in_window", count: 3, window_sec: 60 } },
    ];
    const config = buildRtdbConfig(rules, sensors, false, 90);

    expect(config.a).toBe(false);
    expect(config.d).toBe(90);
    expect(config.r).toEqual(["0xA1B2C", "0xD4E5F", "0x11223"]);
    expect(config.c).toEqual([
      [{ t: 0 }],
      [{ t: 0 }],
      [{ t: 1, n: 3, w: 60 }],
    ]);
  });

  it("merges conditions when a sensor appears in multiple rules", () => {
    const rules: Rule[] = [
      { id: "r1", name: "A", sensors: ["s1"], condition: { type: "immediate" } },
      { id: "r2", name: "B", sensors: ["s1"], condition: { type: "entry_delay", delay_sec: 30 } },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 60);

    expect(config.r).toEqual(["0xA1B2C"]);
    expect(config.c).toEqual([[{ t: 0 }, { t: 2, y: 30 }]]);
  });

  it("skips sensors not found in the sensors array", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Unknown", sensors: ["nonexistent"], condition: { type: "immediate" } },
    ];
    const config = buildRtdbConfig(rules, sensors, false, 120);

    expect(config.r).toEqual([]);
    expect(config.c).toEqual([]);
  });

  describe("multi_sensor translation", () => {
    it("re-keys per-sensor counts by index into r", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Break-in",
          sensors: ["s1", "s2"],
          condition: { type: "multi_sensor", window_sec: 60, counts: { s1: 1, s2: 2 } },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.r).toEqual(["0xA1B2C", "0xD4E5F"]);
      // index 0 = s1/family 0xA1B2C, index 1 = s2/family 0xD4E5F
      expect(config.c).toEqual([
        [{ t: 3, w: 60, k: { "0": 1, "1": 2 } }],
        [{ t: 3, w: 60, k: { "0": 1, "1": 2 } }],
      ]);
    });

    it("defaults a missing count to 1 and makes every participant explicit", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Pair",
          sensors: ["s1", "s3"],
          condition: { type: "multi_sensor", window_sec: 30, counts: { s1: 3 } }, // s3 omitted
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.r).toEqual(["0xA1B2C", "0x11223"]);
      expect(config.c[0][0]).toEqual({ t: 3, w: 30, k: { "0": 3, "1": 1 } });
    });

    it("fills in counts when the condition has none at all", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Pair",
          sensors: ["s1", "s2"],
          condition: { type: "multi_sensor", window_sec: 45 },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.c[0][0]).toEqual({ t: 3, w: 45, k: { "0": 1, "1": 1 } });
    });

    it("drops participants that cannot be resolved to an rfId", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Pair",
          sensors: ["s1", "ghost"],
          condition: { type: "multi_sensor", window_sec: 60, counts: { s1: 2, ghost: 5 } },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.r).toEqual(["0xA1B2C"]);
      expect(config.c).toEqual([[{ t: 3, w: 60, k: { "0": 2 } }]]);
    });

    it("leaves single-sensor conditions untouched", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Door",
          sensors: ["s1"],
          condition: { type: "count_in_window", count: 3, window_sec: 60 },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.c).toEqual([[{ t: 1, n: 3, w: 60 }]]);
    });
  });

  describe("min_gap_sec", () => {
    it("emits g when min_gap_sec is set", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "PIR",
          sensors: ["s1"],
          condition: {
            type: "count_in_window",
            count: 2,
            window_sec: 120,
            min_gap_sec: 20,
          },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.c).toEqual([[{ t: 1, n: 2, w: 120, g: 20 }]]);
    });

    // Omitted, not sent as 0 or undefined: RTDB rejects undefined outright,
    // and the device polls this payload every 5s so the common shape must not
    // grow a key for a feature almost no rule uses.
    it("omits g entirely when min_gap_sec is absent", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "PIR",
          sensors: ["s1"],
          condition: { type: "count_in_window", count: 2, window_sec: 120 },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.c).toEqual([[{ t: 1, n: 2, w: 120 }]]);
    });

    it("omits g when min_gap_sec is 0", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "PIR",
          sensors: ["s1"],
          condition: {
            type: "count_in_window",
            count: 2,
            window_sec: 120,
            min_gap_sec: 0,
          },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);

      expect(config.c).toEqual([[{ t: 1, n: 2, w: 120 }]]);
    });
  });

  it("returns empty r/c for empty rules", () => {
    const config = buildRtdbConfig([], sensors, false, 120);

    expect(config.a).toBe(false);
    expect(config.d).toBe(120);
    expect(config.r).toEqual([]);
    expect(config.c).toEqual([]);
  });
});

describe("buildRtdbConfig — always-on rules", () => {
  it("omits x for an ordinary rule", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Door", sensors: ["s1"], condition: { type: "immediate" } },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 120);
    expect(config.c).toEqual([[{ t: 0 }]]);
  });

  it("sets x:1 for an always rule", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        name: "Smoke",
        sensors: ["s1"],
        condition: { type: "immediate" },
        always: true,
      },
    ];
    const config = buildRtdbConfig(rules, sensors, true, 120);
    expect(config.c).toEqual([[{ t: 0, x: 1 }]]);
  });

  it("includes an always rule from a non-active profile", () => {
    // The active profile covers s1; the always rule lives elsewhere and
    // covers s2. Without the second pass, s2 never reaches the device.
    const active: Rule[] = [
      { id: "r1", name: "Door", sensors: ["s1"], condition: { type: "immediate" } },
    ];
    const alwaysRules: Rule[] = [
      {
        id: "r9",
        name: "Smoke",
        sensors: ["s2"],
        condition: { type: "immediate" },
        always: true,
      },
    ];
    const config = buildRtdbConfig(active, sensors, true, 120, true, alwaysRules);
    expect(config.r).toEqual(["0xA1B2C", "0xD4E5F"]);
    expect(config.c).toEqual([[{ t: 0 }], [{ t: 0, x: 1 }]]);
  });

  it("does not duplicate an always rule that is also in the active profile", () => {
    const rule: Rule = {
      id: "r1",
      name: "Smoke",
      sensors: ["s1"],
      condition: { type: "immediate" },
      always: true,
    };
    // Same rule id arriving through both paths must appear once.
    const config = buildRtdbConfig([rule], sensors, true, 120, true, [rule]);
    expect(config.r).toEqual(["0xA1B2C"]);
    expect(config.c).toEqual([[{ t: 0, x: 1 }]]);
  });

  // The quorum ("2 of 3") rides as `q`. Omitted whenever it equals the
  // participant count, so the payload for every existing rule is byte-for-byte
  // what it was — this config is polled every 5s.
  describe("multi_sensor quorum", () => {
    const threeSensorRule = (quorum?: number): Rule[] => [
      {
        id: "r1",
        name: "Any two",
        sensors: ["s1", "s2", "s3"],
        condition: { type: "multi_sensor", window_sec: 60, quorum },
      },
    ];

    it("omits q when every sensor is required", () => {
      const config = buildRtdbConfig(threeSensorRule(3), sensors, true, 120);
      const cond = config.c[0][0];
      expect(cond.q).toBeUndefined();
      expect(cond).toEqual({ t: 3, w: 60, k: { "0": 1, "1": 1, "2": 1 } });
    });

    it("omits q when the quorum is absent", () => {
      const config = buildRtdbConfig(threeSensorRule(undefined), sensors, true, 120);
      expect(config.c[0][0].q).toBeUndefined();
    });

    it("emits q when fewer than all sensors are required", () => {
      const config = buildRtdbConfig(threeSensorRule(2), sensors, true, 120);
      // Every participant carries the same condition copy, quorum included —
      // the device matches participants on (t, w, kLen, q).
      for (const idx of [0, 1, 2]) {
        expect(config.c[idx][0]).toEqual({
          t: 3,
          w: 60,
          k: { "0": 1, "1": 1, "2": 1 },
          q: 2,
        });
      }
    });

    it("clamps q to the participants that actually resolved", () => {
      // s9 has no matching sensor, so it is dropped from k. A quorum of 3
      // over 2 surviving participants would be permanently unfireable.
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Partly unknown",
          sensors: ["s1", "s2", "s9"],
          condition: { type: "multi_sensor", window_sec: 60, quorum: 3 },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);
      const cond = config.c[0][0];
      expect(cond.k).toEqual({ "0": 1, "1": 1 });
      // Equals the surviving participant count, so it is omitted entirely.
      expect(cond.q).toBeUndefined();
    });

    it("keeps per-sensor counts alongside a quorum", () => {
      const rules: Rule[] = [
        {
          id: "r1",
          name: "Two of three, one needs twice",
          sensors: ["s1", "s2", "s3"],
          condition: {
            type: "multi_sensor",
            window_sec: 30,
            quorum: 2,
            counts: { s1: 2 },
          },
        },
      ];
      const config = buildRtdbConfig(rules, sensors, true, 120);
      expect(config.c[0][0]).toEqual({
        t: 3,
        w: 30,
        k: { "0": 2, "1": 1, "2": 1 },
        q: 2,
      });
    });
  });

  it("emits paired remote identities as numbers in m", () => {
    const config = buildRtdbConfig([], sensors, false, 120, true, [], [
      {
        id: "r1",
        identity: "0xE45CA",
        name: "Keyfob",
        pairedAt: Timestamp.fromMillis(1000),
        lastSeen: null,
      },
    ]);
    expect(config.m).toEqual([0xe45ca]);
  });

  it("omits m entirely when no remotes are paired", () => {
    const config = buildRtdbConfig([], sensors, false, 120, true, [], []);
    expect(config.m).toBeUndefined();
  });

  // The siren address is echoed back so a device whose EEPROM was wiped can
  // re-adopt the address its physical siren is still paired to, rather than
  // generating a new one the siren has never heard.
  it("emits the siren base address as a number in s", () => {
    const config = buildRtdbConfig(
      [], sensors, false, 120, true, [], [], "0xA1B2C0"
    );
    expect(config.s).toBe(0xa1b2c0);
  });

  it("omits s when the project has no siren address", () => {
    const config = buildRtdbConfig([], sensors, false, 120, true, [], []);
    expect(config.s).toBeUndefined();
  });

  // RTDB rejects NaN outright, so an unparseable value must be dropped rather
  // than sent — the same contract m has.
  it("omits s when the stored address is unparseable", () => {
    const config = buildRtdbConfig(
      [], sensors, false, 120, true, [], [], "not-hex"
    );
    expect(config.s).toBeUndefined();
  });
});

describe("buildRtdbConfig — NVR + per-sensor camera mask", () => {
  it("emits NVR fields and an index-aligned camera bitmask", () => {
    const cfg = buildRtdbConfig(
      [{ id: "r1", name: "R", sensors: ["s1"], condition: { type: "immediate" } }],
      [{ ...sensors[0], id: "s1", rfId: "0x0061DA", cameras: [2] } as any],
      true, 30, true, [], [], undefined,
      { nvrMode: "capture+judge", nvrHost: "h", nvrPort: 34567, nvrUser: "u", nvrPassword: "p", captureCooldownSec: 60 }
    );
    expect(cfg.nm).toBe(2);
    expect(cfg.nh).toBe("h");
    expect(cfg.np).toBe(34567);
    expect(cfg.nu).toBe("u");
    expect(cfg.nw).toBe("p");
    expect(cfg.cc).toBe(60);
    // Channel 2 -> bit 1.
    expect(cfg.cmask).toEqual([0b10]);
  });

  it("emits cd:0 only when capture-while-disarmed is turned off", () => {
    const build = (captureWhenDisarmed?: boolean) =>
      buildRtdbConfig(
        [{ id: "r1", name: "R", sensors: ["s1"], condition: { type: "immediate" } }],
        [{ ...sensors[0], id: "s1", rfId: "0x0061DA", cameras: [1] } as any],
        true, 30, true, [], [], undefined,
        { nvrMode: "capture", nvrHost: "h", nvrPort: 34567, captureWhenDisarmed }
      );
    // Absent and true both mean "capture while disarmed" — the device's own
    // default — so the payload stays exactly what it was before the field.
    expect(build(undefined)).not.toHaveProperty("cd");
    expect(build(true)).not.toHaveProperty("cd");
    expect(build(false).cd).toBe(0);
  });

  it("ORs several cameras on one sensor into a single mask entry", () => {
    const cfg = buildRtdbConfig(
      [{ id: "r1", name: "R", sensors: ["s1"], condition: { type: "immediate" } }],
      [{ ...sensors[0], id: "s1", rfId: "0x0061DA", cameras: [1, 3, 8] } as any],
      true, 30, true, [], [], undefined,
      { nvrMode: "capture", nvrHost: "h", nvrPort: 34567 }
    );
    expect(cfg.cmask).toEqual([0b10000101]);
  });

  // --- siren hold for non-definite sensors ---
  //
  // The DEVICE delays the siren (it fires it locally, with no cloud
  // involvement), so both the per-sensor certainty and the hold duration have
  // to travel in the config. `nd` lists the indices into r that are NOT
  // definite; absent/empty means every sensor is definite, which is the
  // pre-existing behaviour and keeps the common payload unchanged.
  describe("siren hold", () => {
    const immediate = (id: string, sensorId: string) => ({
      id,
      name: "R",
      sensors: [sensorId],
      condition: { type: "immediate" as const },
    });

    it("emits sh and the non-definite index list", () => {
      const cfg = buildRtdbConfig(
        [immediate("r1", "s1"), immediate("r2", "s2")],
        [
          { ...sensors[0], id: "s1", rfId: "0x0061DA", definiteBreach: false } as any,
          { ...sensors[0], id: "s2", rfId: "0x0072EA", definiteBreach: true } as any,
        ],
        true, 30, true, [], [], undefined, undefined, 20
      );
      expect(cfg.sh).toBe(20);
      expect(cfg.nd).toEqual([0]);
    });

    // Absent certainty means DEFINITE, matching breachCertainty's single
    // source of that default — a newly paired sensor must sound the siren
    // immediately, not inherit a hold nobody configured.
    it("treats an absent definiteBreach as definite", () => {
      const cfg = buildRtdbConfig(
        [immediate("r1", "s1")],
        [{ ...sensors[0], id: "s1", rfId: "0x0061DA" } as any],
        true, 30, true, [], [], undefined, undefined, 20
      );
      expect(cfg.nd).toBeUndefined();
    });

    // No hold configured => nothing to send, even if sensors are
    // non-definite. Keeps the payload identical for every project that has
    // not opted in.
    it("omits both keys when no hold is configured", () => {
      const cfg = buildRtdbConfig(
        [immediate("r1", "s1")],
        [{ ...sensors[0], id: "s1", rfId: "0x0061DA", definiteBreach: false } as any],
        true, 30, true, [], [], undefined, undefined, 0
      );
      expect(cfg.sh).toBeUndefined();
      expect(cfg.nd).toBeUndefined();
    });

    it("omits both keys when the hold is unset", () => {
      const cfg = buildRtdbConfig(
        [immediate("r1", "s1")],
        [{ ...sensors[0], id: "s1", rfId: "0x0061DA", definiteBreach: false } as any],
        true, 30, true, [], [], undefined, undefined, undefined
      );
      expect(cfg.sh).toBeUndefined();
      expect(cfg.nd).toBeUndefined();
    });

    it("indexes non-definite sensors against r, not the input order", () => {
      const cfg = buildRtdbConfig(
        [immediate("r1", "s1"), immediate("r2", "s2"), immediate("r3", "s3")],
        [
          { ...sensors[0], id: "s1", rfId: "0x0061DA", definiteBreach: true } as any,
          { ...sensors[0], id: "s2", rfId: "0x0072EA", definiteBreach: false } as any,
          { ...sensors[0], id: "s3", rfId: "0x0083FA", definiteBreach: false } as any,
        ],
        true, 30, true, [], [], undefined, undefined, 15
      );
      expect(cfg.r).toEqual(["0x0061D", "0x0072E", "0x0083F"]);
      expect(cfg.nd).toEqual([1, 2]);
    });
  });

  it("emits a zero mask for a sensor with no cameras selected", () => {
    // Index alignment with r is what makes the array readable at all, so a
    // no-camera sensor must still occupy its slot when a SIBLING has one.
    const cfg = buildRtdbConfig(
      [
        { id: "r1", name: "R", sensors: ["s1"], condition: { type: "immediate" } },
        { id: "r2", name: "R2", sensors: ["s2"], condition: { type: "immediate" } },
      ],
      [
        { ...sensors[0], id: "s1", rfId: "0x0061DA", cameras: [] } as any,
        { ...sensors[0], id: "s2", rfId: "0x0072EA", cameras: [4] } as any,
      ],
      true, 30, true, [], [], undefined,
      { nvrMode: "capture", nvrHost: "h", nvrPort: 34567 }
    );
    expect(cfg.cmask).toEqual([0, 0b1000]);
  });

  it("drops out-of-range channels rather than overflowing the mask byte", () => {
    const cfg = buildRtdbConfig(
      [{ id: "r1", name: "R", sensors: ["s1"], condition: { type: "immediate" } }],
      [{ ...sensors[0], id: "s1", rfId: "0x0061DA", cameras: [0, 9, 2] } as any],
      true, 30, true, [], [], undefined,
      { nvrMode: "capture", nvrHost: "h", nvrPort: 34567 }
    );
    expect(cfg.cmask).toEqual([0b10]);
  });

  it("omits cmask entirely when no sensor has a camera", () => {
    const cfg = buildRtdbConfig(
      [{ id: "r1", name: "R", sensors: ["s1"], condition: { type: "immediate" } }],
      [sensors[0]],
      true, 30, true, [], [], undefined,
      undefined
    );
    expect(cfg.cmask).toBeUndefined();
    expect(cfg.nm).toBeUndefined();
    expect(cfg.nh).toBeUndefined();
    expect(cfg.cc).toBeUndefined();
  });
});
