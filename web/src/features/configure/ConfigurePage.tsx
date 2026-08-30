import { useState } from "react";
import SensorsTab from "./SensorsTab";
import ProfilesTab from "./ProfilesTab";
import SirenTab from "./SirenTab";
import { ScrollingTabs } from "@/components/ScrollingTabs";
import { useT } from "@/i18n/I18nProvider";
import type { TranslationKey } from "@/i18n/en";

type Tab = "sensors" | "profiles" | "siren";

const TABS: { id: Tab; key: TranslationKey }[] = [
  { id: "sensors", key: "cfg.tab.sensors" },
  { id: "profiles", key: "cfg.tab.profiles" },
  { id: "siren", key: "cfg.tab.siren" },
];

export default function ConfigurePage() {
  const t = useT();
  const [activeTab, setActiveTab] = useState<Tab>("sensors");
  const [creatingProfile, setCreatingProfile] = useState(false);

  return (
    <div>
      <h1 className="sr-only">{t("cfg.title")}</h1>

      {/* The `+` sits BESIDE the strip, not inside it: ScrollingTabs renders
          its children into role="tablist", where a non-tab child is invalid,
          and it would scroll out of reach with the tabs. */}
      <div className="tabs-row">
        {/* Tabs are selected via aria-selected rather than `disabled`: a
            disabled button is removed from the focus order, so the active tab
            became unreachable by keyboard. */}
        <ScrollingTabs activeKey={activeTab} ariaLabel={t("cfg.title")}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`panel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {t(tab.key)}
            </button>
          ))}
        </ScrollingTabs>

        {activeTab === "profiles" && (
          <button
            type="button"
            className="btn btn--sm tabs-row__action"
            onClick={() => setCreatingProfile(true)}
            aria-label={t("cfg.profiles.createProfile")}
            title={t("cfg.profiles.createProfile")}
          >
            +
          </button>
        )}
      </div>

      <div
        id={`panel-${activeTab}`}
        role="tabpanel"
        style={{ marginBlockStart: "var(--sp-4)" }}
      >
        {activeTab === "sensors" && <SensorsTab />}
        {activeTab === "profiles" && (
          <ProfilesTab
            creating={creatingProfile}
            onCreatingChange={setCreatingProfile}
          />
        )}
        {activeTab === "siren" && <SirenTab />}
      </div>
    </div>
  );
}
