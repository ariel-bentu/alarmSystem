import { useState } from "react";
import SensorsTab from "./SensorsTab";
import ProfilesTab from "./ProfilesTab";
import SirenTab from "./SirenTab";

type Tab = "sensors" | "profiles" | "siren";

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
        <button
          onClick={() => setActiveTab("siren")}
          disabled={activeTab === "siren"}
        >
          Siren
        </button>
      </nav>
      <div style={{ marginTop: "1rem" }}>
        {activeTab === "sensors" && <SensorsTab />}
        {activeTab === "profiles" && <ProfilesTab />}
        {activeTab === "siren" && <SirenTab />}
      </div>
    </div>
  );
}
