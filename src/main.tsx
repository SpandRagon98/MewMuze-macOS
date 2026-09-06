import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// The overlay should never show a browser context menu, text selection, or the
// native image-drag ghost — it must feel like a bare desktop pet.
window.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("dragstart", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
