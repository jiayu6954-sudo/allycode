import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { createMockDesktopApi } from "./mock-api.js";
import "./styles.css";

const mockMode =
  import.meta.env.DEV ||
  new URLSearchParams(window.location.search).get("mock") === "1";
if (!window.allycode && mockMode) {
  window.allycode = createMockDesktopApi();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
