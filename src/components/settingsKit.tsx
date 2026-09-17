//! Building blocks every Settings page is made of: page header, section card,
//! a labelled row, toggle, select and the "Advanced" disclosure. One place for
//! the markup means every page reads the same and search can find any row.

import type { ReactNode } from "react";
import { Icon } from "./icons";

/** Stable id for a setting, used by search to scroll to and flash its row. */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export function Page({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <>
      <header className="mm-page-head">
        <h1 className="mm-page-title">{title}</h1>
        {sub && <p className="mm-page-sub">{sub}</p>}
      </header>
      {children}
    </>
  );
}

/** `wide`: spans the full page even when a wide window flows sections into two columns. */
export function Section({ title, sub, action, bare = false, wide = false, children }: { title?: string; sub?: string; action?: ReactNode; bare?: boolean; wide?: boolean; children: ReactNode }) {
  return (
    <section className={`mm-section${wide ? " wide" : ""}`}>
      {title && (
        <h2 className="mm-section-title">
          {title}
          {action}
        </h2>
      )}
      {sub && <p className="mm-section-sub">{sub}</p>}
      {bare ? children : <div className="mm-card">{children}</div>}
    </section>
  );
}

/** A labelled setting: name and one short sentence on the left, control on the right. */
export function Row({ label, hint, children, stack = false, badge }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; stack?: boolean; badge?: ReactNode }) {
  const id = typeof label === "string" ? slug(label) : undefined;
  return (
    <div className={`sk-row${stack ? " stack" : ""}`} data-setting={id}>
      <label className="sk-label">
        <span>
          {label}
          {badge}
        </span>
        {hint && <span className="sk-hint">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

export function Toggle({ label, hint, checked, onChange, disabled = false, badge }: { label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; badge?: ReactNode }) {
  return (
    <Row label={label} hint={hint} badge={badge}>
      <button role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`sk-switch${checked ? " on" : ""}`} onClick={() => onChange(!checked)}>
        <span className="sk-switch-knob" />
      </button>
    </Row>
  );
}

export function Select<T extends string | number>({
  label,
  hint,
  value,
  options,
  onChange,
  disabled = false,
  badge,
}: {
  label: string;
  hint?: ReactNode;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  disabled?: boolean;
  badge?: ReactNode;
}) {
  return (
    <Row label={label} hint={hint} badge={badge}>
      <select
        className="sk-input"
        aria-label={label}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const hit = options.find(([v]) => String(v) === e.target.value);
          if (hit) onChange(hit[0]);
        }}
      >
        {options.map(([v, text]) => (
          <option key={String(v)} value={String(v)}>
            {text}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** Settings most people never need, one click away instead of in the way. */
export function Advanced({ label = "Advanced", children }: { label?: string; children: ReactNode }) {
  return (
    <details className="mm-advanced">
      <summary>
        <Icon name="chevronRight" size={15} />
        {label}
      </summary>
      <div className="mm-advanced-body">{children}</div>
    </details>
  );
}
