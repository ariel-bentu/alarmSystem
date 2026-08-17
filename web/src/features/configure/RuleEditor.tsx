import { useState, useEffect } from "react";
import type { Condition, ConditionType } from "@/types";
import { conditionParamsValid } from "./profileRules";

// Default params for each condition type.
function defaultsFor(type: ConditionType): Condition {
  switch (type) {
    case "count_in_window":
      return { type: "count_in_window", count: 3, window_sec: 60 };
    case "entry_delay":
      return { type: "entry_delay", delay_sec: 30 };
    case "multi_sensor":
      return { type: "multi_sensor", window_sec: 10 };
    case "immediate":
    default:
      return { type: "immediate" };
  }
}

interface RuleEditorProps {
  condition: Condition;
  onChange: (condition: Condition) => void;
  /** Sensors selected for this rule — used to render per-sensor counts. */
  selectedSensors?: { id: string; name: string }[];
}

const CONDITION_TYPES: { value: ConditionType; label: string }[] = [
  { value: "immediate", label: "Immediate" },
  { value: "count_in_window", label: "Count in Window" },
  { value: "entry_delay", label: "Entry Delay" },
  { value: "multi_sensor", label: "Multi Sensor" },
];

export default function RuleEditor({
  condition,
  onChange,
  selectedSensors = [],
}: RuleEditorProps) {
  const [localCondition, setLocalCondition] = useState<Condition>(condition);

  const isMulti = selectedSensors.length > 1;

  // The condition type is driven by how many sensors the rule covers:
  // 2+ sensors is only meaningful as multi_sensor, 1 sensor never is.
  useEffect(() => {
    if (isMulti && localCondition.type !== "multi_sensor") {
      const next = defaultsFor("multi_sensor");
      setLocalCondition(next);
      onChange(next);
    } else if (!isMulti && localCondition.type === "multi_sensor") {
      const next = defaultsFor("immediate");
      setLocalCondition(next);
      onChange(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMulti]);

  // Per-sensor required trigger counts (multi_sensor only). Default 1.
  const handleCountChange = (sensorId: string, value: number) => {
    const counts = { ...(localCondition.counts ?? {}), [sensorId]: value };
    const next = { ...localCondition, counts };
    setLocalCondition(next);
    onChange(next);
  };

  const handleTypeChange = (type: ConditionType) => {
    const next = defaultsFor(type);
    setLocalCondition(next);
    onChange(next);
  };

  const handleParamChange = (key: string, value: number) => {
    const next = { ...localCondition, [key]: value };
    setLocalCondition(next);
    onChange(next);
  };

  const isValid = conditionParamsValid(localCondition);

  return (
    <div className="rule-editor">
      <label>
        Condition Type:{" "}
        <select
          value={localCondition.type}
          disabled={isMulti}
          onChange={(e) => handleTypeChange(e.target.value as ConditionType)}
        >
          {CONDITION_TYPES.filter((ct) =>
            isMulti ? ct.value === "multi_sensor" : ct.value !== "multi_sensor"
          ).map((ct) => (
            <option key={ct.value} value={ct.value}>
              {ct.label}
            </option>
          ))}
        </select>
      </label>
      {isMulti && (
        <p style={{ opacity: 0.7, fontSize: 13, margin: "4px 0" }}>
          Two or more sensors — the rule is a Multi Sensor condition.
        </p>
      )}

      {localCondition.type === "count_in_window" && (
        <div>
          <label>
            Count:{" "}
            <input
              type="number"
              min={1}
              value={localCondition.count ?? ""}
              onChange={(e) =>
                handleParamChange("count", Number(e.target.value))
              }
            />
          </label>
          <label>
            Window (sec):{" "}
            <input
              type="number"
              min={1}
              value={localCondition.window_sec ?? ""}
              onChange={(e) =>
                handleParamChange("window_sec", Number(e.target.value))
              }
            />
          </label>
        </div>
      )}

      {localCondition.type === "entry_delay" && (
        <div>
          <label>
            Delay (sec):{" "}
            <input
              type="number"
              min={1}
              value={localCondition.delay_sec ?? ""}
              onChange={(e) =>
                handleParamChange("delay_sec", Number(e.target.value))
              }
            />
          </label>
        </div>
      )}

      {localCondition.type === "multi_sensor" && (
        <div>
          <label>
            Window (sec):{" "}
            <input
              type="number"
              min={1}
              value={localCondition.window_sec ?? ""}
              onChange={(e) =>
                handleParamChange("window_sec", Number(e.target.value))
              }
            />
          </label>
          {selectedSensors.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <strong>Triggers required per sensor</strong>
              <p style={{ opacity: 0.7, fontSize: 13, margin: "4px 0" }}>
                All sensors must reach their count within the window.
              </p>
              {selectedSensors.map((s) => (
                <div key={s.id}>
                  <label>
                    {s.name}:{" "}
                    <input
                      type="number"
                      min={1}
                      value={localCondition.counts?.[s.id] ?? 1}
                      onChange={(e) =>
                        handleCountChange(s.id, Number(e.target.value))
                      }
                    />
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!isValid && (
        <p style={{ color: "red" }}>Invalid condition parameters.</p>
      )}
    </div>
  );
}
