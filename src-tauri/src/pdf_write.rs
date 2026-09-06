//! Minimal hand-written PDF writer: one image per page, no text/fonts. A real
//! PDF crate would add far more to the binary than this file does.
//! JPEGs embed byte-for-byte via /DCTDecode (PDF speaks JPEG natively);
//! everything else decodes to RGB and stores /FlateDecode. `panic = "abort"`
//! in release, so bad input must return Err, never unwind.

use std::io::Write;

/// 96 DPI, so a screenshot comes out life-size rather than blown up.
const PT_PER_PX: f64 = 72.0 / 96.0;

pub struct ImagePage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    /// `DCTDecode` or `FlateDecode`.
    pub filter: &'static str,
    /// `DeviceRGB` or `DeviceGray`.
    pub color_space: &'static str,
}

/// Reads the JPEG SOF segment directly so a 20MP photo isn't decoded just to
/// learn its size — it gets embedded without decoding either way.
fn jpeg_info(bytes: &[u8]) -> Option<(u32, u32, u8)> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None; // not a JPEG
    }
    let mut i = 2usize;
    while i + 3 < bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        // Standalone markers carry no length field.
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 || marker == 0xFF {
            i += 2;
            continue;
        }
        let len = ((bytes[i + 2] as usize) << 8) | bytes[i + 3] as usize;
        if len < 2 || i + 2 + len > bytes.len() {
            return None;
        }
        // SOF0/1/2/3, 5-7, 9-11, 13-15 all carry the frame header. DHT (C4),
        // JPG (C8) and DAC (CC) sit in the same range but are not frames.
        let is_sof = (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
        if is_sof {
            if len < 8 {
                return None;
            }
            let seg = &bytes[i + 4..i + 2 + len];
            // precision(1) height(2) width(2) components(1)
            let height = ((seg[1] as u32) << 8) | seg[2] as u32;
            let width = ((seg[3] as u32) << 8) | seg[4] as u32;
            let components = seg[5];
            if width == 0 || height == 0 {
                return None;
            }
            return Some((width, height, components));
        }
        i += 2 + len;
    }
    None
}

fn flate(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(data).map_err(|e| e.to_string())?;
    enc.finish().map_err(|e| e.to_string())
}

pub fn load_image_page(path: &str) -> Result<ImagePage, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {}", short_name(path), e))?;

    // JPEG fast path: hand the original bytes straight to the PDF.
    if let Some((w, h, comps)) = jpeg_info(&bytes) {
        let color_space = match comps {
            1 => Some("DeviceGray"),
            3 => Some("DeviceRGB"),
            _ => None, // CMYK and friends: fall through to a full decode
        };
        if let Some(cs) = color_space {
            return Ok(ImagePage { width: w, height: h, data: bytes, filter: "DCTDecode", color_space: cs });
        }
    }

    // Everything else (PNG, odd JPEGs): decode, flatten onto white, deflate.
    let img = image::load_from_memory(&bytes).map_err(|e| format!("{}: {}", short_name(path), e))?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    if w == 0 || h == 0 {
        return Err(format!("{}: image has no pixels", short_name(path)));
    }
    // PDF image XObjects have no alpha channel of their own, so composite onto
    // white — the background a printed page would have anyway.
    let mut rgb = Vec::with_capacity((w as usize) * (h as usize) * 3);
    for p in rgba.pixels() {
        let a = p[3] as u32;
        for c in 0..3 {
            rgb.push(((p[c] as u32 * a + 255 * (255 - a)) / 255) as u8);
        }
    }
    Ok(ImagePage {
        width: w,
        height: h,
        data: flate(&rgb)?,
        filter: "FlateDecode",
        color_space: "DeviceRGB",
    })
}

fn short_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_string()
}

pub fn build_pdf(pages: &[ImagePage]) -> Result<Vec<u8>, String> {
    if pages.is_empty() {
        return Err("No images to convert.".into());
    }

    let mut out: Vec<u8> = Vec::new();
    // Object offsets, 1-based; slot 0 is the free-list head, never written.
    let mut offsets: Vec<usize> = vec![0; 1 + 2 + pages.len() * 3];

    out.extend_from_slice(b"%PDF-1.7\n");
    // A binary comment marks the file as containing binary data, so tools do
    // not mangle it in text mode.
    out.extend_from_slice(b"%\xE2\xE3\xCF\xD3\n");

    let page_obj = |i: usize| 3 + i * 3;
    let content_obj = |i: usize| 4 + i * 3;
    let image_obj = |i: usize| 5 + i * 3;

    let begin = |out: &mut Vec<u8>, offsets: &mut Vec<usize>, num: usize| {
        offsets[num] = out.len();
        out.extend_from_slice(format!("{} 0 obj\n", num).as_bytes());
    };

    // 1: catalogue.
    begin(&mut out, &mut offsets, 1);
    out.extend_from_slice(b"<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    // 2: page tree.
    begin(&mut out, &mut offsets, 2);
    let kids: String = (0..pages.len()).map(|i| format!("{} 0 R ", page_obj(i))).collect();
    out.extend_from_slice(
        format!("<< /Type /Pages /Kids [ {}] /Count {} >>\nendobj\n", kids, pages.len()).as_bytes(),
    );

    for (i, page) in pages.iter().enumerate() {
        let pw = page.width as f64 * PT_PER_PX;
        let ph = page.height as f64 * PT_PER_PX;

        // Page.
        begin(&mut out, &mut offsets, page_obj(i));
        out.extend_from_slice(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.2} {:.2}] \
                 /Resources << /XObject << /Im0 {} 0 R >> >> /Contents {} 0 R >>\nendobj\n",
                pw,
                ph,
                image_obj(i),
                content_obj(i),
            )
            .as_bytes(),
        );

        // Content stream: scale the unit image square to fill the page.
        let content = format!("q {:.2} 0 0 {:.2} 0 0 cm /Im0 Do Q\n", pw, ph);
        begin(&mut out, &mut offsets, content_obj(i));
        out.extend_from_slice(format!("<< /Length {} >>\nstream\n", content.len()).as_bytes());
        out.extend_from_slice(content.as_bytes());
        out.extend_from_slice(b"endstream\nendobj\n");

        // Image XObject.
        begin(&mut out, &mut offsets, image_obj(i));
        out.extend_from_slice(
            format!(
                "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /{} \
                 /BitsPerComponent 8 /Filter /{} /Length {} >>\nstream\n",
                page.width,
                page.height,
                page.color_space,
                page.filter,
                page.data.len(),
            )
            .as_bytes(),
        );
        out.extend_from_slice(&page.data);
        out.extend_from_slice(b"\nendstream\nendobj\n");
    }

    // Cross-reference table.
    let xref_at = out.len();
    let count = offsets.len();
    out.extend_from_slice(format!("xref\n0 {}\n", count).as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for off in offsets.iter().skip(1) {
        out.extend_from_slice(format!("{:010} 00000 n \n", off).as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
            count, xref_at
        )
        .as_bytes(),
    );

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grey_page() -> ImagePage {
        ImagePage { width: 2, height: 2, data: vec![1, 2, 3, 4], filter: "FlateDecode", color_space: "DeviceGray" }
    }

    #[test]
    fn rejects_an_empty_document() {
        assert!(build_pdf(&[]).is_err());
    }

    #[test]
    fn writes_a_header_and_trailer() {
        let pdf = build_pdf(&[grey_page()]).expect("builds");
        assert!(pdf.starts_with(b"%PDF-1.7"));
        assert!(pdf.ends_with(b"%%EOF\n"));
    }

    #[test]
    fn page_count_matches_the_images() {
        let pdf = build_pdf(&[grey_page(), grey_page(), grey_page()]).expect("builds");
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Count 3"), "page tree should report three pages");
        assert_eq!(text.matches("/Type /Page ").count(), 3);
    }

    /// Follows startxref to the table and checks every offset lands on its
    /// object. Works on raw bytes — a PDF isn't UTF-8, so stringifying first
    /// shifts every offset via replacement characters and voids the check.
    #[test]
    fn xref_offsets_point_at_their_objects() {
        let pdf = build_pdf(&[grey_page(), grey_page()]).expect("builds");

        let rfind = |needle: &[u8]| {
            pdf.windows(needle.len()).rposition(|w| w == needle)
        };

        // Follow the trailer's startxref pointer, exactly as a reader would.
        let marker = rfind(b"startxref\n").expect("has a startxref");
        let after = &pdf[marker + b"startxref\n".len()..];
        let end = after.iter().position(|&b| b == b'\n').expect("value is terminated");
        let xref_at: usize = std::str::from_utf8(&after[..end])
            .expect("ascii")
            .trim()
            .parse()
            .expect("startxref is a number");
        assert!(
            pdf[xref_at..].starts_with(b"xref\n"),
            "startxref must point at the xref table"
        );

        // From the xref onward the file is pure ASCII, so it is safe to read as text.
        let table = std::str::from_utf8(&pdf[xref_at..]).expect("xref section is ascii");
        let object_count = 1 + 2 + 2 * 3;
        let mut lines = table.lines();
        assert_eq!(lines.next(), Some("xref"));
        assert_eq!(lines.next(), Some(format!("0 {object_count}").as_str()));
        // The free-list head, which is not a real object.
        assert!(lines.next().expect("free entry").starts_with("0000000000 65535 f"));

        for num in 1..object_count {
            let line = lines.next().expect("an entry per object");
            let off: usize = line[..10].parse().expect("ten-digit offset");
            assert!(
                pdf[off..].starts_with(format!("{num} 0 obj").as_bytes()),
                "object {num} should start at offset {off}"
            );
        }
    }

    #[test]
    fn parses_jpeg_dimensions_without_decoding() {
        // Minimal SOF0: FFD8 then FFC0, length 17, precision 8, 3x4, 3 comps.
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08];
        bytes.extend_from_slice(&[0x00, 0x04, 0x00, 0x03, 0x03]); // h=4, w=3, comps=3
        bytes.extend_from_slice(&[0u8; 9]);
        assert_eq!(jpeg_info(&bytes), Some((3, 4, 3)));
    }

    /// Encode real images, build a PDF, open it with PDFium — hand-rolled PDFs
    /// fail in ways only a real reader catches.
    #[test]
    fn round_trips_through_a_real_pdf_reader() {
        let dir = std::env::temp_dir().join("pixelcat-pdf-roundtrip");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let png_path = dir.join("a.png");
        let jpg_path = dir.join("b.jpg");

        let img = image::RgbImage::from_fn(40, 20, |x, y| {
            image::Rgb([(x * 6) as u8, (y * 12) as u8, 128])
        });
        img.save(&png_path).expect("write png");
        img.save(&jpg_path).expect("write jpg");

        let pages = vec![
            load_image_page(png_path.to_str().expect("path")).expect("png page"),
            load_image_page(jpg_path.to_str().expect("path")).expect("jpg page"),
        ];
        // The PNG is decoded and deflated; the JPEG is passed through untouched.
        assert_eq!(pages[0].filter, "FlateDecode");
        assert_eq!(pages[1].filter, "DCTDecode");
        assert_eq!((pages[0].width, pages[0].height), (40, 20));
        assert_eq!((pages[1].width, pages[1].height), (40, 20), "SOF parse must match the encoder");

        let pdf = build_pdf(&pages).expect("builds");
        let out = dir.join("out.pdf");
        std::fs::write(&out, &pdf).expect("write pdf");

        let lib = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("lib").join("pdfium.dll");
        if !lib.is_file() {
            eprintln!("skipping reader check: run `npm run fetch:pdfium` first");
            return;
        }
        use pdfium_render::prelude::*;
        let bindings = Pdfium::bind_to_library(&lib).expect("bind pdfium");
        let pdfium = Pdfium::new(bindings);
        let doc = pdfium
            .load_pdf_from_file(out.to_str().expect("path"), None)
            .expect("PDFium must accept our PDF");

        assert_eq!(doc.pages().len(), 2, "both images should be pages");
        // 40 px at 96 DPI is 30 pt wide, 20 px is 15 pt tall.
        let first = doc.pages().get(0).expect("first page");
        assert!((first.width().value - 30.0).abs() < 0.5, "page width in points");
        assert!((first.height().value - 15.0).abs() < 0.5, "page height in points");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ignores_non_jpeg_data() {
        assert_eq!(jpeg_info(b"\x89PNG\r\n\x1a\n"), None);
        assert_eq!(jpeg_info(b""), None);
    }
}
