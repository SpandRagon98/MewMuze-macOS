//! Quick Tools conversions. Every command is async: a sync command runs on the
//! main-thread STA, and blocking it once deadlocked this app (see
//! `context::get_media_playing`), so the real work is `spawn_blocking`.
//!
//! Merge/split reuse the pdfium binding that PDF -> images already needs, so
//! they add no dependency and inherit the same "missing library degrades
//! gracefully" behaviour.

use crate::pdf_write::{build_pdf, load_image_page};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// Upper bounds that keep a mis-click from trying to allocate the whole machine.
const MAX_IMAGES: usize = 500;
const MIN_DPI: u32 = 48;
const MAX_DPI: u32 = 600;
/// pdfium indexes pages as u16, so this is also the hard ceiling per document.
const MAX_MERGE_FILES: usize = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertSupport {
    pub pdf_render: bool,
    pub reason: String,
}

/// Checked in order: beside the exe (installed layout), the Tauri resource
/// dir, then the crate dir in development builds only (`tauri dev`).
fn pdfium_path(app: &AppHandle) -> Option<PathBuf> {
    // Mach-O dynamic libraries are .dylib. Falling through to the Linux .so
    // name meant the file never existed inside the .app, so PDF -> images
    // reported "pdfium is not installed" forever on macOS.
    let name = if cfg!(windows) {
        "pdfium.dll"
    } else if cfg!(target_os = "macos") {
        "libpdfium.dylib"
    } else {
        "libpdfium.so"
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(name));
        candidates.push(dir.join("lib").join(name));
    }
    #[cfg(debug_assertions)]
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("lib").join(name));
    candidates.into_iter().find(|p| p.is_file())
}

/// Bind to PDFium, or explain why we could not.
fn bind_pdfium(app: &AppHandle) -> Result<pdfium_render::prelude::Pdfium, String> {
    use pdfium_render::prelude::*;
    let path = pdfium_path(app).ok_or_else(|| {
        "The PDF renderer (pdfium) is not installed alongside the app.".to_string()
    })?;
    let bindings = Pdfium::bind_to_library(&path)
        .map_err(|e| format!("Could not load the PDF renderer: {e}"))?;
    Ok(Pdfium::new(bindings))
}

/// What the conversion tools can do on this machine right now.
#[tauri::command]
pub async fn convert_support(app: AppHandle) -> ConvertSupport {
    let available = tauri::async_runtime::spawn_blocking(move || match bind_pdfium(&app) {
        Ok(_) => (true, String::new()),
        Err(e) => (false, e),
    })
    .await
    .unwrap_or((false, "The PDF renderer could not be started.".to_string()));

    ConvertSupport { pdf_render: available.0, reason: available.1 }
}

/// Combine images into a single PDF, one image per page, in the order given.
#[tauri::command]
pub async fn images_to_pdf(paths: Vec<String>, output: String) -> Result<String, String> {
    if paths.is_empty() {
        return Err("Choose at least one image first.".into());
    }
    if paths.len() > MAX_IMAGES {
        return Err(format!("That is more than {MAX_IMAGES} images — try a smaller batch."));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut pages = Vec::with_capacity(paths.len());
        for path in &paths {
            pages.push(load_image_page(path)?);
        }
        let pdf = build_pdf(&pages)?;
        let out = PathBuf::from(&output);
        if let Some(dir) = out.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&out, pdf).map_err(|e| format!("Could not write the PDF: {e}"))?;
        Ok(output)
    })
    .await
    .map_err(|e| format!("The conversion did not finish: {e}"))?
}

/// Render every page of a PDF to an image file in `output_dir`.
#[tauri::command]
pub async fn pdf_to_images(
    app: AppHandle,
    path: String,
    output_dir: String,
    format: String,
    dpi: u32,
) -> Result<Vec<String>, String> {
    let format = match format.as_str() {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        other => return Err(format!("Unsupported image format: {other}")),
    };
    let dpi = dpi.clamp(MIN_DPI, MAX_DPI);

    tauri::async_runtime::spawn_blocking(move || {
        use pdfium_render::prelude::*;

        let source = Path::new(&path);
        if !source.is_file() {
            return Err("That PDF could not be found.".to_string());
        }
        let out_dir = PathBuf::from(&output_dir);
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("Could not use that folder: {e}"))?;

        let pdfium = bind_pdfium(&app)?;
        let document = pdfium
            .load_pdf_from_file(&path, None)
            .map_err(|e| format!("Could not open that PDF: {e}"))?;

        let stem = source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("page")
            .to_string();

        // PDF user-space units are points (1/72"), so this is the honest
        // pixels-per-point factor for the requested DPI.
        let config = PdfRenderConfig::new().scale_page_by_factor(dpi as f32 / 72.0);

        let mut written = Vec::new();
        for (index, page) in document.pages().iter().enumerate() {
            let image = page
                .render_with_config(&config)
                .map_err(|e| format!("Page {} could not be rendered: {e}", index + 1))?
                .as_image();

            let name = format!("{stem}-{:03}.{format}", index + 1);
            let target = out_dir.join(&name);
            let result = if format == "jpg" {
                // JPEG has no alpha channel; drop it rather than let the encoder
                // refuse the buffer.
                image.to_rgb8().save(&target)
            } else {
                image.save(&target)
            };
            result.map_err(|e| format!("Could not save {name}: {e}"))?;
            written.push(target.to_string_lossy().to_string());
        }

        if written.is_empty() {
            return Err("That PDF has no pages.".to_string());
        }
        Ok(written)
    })
    .await
    .map_err(|e| format!("The conversion did not finish: {e}"))?
}

// ---------------------------------------------------------------------------
// Merge / split
// ---------------------------------------------------------------------------

/// Just the file name, for error messages that name the offending file.
fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

/// Open a PDF, turning pdfium's internal codes into something a person can act
/// on. Encrypted and corrupt files are the two cases users actually hit.
fn open_pdf<'a>(
    pdfium: &'a pdfium_render::prelude::Pdfium,
    path: &str,
) -> Result<pdfium_render::prelude::PdfDocument<'a>, String> {
    use pdfium_render::prelude::{PdfiumError, PdfiumInternalError};

    if !Path::new(path).is_file() {
        return Err(format!("{} could not be found.", file_name(path)));
    }
    pdfium.load_pdf_from_file(path, None).map_err(|e| {
        let name = file_name(path);
        match e {
            PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
                format!("{name} is password-protected. Remove the password and try again.")
            }
            PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::SecurityError) => {
                format!("{name} does not allow copying its pages.")
            }
            PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::FormatError) => {
                format!("{name} is damaged or is not a PDF.")
            }
            _ => format!("{name} could not be opened."),
        }
    })
}

/// Validate a user page spec ("1,3,5-7") against the real page count and return
/// it in the comma-separated, 1-based form pdfium's `FPDF_ImportPages` expects.
///
/// Kept in Rust on purpose: this is the trust boundary. The webview sends the
/// raw string and only displays the error, so there is one parser, not two.
fn parse_page_spec(spec: &str, page_count: u16) -> Result<String, String> {
    let mut groups: Vec<String> = Vec::new();

    for raw in spec.split(',') {
        let part = raw.trim();
        if part.is_empty() {
            continue;
        }
        let bounds: Vec<&str> = part.split('-').map(str::trim).collect();
        let parse_one = |s: &str| -> Result<u16, String> {
            if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
                return Err(format!("\"{part}\" is not a page number or range."));
            }
            let n: u16 = s
                .parse()
                .map_err(|_| format!("\"{part}\" is not a valid page number."))?;
            if n == 0 {
                return Err("Pages start at 1.".to_string());
            }
            if n > page_count {
                return Err(format!(
                    "Page {n} does not exist — this PDF has {page_count} page{}.",
                    if page_count == 1 { "" } else { "s" }
                ));
            }
            Ok(n)
        };

        match bounds.as_slice() {
            [single] => groups.push(parse_one(single)?.to_string()),
            [from, to] => {
                let (a, b) = (parse_one(from)?, parse_one(to)?);
                if a > b {
                    return Err(format!("Range \"{part}\" runs backwards."));
                }
                groups.push(if a == b { a.to_string() } else { format!("{a}-{b}") });
            }
            _ => return Err(format!("\"{part}\" is not a page number or range.")),
        }
    }

    if groups.is_empty() {
        return Err("Enter which pages to keep, for example 1,3,5-7.".to_string());
    }
    Ok(groups.join(","))
}

/// `{ done, total }` progress for the merge/split status line.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfProgress {
    done: usize,
    total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub output: String,
    pub pages: u32,
}

fn report(app: &AppHandle, done: usize, total: usize) {
    let _ = app.emit("pdf-progress", PdfProgress { done, total });
}

/// Combine PDFs end to end, in the order given, into one file.
#[tauri::command]
pub async fn merge_pdfs(
    app: AppHandle,
    paths: Vec<String>,
    output: String,
) -> Result<MergeResult, String> {
    if paths.len() < 2 {
        return Err("Choose at least two PDFs to merge.".into());
    }
    if paths.len() > MAX_MERGE_FILES {
        return Err(format!("That is more than {MAX_MERGE_FILES} files — try a smaller batch."));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let total = paths.len();
        let pdfium = bind_pdfium(&app)?;
        let mut target = pdfium
            .create_new_pdf()
            .map_err(|e| format!("Could not start a new PDF: {e}"))?;

        let mut pages_written: u32 = 0;
        for (index, path) in paths.iter().enumerate() {
            let source = open_pdf(&pdfium, path)?;
            let count = source.pages().len();
            if count == 0 {
                return Err(format!("{} has no pages.", file_name(path)));
            }
            // pdfium indexes pages as u16. Without this the insertion point
            // would wrap past 65535 and quietly interleave pages instead of
            // appending them, producing a corrupt file rather than an error.
            if pages_written + count as u32 > u16::MAX as u32 {
                return Err(format!(
                    "The merged PDF would exceed {} pages, which is the format limit here.",
                    u16::MAX
                ));
            }
            // Appending: the insertion point is whatever is already there.
            let at = target.pages().len();
            target
                .pages_mut()
                .copy_pages_from_document(&source, &format!("1-{count}"), at)
                .map_err(|e| format!("Could not copy pages from {}: {e}", file_name(path)))?;
            pages_written += count as u32;
            report(&app, index + 1, total);
        }

        let out = PathBuf::from(&output);
        if let Some(dir) = out.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        target
            .save_to_file(&out)
            .map_err(|e| format!("Could not save the merged PDF: {e}"))?;
        Ok(MergeResult { output, pages: pages_written })
    })
    .await
    .map_err(|e| format!("The merge did not finish: {e}"))?
}

/// Split a PDF. `mode` is "every" (one file per page) or "select" (a single file
/// containing `pages`). Returns the paths written.
#[tauri::command]
pub async fn split_pdf(
    app: AppHandle,
    path: String,
    mode: String,
    pages: String,
    output_dir: String,
) -> Result<Vec<String>, String> {
    if mode != "every" && mode != "select" {
        return Err(format!("Unknown split mode: {mode}"));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let out_dir = PathBuf::from(&output_dir);
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("Could not use that folder: {e}"))?;

        let pdfium = bind_pdfium(&app)?;
        let source = open_pdf(&pdfium, &path)?;
        let count = source.pages().len();
        if count == 0 {
            return Err("That PDF has no pages.".to_string());
        }

        let stem = Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("document")
            .to_string();

        // One document per page, or one document holding the chosen pages.
        let jobs: Vec<(String, String)> = if mode == "every" {
            (1..=count)
                .map(|n| (n.to_string(), format!("{stem}-{n:03}.pdf")))
                .collect()
        } else {
            let spec = parse_page_spec(&pages, count)?;
            vec![(spec, format!("{stem}-pages.pdf"))]
        };

        let total = jobs.len();
        let mut written = Vec::with_capacity(total);
        for (index, (spec, name)) in jobs.iter().enumerate() {
            let mut target = pdfium
                .create_new_pdf()
                .map_err(|e| format!("Could not start a new PDF: {e}"))?;
            target
                .pages_mut()
                .copy_pages_from_document(&source, spec, 0)
                .map_err(|e| format!("Could not copy pages {spec}: {e}"))?;
            let file = out_dir.join(name);
            target
                .save_to_file(&file)
                .map_err(|e| format!("Could not save {name}: {e}"))?;
            written.push(file.to_string_lossy().to_string());
            report(&app, index + 1, total);
        }
        Ok(written)
    })
    .await
    .map_err(|e| format!("The split did not finish: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::parse_page_spec;

    #[test]
    fn accepts_single_pages_and_ranges() {
        assert_eq!(parse_page_spec("1,3,5-7", 10).unwrap(), "1,3,5-7");
        assert_eq!(parse_page_spec("  2 , 4 ", 10).unwrap(), "2,4");
        // A one-page range collapses; pdfium accepts both but this reads better.
        assert_eq!(parse_page_spec("3-3", 10).unwrap(), "3");
    }

    #[test]
    fn rejects_pages_outside_the_document() {
        assert!(parse_page_spec("11", 10).is_err());
        assert!(parse_page_spec("0", 10).is_err());
        assert!(parse_page_spec("1-99", 10).is_err());
    }

    #[test]
    fn rejects_malformed_and_empty_specs() {
        assert!(parse_page_spec("", 10).is_err());
        assert!(parse_page_spec("   ", 10).is_err());
        assert!(parse_page_spec(",,", 10).is_err());
        assert!(parse_page_spec("abc", 10).is_err());
        assert!(parse_page_spec("1-2-3", 10).is_err());
        assert!(parse_page_spec("5-2", 10).is_err(), "backwards range");
        assert!(parse_page_spec("-", 10).is_err());
    }

    #[test]
    fn error_text_names_the_real_page_count() {
        let err = parse_page_spec("9", 1).unwrap_err();
        assert!(err.contains("1 page"), "should not say '1 pages': {err}");
    }
}
