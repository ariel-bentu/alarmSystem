import { useState, useEffect } from "react";
import type { Condition, ConditionType } from "@/types";
import { conditionParamsValid } from "./profileRules";
import { useT } from "@/i18n/I18nProvider";
import type { TranslationKey } from "@/i18n/en";

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
  /** Rule-level always-on flag. Lives on the rule, not the condition. */
  always?: boolean;
  onAlwaysChange?: (always: boolean) => void;
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
  always = false,
  onAlwaysChange,
}: RuleEditorProps) {
  const t = useT();
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
    <div className="stack">
      {/* Hidden while `always` is ticked: an always-rule is single-sensor
          immediate by definition, so offering the choice would only allow an
          invalid combination. */}
      {!always && (
        <div className="field">
          <label className="field__label" htmlFor="condition-type">
            {t("cfg.rule.conditionType")}
          </label>
          <select
            id="condition-type"
            className="input"
            value={localCondition.type}
            disabled={isMulti}
            onChange={(e) => handleTypeChange(e.target.value as ConditionType)}
          >
            {CONDITION_TYPES.filter((ct) =>
              isMulti ? ct.value === "multi_sensor" : ct.value !== "multi_sensor"
            ).map((ct) => (
              <option key={ct.value} value={ct.value}>
                {t(`cfg.rule.type.${ct.value}` as TranslationKey)}
              </option>
            ))}
          </select>
        </div>
      )}

      {isMulti && <p className="muted">{t("cfg.rule.multiHint")}</p>}

      {/* Ticking `always` coerces the rule to a single-sensor immediate
          condition — the same coercion style as the sensor-count effect
          above, so an invalid combination is unrepresentable rather than
          rejected on save.

          The two coercions must not fight: with 2+ sensors selected, sensor
          count wins and `always` is disabled. */}
      {onAlwaysChange && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={always}
              disabled={isMulti}
              onChange={(e) => {
                const next = e.target.checked;
                if (next && localCondition.type !== "immediate") {
                  const c = defaultsFor("immediate");
                  setLocalCondition(c);
                  onChange(c);
                }
                onAlwaysChange(next);
              }}
            />
            <span>{t("cfg.rule.always")}</span>
          </label>
          <p className="muted">
            {isMulti ? t("cfg.rule.alwaysMultiHint") : t("cfg.rule.alwaysHelp")}
          </p>
        </>
      )}

      {localCondition.type === "count_in_window" && (
        <div className="row">
          <div className="field">
            <label className="field__label" htmlFor="cond-count">
              {t("cfg.rule.count")}
            </label>
            <input
              id="cond-count"
              className="input input--narrow"
              type="number"
              min={1}
              value={localCondition.count ?? ""}
              onChange={(e) => handleParamChange("count", Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="cond-window">
              {t("cfg.rule.windowSec")}
            </label>
            <input
              id="cond-window"
              className="input input--narrow"
              type="number"
              min={1}
              value={localCondition.window_sec ?? ""}
              onChange={(e) =>
                handleParamChange("window_sec", Number(e.target.value))
              }
            />
          </div>
        </div>
      )}

      {localCondition.type === "entry_delay" && (
        <div className="field">
          <label className="field__label" htmlFor="cond-delay">
            {t("cfg.rule.delaySec")}
          </label>
          <input
            id="cond-delay"
            className="input input--narrow"
            type="number"
            min={1}
            value={localCondition.delay_sec ?? ""}
            onChange={(e) =>
              handleParamChange("delay_sec", Number(e.target.value))
            }
          />
        </div>
      )}

      {localCondition.type === "multi_sensor" && (
        <div>
          <div className="field">
            <label className="field__label" htmlFor="cond-multi-window">
              {t("cfg.rule.windowSec")}
            </label>
            <input
              id="cond-multi-window"
              className="input input--narrow"
              type="number"
              min={1}
              value={localCondition.window_sec ?? ""}
              onChange={(e) =>
                handleParamChange("window_sec", Number(e.target.value))
              }
            />
          </div>
          {selectedSensors.length > 0 && (
            <div>
              <strong>{t("cfg.rule.triggersPerSensor")}</strong>
              <p className="muted">{t("cfg.rule.allMustReach")}</p>
              {selectedSensors.map((s) => (
                <div className="field" key={s.id}>
                  <label className="field__label" htmlFor={`count-${s.id}`}>
                    {s.name}
                  </label>
                  <input
                    id={`count-${s.id}`}
                    className="input input--narrow"
                    type="number"
                    min={1}
                    value={localCondition.counts?.[s.id] ?? 1}
                    onChange={(e) =>
                      handleCountChange(s.id, Number(e.target.value))
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!isValid && (
        <p className="badge badge--danger">{t("cfg.rule.invalid")}</p>
      )}
    </div>
  );
}
