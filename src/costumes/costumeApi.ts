import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface InstalledCostume {
  costumeId: string;
  version: string;
  installationTime: number;
  localPackageLocation: string;
  signatureStatus: "verified";
  entitlementIdentifier: string;
  enabled: boolean;
  name: string;
  creator: string;
  description: string;
  supportedBodies: string[];
  thumbnailDataUrl: string | null;
}

export interface InstallResult {
  costumeId: string;
  name: string;
  version: string;
  message: string;
}

export interface PendingInstallRequest {
  kind: "token" | "package";
  source: string;
  token: string | null;
  packagePath: string | null;
  productId: string | null;
  costumeName: string;
  creator: string;
  version: string;
  packageSize: number;
  minimumAppVersion: string;
  previewDataUrl: string | null;
}

export async function listInstalledCostumes(): Promise<InstalledCostume[]> {
  try {
    return await invoke<InstalledCostume[]>("list_installed_costumes");
  } catch {
    return [];
  }
}

export async function chooseAndInstallCostume(): Promise<InstallResult | null> {
  const chosen = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "MewMuze Costume", extensions: ["mewcostume"] }],
  });
  if (!chosen || Array.isArray(chosen)) return null;
  return invoke<InstallResult>("install_costume_package", { path: chosen });
}

export function installCostumePackage(path: string): Promise<InstallResult> {
  return invoke<InstallResult>("install_costume_package", { path });
}

export function setCostumeEnabled(costumeId: string, enabled: boolean): Promise<void> {
  return invoke("set_costume_enabled", { costumeId, enabled });
}

export function uninstallCostume(costumeId: string): Promise<void> {
  return invoke("uninstall_costume", { costumeId });
}

export function openMewMuzeStore(): Promise<void> {
  return invoke("open_mewmuze_store");
}

export function pendingCostumeRequest(): Promise<PendingInstallRequest | null> {
  return invoke("get_pending_costume_request");
}

export function clearPendingCostumeRequest(): Promise<void> {
  return invoke("clear_pending_costume_request");
}

export function confirmInstallToken(token: string): Promise<string> {
  return invoke("confirm_install_token", { token });
}

/** Open (or refocus) the Look Preview window on a costume. Never changes what the cat wears. */
export function openLookPreview(costumeId: string): Promise<void> {
  return invoke("open_look_preview", { look: costumeId });
}
