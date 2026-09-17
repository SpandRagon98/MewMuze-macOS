import { useState } from "react";
import type { Settings } from "../settings/settingsStore";
import {
  CYBERPUNK_CAT_ID,
  CYBERPUNK_COLOURS,
  DEFAULT_CYBERPUNK_COLOUR,
} from "./cyberpunkCat";
import { BATCAT_ID, BATCAT_COLOURS, DEFAULT_BATCAT_COLOUR } from "./batCat";
import { CORPORATE_CAT_ID, CORPORATE_COLOURS, DEFAULT_CORPORATE_COLOUR } from "./corporateCat";

/**
 * Costumes that let the customer pick a colour, and what they offer.
 *
 * A table rather than a chain of id checks: the second costume to want
 * swatches is where that chain starts going stale.
 */
const TINTABLE: Record<string, { colours: ReadonlyArray<{ id: string; label: string; hex: string }>; fallback: string }> = {
  [CYBERPUNK_CAT_ID]: { colours: CYBERPUNK_COLOURS, fallback: DEFAULT_CYBERPUNK_COLOUR },
  [BATCAT_ID]: { colours: BATCAT_COLOURS, fallback: DEFAULT_BATCAT_COLOUR },
  [CORPORATE_CAT_ID]: { colours: CORPORATE_COLOURS, fallback: DEFAULT_CORPORATE_COLOUR },
};
import {
  chooseAndInstallCostume,
  openLookPreview,
  openMewMuzeStore,
  setCostumeEnabled,
  uninstallCostume,
  type InstalledCostume,
} from "./costumeApi";
import { FEATURED, FeaturedLooks, LookMenu, useInstalledCostumes, type LookMenuItem } from "../components/FeaturedLooks";
import { Icon } from "../components/icons";
import { confirmAction } from "../components/ConfirmDialog";

/**
 * Looks: every outfit in one place - the Featured posters, then the looks you
 * own, with Browse Store and Install Outfit at the top. This replaced a
 * separate "Costumes" management panel that repeated the same outfits.
 *
 * Primary actions sit on each card (Preview, Get / Wear / Wearing). Secondary
 * ones (Disable, Check for updates, Delete) live in its ⋯ menu, and Delete
 * always asks first. Installing still goes through the same checked
 * .mewcostume path (chooseAndInstallCostume) - nothing about it changed.
 */
export function CostumeManager({ settings, onChange, premium = true }: { settings: Settings; onChange: (next: Settings) => void; premium?: boolean }) {
  const [costumes, refresh] = useInstalledCostumes();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const install = async () => {
    setBusy(true);
    setStatus("");
    try {
      const result = await chooseAndInstallCostume();
      if (result) {
        setStatus(result.message);
        await refresh();
      }
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  };

  const select = (costume: InstalledCostume) => {
    if (!costume.supportedBodies.includes(settings.appearance.species)) {
      setStatus(`${costume.name} fits ${costume.supportedBodies.join(", ")} cats. Change the breed first.`);
      return;
    }
    onChange({ ...settings, selectedCostumeId: costume.costumeId });
    setStatus(`Wearing ${costume.name}.`);
  };

  const toggleEnabled = async (costume: InstalledCostume) => {
    setBusy(true);
    try {
      await setCostumeEnabled(costume.costumeId, !costume.enabled);
      if (costume.enabled && settings.selectedCostumeId === costume.costumeId) {
        onChange({ ...settings, selectedCostumeId: "" });
      }
      await refresh();
      setStatus(costume.enabled ? `${costume.name} disabled.` : `${costume.name} enabled.`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (costume: InstalledCostume) => {
    if (!(await confirmAction({ title: `Delete ${costume.name}?`, message: "You can install it again later. Your other appearance settings stay.", confirmLabel: "Delete", danger: true }))) return;
    setBusy(true);
    try {
      if (settings.selectedCostumeId === costume.costumeId) {
        onChange({ ...settings, selectedCostumeId: "" });
      }
      await uninstallCostume(costume.costumeId);
      await refresh();
      setStatus(`${costume.name} was deleted. You can reinstall its .mewcostume package later.`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  };

  const checkUpdates = () => setStatus("No outfit updates right now. Installed outfits keep working offline.");

  const manage = (costume: InstalledCostume): LookMenuItem[] => [
    { label: costume.enabled ? "Disable" : "Enable", onSelect: () => void toggleEnabled(costume) },
    { label: "Check for updates", onSelect: checkUpdates },
    { label: "Delete…", onSelect: () => void remove(costume), danger: true },
  ];

  const yours = costumes.filter((c) => !FEATURED.some((f) => f.id === c.costumeId));
  const classic = !settings.selectedCostumeId;

  return (
    <div className="costume-manager" aria-labelledby="costume-manager-title" data-setting="costumes">
      <div className="costume-manager-head">
        <div>
          <h2 id="costume-manager-title" className="mm-section-title">
            Featured Looks
          </h2>
          <span className="sk-hint">Outfits change how MewMuze looks, never how it behaves. Every outfit is checked before it is installed.</span>
        </div>
        <div className="costume-manager-actions">
          <button className="mm-btn" onClick={() => void openMewMuzeStore()}>
            <Icon name="sparkle" size={15} /> Browse Store
          </button>
          <button className="mm-btn primary" onClick={() => void install()} disabled={busy}>
            <Icon name="download" size={15} /> Install Outfit
          </button>
          <LookMenu label="More outfit options" items={[{ label: "Check for updates", onSelect: checkUpdates }]} />
        </div>
      </div>

      <FeaturedLooks settings={settings} onChange={onChange} premium={premium} installed={costumes} manage={manage} onNote={setStatus} />

      <h3 className="mm-subtitle">Your Looks</h3>
      <div className="costume-list">
        <article className={`costume-item classic${classic ? " on" : ""}`}>
          <span className="costume-thumb placeholder" aria-hidden="true">
            <Icon name="cat" size={22} />
          </span>
          <div className="costume-copy">
            <strong>Classic</strong>
            <span>Just your cat, no outfit.</span>
          </div>
          <div className="costume-item-actions">
            {classic ? (
              <button className="mm-btn" disabled>
                Wearing
              </button>
            ) : (
              <button className="mm-btn" onClick={() => onChange({ ...settings, selectedCostumeId: "" })}>
                Take off outfit
              </button>
            )}
          </div>
        </article>
        {yours.map((costume) => {
          const wearing = settings.selectedCostumeId === costume.costumeId;
          return (
            <article className={`costume-item${costume.enabled ? "" : " disabled"}${wearing ? " on" : ""}`} key={costume.costumeId}>
              {costume.thumbnailDataUrl ? (
                <img src={costume.thumbnailDataUrl} alt="" className="costume-thumb" />
              ) : (
                <span className="costume-thumb placeholder" aria-hidden="true">
                  <Icon name="sparkle" size={20} />
                </span>
              )}
              <div className="costume-copy">
                <strong>{costume.name}</strong>
                <span>
                  v{costume.version} · {costume.creator}
                </span>
                <span>{costume.signatureStatus === "verified" ? "Checked and safe" : costume.signatureStatus}</span>
              </div>
              <div className="costume-item-actions">
                <button className="mm-btn" onClick={() => void openLookPreview(costume.costumeId).catch((e) => setStatus(String(e)))}>
                  Preview
                </button>
                <button className={`mm-btn${wearing ? "" : " primary"}`} disabled={busy || !costume.enabled || wearing} onClick={() => select(costume)}>
                  {wearing ? "Wearing" : "Wear"}
                </button>
                <LookMenu label={`More for ${costume.name}`} items={manage(costume)} />
              </div>
            </article>
          );
        })}
        {yours.length === 0 && <div className="costume-empty">Outfits you install from a file or the Store appear here.</div>}
      </div>

      {Object.keys(TINTABLE).includes(settings.selectedCostumeId) && (
        <div className="costume-tint">
          <span className="sk-label">Outfit colour</span>
          {costumes
            .filter((costume) => costume.costumeId === settings.selectedCostumeId)
            .map((costume) =>
              TINTABLE[costume.costumeId] && (
                <div className="costume-colours" role="group" aria-label="Outfit colour" key={costume.costumeId}>
                  {TINTABLE[costume.costumeId].colours.map((c) => {
                    const active = (settings.costumeTint || TINTABLE[costume.costumeId].fallback) === c.hex;
                    return (
                      <button
                        key={c.id}
                        className={`costume-swatch${active ? " on" : ""}`}
                        style={{ background: c.hex }}
                        aria-label={c.label}
                        aria-pressed={active}
                        title={c.label}
                        disabled={busy}
                        onClick={() => onChange({ ...settings, costumeTint: c.hex })}
                      />
                    );
                  })}
                </div>
              ),
            )}
        </div>
      )}
      {status && (
        <div className="costume-status" role="status">
          {status}
        </div>
      )}
    </div>
  );
}
