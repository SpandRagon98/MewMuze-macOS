import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// The overlay should never show a browser context menu, text selection, or the
// native image-drag ghost — it must feel like a bare desktop pet.
window.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("dragstart", (e) => e.preventDefault());

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
// The Look Preview window loads this same page with ?view=preview: it gets its
// own small app (lazy, so the overlay never downloads it) and never the cat.
const view = (window as Window & { __MEWMUZE_VIEW__?: { view?: string } }).__MEWMUZE_VIEW__?.view ?? new URLSearchParams(location.search).get("view");
if (view === "preview") {
  void import("./preview/LookPreviewApp").then(({ LookPreviewApp }) =>
    root.render(
      <React.StrictMode>
        <LookPreviewApp />
      </React.StrictMode>,
    ),
  );
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
