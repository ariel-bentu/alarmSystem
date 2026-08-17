import { useState } from "react";
import SensorsTab from "./SensorsTab";
import ProfilesTab from "./ProfilesTab";

type Tab = "sensors" | "profiles";

export default function ConfigurePage() {
  const [activeTab, setActiveTab] = useState<Tab>("sensors");

  return (
    <div>
      <h1>Configure</h1>
      <nav>
        <button
          onClick={() => setActiveTab("sensors")}
          disabled={activeTab === "sensors"}
        >
          Sensors
        </button>
        <button
          onClick={() => setActiveTab("profiles")}
          disabled={activeTab === "profiles"}
        >
          Profiles
        </button>
      </nav>
      <div style={{ marginTop: "1rem" }}>
        {activeTab === "sensors" && <SensorsTab />}
        {activeTab === "profiles" && <ProfilesTab />}
      </div>
    </div>
  );
}
