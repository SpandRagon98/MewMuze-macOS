// File-conversion bridge for Quick Tools. What's supported and why is a
// deliberate call — see docs/QUICK_TOOLS.md. Deliberately bypasses App's
// invokeSafe: its 4s watchdog is for wedged status polls, not a real PDF
// render the user is watching a progress line for.

export type ImageFormat = "png" | "jpg";

export interface ConvertSupport {
  pdfRender: boolean;
  /** Why not, when pdfRender is false. */
  reason: string;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(cmd, args);
}

export async function convertSupport(): Promise<ConvertSupport> {
  try {
    return await invoke<ConvertSupport>("convert_support");
  } catch {
    return { pdfRender: false, reason: "Conversion tools are unavailable outside the app." };
  }
}

export async function pickImages(): Promise<string[]> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : [picked];
  } catch {
    return [];
  }
}

export async function pickPdfs(): Promise<string[]> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: true, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : [picked];
  } catch {
    return [];
  }
}

export async function pickPdf(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: false, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}

export async function pickPdfDestination(defaultName: string): Promise<string | null> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const picked = await save({ defaultPath: defaultName, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}

export async function pickFolder(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}

/** One image per page, in order. Resolves to the written path. */
export async function imagesToPdf(paths: string[], output: string): Promise<string> {
  return invoke<string>("images_to_pdf", { paths, output });
}

export async function pdfToImages(
  path: string,
  outputDir: string,
  format: ImageFormat,
  dpi: number,
): Promise<string[]> {
  return invoke<string[]>("pdf_to_images", { path, outputDir, format, dpi });
}

export interface MergeResult {
  output: string;
  pages: number;
}

/** Concatenate PDFs in the given order. Resolves once the file is written. */
export async function mergePdfs(paths: string[], output: string): Promise<MergeResult> {
  return invoke<MergeResult>("merge_pdfs", { paths, output });
}

export type SplitMode = "every" | "select";

/**
 * "every" writes one PDF per page; "select" writes a single PDF holding `pages`
 * (a 1-based spec like "1,3,5-7"). The spec is validated in Rust — the trust
 * boundary — so bad input comes back as a plain-language error to display.
 */
export async function splitPdf(
  path: string,
  mode: SplitMode,
  pages: string,
  outputDir: string,
): Promise<string[]> {
  return invoke<string[]>("split_pdf", { path, mode, pages, outputDir });
}

/** `{done,total}` while a merge/split runs. Returns an unlisten function. */
export async function onPdfProgress(
  handler: (done: number, total: number) => void,
): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<{ done: number; total: number }>("pdf-progress", (e) =>
      handler(e.payload.done, e.payload.total),
    );
  } catch {
    return () => {};
  }
}

/** Just the file name, for compact status lines. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** "3 images" / "1 image" */
export function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
