import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { evaluateRules } from "./alarmLogic";
import { Rule, AlarmEvent } from "./types";

function makeEvent(overrides: Partial<Omit<AlarmEvent, "timestamp">> & { timestamp?: number } = {}): AlarmEvent {
  const { timestamp: ts, ...rest } = overrides;
  return {
    id: "evt1",
    sensorId: "sensor1",
    rfId: "0xABC",
    sensorName: "Front door",
    eventType: "trigger",
    batteryLow: false,
    rssi: -50,
    timestamp: Timestamp.fromMillis(ts ?? 1000000),
    ...rest,
  };
}

describe("evaluateRules", () => {
  describe("immediate condition", () => {
    const rules: Rule[] = [
      { id: "r1", name: "Door", sensors: ["sensor1"], condition: { type: "immediate" } },
    ];

    it("triggers on matching sensor", () => {
      const result = evaluateRules(rules, makeEvent(), [], Date.now());
      expect(result).toMatchObject({ triggered: true });
    });

    it("does not trigger if sensor not in rule", () => {
      const result = evaluateRules(rules, makeEvent({ sensorId: "sensor99" }), [], Date.now());
      expect(result).toEqual({ triggered: false });
    });
  });

  describe("count_in_window condition", () => {
    const now = 100_000;
    const rules: Rule[] = [
      {
        id: "r1",
        name: "PIR",
        sensors: ["sensor1"],
        condition: { type: "count_in_window", count: 3, window_sec: 60 },
      },
    ];

    it("does not trigger with insufficient recent events", () => {
      // current event = 1, recentEvents has 1 → total 2, need 3
      const recent = [makeEvent({ timestamp: now - 10_000 })];
      const result = evaluateRules(rules, makeEvent({ timestamp: now }), recent, now);
      expect(result.triggered).toBe(false);
    });

    it("triggers when count is met", () => {
      // current event = 1, recentEvents has 2 → total 3
      const recent = [
        makeEvent({ timestamp: now - 10_000 }),
        makeEvent({ timestamp: now - 20_000 }),
      ];
      const result = evaluateRules(rules, makeEvent({ timestamp: now }), recent, now);
      expect(result.triggered).toBe(true);
    });

    it("ignores events outside the window", () => {
      const recent = [
        makeEvent({ timestamp: now - 10_000 }),
        makeEvent({ timestamp: now - 70_000 }), // outside 60s window
      ];
      const result = evaluateRules(rules, makeEvent({ timestamp: now }), recent, now);
      expect(result.triggered).toBe(false);
    });

    it("ignores events from different sensors", () => {
      const recent = [
        makeEvent({ sensorId: "sensor2", timestamp: now - 5_000 }),
        makeEvent({ sensorId: "sensor2", timestamp: now - 10_000 }),
      ];
      const result = evaluateRules(rules, makeEvent({ timestamp: now }), recent, now);
      expect(result.triggered).toBe(false);
    });
  });

  describe("entry_delay condition", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        name: "Entry",
        sensors: ["sensor1"],
        condition: { type: "entry_delay", delay_sec: 30 },
      },
    ];

    it("triggers with delayMs", () => {
      const result = evaluateRules(rules, makeEvent(), [], Date.now());
      expect(result).toMatchObject({ triggered: true, delayMs: 30_000 });
    });

    it("uses default 30s if delay_sec not specified", () => {
      const noDelayRules: Rule[] = [
        { id: "r1", name: "Entry", sensors: ["sensor1"], condition: { type: "entry_delay" } },
      ];
      const result = evaluateRules(noDelayRules, makeEvent(), [], Date.now());
      expect(result).toMatchObject({ triggered: true, delayMs: 30_000 });
    });
  });

  describe("multi_sensor condition", () => {
    const now = 100_000;
    const rules: Rule[] = [
      {
        id: "r1",
        name: "Multi",
        sensors: ["sensor1", "sensor2"],
        condition: { type: "multi_sensor", window_sec: 60 },
      },
    ];

    it("triggers when another sensor fired within window", () => {
      const recent = [makeEvent({ sensorId: "sensor2", timestamp: now - 5_000 })];
      const result = evaluateRules(rules, makeEvent({ sensorId: "sensor1", timestamp: now }), recent, now);
      expect(result.triggered).toBe(true);
    });

    it("does not trigger without another sensor in window", () => {
      const recent = [makeEvent({ sensorId: "sensor1", timestamp: now - 5_000 })];
      const result = evaluateRules(rules, makeEvent({ sensorId: "sensor1", timestamp: now }), recent, now);
      expect(result.triggered).toBe(false);
    });

    it("does not trigger when other sensor is outside window", () => {
      const recent = [makeEvent({ sensorId: "sensor2", timestamp: now - 70_000 })];
      const result = evaluateRules(rules, makeEvent({ sensorId: "sensor1", timestamp: now }), recent, now);
      expect(result.triggered).toBe(false);
    });

    describe("per-sensor counts", () => {
      // sensor1 must trigger twice, sensor2 once, within 30s.
      const countRules: Rule[] = [
        {
          id: "r1",
          name: "Hallway pair",
          sensors: ["sensor1", "sensor2"],
          condition: {
            type: "multi_sensor",
            window_sec: 30,
            counts: { sensor1: 2, sensor2: 1 },
          },
        },
      ];

      it("triggers when every sensor reaches its required count", () => {
        const recent = [
          makeEvent({ sensorId: "sensor1", timestamp: now - 5_000 }), // sensor1 #1
          makeEvent({ sensorId: "sensor2", timestamp: now - 8_000 }), // sensor2 #1
        ];
        // current event is sensor1 #2 → sensor1=2, sensor2=1 → met
        const result = evaluateRules(
          countRules,
          makeEvent({ sensorId: "sensor1", timestamp: now }),
          recent,
          now
        );
        expect(result.triggered).toBe(true);
      });

      it("does not trigger when one sensor is short of its count", () => {
        const recent = [
          makeEvent({ sensorId: "sensor2", timestamp: now - 8_000 }),
        ];
        // sensor1 has only the current event (1 of 2 required)
        const result = evaluateRules(
          countRules,
          makeEvent({ sensorId: "sensor1", timestamp: now }),
          recent,
          now
        );
        expect(result.triggered).toBe(false);
      });

      it("does not trigger when a sensor never fired", () => {
        const recent = [
          makeEvent({ sensorId: "sensor1", timestamp: now - 5_000 }),
        ];
        // sensor1 reaches 2, but sensor2 has none
        const result = evaluateRules(
          countRules,
          makeEvent({ sensorId: "sensor1", timestamp: now }),
          recent,
          now
        );
        expect(result.triggered).toBe(false);
      });

      it("ignores contributions outside the shared window", () => {
        const recent = [
          makeEvent({ sensorId: "sensor1", timestamp: now - 5_000 }),
          makeEvent({ sensorId: "sensor2", timestamp: now - 40_000 }), // outside 30s
        ];
        const result = evaluateRules(
          countRules,
          makeEvent({ sensorId: "sensor1", timestamp: now }),
          recent,
          now
        );
        expect(result.triggered).toBe(false);
      });

      it("defaults a missing count to 1", () => {
        const mixed: Rule[] = [
          {
            id: "r1",
            name: "Mixed",
            sensors: ["sensor1", "sensor2"],
            condition: {
              type: "multi_sensor",
              window_sec: 30,
              counts: { sensor1: 2 }, // sensor2 defaults to 1
            },
          },
        ];
        const recent = [
          makeEvent({ sensorId: "sensor1", timestamp: now - 5_000 }),
          makeEvent({ sensorId: "sensor2", timestamp: now - 6_000 }),
        ];
        const result = evaluateRules(
          mixed,
          makeEvent({ sensorId: "sensor1", timestamp: now }),
          recent,
          now
        );
        expect(result.triggered).toBe(true);
      });
    });

    // Mirrors the live scenario tested against the deployed function:
    // window must trigger once, Front Door twice, within 60 seconds.
    describe("scenario: window x1 + front door x2 in 60s", () => {
      const T = 1_000_000; // fixed 'now' for deterministic timings
      const scenarioRules: Rule[] = [
        {
          id: "r1",
          name: "Break-in",
          sensors: ["window", "frontDoor"],
          condition: {
            type: "multi_sensor",
            window_sec: 60,
            counts: { window: 1, frontDoor: 2 },
          },
        },
      ];

      const evalWith = (
        current: { sensorId: string; at: number },
        past: { sensorId: string; at: number }[]
      ) =>
        evaluateRules(
          scenarioRules,
          makeEvent({ sensorId: current.sensorId, timestamp: current.at }),
          past.map((p) => makeEvent({ sensorId: p.sensorId, timestamp: p.at })),
          current.at
        );

      it("front door twice alone does not trigger (window missing)", () => {
        const result = evalWith(
          { sensorId: "frontDoor", at: T },
          [{ sensorId: "frontDoor", at: T - 1_000 }]
        );
        expect(result.triggered).toBe(false);
      });

      it("window alone does not trigger (front door missing)", () => {
        const result = evalWith({ sensorId: "window", at: T }, []);
        expect(result.triggered).toBe(false);
      });

      it("window once + front door once does not trigger (front door needs 2)", () => {
        const result = evalWith(
          { sensorId: "window", at: T },
          [{ sensorId: "frontDoor", at: T - 2_000 }]
        );
        expect(result.triggered).toBe(false);
      });

      it("window completing the set after two front door hits triggers", () => {
        const result = evalWith({ sensorId: "window", at: T }, [
          { sensorId: "frontDoor", at: T - 15_000 },
          { sensorId: "frontDoor", at: T - 14_000 },
        ]);
        expect(result.triggered).toBe(true);
      });

      it("front door completing the set after a window hit triggers", () => {
        const result = evalWith({ sensorId: "frontDoor", at: T }, [
          { sensorId: "window", at: T - 30_000 },
          { sensorId: "frontDoor", at: T - 20_000 },
        ]);
        expect(result.triggered).toBe(true);
      });

      it("does not trigger when a contribution falls outside the 60s window", () => {
        const result = evalWith({ sensorId: "window", at: T }, [
          { sensorId: "frontDoor", at: T - 61_000 }, // too old
          { sensorId: "frontDoor", at: T - 10_000 },
        ]);
        expect(result.triggered).toBe(false);
      });

      it("triggers on the exact window boundary", () => {
        const result = evalWith({ sensorId: "window", at: T }, [
          { sensorId: "frontDoor", at: T - 60_000 }, // exactly at cutoff
          { sensorId: "frontDoor", at: T - 10_000 },
        ]);
        expect(result.triggered).toBe(true);
      });

      it("extra triggers beyond the required counts still trigger", () => {
        const result = evalWith({ sensorId: "frontDoor", at: T }, [
          { sensorId: "window", at: T - 5_000 },
          { sensorId: "window", at: T - 6_000 },
          { sensorId: "frontDoor", at: T - 7_000 },
          { sensorId: "frontDoor", at: T - 8_000 },
        ]);
        expect(result.triggered).toBe(true);
      });

      it("reports the rule name so the alert can identify the condition", () => {
        const result = evalWith({ sensorId: "window", at: T }, [
          { sensorId: "frontDoor", at: T - 15_000 },
          { sensorId: "frontDoor", at: T - 14_000 },
        ]);
        expect(result.ruleName).toBe("Break-in");
        expect(result.conditionType).toBe("multi_sensor");
      });
    });
  });

  describe("multiple rules", () => {
    it("returns triggered if ANY rule matches", () => {
      const rules: Rule[] = [
        { id: "r1", name: "A", sensors: ["sensorA"], condition: { type: "immediate" } },
        { id: "r2", name: "B", sensors: ["sensor1"], condition: { type: "immediate" } },
      ];
      const result = evaluateRules(rules, makeEvent(), [], Date.now());
      expect(result.triggered).toBe(true);
    });

    it("returns not triggered if no rules match", () => {
      const rules: Rule[] = [
        { id: "r1", name: "A", sensors: ["sensorA"], condition: { type: "immediate" } },
      ];
      const result = evaluateRules(rules, makeEvent(), [], Date.now());
      expect(result.triggered).toBe(false);
    });
  });
});
