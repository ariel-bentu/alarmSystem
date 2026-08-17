import { useState, useEffect } from "react";
import {
  getDocs,
  addDoc,
  deleteDoc,
  updateDoc,
  Timestamp,
} from "firebase/firestore";
import {
  sensorsCol,
  profilesCol,
  profileDoc,
  rulesCol,
  ruleDoc,
} from "@/lib/firestore";
import { useProject } from "@/app/ProjectProvider";
import type { Sensor, Profile, Rule, Condition } from "@/types";
import {
  buildInitialRules,
  conditionParamsValid,
  ruleNameRequired,
  ruleNameValid,
  sensorCountValidForType,
} from "./profileRules";
import RuleEditor from "./RuleEditor";

export default function ProfilesTab() {
  const { project } = useProject();
  const projectId = project?.id ?? "";

  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [rulesMap, setRulesMap] = useState<Record<string, Rule[]>>({});
  const [newProfileName, setNewProfileName] = useState("");
  const [loading, setLoading] = useState(true);

  // Editing state
  const [editingRule, setEditingRule] = useState<{
    profileId: string;
    rule: Rule;
  } | null>(null);

  // New rule state
  const [addingRuleProfile, setAddingRuleProfile] = useState<string | null>(
    null
  );
  const [newRuleSensors, setNewRuleSensors] = useState<string[]>([]);
  const [newRuleCondition, setNewRuleCondition] = useState<Condition>({
    type: "immediate",
  });
  const [newRuleName, setNewRuleName] = useState("");

  const loadData = async () => {
    if (!projectId) return;
    setLoading(true);

    const [sensorSnap, profileSnap] = await Promise.all([
      getDocs(sensorsCol(projectId)),
      getDocs(profilesCol(projectId)),
    ]);

    const loadedSensors = sensorSnap.docs.map((d) => d.data());
    const loadedProfiles = profileSnap.docs.map((d) => d.data());

    setSensors(loadedSensors);
    setProfiles(loadedProfiles);

    // Load rules for each profile
    const rMap: Record<string, Rule[]> = {};
    await Promise.all(
      loadedProfiles.map(async (p) => {
        const rulesSnap = await getDocs(rulesCol(projectId, p.id));
        rMap[p.id] = rulesSnap.docs.map((d) => d.data());
      })
    );
    setRulesMap(rMap);
    setLoading(false);
  };

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const handleCreateProfile = async () => {
    if (!newProfileName.trim() || !projectId) return;
    const profileId = newProfileName.trim().toLowerCase().replace(/\s+/g, "");
    const displayName = newProfileName.trim();

    const newProfile: Omit<Profile, "id"> = {
      displayName,
      createdAt: Timestamp.now(),
      enabled: true,
      isActiveOnDevice: false,
      isActiveOnServer: false,
    };

    // Create profile doc with specific ID
    const { setDoc } = await import("firebase/firestore");
    await setDoc(profileDoc(projectId, profileId), {
      id: profileId,
      ...newProfile,
    } as Profile);

    // Auto-generate one immediate rule per paired sensor
    const sensorIds = sensors.map((s) => s.id);
    const initialRules = buildInitialRules(sensorIds);
    for (const rule of initialRules) {
      await addDoc(rulesCol(projectId, profileId), rule as Rule);
    }

    setNewProfileName("");
    await loadData();
  };

  const handleDeleteRule = async (profileId: string, ruleId: string) => {
    if (!projectId) return;
    await deleteDoc(ruleDoc(projectId, profileId, ruleId));
    await loadData();
  };

  const handleSaveEditedRule = async () => {
    if (!editingRule || !projectId) return;
    const { profileId, rule } = editingRule;

    // A sensor may appear in several rules of the same profile — rules are
    // OR'd, so e.g. sensor1 can be in a count_in_window rule and also in a
    // multi_sensor rule with sensor2.

    if (!sensorCountValidForType(rule.condition.type, rule.sensors.length)) {
      alert(
        rule.condition.type === "multi_sensor"
          ? "A Multi Sensor rule needs at least two sensors."
          : "This condition type applies to exactly one sensor. Use Multi Sensor for several."
      );
      return;
    }

    if (!ruleNameValid(rule.sensors, rule.name ?? "")) {
      alert("A rule with more than one sensor must have a name.");
      return;
    }

    if (!conditionParamsValid(rule.condition)) {
      alert("Invalid condition parameters.");
      return;
    }

    await updateDoc(ruleDoc(projectId, profileId, rule.id), {
      name: rule.name,
      sensors: rule.sensors,
      condition: rule.condition,
    });
    setEditingRule(null);
    await loadData();
  };

  const handleAddRule = async () => {
    if (!addingRuleProfile || !projectId) return;
    if (newRuleSensors.length === 0) {
      alert("Select at least one sensor.");
      return;
    }

    // No uniqueness constraint: a sensor may take part in multiple rules of the
    // same profile (rules are evaluated with OR semantics).

    if (!sensorCountValidForType(newRuleCondition.type, newRuleSensors.length)) {
      alert(
        newRuleCondition.type === "multi_sensor"
          ? "A Multi Sensor rule needs at least two sensors."
          : "This condition type applies to exactly one sensor. Use Multi Sensor for several."
      );
      return;
    }

    if (!ruleNameValid(newRuleSensors, newRuleName)) {
      alert("A rule with more than one sensor must have a name.");
      return;
    }

    if (!conditionParamsValid(newRuleCondition)) {
      alert("Invalid condition parameters.");
      return;
    }

    const newRule: Omit<Rule, "id"> = {
      name: newRuleName.trim(),
      sensors: newRuleSensors,
      condition: newRuleCondition,
    };
    await addDoc(rulesCol(projectId, addingRuleProfile), newRule as Rule);

    setAddingRuleProfile(null);
    setNewRuleSensors([]);
    setNewRuleCondition({ type: "immediate" });
    setNewRuleName("");
    await loadData();
  };

  // Enable/disable a profile. A disabled profile is hidden in Operations; if it
  // was armed anywhere, disabling also clears that activation.
  const handleToggleEnabled = async (profile: Profile) => {
    if (!projectId) return;
    const nextEnabled = !(profile.enabled !== false);
    const update: Partial<Profile> = { enabled: nextEnabled };
    if (!nextEnabled) {
      update.isActiveOnDevice = false;
      update.isActiveOnServer = false;
    }
    await updateDoc(profileDoc(projectId, profile.id), update);
    await loadData();
  };

  const toggleSensorInNewRule = (sensorId: string) => {
    setNewRuleSensors((prev) =>
      prev.includes(sensorId)
        ? prev.filter((id) => id !== sensorId)
        : [...prev, sensorId]
    );
  };

  if (loading) return <p>Loading profiles...</p>;

  return (
    <div>
      <h2>Profiles</h2>

      {/* Create new profile */}
      <div>
        <input
          type="text"
          value={newProfileName}
          onChange={(e) => setNewProfileName(e.target.value)}
          placeholder="Profile name (e.g. Away)"
        />
        <button onClick={handleCreateProfile} disabled={!newProfileName.trim()}>
          Create Profile
        </button>
      </div>

      {/* List profiles */}
      {profiles.map((profile) => (
        <div key={profile.id} style={{ marginTop: "1rem", border: "1px solid #ccc", padding: "1rem" }}>
          <h3>
            {profile.displayName}
            {profile.enabled === false && (
              <span style={{ opacity: 0.6, fontWeight: 400 }}> (disabled)</span>
            )}
          </h3>
          <div>
            <label>
              <input
                type="checkbox"
                checked={profile.enabled !== false}
                onChange={() => handleToggleEnabled(profile)}
              />
              Enabled (available to arm in Operations)
            </label>
          </div>

          {/* Rules list */}
          <h4>Rules</h4>
          {(rulesMap[profile.id] ?? []).length === 0 && <p>No rules.</p>}
          <ul>
            {(rulesMap[profile.id] ?? []).map((rule) => (
              <li key={rule.id}>
                <strong>{rule.name || "(unnamed)"}</strong>
                {" — Sensors: "}
                {rule.sensors
                  .map(
                    (sid) =>
                      sensors.find((s) => s.id === sid)?.name ?? sid
                  )
                  .join(", ")}
                {" — Condition: "}
                {rule.condition.type}
                {" "}
                <button
                  onClick={() =>
                    setEditingRule({ profileId: profile.id, rule: { ...rule } })
                  }
                >
                  Edit
                </button>
                <button onClick={() => handleDeleteRule(profile.id, rule.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>

          <button onClick={() => setAddingRuleProfile(profile.id)}>
            Add Rule
          </button>
        </div>
      ))}

      {/* Edit rule modal */}
      {editingRule && (
        <div style={{ marginTop: "1rem", border: "2px solid blue", padding: "1rem" }}>
          <h3>Edit Rule</h3>
          <label>
            Name:{" "}
            <input
              type="text"
              value={editingRule.rule.name}
              onChange={(e) =>
                setEditingRule({
                  ...editingRule,
                  rule: { ...editingRule.rule, name: e.target.value },
                })
              }
            />
          </label>
          <div>
            <strong>Sensors:</strong>
            {sensors.map((s) => (
              <label key={s.id} style={{ display: "block" }}>
                <input
                  type="checkbox"
                  checked={editingRule.rule.sensors.includes(s.id)}
                  onChange={() => {
                    const current = editingRule.rule.sensors;
                    const next = current.includes(s.id)
                      ? current.filter((id) => id !== s.id)
                      : [...current, s.id];
                    setEditingRule({
                      ...editingRule,
                      rule: { ...editingRule.rule, sensors: next },
                    });
                  }}
                />
                {s.name} ({s.rfId})
              </label>
            ))}
          </div>
          <RuleEditor
            condition={editingRule.rule.condition}
            selectedSensors={sensors
              .filter((s) => editingRule.rule.sensors.includes(s.id))
              .map((s) => ({ id: s.id, name: s.name }))}
            onChange={(condition) =>
              setEditingRule({
                ...editingRule,
                rule: { ...editingRule.rule, condition },
              })
            }
          />
          <button onClick={handleSaveEditedRule}>Save</button>
          <button onClick={() => setEditingRule(null)}>Cancel</button>
        </div>
      )}

      {/* Add rule form */}
      {addingRuleProfile && (
        <div style={{ marginTop: "1rem", border: "2px solid green", padding: "1rem" }}>
          <h3>
            Add Rule to{" "}
            {profiles.find((p) => p.id === addingRuleProfile)?.displayName}
          </h3>
          <label>
            Name{ruleNameRequired(newRuleSensors) ? " (required)" : ""}:{" "}
            <input
              type="text"
              value={newRuleName}
              onChange={(e) => setNewRuleName(e.target.value)}
              placeholder={
                ruleNameRequired(newRuleSensors)
                  ? "Required for multi-sensor rules"
                  : "Optional label"
              }
              required={ruleNameRequired(newRuleSensors)}
            />
          </label>
          <div>
            <strong>Select Sensors:</strong>
            {sensors.map((s) => (
              <label key={s.id} style={{ display: "block" }}>
                <input
                  type="checkbox"
                  checked={newRuleSensors.includes(s.id)}
                  onChange={() => toggleSensorInNewRule(s.id)}
                />
                {s.name} ({s.rfId})
              </label>
            ))}
          </div>
          <RuleEditor
            condition={newRuleCondition}
            selectedSensors={sensors
              .filter((s) => newRuleSensors.includes(s.id))
              .map((s) => ({ id: s.id, name: s.name }))}
            onChange={(c) => setNewRuleCondition(c)}
          />
          <button onClick={handleAddRule}>Add</button>
          <button
            onClick={() => {
              setAddingRuleProfile(null);
              setNewRuleSensors([]);
              setNewRuleCondition({ type: "immediate" });
              setNewRuleName("");
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
