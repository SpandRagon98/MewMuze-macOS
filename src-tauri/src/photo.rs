//! Photo Mode's four native jobs: write a PNG, copy one to the clipboard,
//! show one in the file manager, and — only on an explicit request from the
//! panel — photograph the screen.
//!
//! No new crates. The screen grab and the clipboard image both use GDI and the
//! Win32 clipboard that `clipboard.rs` already depends on, and the PNG encoder
//! is the `image` crate the Quick Tools conversions already ship.
//!
//! Every command here is `async` and does its blocking work inside
//! `spawn_blocking`. A non-async `#[tauri::command]` runs on the main thread,
//! which on Windows is an STA that also pumps the overlay's window messages —
//! blocking it freezes the cat.

use std::path::PathBuf;

/// A photo far larger than any screen is either a bug or an attempt to exhaust
/// memory; neither should reach the encoder.
const MAX_PHOTO_BYTES: usize = 64 * 1024 * 1024;

/// Write the PNG the panel composed. Returns the path actually written.
#[tauri::command]
pub async fn photo_save(bytes: Vec<u8>, output: String) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("There is no photo to save yet.".into());
    }
    if bytes.len() > MAX_PHOTO_BYTES {
        return Err("That photo is too large to save.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&output);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Could not create that folder: {e}"))?;
        }
        std::fs::write(&path, bytes).map_err(|e| format!("Could not save the photo: {e}"))?;
        Ok(output)
    })
    .await
    .map_err(|e| format!("Saving did not finish: {e}"))?
}

/// Put the photo on the clipboard as an image, so it can be pasted anywhere.
#[tauri::command]
pub async fn photo_copy_image(bytes: Vec<u8>) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("There is no photo to copy yet.".into());
    }
    if bytes.len() > MAX_PHOTO_BYTES {
        return Err("That photo is too large to copy.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            return platform::copy_png(&bytes);
        }
        #[cfg(target_os = "macos")]
        {
            return platform_mac::copy_png(&bytes);
        }
        #[allow(unreachable_code)]
        Err("Copying an image is not available on this platform.".to_string())
    })
    .await
    .map_err(|e| format!("Copying did not finish: {e}"))?
}

/// Open the containing folder with the saved photo selected.
#[tauri::command]
pub async fn photo_reveal(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.is_file() {
        return Err("That photo is no longer there.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // `/select,<path>` opens the folder and highlights the file. The path is
        // passed as one argument, never through a shell, so spaces and quotes in
        // a folder name cannot turn into extra arguments.
        #[cfg(windows)]
        {
            return std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", target.display()))
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("Could not open the folder: {e}"));
        }
        #[cfg(target_os = "macos")]
        {
            return std::process::Command::new("open")
                .arg("-R")
                .arg(&target)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("Could not open the folder: {e}"));
        }
        #[allow(unreachable_code)]
        Err("Opening the folder is not available on this platform.".to_string())
    })
    .await
    .map_err(|e| format!("Opening the folder did not finish: {e}"))?
}

/// Photograph the whole virtual screen and return PNG bytes.
///
/// PRIVACY: this is the only code in MewMuze that reads the screen, it holds
/// nothing back (no cache, no temp file — the bytes go straight to the panel
/// that asked), and nothing calls it except the Photo Mode "Take desktop photo"
/// button after the user has confirmed a warning that says what will be in the
/// image. It is never called on open, on a pose change, or by any other mode.
#[tauri::command]
pub async fn photo_capture_screen() -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(windows)]
        {
            return platform::capture_screen();
        }
        #[cfg(target_os = "macos")]
        {
            return platform_mac::capture_screen();
        }
        #[allow(unreachable_code)]
        Err("Desktop photos are not available on this platform.".to_string())
    })
    .await
    .map_err(|e| format!("The screenshot did not finish: {e}"))?
}

/// Encode straight (top-down) RGBA pixels as a PNG. Shared by both platforms.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
fn rgba_to_png(width: u32, height: u32, rgba: Vec<u8>) -> Result<Vec<u8>, String> {
    let buffer = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| "The screenshot was an unexpected size.".to_string())?;
    let mut out = std::io::Cursor::new(Vec::new());
    buffer
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| format!("Could not encode the screenshot: {e}"))?;
    Ok(out.into_inner())
}

#[cfg(windows)]
mod platform {
    use super::rgba_to_png;
    use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HBITMAP, HDC, HGDIOBJ, SRCCOPY,
    };
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    /// Closes the clipboard however the surrounding code leaves, including on
    /// an early `?`. Leaving it open would lock every other app out of it.
    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    /// Frees the allocation unless ownership was handed to the clipboard.
    struct Allocation(Option<HGLOBAL>);
    impl Drop for Allocation {
        fn drop(&mut self) {
            if let Some(h) = self.0.take() {
                unsafe {
                    let _ = windows::Win32::Foundation::GlobalFree(h);
                }
            }
        }
    }

    /// Releases the GDI objects in the reverse order they were made.
    struct Surface {
        screen: HDC,
        mem: HDC,
        bitmap: HBITMAP,
        previous: HGDIOBJ,
    }
    impl Drop for Surface {
        fn drop(&mut self) {
            unsafe {
                if !self.previous.is_invalid() {
                    SelectObject(self.mem, self.previous);
                }
                if !self.bitmap.is_invalid() {
                    let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
                }
                if !self.mem.is_invalid() {
                    let _ = DeleteDC(self.mem);
                }
                if !self.screen.is_invalid() {
                    ReleaseDC(HWND::default(), self.screen);
                }
            }
        }
    }

    fn header(width: i32, height: i32) -> BITMAPINFO {
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        // Negative height asks GDI for top-down rows, which is the order PNG
        // wants. A positive height here is the classic upside-down screenshot.
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;
        info
    }

    pub fn capture_screen() -> Result<Vec<u8>, String> {
        let (x, y, width, height) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        if width <= 0 || height <= 0 {
            return Err("Could not measure the screen.".into());
        }

        let screen = unsafe { GetDC(HWND::default()) };
        if screen.is_invalid() {
            return Err("Could not read the screen.".into());
        }
        let mem = unsafe { CreateCompatibleDC(screen) };
        let bitmap = unsafe { CreateCompatibleBitmap(screen, width, height) };
        let previous = if mem.is_invalid() || bitmap.is_invalid() {
            HGDIOBJ::default()
        } else {
            unsafe { SelectObject(mem, HGDIOBJ(bitmap.0)) }
        };
        let surface = Surface { screen, mem, bitmap, previous };
        if surface.mem.is_invalid() || surface.bitmap.is_invalid() {
            return Err("Could not prepare the screenshot.".into());
        }

        unsafe { BitBlt(surface.mem, 0, 0, width, height, surface.screen, x, y, SRCCOPY) }
            .map_err(|_| "The screen could not be copied.".to_string())?;

        let pixels = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or_else(|| "That screen is too large to photograph.".to_string())?;
        let mut buffer = vec![0u8; pixels];
        let mut info = header(width, height);
        let copied = unsafe {
            GetDIBits(
                surface.mem,
                surface.bitmap,
                0,
                height as u32,
                Some(buffer.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        if copied == 0 {
            return Err("The screen could not be read.".into());
        }

        // GDI hands back BGRA with an undefined alpha channel; PNG wants RGBA
        // and a screenshot is fully opaque.
        for px in buffer.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        rgba_to_png(width as u32, height as u32, buffer)
    }

    /// CF_DIB: a BITMAPINFOHEADER followed by bottom-up BGRA rows.
    const CF_DIB_ID: u32 = 8;

    pub fn copy_png(bytes: &[u8]) -> Result<(), String> {
        let image = image::load_from_memory(bytes)
            .map_err(|_| "That photo could not be read back.".to_string())?
            .to_rgba8();
        let (width, height) = (image.width(), image.height());
        if width == 0 || height == 0 {
            return Err("That photo is empty.".into());
        }

        let head = std::mem::size_of::<BITMAPINFOHEADER>();
        let row = width as usize * 4;
        let total = head + row * height as usize;
        let mut dib = vec![0u8; total];
        {
            let info = header(width as i32, height as i32);
            let mut header_bytes = info.bmiHeader;
            // The clipboard's DIB is bottom-up, unlike the top-down one used
            // for the screen grab, so the sign flips back.
            header_bytes.biHeight = height as i32;
            let raw = unsafe {
                std::slice::from_raw_parts(
                    (&header_bytes as *const BITMAPINFOHEADER).cast::<u8>(),
                    head,
                )
            };
            dib[..head].copy_from_slice(raw);
        }
        for y in 0..height as usize {
            let src = &image.as_raw()[y * row..y * row + row];
            let dst_y = height as usize - 1 - y;
            let dst = &mut dib[head + dst_y * row..head + dst_y * row + row];
            for (out, px) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                out[0] = px[2];
                out[1] = px[1];
                out[2] = px[0];
                out[3] = px[3];
            }
        }

        let global = unsafe { GlobalAlloc(GMEM_MOVEABLE, dib.len()) }
            .map_err(|_| "Not enough memory to copy the photo.".to_string())?;
        let mut allocation = Allocation(Some(global));
        let ptr = unsafe { GlobalLock(global) } as *mut u8;
        if ptr.is_null() {
            return Err("The clipboard memory could not be prepared.".into());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(dib.as_ptr(), ptr, dib.len());
            let _ = GlobalUnlock(global);
        }

        unsafe { OpenClipboard(HWND::default()) }
            .map_err(|_| "The clipboard is busy — try again.".to_string())?;
        let _guard = ClipboardGuard;
        unsafe { EmptyClipboard() }
            .map_err(|_| "The clipboard could not be cleared.".to_string())?;
        if unsafe { SetClipboardData(CF_DIB_ID, HANDLE(global.0)) }.is_err() {
            return Err("The photo could not be copied.".into());
        }
        // The clipboard owns the memory now; dropping must not free it.
        allocation.0 = None;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod platform_mac {
    use super::rgba_to_png;
    use std::io::Write;
    use std::process::{Command, Stdio};

    /// Photograph every active display into one image.
    ///
    /// Quartz captures per display, so the displays are composited into the
    /// union of their bounds — the same single-image result the Windows
    /// virtual-screen BitBlt produces. Gaps between non-adjacent displays stay
    /// transparent rather than black.
    ///
    /// PERMISSION: on macOS 10.15+ this needs Screen Recording, which the
    /// system prompts for the first time it is called. Until the user grants
    /// it, Quartz hands back the desktop picture with no windows in it. That is
    /// a degraded photo, never a silent leak, and Photo Mode only reaches this
    /// code after the user has ticked the on-screen warning.
    pub fn capture_screen() -> Result<Vec<u8>, String> {
        use core_graphics::display::CGDisplay;

        let ids = CGDisplay::active_displays().map_err(|_| "Could not find a display.".to_string())?;
        if ids.is_empty() {
            return Err("Could not find a display.".into());
        }

        // Union of every display, in points (which is what CGDisplay reports).
        let (mut ox, mut oy, mut mx, mut my) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for id in &ids {
            let b = CGDisplay::new(*id).bounds();
            ox = ox.min(b.origin.x);
            oy = oy.min(b.origin.y);
            mx = mx.max(b.origin.x + b.size.width);
            my = my.max(b.origin.y + b.size.height);
        }
        if !(ox.is_finite() && oy.is_finite() && mx > ox && my > oy) {
            return Err("Could not measure the screen.".into());
        }

        // Work in the BACKING pixels of the densest display, so a Retina screen
        // is photographed at its real resolution rather than downsampled to
        // points. Every display is placed at that same scale.
        let mut scale = 1.0f64;
        for id in &ids {
            let d = CGDisplay::new(*id);
            let b = d.bounds();
            if b.size.width > 0.0 {
                scale = scale.max(d.pixels_wide() as f64 / b.size.width);
            }
        }

        let width = ((mx - ox) * scale).round() as usize;
        let height = ((my - oy) * scale).round() as usize;
        let pixels = width
            .checked_mul(height)
            .and_then(|n| n.checked_mul(4))
            .ok_or_else(|| "That screen is too large to photograph.".to_string())?;
        if width == 0 || height == 0 {
            return Err("Could not measure the screen.".into());
        }
        let mut canvas = vec![0u8; pixels];

        let mut captured_any = false;
        for id in &ids {
            let d = CGDisplay::new(*id);
            let Some(image) = d.image() else { continue };
            let b = d.bounds();
            let src_w = image.width();
            let src_h = image.height();
            let stride = image.bytes_per_row();
            if image.bits_per_pixel() != 32 || src_w == 0 || src_h == 0 {
                continue;
            }
            let data = image.data();
            let bytes = data.bytes();
            // Where this display starts inside the composite, in backing pixels.
            let dx = ((b.origin.x - ox) * scale).round() as usize;
            let dy = ((b.origin.y - oy) * scale).round() as usize;

            for row in 0..src_h {
                let out_y = dy + row;
                if out_y >= height {
                    break;
                }
                let src_row = row * stride;
                for col in 0..src_w {
                    let out_x = dx + col;
                    if out_x >= width {
                        break;
                    }
                    let s = src_row + col * 4;
                    if s + 3 >= bytes.len() {
                        break;
                    }
                    let o = (out_y * width + out_x) * 4;
                    // Quartz gives BGRA on little-endian; PNG wants RGBA, and a
                    // screenshot is opaque whatever the source alpha says.
                    canvas[o] = bytes[s + 2];
                    canvas[o + 1] = bytes[s + 1];
                    canvas[o + 2] = bytes[s];
                    canvas[o + 3] = 255;
                }
            }
            captured_any = true;
        }

        if !captured_any {
            return Err(
                "macOS did not allow the screen to be read. Grant MewMuze Screen Recording \
                 in System Settings > Privacy & Security."
                    .into(),
            );
        }
        rgba_to_png(width as u32, height as u32, canvas)
    }

    pub fn copy_png(bytes: &[u8]) -> Result<(), String> {
        // osascript reads the file rather than the pipe, so the bytes go to a
        // temp file that is removed as soon as the clipboard has them.
        let mut path = std::env::temp_dir();
        path.push("mewmuze-photo-clipboard.png");
        std::fs::write(&path, bytes).map_err(|e| format!("Could not copy the photo: {e}"))?;
        let script = format!(
            "set the clipboard to (read (POSIX file \"{}\") as «class PNGf»)",
            path.display()
        );
        let mut child = Command::new("osascript")
            .arg("-")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not copy the photo: {e}"))?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(script.as_bytes())
                .map_err(|e| format!("Could not copy the photo: {e}"))?;
        }
        let status = child.wait().map_err(|e| format!("Could not copy the photo: {e}"))?;
        let _ = std::fs::remove_file(&path);
        if status.success() {
            Ok(())
        } else {
            Err("The photo could not be copied.".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_an_empty_photo() {
        let err = tauri::async_runtime::block_on(photo_save(Vec::new(), "x.png".into()));
        assert!(err.is_err());
        let err = tauri::async_runtime::block_on(photo_copy_image(Vec::new()));
        assert!(err.is_err());
    }

    #[test]
    fn refuses_an_absurdly_large_photo() {
        let huge = vec![0u8; MAX_PHOTO_BYTES + 1];
        assert!(tauri::async_runtime::block_on(photo_save(huge, "x.png".into())).is_err());
    }

    #[test]
    fn revealing_a_missing_file_is_an_error_not_a_launch() {
        let missing = std::env::temp_dir().join("mewmuze-not-a-real-photo.png");
        let _ = std::fs::remove_file(&missing);
        let result =
            tauri::async_runtime::block_on(photo_reveal(missing.display().to_string()));
        assert!(result.is_err());
    }

    #[test]
    fn encodes_rgba_as_a_readable_png() {
        let png = rgba_to_png(2, 2, vec![255; 16]).expect("encode");
        let decoded = image::load_from_memory(&png).expect("decode");
        assert_eq!(decoded.width(), 2);
        assert_eq!(decoded.height(), 2);
    }

    #[test]
    fn rejects_pixels_that_do_not_match_the_size() {
        assert!(rgba_to_png(4, 4, vec![0; 8]).is_err());
    }
}
