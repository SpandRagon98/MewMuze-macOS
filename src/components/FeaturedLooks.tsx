//! Featured Looks: poster cards for Corporate, BatCat and Cyberpunk.
//!
//! Each poster draws the REAL cat - your breed, fur and eyes - wearing that
//! costume, through the same renderer the desktop cat uses, so the poster can
//! never disagree with what you get. The costume you actually wear is never
//! touched here: posters draw with previewCostumeFrame, and "Preview" opens
//! the separate Look Preview window. Posters are still frames; hovering one
//! plays a short real animation, and nothing runs while Settings is closed.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { ART, applyAppearanceStroke, poseKey, spriteEpoch, type PoseSpec } from "../animation/spriteLoader";
import type { AnimationName } from "../types/cat";
import type { Settings } from "../settings/settingsStore";
import { previewCostumeFrame } from "../costumes/costumeOverlay";
import { listInstalledCostumes, openLookPreview, openMewMuzeStore, type InstalledCostume } from "../costumes/costumeApi";
import { BATCAT_ID, BATCAT_COLOURS } from "../costumes/batCat";
import { CORPORATE_CAT_ID, CORPORATE_COLOURS } from "../costumes/corporateCat";
import { CYBERPUNK_CAT_ID, CYBERPUNK_COLOURS } from "../costumes/cyberpunkCat";
import { cachedPreview, useCatAnimation } from "./CatPreview";
import { Icon } from "./icons";

export const FEATURED = [
  { id: CORPORATE_CAT_ID, cls: "corporate", name: "Corporate", tag: "Ready for business.", colours: CORPORATE_COLOURS },
  { id: BATCAT_ID, cls: "batcat", name: "BatCat", tag: "Own the night.", colours: BATCAT_COLOURS },
  { id: CYBERPUNK_CAT_ID, cls: "cyberpunk", name: "Cyberpunk", tag: "Built for the neon hours.", colours: CYBERPUNK_COLOURS },
] as const;

/** The tint a poster shows: yours if you picked one for this costume, else its default. */
export function tintFor(look: (typeof FEATURED)[number], chosen: string): string {
  return look.colours.some((c) => c.hex === chosen) ? chosen : look.colours[0].hex;
}

/** A costume drawn at its own device-pixel size (shown 1:1), still unless `playing`. */
export function LookArt({ id, tint, playing, css = ART, delay = 0 }: { id: string; tint: string; playing: boolean; css?: number; delay?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const epoch = spriteEpoch();
  const size = Math.round(css * (window.devicePixelRatio || 1));
  // Posters share the preview cache, so a return visit to Cat & Looks paints
  // nothing new: the outline pass and the costume paint are the expensive part.
  const frame = useCallback(
    (pose: PoseSpec) =>
      cachedPreview(`look|${id}|${tint}|${epoch}|${size}|${poseKey(pose)}`, () =>
        applyAppearanceStroke(previewCostumeFrame(id, tint, pose, size)),
      ),
    [id, tint, epoch, size],
  );
  const anim: AnimationName = playing ? "happy" : "idle";
  useCatAnimation(ref, anim, frame, [id, tint, epoch, size], playing, delay);
  return <canvas ref={ref} width={size} height={size} style={{ width: css, height: css }} role="img" aria-label="Costume preview" />;
}

export interface LookMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** The ⋯ menu: secondary actions out of the way, keyboard-friendly. */
export function LookMenu({ label, items }: { label: string; items: LookMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    wrap.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div
      className="mm-lookmenu"
      ref={wrap}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button className="mm-icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div className="mm-lookmenu-list" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className={`mm-lookmenu-item${it.danger ? " danger" : ""}`}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Installed costumes, kept fresh when one is installed or removed. */
export function useInstalledCostumes(): [InstalledCostume[], () => Promise<void>] {
  const [installed, setInstalled] = useState<InstalledCostume[]>([]);
  const refresh = useCallback(async () => {
    setInstalled(await listInstalledCostumes().catch(() => [] as InstalledCostume[]));
  }, []);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void refresh();
    void listen("costumes-changed", () => void refresh())
      .then((unlisten) => (disposed ? unlisten() : (stop = unlisten)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, [refresh]);
  return [installed, refresh];
}

/** The three posters. `manage` adds each owned look's ⋯ menu (Cat & Looks). */
export function FeaturedLooks({
  settings,
  onChange,
  premium,
  installed: given,
  manage,
  onNote,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
  premium: boolean;
  installed?: InstalledCostume[];
  manage?: (costume: InstalledCostume) => LookMenuItem[];
  onNote?: (text: string) => void;
}) {
  const [own] = useInstalledCostumes();
  const installed = given ?? own;
  const [hover, setHover] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const say = (t: string) => (onNote ? onNote(t) : setNote(t));
  // Very wide posters (ultrawide, maximised) get a bigger cat. The art is
  // redrawn at its new size - a CSS scale would blur the pixels.
  const grid = useRef<HTMLDivElement>(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    const el = grid.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setBig(e.contentRect.width >= 1900));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const wear = (look: (typeof FEATURED)[number], costume: InstalledCostume) => {
    if (!costume.supportedBodies.includes(settings.appearance.species)) {
      say(`${look.name} fits ${costume.supportedBodies.join(", ")} cats. Change the breed first.`);
      return;
    }
    say("");
    onChange({ ...settings, selectedCostumeId: look.id });
  };

  return (
    <div className={`mm-looks${big ? " big" : ""}`} ref={grid}>
      {FEATURED.map((look, i) => {
        const costume = installed.find((c) => c.costumeId === look.id);
        const usable = costume?.enabled;
        const wearing = settings.selectedCostumeId === look.id;
        const state: ReactNode = wearing ? (
          <span className="mm-badge accent">Wearing</span>
        ) : usable ? (
          <span className="mm-badge ok">Owned</span>
        ) : costume ? (
          <span className="mm-badge">Disabled</span>
        ) : (
          <span className="mm-badge">In the Store</span>
        );
        return (
          <article
            key={look.id}
            className={`mm-look ${look.cls}`}
            onPointerEnter={() => setHover(look.id)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(look.id)}
            onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setHover(null)}
          >
            <div className="mm-look-stage">
              <span className="mm-look-light" aria-hidden="true" />
              <LookArt id={look.id} tint={tintFor(look, settings.costumeTint)} playing={hover === look.id} css={big ? 288 : 192} delay={hover ? 0 : 60 + i * 40} />
              <span className="mm-look-floor" aria-hidden="true" />
            </div>
            <div className="mm-look-copy">
              <span className="mm-look-kicker">Featured look</span>
              <h3 className="mm-look-name">{look.name}</h3>
              <p className="mm-look-tag">{look.tag}</p>
              <div className="mm-look-badges">
                {state}
                {!premium && <span className="mm-badge pro">PRO</span>}
              </div>
            </div>
            <div className="mm-look-actions">
              <button className="mm-btn" onClick={() => void openLookPreview(look.id).catch((e) => say(String(e)))}>
                Preview
              </button>
              {wearing ? (
                <button className="mm-btn" disabled>
                  Wearing
                </button>
              ) : usable && costume ? (
                <button className="mm-btn primary" onClick={() => wear(look, costume)}>
                  Wear
                </button>
              ) : costume ? null : (
                <button className="mm-btn primary" onClick={() => void openMewMuzeStore()}>
                  Get it
                </button>
              )}
              {manage && costume && <LookMenu label={`More for ${look.name}`} items={manage(costume)} />}
            </div>
          </article>
        );
      })}
      {note && (
        <div className="costume-status" role="status">
          {note}
        </div>
      )}
    </div>
  );
}
