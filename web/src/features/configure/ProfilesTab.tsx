import { useState, useEffect, useRef } from "react";
import {
  getDocs,
  addDoc,
  deleteDoc,
  updateDoc,
  Timestamp,
} from "firebase/firestore";
import { set } from "firebase/database";
import {
  sensorsCol,
  profilesCol,
  profileDoc,
  projectDoc,
  rulesCol,
  ruleDoc,
} from "@/lib/firestore";
import { commandsArmedRef, commandsArmedViaRef } from "@/lib/rtdb";
import { useProject } from "@/app/ProjectProvider";
import type { Sensor, Profile, Rule, Condition } from "@/types";
import {
  buildInitialRules,
  conditionParamsValid,
  ruleDisplayName,
  ruleNameRequired,
  ruleNameValid,
  sensorCountValidForType,
} from "./profileRules";
import RuleEditor from "./RuleEditor";
import { useT } from "@/i18n/I18nProvider";
import type { TranslationKey } from "@/i18n/en";

interface ProfilesTabProps {
  /** Whether the create-profile dialog is open. Owned by ConfigurePage, which
   *  renders the `+` button beside the tab strip — the button and the dialog
   *  live in different components, so the open state is the only thing that
   *  crosses between them. */
  creating?: boolean;
  onCreatingChange?: (creating: boolean) => void;
}

export default function ProfilesTab({
  creating = false,
  onCreatingChange,
}: ProfilesTabProps) {
  const t = useT();
  const { project } = useProject();
  const projectId = project?.id ?? "";

  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [rulesMap, setRulesMap] = useState<Record<string, Rule[]>>({});
  const [newProfileName, setNewProfileName] = useState("");
  // Inline rename: which profile is being renamed, and the pending name.
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null
  );
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
  const [newRuleAlways, setNewRuleAlways] = useState(false);

  const editDialogRef = useRef<HTMLDialogElement>(null);
  const addDialogRef = useRef<HTMLDialogElement>(null);
  const createProfileDialogRef = useRef<HTMLDialogElement>(null);

  // Adding a rule discards several fields, so closing has to go through one
  // place — otherwise Esc and the backdrop would leave half-filled state
  // behind for the next open.
  const closeAddRule = () => {
    setAddingRuleProfile(null);
    setNewRuleSensors([]);
    setNewRuleCondition({ type: "immediate" });
    setNewRuleName("");
    setNewRuleAlways(false);
  };

  // showModal() is what puts the dialog in the top layer and gives it the
  // ::backdrop, focus trap and Esc handling; rendering with `open` does none
  // of that. See the same pattern in SensorsTab's pair dialog.
  useEffect(() => {
    const el = editDialogRef.current;
    if (!el) return;
    if (editingRule && !el.open) el.showModal();
    if (!editingRule && el.open) el.close();
  }, [editingRule]);

  useEffect(() => {
    const el = addDialogRef.current;
    if (!el) return;
    if (addingRuleProfile && !el.open) el.showModal();
    if (!addingRuleProfile && el.open) el.close();
  }, [addingRuleProfile]);

  useEffect(() => {
    const el = createProfileDialogRef.current;
    if (!el) return;
    if (creating && !el.open) el.showModal();
    if (!creating && el.open) el.close();
  }, [creating]);

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
    onCreatingChange?.(false);
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

    // `always` is written explicitly as a boolean rather than spread in only
    // when true: unlike creation, an update must be able to turn it OFF, and
    // omitting the key would leave the stored `true` untouched.
    await updateDoc(ruleDoc(projectId, profileId, rule.id), {
      name: rule.name,
      sensors: rule.sensors,
      condition: rule.condition,
      always: rule.always === true,
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
      // Spread only when true, so ordinary rules do not each carry a dead
      // `always: false` field.
      ...(newRuleAlways ? { always: true } : {}),
    };
    await addDoc(rulesCol(projectId, addingRuleProfile), newRule as Rule);

    // Reuse closeAddRule rather than repeating the field list: a reset that
    // misses a field leaks it into the NEXT rule added, which for `always`
    // would silently mark an ordinary rule always-on.
    closeAddRule();
    await loadData();
  };

  // Renaming changes displayName only. The doc id is derived from the name at
  // creation but is referenced by rules and by the arm-state flags, so it is
  // deliberately left alone — a rename must not orphan them.
  const handleRenameProfile = async () => {
    if (!renaming || !projectId) return;
    const name = renaming.name.trim();
    if (!name) return;
    await updateDoc(profileDoc(projectId, renaming.id), { displayName: name });
    setRenaming(null);
    await loadData();
  };

  const handleDeleteProfile = async (profile: Profile) => {
    if (!projectId) return;
    if (
      !window.confirm(
        t("cfg.profiles.deleteProfileConfirm", { name: profile.displayName })
      )
    ) {
      return;
    }

    // Disarm first, for the same reason disabling does: arm state lives on the
    // profile AND on serverArmed / commands.armed. Deleting the profile alone
    // would leave the system claiming armed with nothing to evaluate.
    if (profile.isActiveOnServer) {
      await updateDoc(projectDoc(projectId), { serverArmed: false });
    }
    if (profile.isActiveOnDevice) {
      // See OperationsPage: written before commands/armed so the resulting
      // timeline row is attributed to the app.
      await set(commandsArmedViaRef(projectId), "app");
      await set(commandsArmedRef(projectId), false);
    }

    // Firestore does not cascade: deleting the profile doc would orphan its
    // rules subcollection, which then counts against nothing and is invisible
    // in the UI but still billed and still returned by collection queries.
    const rulesSnap = await getDocs(rulesCol(projectId, profile.id));
    await Promise.all(rulesSnap.docs.map((d) => deleteDoc(d.ref)));

    await deleteDoc(profileDoc(projectId, profile.id));
    await loadData();
  };

  // Enable/disable a profile. A disabled profile is hidden in Operations; if it
  // was armed anywhere, disabling also clears that activation.
  const handleToggleEnabled = async (profile: Profile) => {
    if (!projectId) return;
    const nextEnabled = !(profile.enabled !== false);
    const update: Partial<Profile> = { enabled: nextEnabled };
    const wasArmedSomewhere =
      Boolean(profile.isActiveOnDevice) || Boolean(profile.isActiveOnServer);
    if (!nextEnabled) {
      update.isActiveOnDevice = false;
      update.isActiveOnServer = false;
    }
    await updateDoc(profileDoc(projectId, profile.id), update);

    // Arm state lives in two places — the profile's isActiveOn* flags and the
    // project's serverArmed / RTDB commands.armed. Clearing only the flags
    // left the system claiming "armed" with no active profile: the badge said
    // armed while the grid highlighted Disarmed. Disabling an armed profile
    // must disarm that side too.
    if (!nextEnabled && wasArmedSomewhere) {
      if (profile.isActiveOnServer) {
        await updateDoc(projectDoc(projectId), { serverArmed: false });
      }
      if (profile.isActiveOnDevice) {
        await set(commandsArmedViaRef(projectId), "app");
        await set(commandsArmedRef(projectId), false);
      }
    }

    await loadData();
  };

  const toggleSensorInNewRule = (sensorId: string) => {
    setNewRuleSensors((prev) =>
      prev.includes(sensorId)
        ? prev.filter((id) => id !== sensorId)
        : [...prev, sensorId]
    );
  };

  if (loading) return <p>{t("cfg.profiles.loading")}</p>;

  // Checkbox list of sensors, shared by the add and edit rule forms.
  const SensorPicker = ({
    selected,
    onToggle,
  }: {
    selected: string[];
    onToggle: (id: string) => void;
  }) => (
    <div className="field">
      <span className="field__label">{t("cfg.profiles.selectSensors")}</span>
      {sensors.map((s) => (
        <label key={s.id} className="check">
          <input
            type="checkbox"
            checked={selected.includes(s.id)}
            onChange={() => onToggle(s.id)}
          />
          <span>
            {s.name} <span className="ltr muted">({s.rfId})</span>
          </span>
        </label>
      ))}
    </div>
  );

  return (
    <div>
      {/* Creating a profile is occasional; the profiles themselves are what
          the tab is for. A permanent form pushed them down the page, so this
          is a modal opened by the `+` beside the tab strip. */}
      <dialog
        ref={createProfileDialogRef}
        className="modal"
        onCancel={() => onCreatingChange?.(false)}
        onClose={() => onCreatingChange?.(false)}
      >
        <div className="modal__body">
          <h3 className="card__title">{t("cfg.profiles.createProfile")}</h3>
          <div className="field">
            <label className="field__label" htmlFor="new-profile-name">
              {t("cfg.profiles.renameLabel")}
            </label>
            <input
              id="new-profile-name"
              className="input"
              type="text"
              value={newProfileName}
              autoFocus
              onChange={(e) => setNewProfileName(e.target.value)}
              placeholder={t("cfg.profiles.namePlaceholder")}
              // Enter creates, Escape abandons — <dialog> already handles
              // Escape, so only Enter needs wiring.
              onKeyDown={(e) => {
                if (e.key === "Enter" && newProfileName.trim()) {
                  void handleCreateProfile();
                }
              }}
            />
          </div>
          <div className="row">
            <button
              className="btn btn--primary"
              onClick={() => void handleCreateProfile()}
              disabled={!newProfileName.trim()}
            >
              {t("cfg.profiles.createProfile")}
            </button>
            <button
              className="btn"
              onClick={() => {
                setNewProfileName("");
                onCreatingChange?.(false);
              }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </dialog>

      {profiles.map((profile) => (
        <section className="card" key={profile.id}>
          <div className="card__header">
            {renaming?.id === profile.id ? (
              <>
                <input
                  className="input"
                  type="text"
                  value={renaming.name}
                  autoFocus
                  aria-label={t("cfg.profiles.renameLabel")}
                  onChange={(e) =>
                    setRenaming({ id: profile.id, name: e.target.value })
                  }
                  // Enter saves, Escape abandons — expected of an inline edit,
                  // and avoids trapping someone who opened it by accident.
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleRenameProfile();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  onClick={() => void handleRenameProfile()}
                  disabled={!renaming.name.trim()}
                >
                  {t("common.save")}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setRenaming(null)}
                >
                  {t("common.cancel")}
                </button>
              </>
            ) : (
              <>
                <h3 className="card__title">
                  {profile.displayName}
                  {profile.enabled === false && (
                    <span className="muted">
                      {" "}
                      {t("cfg.profiles.disabledSuffix")}
                    </span>
                  )}
                </h3>
                <button
                  type="button"
                  className="btn btn--sm spacer"
                  onClick={() =>
                    setRenaming({ id: profile.id, name: profile.displayName })
                  }
                >
                  {t("cfg.profiles.rename")}
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  onClick={() => void handleDeleteProfile(profile)}
                >
                  {t("common.delete")}
                </button>
              </>
            )}
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={profile.enabled !== false}
              onChange={() => handleToggleEnabled(profile)}
            />
            <span>{t("cfg.profiles.enabledHelp")}</span>
          </label>

          {/* The + sits on the heading rather than below the list: with
              several rules the trailing button drifted down the card, away
              from the thing it adds to. */}
          <div className="section-head">
            <h4>{t("cfg.profiles.rules")}</h4>
            <button
              type="button"
              className="btn btn--sm section-head__action"
              onClick={() => setAddingRuleProfile(profile.id)}
              aria-label={t("cfg.profiles.addRuleTo", {
                profile: profile.displayName,
              })}
              title={t("cfg.profiles.addRule")}
            >
              +
            </button>
          </div>
          {(rulesMap[profile.id] ?? []).length === 0 ? (
            <p className="muted">{t("cfg.profiles.noRules")}</p>
          ) : (
            <ul className="rule-list">
              {(rulesMap[profile.id] ?? []).map((rule) => (
                <li className="rule-row" key={rule.id}>
                  {/* One line per rule. The name and the condition sit inline
                      and the actions are pushed to the end, so a profile's
                      rules can be scanned vertically instead of read as a
                      stack of four-line blocks. */}
                  <span className="rule-row__name">
                    {ruleDisplayName(rule, (id) =>
                      sensors.find((s) => s.id === id)?.name
                    ) ?? t("cfg.profiles.unnamedRule")}
                  </span>
                  <span className="rule-row__cond muted">
                    {t(`cfg.rule.type.${rule.condition.type}` as TranslationKey)}
                  </span>
                  {/* An always-rule fires while the system is DISARMED, so it
                      must not read as just another muted detail next to the
                      condition type — it gets its own high-contrast tag. */}
                  {rule.always === true && (
                    <span className="rule-row__always">
                      {t("cfg.rule.alwaysBadge")}
                    </span>
                  )}
                  <button
                    className="btn btn--sm"
                    onClick={() =>
                      setEditingRule({ profileId: profile.id, rule: { ...rule } })
                    }
                  >
                    {t("common.edit")}
                  </button>
                  <button
                    className="btn btn--sm btn--danger"
                    onClick={() => handleDeleteRule(profile.id, rule.id)}
                  >
                    {t("common.delete")}
                  </button>
                </li>
              ))}
            </ul>
          )}

        </section>
      ))}

      {/* Both rule forms are modals rather than cards appended to the page.
          Inline they rendered after every profile card, so on a page with a
          few profiles the form opened off-screen and the click looked inert. */}
      <dialog
        ref={editDialogRef}
        className="modal"
        onCancel={() => setEditingRule(null)}
        onClose={() => setEditingRule(null)}
      >
        {editingRule && (
        <div className="modal__body">
          <h3 className="card__title">{t("cfg.profiles.editRule")}</h3>
          <div className="field">
            <label className="field__label" htmlFor="edit-rule-name">
              {t("cfg.rule.name")}
            </label>
            <input
              id="edit-rule-name"
              className="input"
              type="text"
              value={editingRule.rule.name}
              onChange={(e) =>
                setEditingRule({
                  ...editingRule,
                  rule: { ...editingRule.rule, name: e.target.value },
                })
              }
            />
          </div>
          <SensorPicker
            selected={editingRule.rule.sensors}
            onToggle={(id) => {
              const current = editingRule.rule.sensors;
              const next = current.includes(id)
                ? current.filter((x) => x !== id)
                : [...current, id];
              setEditingRule({
                ...editingRule,
                rule: { ...editingRule.rule, sensors: next },
              });
            }}
          />
          <RuleEditor
            condition={editingRule.rule.condition}
            selectedSensors={sensors
              .filter((s) => editingRule.rule.sensors.includes(s.id))
              .map((s) => ({ id: s.id, name: s.name }))}
            always={editingRule.rule.always === true}
            onAlwaysChange={(always) =>
              setEditingRule({
                ...editingRule,
                rule: { ...editingRule.rule, always },
              })
            }
            onChange={(condition) =>
              setEditingRule({
                ...editingRule,
                rule: { ...editingRule.rule, condition },
              })
            }
          />
          <div className="row">
            <button className="btn btn--primary" onClick={handleSaveEditedRule}>
              {t("common.save")}
            </button>
            <button className="btn" onClick={() => setEditingRule(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
        )}
      </dialog>

      <dialog
        ref={addDialogRef}
        className="modal"
        onCancel={closeAddRule}
        onClose={closeAddRule}
      >
        {addingRuleProfile && (
        <div className="modal__body">
          <h3 className="card__title">
            {t("cfg.profiles.addRuleTo", {
              profile:
                profiles.find((p) => p.id === addingRuleProfile)?.displayName ??
                "",
            })}
          </h3>
          <div className="field">
            <label className="field__label" htmlFor="new-rule-name">
              {ruleNameRequired(newRuleSensors)
                ? t("cfg.profiles.nameRequired")
                : t("cfg.profiles.nameOptional")}
            </label>
            <input
              id="new-rule-name"
              className="input"
              type="text"
              value={newRuleName}
              onChange={(e) => setNewRuleName(e.target.value)}
              placeholder={
                ruleNameRequired(newRuleSensors)
                  ? t("cfg.profiles.requiredForMulti")
                  : t("cfg.profiles.optionalLabel")
              }
              required={ruleNameRequired(newRuleSensors)}
            />
          </div>
          <SensorPicker
            selected={newRuleSensors}
            onToggle={toggleSensorInNewRule}
          />
          <RuleEditor
            condition={newRuleCondition}
            selectedSensors={sensors
              .filter((s) => newRuleSensors.includes(s.id))
              .map((s) => ({ id: s.id, name: s.name }))}
            onChange={(c) => setNewRuleCondition(c)}
            always={newRuleAlways}
            onAlwaysChange={setNewRuleAlways}
          />
          <div className="row">
            <button className="btn btn--primary" onClick={handleAddRule}>
              {t("common.add")}
            </button>
            <button className="btn" onClick={closeAddRule}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
        )}
      </dialog>
    </div>
  );
}
