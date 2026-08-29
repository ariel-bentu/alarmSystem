import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { I18nProvider } from "./i18n/I18nProvider";
import { registerServiceWorker } from "./pwa/registerSW";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
);

registerServiceWorker();
