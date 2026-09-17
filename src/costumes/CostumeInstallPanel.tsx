import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  clearPendingCostumeRequest,
  confirmInstallToken,
  installCostumePackage,
  pendingCostumeRequest,
  type PendingInstallRequest,
} from "./costumeApi";
import { Icon } from "../components/icons";

function sizeLabel(bytes: number): string {
  if (!bytes) return "Package supplied after the mock checkout";
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function CostumeInstallPanel({
  onOpenChange,
}: {
  onOpenChange?: (open: boolean) => void;
}) {
  const [request, setRequest] = useState<PendingInstallRequest | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void pendingCostumeRequest().then((pending) => {
      if (!disposed && pending) setRequest(pending);
    });
    void listen<PendingInstallRequest>("costume-install-request", (event) => {
      if (!disposed) {
        setStatus("");
        setRequest(event.payload);
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    onOpenChange?.(request !== null);
    return () => onOpenChange?.(false);
  }, [onOpenChange, request]);

  if (!request) return null;

  const close = async () => {
    await clearPendingCostumeRequest();
    setRequest(null);
    setStatus("");
  };

  const confirm = async () => {
    setBusy(true);
    setStatus("");
    try {
      if (request.kind === "package" && request.packagePath) {
        await installCostumePackage(request.packagePath);
        await clearPendingCostumeRequest();
        setRequest(null);
        setStatus("");
      } else if (request.kind === "token" && request.token) {
        setStatus(await confirmInstallToken(request.token));
      } else {
        setStatus("This installation request is incomplete.");
      }
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="costume-confirm-backdrop">
      <section className="costume-confirm" role="dialog" aria-modal="true" aria-labelledby="costume-confirm-title">
        <div className="costume-confirm-label">MewMuze costume request</div>
        <h2 id="costume-confirm-title">{request.costumeName}</h2>
        {request.previewDataUrl ? (
          <img className="costume-confirm-preview" src={request.previewDataUrl} alt={`${request.costumeName} preview`} />
        ) : (
          <div className="costume-confirm-preview placeholder" aria-label="Preview supplied with the signed package"><Icon name="sparkle" size={36} /></div>
        )}
        <dl>
          <div><dt>Creator</dt><dd>{request.creator}</dd></div>
          <div><dt>Version</dt><dd>{request.version}</dd></div>
          <div><dt>Package</dt><dd>{sizeLabel(request.packageSize)}</dd></div>
          <div><dt>Requires</dt><dd>MewMuze {request.minimumAppVersion}+</dd></div>
          <div><dt>Source</dt><dd>{request.source}</dd></div>
        </dl>
        <p>
          Only signed visual assets will be accepted. This costume cannot run code or change MewMuze behaviour.
        </p>
        {status && <div className="costume-status" role="status">{status}</div>}
        <div className="costume-confirm-actions">
          <button className="sk-btn" disabled={busy} onClick={() => void close()}>Cancel</button>
          <button className="sk-btn primary" disabled={busy} onClick={() => void confirm()}>
            {busy ? "Verifying…" : request.kind === "package" ? "Verify & install" : "Confirm mock purchase"}
          </button>
        </div>
      </section>
    </div>
  );
}
