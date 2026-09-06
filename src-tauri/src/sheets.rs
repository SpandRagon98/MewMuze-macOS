//! Spreadsheet tools for Work Mode: CSV <-> XLSX, merge, and split.
//!
//! Everything is local and offline. Like `convert.rs`, every command is async
//! and does its real work in `spawn_blocking`, because a sync command runs on
//! the main-thread STA and blocking that once deadlocked this app.
//!
//! Deliberate limits, so this stays a *tool* and not half an Excel:
//!   * Formulas are read as the value Excel last cached and written back as
//!     text. There is no calculation engine, and we never evaluate anything.
//!   * Macros (.xlsm) are never executed — we only read cell data.
//!   * Encrypted workbooks are detected and refused with a plain-language
//!     message rather than a parser panic.

use calamine::{open_workbook_auto, Data, Reader};
use rust_xlsxwriter::Workbook;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

/// Upper bounds that keep a mis-click from trying to allocate the whole machine.
const MAX_INPUT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MERGE_FILES: usize = 200;
/// xlsx itself stops at 1,048,576 rows; refuse earlier with a clear message.
const MAX_ROWS: usize = 1_000_000;
const PREVIEW_ROWS: usize = 12;
const PREVIEW_COLS: usize = 12;

/// Set by `cancel_sheet_op`, cleared at the start of every operation.
///
/// One flag is enough because the panel runs a single operation at a time (all
/// its buttons disable while one is in flight).
static CANCELLED: AtomicBool = AtomicBool::new(false);

fn begin_op() {
    CANCELLED.store(false, Ordering::SeqCst);
}

fn cancelled() -> bool {
    CANCELLED.load(Ordering::SeqCst)
}

/// `Err` if the user asked to stop, so callers can `?` out of a loop.
fn check_cancel() -> Result<(), String> {
    if cancelled() {
        return Err("Cancelled.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_sheet_op() {
    CANCELLED.store(true, Ordering::SeqCst);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfo {
    pub sheets: Vec<String>,
    pub rows: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetPreview {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSummary {
    pub output: String,
    pub files: usize,
    pub rows: usize,
    pub sheets: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SheetProgress {
    done: usize,
    total: usize,
}

fn report(app: &AppHandle, done: usize, total: usize) {
    let _ = app.emit("sheet-progress", SheetProgress { done, total });
}

/// Reject anything we cannot safely open before a parser ever sees it.
fn validate_input(path: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(path)
        .map_err(|_| format!("Could not open {}.", base_name(path)))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file.", base_name(path)));
    }
    if meta.len() == 0 {
        return Err(format!("{} is empty.", base_name(path)));
    }
    if meta.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "{} is larger than {} MB.",
            base_name(path),
            MAX_INPUT_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

/// An OOXML file is a zip; an encrypted one is an OLE compound file starting
/// with the D0 CF 11 E0 magic. calamine reports that as an opaque error, so
/// detect it up front and say something the user can act on.
fn reject_if_encrypted(path: &Path) -> Result<(), String> {
    use std::io::Read;
    let ext = extension(path);
    if ext != "xlsx" && ext != "xlsm" {
        return Ok(());
    }
    let mut file = std::fs::File::open(path)
        .map_err(|_| format!("Could not open {}.", base_name(path)))?;
    let mut magic = [0u8; 8];
    if file.read_exact(&mut magic).is_err() {
        return Err(format!("{} is not a readable workbook.", base_name(path)));
    }
    if magic[..4] == [0xD0, 0xCF, 0x11, 0xE0] {
        return Err(format!(
            "{} looks password protected. Remove the password in your spreadsheet app and try again.",
            base_name(path)
        ));
    }
    if magic[..2] != [0x50, 0x4B] {
        return Err(format!(
            "{} is not a valid .xlsx file (it may be corrupt or renamed).",
            base_name(path)
        ));
    }
    Ok(())
}

fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "sheet".to_string())
}

fn extension(path: &Path) -> String {
    path.extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// A cell as text. Formulas arrive as their cached value; nothing is evaluated.
fn cell_text(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            // Whole floats render as "1" rather than "1.0", which is what a
            // spreadsheet shows and what a CSV consumer expects.
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string().to_uppercase(),
        Data::Error(e) => format!("{e:?}"),
        Data::DateTime(d) => d.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
    }
}

/// Worksheet names are constrained by xlsx itself: 31 chars, and none of
/// : \ / ? * [ ]. Sanitising keeps a split/merge from producing a file the
/// user's spreadsheet app then refuses to open.
pub fn safe_sheet_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            ':' | '\\' | '/' | '?' | '*' | '[' | ']' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('\'').trim();
    let capped: String = trimmed.chars().take(31).collect();
    if capped.is_empty() {
        "Sheet".to_string()
    } else {
        capped
    }
}

/// Output file names must survive Windows' reserved names and illegal chars.
pub fn safe_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    let stem_upper = trimmed.to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if trimmed.is_empty() {
        return "sheet".to_string();
    }
    if RESERVED.contains(&stem_upper.as_str()) {
        return format!("{trimmed}_");
    }
    trimmed.chars().take(120).collect()
}

/// Never silently clobber: callers pass `overwrite` only after confirming.
fn guard_overwrite(output: &Path, overwrite: bool) -> Result<(), String> {
    if output.exists() && !overwrite {
        return Err(format!(
            "{} already exists. Confirm to replace it.",
            base_name(output)
        ));
    }
    Ok(())
}

/// A destination that does not exist yet, by adding " (2)", " (3)" ... .
fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    candidate
}

fn delimiter_byte(delimiter: &str) -> u8 {
    match delimiter {
        "tab" | "\t" => b'\t',
        "semicolon" | ";" => b';',
        "pipe" | "|" => b'|',
        _ => b',',
    }
}

/// Read a CSV as rows of text. Strips a UTF-8 BOM so the first header is not
/// silently prefixed with a zero-width character.
fn read_csv(path: &Path, delimiter: u8) -> Result<Vec<Vec<String>>, String> {
    let bytes = std::fs::read(path).map_err(|_| format!("Could not read {}.", base_name(path)))?;
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .flexible(true)
        .has_headers(false)
        .from_reader(body);

    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| format!("{} is not valid CSV: {e}", base_name(path)))?;
        rows.push(record.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        if rows.len() > MAX_ROWS {
            return Err(format!("{} has more than {MAX_ROWS} rows.", base_name(path)));
        }
    }
    Ok(rows)
}

/// Read one worksheet as rows of text.
fn read_sheet(path: &Path, sheet: &str) -> Result<Vec<Vec<String>>, String> {
    validate_input(path)?;
    reject_if_encrypted(path)?;
    let mut wb = open_workbook_auto(path)
        .map_err(|e| format!("Could not open {}: {e}", base_name(path)))?;
    let range = wb
        .worksheet_range(sheet)
        .map_err(|_| format!("{} has no worksheet named \"{sheet}\".", base_name(path)))?;
    let mut rows: Vec<Vec<String>> = Vec::new();
    for row in range.rows() {
        rows.push(row.iter().map(cell_text).collect());
    }
    Ok(rows)
}

/// Write rows to a new xlsx. `sheet_name` is sanitised by the caller.
fn write_xlsx(rows: &[Vec<String>], sheet_name: &str, output: &Path) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet
        .set_name(sheet_name)
        .map_err(|e| format!("Invalid worksheet name: {e}"))?;
    for (r, row) in rows.iter().enumerate() {
        for (c, value) in row.iter().enumerate() {
            worksheet
                .write_string(r as u32, c as u16, value)
                .map_err(|e| format!("Could not write cell: {e}"))?;
        }
    }
    workbook
        .save(output)
        .map_err(|e| format!("Could not save {}: {e}", base_name(output)))?;
    Ok(())
}

fn write_csv(rows: &[Vec<String>], delimiter: u8, output: &Path) -> Result<(), String> {
    let mut writer = csv::WriterBuilder::new()
        .delimiter(delimiter)
        .from_path(output)
        .map_err(|e| format!("Could not write {}: {e}", base_name(output)))?;
    for row in rows {
        writer
            .write_record(row)
            .map_err(|e| format!("Could not write {}: {e}", base_name(output)))?;
    }
    writer
        .flush()
        .map_err(|e| format!("Could not finish writing {}: {e}", base_name(output)))?;
    Ok(())
}

/// Worksheet names and row count, for populating the sheet picker.
#[tauri::command]
pub async fn sheet_info(path: String) -> Result<SheetInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        validate_input(&path)?;
        if extension(&path) == "csv" || extension(&path) == "txt" {
            let rows = read_csv(&path, b',')?;
            return Ok(SheetInfo { sheets: vec!["CSV".to_string()], rows: rows.len() });
        }
        reject_if_encrypted(&path)?;
        let wb = open_workbook_auto(&path)
            .map_err(|e| format!("Could not open {}: {e}", base_name(&path)))?;
        let sheets = wb.sheet_names().to_vec();
        if sheets.is_empty() {
            return Err(format!("{} has no worksheets.", base_name(&path)));
        }
        Ok(SheetInfo { sheets, rows: 0 })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// First rows of a sheet (or CSV), for the pre-save preview.
#[tauri::command]
pub async fn sheet_preview(
    path: String,
    sheet: String,
    delimiter: String,
) -> Result<SheetPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        validate_input(&path)?;
        let rows = if extension(&path) == "csv" || extension(&path) == "txt" {
            read_csv(&path, delimiter_byte(&delimiter))?
        } else {
            read_sheet(&path, &sheet)?
        };
        let total_rows = rows.len();
        let headers = rows
            .first()
            .map(|r| r.iter().take(PREVIEW_COLS).cloned().collect())
            .unwrap_or_default();
        let body: Vec<Vec<String>> = rows
            .iter()
            .skip(1)
            .take(PREVIEW_ROWS)
            .map(|r| r.iter().take(PREVIEW_COLS).cloned().collect())
            .collect();
        Ok(SheetPreview {
            headers,
            rows: body,
            total_rows,
            truncated: total_rows > PREVIEW_ROWS + 1,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn csv_to_xlsx(
    input: String,
    output: String,
    delimiter: String,
    overwrite: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        begin_op();
        let input = PathBuf::from(input);
        let output = PathBuf::from(output);
        validate_input(&input)?;
        guard_overwrite(&output, overwrite)?;
        let rows = read_csv(&input, delimiter_byte(&delimiter))?;
        check_cancel()?;
        if rows.is_empty() {
            return Err(format!("{} has no rows.", base_name(&input)));
        }
        write_xlsx(&rows, &safe_sheet_name(&file_stem(&input)), &output)?;
        Ok(output.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn xlsx_to_csv(
    input: String,
    sheet: String,
    output: String,
    delimiter: String,
    overwrite: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        begin_op();
        let input = PathBuf::from(input);
        let output = PathBuf::from(output);
        guard_overwrite(&output, overwrite)?;
        let rows = read_sheet(&input, &sheet)?;
        check_cancel()?;
        if rows.is_empty() {
            return Err(format!("\"{sheet}\" has no rows."));
        }
        write_csv(&rows, delimiter_byte(&delimiter), &output)?;
        Ok(output.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Rows of one input file, whatever its type, for merging.
fn read_any(path: &Path, delimiter: u8) -> Result<Vec<Vec<String>>, String> {
    validate_input(path)?;
    let ext = extension(path);
    if ext == "csv" || ext == "txt" {
        read_csv(path, delimiter)
    } else {
        reject_if_encrypted(path)?;
        let mut wb = open_workbook_auto(path)
            .map_err(|e| format!("Could not open {}: {e}", base_name(path)))?;
        let first = wb
            .sheet_names()
            .first()
            .cloned()
            .ok_or_else(|| format!("{} has no worksheets.", base_name(path)))?;
        let range = wb
            .worksheet_range(&first)
            .map_err(|e| format!("Could not read {}: {e}", base_name(path)))?;
        Ok(range.rows().map(|r| r.iter().map(cell_text).collect()).collect())
    }
}

/// Align a file's rows to a shared header order, by header name.
///
/// Columns present in the target but missing here become empty, so a merge of
/// files with differing column orders still lines up correctly.
fn align_to_headers(
    rows: &[Vec<String>],
    target: &[String],
    source_label: Option<&str>,
) -> Vec<Vec<String>> {
    let own_headers = match rows.first() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let index: Vec<Option<usize>> = target
        .iter()
        .map(|want| own_headers.iter().position(|h| h.eq_ignore_ascii_case(want)))
        .collect();
    rows.iter()
        .skip(1)
        .map(|row| {
            let mut out: Vec<String> = index
                .iter()
                .map(|i| i.and_then(|i| row.get(i)).cloned().unwrap_or_default())
                .collect();
            if let Some(label) = source_label {
                out.push(label.to_string());
            }
            out
        })
        .collect()
}

/// `mode` is "columns" (one worksheet, matched by header) or "sheets" (one
/// worksheet per input file).
#[tauri::command]
pub async fn merge_sheets(
    app: AppHandle,
    paths: Vec<String>,
    output: String,
    mode: String,
    add_source_column: bool,
    delimiter: String,
    overwrite: bool,
) -> Result<MergeSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        begin_op();
        if paths.len() < 2 {
            return Err("Choose at least two files to merge.".to_string());
        }
        if paths.len() > MAX_MERGE_FILES {
            return Err(format!("Choose at most {MAX_MERGE_FILES} files."));
        }
        let output = PathBuf::from(output);
        guard_overwrite(&output, overwrite)?;
        let delim = delimiter_byte(&delimiter);
        let inputs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        let total = inputs.len();

        let mut workbook = Workbook::new();
        let mut rows_written = 0usize;
        let mut sheets_written = 0usize;

        if mode == "sheets" {
            // One worksheet per file, in the order given.
            let mut used: Vec<String> = Vec::new();
            for (i, path) in inputs.iter().enumerate() {
                check_cancel()?;
                report(&app, i, total);
                let rows = read_any(path, delim)?;
                let mut name = safe_sheet_name(&file_stem(path));
                // Excel rejects duplicate worksheet names.
                let mut n = 2;
                while used.contains(&name) {
                    let suffix = format!("_{n}");
                    let keep = 31 - suffix.len();
                    name = format!("{}{}", name.chars().take(keep).collect::<String>(), suffix);
                    n += 1;
                }
                used.push(name.clone());
                let sheet = workbook.add_worksheet();
                sheet.set_name(&name).map_err(|e| format!("Invalid worksheet name: {e}"))?;
                for (r, row) in rows.iter().enumerate() {
                    for (c, value) in row.iter().enumerate() {
                        sheet
                            .write_string(r as u32, c as u16, value)
                            .map_err(|e| format!("Could not write cell: {e}"))?;
                    }
                }
                rows_written += rows.len().saturating_sub(1);
                sheets_written += 1;
            }
        } else {
            // One worksheet, columns matched by header name across all files.
            let mut headers: Vec<String> = Vec::new();
            let mut body: Vec<Vec<String>> = Vec::new();
            for (i, path) in inputs.iter().enumerate() {
                check_cancel()?;
                report(&app, i, total);
                let rows = read_any(path, delim)?;
                if rows.is_empty() {
                    continue;
                }
                for h in &rows[0] {
                    if !headers.iter().any(|k| k.eq_ignore_ascii_case(h)) {
                        headers.push(h.clone());
                    }
                }
                let label = base_name(path);
                body.extend(align_to_headers(
                    &rows,
                    &headers,
                    add_source_column.then_some(label.as_str()),
                ));
                if body.len() > MAX_ROWS {
                    return Err(format!("The merge would exceed {MAX_ROWS} rows."));
                }
            }
            if headers.is_empty() {
                return Err("None of those files had any rows.".to_string());
            }
            // Late-discovered headers leave earlier rows short; pad so every
            // row is the full width before writing.
            let mut out_headers = headers.clone();
            if add_source_column {
                out_headers.push("Source File".to_string());
            }
            let width = out_headers.len();
            let sheet = workbook.add_worksheet();
            sheet.set_name("Merged").map_err(|e| format!("Invalid worksheet name: {e}"))?;
            for (c, h) in out_headers.iter().enumerate() {
                sheet
                    .write_string(0, c as u16, h)
                    .map_err(|e| format!("Could not write cell: {e}"))?;
            }
            for (r, row) in body.iter().enumerate() {
                for c in 0..width {
                    let value = row.get(c).cloned().unwrap_or_default();
                    sheet
                        .write_string((r + 1) as u32, c as u16, &value)
                        .map_err(|e| format!("Could not write cell: {e}"))?;
                }
            }
            rows_written = body.len();
            sheets_written = 1;
        }

        check_cancel()?;
        workbook
            .save(&output)
            .map_err(|e| format!("Could not save {}: {e}", base_name(&output)))?;
        report(&app, total, total);
        Ok(MergeSummary {
            output: output.to_string_lossy().to_string(),
            files: total,
            rows: rows_written,
            sheets: sheets_written,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One file per selected worksheet. `as_csv` writes .csv instead of .xlsx.
#[tauri::command]
pub async fn split_workbook(
    app: AppHandle,
    path: String,
    sheets: Vec<String>,
    output_dir: String,
    as_csv: bool,
    delimiter: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        begin_op();
        let path = PathBuf::from(path);
        let dir = PathBuf::from(output_dir);
        validate_input(&path)?;
        reject_if_encrypted(&path)?;
        if !dir.is_dir() {
            return Err("Choose a folder to write the files into.".to_string());
        }
        if sheets.is_empty() {
            return Err("Choose at least one worksheet.".to_string());
        }
        let delim = delimiter_byte(&delimiter);
        let stem = file_stem(&path);
        let total = sheets.len();
        // Written files are tracked so a cancel or failure part-way through can
        // remove what it already produced, rather than leaving a half-split set.
        let mut written: Vec<PathBuf> = Vec::new();

        let result = (|| -> Result<(), String> {
            for (i, sheet) in sheets.iter().enumerate() {
                check_cancel()?;
                report(&app, i, total);
                let rows = read_sheet(&path, sheet)?;
                if rows.is_empty() {
                    continue;
                }
                let name = safe_file_name(&format!("{stem} - {sheet}"));
                let out = unique_path(&dir, &name, if as_csv { "csv" } else { "xlsx" });
                if as_csv {
                    write_csv(&rows, delim, &out)?;
                } else {
                    write_xlsx(&rows, &safe_sheet_name(sheet), &out)?;
                }
                written.push(out);
            }
            check_cancel()?;
            Ok(())
        })();

        if let Err(e) = result {
            for p in &written {
                let _ = std::fs::remove_file(p);
            }
            return Err(e);
        }
        report(&app, total, total);
        Ok(written.iter().map(|p| p.to_string_lossy().to_string()).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitises_worksheet_names() {
        assert_eq!(safe_sheet_name("Q1/Q2 Sales"), "Q1_Q2 Sales");
        assert_eq!(safe_sheet_name("a:b\\c?d*e[f]g"), "a_b_c_d_e_f_g");
        assert_eq!(safe_sheet_name("   "), "Sheet");
        // xlsx hard-caps worksheet names at 31 characters.
        assert_eq!(safe_sheet_name(&"x".repeat(40)).chars().count(), 31);
    }

    #[test]
    fn sanitises_output_file_names() {
        assert_eq!(safe_file_name("report:2026"), "report_2026");
        assert_eq!(safe_file_name("a/b\\c"), "a_b_c");
        // Windows reserved device names would be unopenable.
        assert_eq!(safe_file_name("CON"), "CON_");
        assert_eq!(safe_file_name("nul"), "nul_");
        assert_eq!(safe_file_name(""), "sheet");
        // A trailing dot is stripped by the filesystem and breaks round trips.
        assert_eq!(safe_file_name("data."), "data");
    }

    #[test]
    fn maps_delimiter_names() {
        assert_eq!(delimiter_byte("comma"), b',');
        assert_eq!(delimiter_byte("semicolon"), b';');
        assert_eq!(delimiter_byte("tab"), b'\t');
        assert_eq!(delimiter_byte("pipe"), b'|');
        // Anything unrecognised falls back to a comma rather than erroring.
        assert_eq!(delimiter_byte("nonsense"), b',');
    }

    #[test]
    fn renders_cells_the_way_a_spreadsheet_shows_them() {
        assert_eq!(cell_text(&Data::Empty), "");
        assert_eq!(cell_text(&Data::String("hi".into())), "hi");
        assert_eq!(cell_text(&Data::Int(42)), "42");
        // Whole floats must not render as "1200.0" in a CSV.
        assert_eq!(cell_text(&Data::Float(1200.0)), "1200");
        assert_eq!(cell_text(&Data::Float(1.5)), "1.5");
        assert_eq!(cell_text(&Data::Bool(true)), "TRUE");
    }

    #[test]
    fn aligns_columns_by_header_name_not_position() {
        // Second file has the same columns in a different order.
        let target = vec!["Name".to_string(), "Qty".to_string()];
        let rows = vec![
            vec!["Qty".to_string(), "Name".to_string()],
            vec!["7".to_string(), "Widget".to_string()],
        ];
        let aligned = align_to_headers(&rows, &target, None);
        assert_eq!(aligned, vec![vec!["Widget".to_string(), "7".to_string()]]);
    }

    #[test]
    fn missing_columns_become_empty_and_source_label_is_appended() {
        let target = vec!["Name".to_string(), "Qty".to_string(), "Region".to_string()];
        let rows = vec![
            vec!["Name".to_string(), "Qty".to_string()],
            vec!["Widget".to_string(), "7".to_string()],
        ];
        let aligned = align_to_headers(&rows, &target, Some("a.csv"));
        assert_eq!(
            aligned,
            vec![vec![
                "Widget".to_string(),
                "7".to_string(),
                String::new(),
                "a.csv".to_string()
            ]]
        );
    }

    #[test]
    fn header_matching_ignores_case() {
        let target = vec!["Name".to_string()];
        let rows = vec![vec!["NAME".to_string()], vec!["Widget".to_string()]];
        assert_eq!(align_to_headers(&rows, &target, None), vec![vec!["Widget".to_string()]]);
    }

    #[test]
    fn refuses_to_overwrite_without_confirmation() {
        let dir = std::env::temp_dir().join("mewmuze-sheets-overwrite-test");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("exists.xlsx");
        std::fs::write(&file, b"x").unwrap();
        assert!(guard_overwrite(&file, false).is_err());
        assert!(guard_overwrite(&file, true).is_ok());
        // A path that does not exist is always fine.
        assert!(guard_overwrite(&dir.join("new.xlsx"), false).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_encrypted_and_corrupt_workbooks() {
        let dir = std::env::temp_dir().join("mewmuze-sheets-magic-test");
        let _ = std::fs::create_dir_all(&dir);

        // OLE compound file magic == password protected.
        let enc = dir.join("locked.xlsx");
        std::fs::write(&enc, [0xD0u8, 0xCF, 0x11, 0xE0, 0, 0, 0, 0]).unwrap();
        let err = reject_if_encrypted(&enc).unwrap_err();
        assert!(err.contains("password protected"), "got: {err}");

        // Not a zip at all == corrupt or renamed.
        let bad = dir.join("broken.xlsx");
        std::fs::write(&bad, b"this is not a workbook").unwrap();
        let err = reject_if_encrypted(&bad).unwrap_err();
        assert!(err.contains("not a valid"), "got: {err}");

        // A real zip header passes this gate.
        let ok = dir.join("fine.xlsx");
        std::fs::write(&ok, [0x50u8, 0x4B, 0x03, 0x04, 0, 0, 0, 0]).unwrap();
        assert!(reject_if_encrypted(&ok).is_ok());

        // CSV is not subject to the workbook magic check.
        let csv = dir.join("plain.csv");
        std::fs::write(&csv, b"a,b\n1,2\n").unwrap();
        assert!(reject_if_encrypted(&csv).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_empty_and_missing_files() {
        let dir = std::env::temp_dir().join("mewmuze-sheets-validate-test");
        let _ = std::fs::create_dir_all(&dir);
        let empty = dir.join("empty.csv");
        std::fs::write(&empty, b"").unwrap();
        assert!(validate_input(&empty).unwrap_err().contains("empty"));
        assert!(validate_input(&dir.join("nope.csv")).is_err());
        // A directory is not a file.
        assert!(validate_input(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn csv_round_trips_through_xlsx_preserving_headers_and_values() {
        let dir = std::env::temp_dir().join("mewmuze-sheets-roundtrip-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let src = dir.join("in.csv");
        std::fs::write(&src, "Name,Qty\nWidget,7\nBolt,12\n").unwrap();
        let rows = read_csv(&src, b',').unwrap();
        assert_eq!(rows[0], vec!["Name", "Qty"]);
        assert_eq!(rows[2], vec!["Bolt", "12"]);

        let xlsx = dir.join("out.xlsx");
        write_xlsx(&rows, "Data", &xlsx).unwrap();
        assert!(xlsx.exists());

        let back = read_sheet(&xlsx, "Data").unwrap();
        assert_eq!(back[0], vec!["Name", "Qty"]);
        assert_eq!(back[1], vec!["Widget", "7"]);
        assert_eq!(back[2], vec!["Bolt", "12"]);

        let csv_out = dir.join("back.csv");
        write_csv(&back, b',', &csv_out).unwrap();
        let text = std::fs::read_to_string(&csv_out).unwrap();
        assert!(text.starts_with("Name,Qty"), "got: {text}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_utf8_and_alternate_delimiters_and_strips_bom() {
        let dir = std::env::temp_dir().join("mewmuze-sheets-utf8-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let semi = dir.join("semi.csv");
        std::fs::write(&semi, "Naïve;Prix\nCafé;3\n".as_bytes()).unwrap();
        let rows = read_csv(&semi, b';').unwrap();
        assert_eq!(rows[0], vec!["Naïve", "Prix"]);
        assert_eq!(rows[1], vec!["Café", "3"]);

        // A BOM must not end up glued to the first header name.
        let bom = dir.join("bom.csv");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"Name,Qty\nWidget,7\n");
        std::fs::write(&bom, bytes).unwrap();
        assert_eq!(read_csv(&bom, b',').unwrap()[0], vec!["Name", "Qty"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancellation_flag_round_trips() {
        begin_op();
        assert!(check_cancel().is_ok());
        cancel_sheet_op();
        assert!(check_cancel().is_err());
        // A new operation clears the previous cancel.
        begin_op();
        assert!(check_cancel().is_ok());
    }

    #[test]
    fn unique_path_avoids_clobbering() {
        let dir = std::env::temp_dir().join("mewmuze-sheets-unique-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_path(&dir, "book", "xlsx");
        assert_eq!(first.file_name().unwrap(), "book.xlsx");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_path(&dir, "book", "xlsx");
        assert_eq!(second.file_name().unwrap(), "book (2).xlsx");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
