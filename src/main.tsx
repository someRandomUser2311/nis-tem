import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initStore } from "./store";
import { loadUserThemes } from "./themes";
import "./styles.css";
import "./themes";

// Block the webview's default context menu (we provide our own) except in text fields.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea, .cm-editor")) e.preventDefault();
});
// Dropping a file anywhere outside a drop zone must not navigate the webview away.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

Promise.all([initStore(), loadUserThemes()]).then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
