import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CostumeInstallPanel } from "../costumes/CostumeInstallPanel";

const costumeMocks = vi.hoisted(() => ({
  installCostumePackage: vi.fn(),
  clearPendingCostumeRequest: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("../costumes/costumeApi", () => ({
  pendingCostumeRequest: vi.fn(async () => ({
    kind: "package",
    source: "Downloaded .mewcostume package",
    token: null,
    packagePath: "C:\\Downloads\\iron-man-cat.mewcostume",
    productId: "mewmuze.iron-man-cat.v1",
    costumeName: "Iron Man Cat",
    creator: "MewMuze Studio",
    version: "1.0.1",
    packageSize: 361983,
    minimumAppVersion: "0.1.0",
    previewDataUrl: null,
  })),
  installCostumePackage: costumeMocks.installCostumePackage,
  clearPendingCostumeRequest: costumeMocks.clearPendingCostumeRequest,
  confirmInstallToken: vi.fn(),
}));

describe("CostumeInstallPanel", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    costumeMocks.installCostumePackage.mockResolvedValue({
      costumeId: "mewmuze.iron-man-cat.v1",
      name: "Iron Man Cat",
      version: "1.0.1",
      message: "Your new costume is ready.",
    });
    costumeMocks.clearPendingCostumeRequest.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("keeps the overlay interactive and dismisses only after a successful install", async () => {
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(<CostumeInstallPanel onOpenChange={onOpenChange} />);
      await Promise.resolve();
    });
    expect(onOpenChange).toHaveBeenCalledWith(true);

    const installButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Verify & install",
    );
    expect(installButton).toBeTruthy();
    await act(async () => {
      installButton!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(costumeMocks.installCostumePackage).toHaveBeenCalledWith("C:\\Downloads\\iron-man-cat.mewcostume");
    expect(costumeMocks.clearPendingCostumeRequest).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
