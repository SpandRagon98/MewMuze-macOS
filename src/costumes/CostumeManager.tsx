import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "../settings/settingsStore";
import {
  chooseAndInstallCostume,
  listInstalledCostumes,
  openMewMuzeStore,
  setCostumeEnabled,
  uninstallCostume,
  type InstalledCostume,
} from "./costumeApi";

export function CostumeManager({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
}) {
  const [costumes, setCostumes] = useState<InstalledCostume[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setCostumes(await listInstalledCostumes());
  }, []);

  useEffect(() => {
    void refresh();
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("costumes-changed", () => {
      if (!disposed) void refresh();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [refresh]);

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
      setStatus(
        `${costume.name} supports ${costume.supportedBodies.join(", ")} bodies. Choose one of those body types first.`,
      );
      return;
    }
    onChange({ ...settings, selectedCostumeId: costume.costumeId });
    setStatus(`${costume.name} selected.`);
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
    if (!window.confirm(`Delete ${costume.name}? You can install it again later. Other appearance settings will not change.`)) return;
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

  return (
    <div className="costume-manager" aria-labelledby="costume-manager-title">
      <div className="costume-manager-head">
        <div>
          <h3 id="costume-manager-title" className="sk-group-title">Costumes</h3>
          <span className="sk-hint">
            Signed visual skins installed locally. {costumes.length}/5 installed. They never change cat behaviour.
          </span>
        </div>
        <div className="costume-manager-actions">
          <button className="sk-btn" onClick={() => void install()} disabled={busy}>
            Install package…
          </button>
          <button className="sk-btn primary" onClick={() => void openMewMuzeStore()}>
            Open MewMuze Store
          </button>
        </div>
      </div>
      {costumes.length === 0 ? (
        <div className="costume-empty">No Store costumes installed yet.</div>
      ) : (
        <div className="costume-list">
          {costumes.map((costume) => (
            <article className={`costume-item${costume.enabled ? "" : " disabled"}`} key={costume.costumeId}>
              {costume.thumbnailDataUrl ? (
                <img src={costume.thumbnailDataUrl} alt="" className="costume-thumb" />
              ) : (
                <span className="costume-thumb placeholder" aria-hidden="true">✦</span>
              )}
              <div className="costume-copy">
                <strong>{costume.name}</strong>
                <span>v{costume.version} · {costume.creator}</span>
                <span>{costume.signatureStatus === "verified" ? "Signature verified" : costume.signatureStatus}</span>
              </div>
              <div className="costume-item-actions">
                <button
                  className="sk-btn"
                  disabled={busy || !costume.enabled || settings.selectedCostumeId === costume.costumeId}
                  onClick={() => select(costume)}
                >
                  {settings.selectedCostumeId === costume.costumeId ? "Selected" : "Select"}
                </button>
                <button className="sk-btn" disabled={busy} onClick={() => void toggleEnabled(costume)}>
                  {costume.enabled ? "Disable" : "Enable"}
                </button>
                <button className="sk-btn danger" disabled={busy} onClick={() => void remove(costume)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="costume-update-row">
        <button
          className="sk-btn"
          onClick={() => setStatus("Mock Store mode has no remote updates. Installed costumes keep working offline.")}
        >
          Check for updates
        </button>
        {settings.selectedCostumeId && (
          <button
            className="sk-btn"
            onClick={() => onChange({ ...settings, selectedCostumeId: "" })}
          >
            Use no costume
          </button>
        )}
      </div>
      {status && <div className="costume-status" role="status">{status}</div>}
    </div>
  );
}
