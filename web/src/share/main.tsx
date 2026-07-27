import React from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider } from "../i18n";
import { SharedView } from "./SharedView.tsx";
import { installSystemColorScheme } from "../platform/color-scheme.ts";
import "../index.css";
import "../styles.css";

installSystemColorScheme();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleProvider>
      <SharedView />
    </LocaleProvider>
  </React.StrictMode>,
);
