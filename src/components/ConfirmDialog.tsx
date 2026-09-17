//! In-app confirmation, replacing window.confirm (an unstyled Windows box
//! that broke the look). `confirmAction` mounts itself on document.body, so
//! any panel can ask without owning a dialog host, and resolves true/false.

import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

function Dialog({ opts, onDone }: { opts: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);
  return (
    <div className="mm-confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onDone(false)}>
      <div className="mm-confirm" role="alertdialog" aria-modal="true" aria-labelledby="mm-confirm-title">
        <h2 id="mm-confirm-title" className="mm-confirm-title">
          {opts.title}
        </h2>
        {opts.message && <p className="mm-confirm-text">{opts.message}</p>}
        <div className="mm-confirm-actions">
          <button className="mm-btn" onClick={() => onDone(false)}>
            {opts.cancelLabel ?? "Cancel"}
          </button>
          <button ref={confirmRef} className={`mm-btn ${opts.danger ? "danger" : "primary"}`} onClick={() => onDone(true)}>
            {opts.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (ok: boolean) => {
      root.unmount();
      host.remove();
      resolve(ok);
    };
    root.render(<Dialog opts={opts} onDone={done} />);
  });
}
