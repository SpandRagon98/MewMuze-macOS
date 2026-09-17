//! Signed, data-only MewMuze costume packages.
//!
//! Packages are untrusted ZIP input. Every entry is bounded and allow-listed,
//! hashes and Ed25519 signatures are verified before extraction, and the final
//! directory is promoted atomically. No package content is ever executed.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use image::GenericImageView;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use zip::ZipArchive;

const STORE_URL: &str = "https://spandragon98.github.io/PawPico-Website/store/";
const STORE_KEY_ID: &str = "store-key-2026-01";
const STORE_PUBLIC_KEY_B64: &str = "wwMcM8TiKB+J7F0Hv5PJsty7vMlI+O8IvxDAd405sCc=";
const MECHA_KEY_ID: &str = "store-key-mecha-2026-01";
const MECHA_PUBLIC_KEY_B64: &str = "6XP8hsa3OEULR2QuDpb/k3LPv6doVIsJBrgBp6bH8cc=";
const MECHA_V2_KEY_ID: &str = "store-key-mecha-2026-02";
/// Signs the first-party anchored costumes. Its private half lives in the
/// separate costume workspace and never ships.
const COSTUME_KEY_ID: &str = "store-key-costume-2026-01";
const COSTUME_PUBLIC_KEY_B64: &str = "WDivgB+TbxgAZjDnsW5JuYURWfS8/PEY4Rpb/btjguk=";
const MECHA_V2_PUBLIC_KEY_B64: &str = "gvdmBxGcLM99o/vAWCQb2zxtVyWPiS+sbcDn1QY/7Jk=";
const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 32 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_ENTRIES: usize = 64;
const MAX_IMAGE_DIMENSION: u32 = 2048;
const MAX_INSTALLED_COSTUMES: usize = 5;
const REGISTRY_FILE: &str = "installed-costumes.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CostumeAsset {
    pub path: String,
    pub view: String,
    pub layer: String,
    #[serde(default = "default_variant")]
    pub variant: String,
    /// Which body mass this piece rides: "torso", "head", or "sprite" for
    /// the legacy behaviour of pinning it to the frame. Absent = "sprite".
    #[serde(default)]
    pub anchor: Option<String>,
    #[serde(default)]
    pub offset_x: i32,
    #[serde(default)]
    pub offset_y: i32,
    #[serde(default = "default_scale")]
    pub scale: f32,
    #[serde(default = "default_opacity")]
    pub opacity: f32,
}

fn default_scale() -> f32 {
    1.0
}

fn default_variant() -> String {
    "base".into()
}

fn default_opacity() -> f32 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CostumeManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub creator: String,
    pub description: String,
    pub category: String,
    pub supported_bodies: Vec<String>,
    pub minimum_app_version: String,
    pub maximum_app_version: Option<String>,
    pub thumbnail: String,
    pub preview: String,
    pub assets: Vec<CostumeAsset>,
    pub asset_hashes: BTreeMap<String, String>,
    pub package_size: u64,
    pub license_id: String,
    pub signature_key_id: String,
    /// Reference geometry the art was drawn against. Required by schema 2.
    #[serde(default)]
    pub anchor: Option<CostumeAnchorSpec>,
}

/// One body mass in the costume's own design space.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnchorEllipse {
    pub x: f32,
    pub y: f32,
    pub rx: f32,
    pub ry: f32,
}

/// Where the artwork assumed the body was.
///
/// The app knows where the torso and head REALLY are for the current pose,
/// so knowing where the artist assumed they were is enough to map one onto
/// the other. That mapping is what lets a single image fit a sitting kitten
/// and a lying chonk without the artist drawing either.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CostumeAnchorSpec {
    pub space: String,
    pub design_size: f32,
    /// How far the garment may be stretched out of its drawn proportions when
    /// the body it rides is a different shape. 1.0 keeps it perfectly
    /// proportional; the default lets it flex a little so it still reads as
    /// clothing rather than a decal.
    #[serde(default = "default_max_aspect")]
    pub max_aspect: f32,
    // Both default to empty: a costume that only dresses the torso has no
    // reason to describe a head, and vice versa.
    #[serde(default)]
    pub torso: BTreeMap<String, AnchorEllipse>,
    #[serde(default)]
    pub head: BTreeMap<String, AnchorEllipse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntitlementReceipt {
    costume_id: String,
    entitlement_id: String,
    issued_at: u64,
    mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledCostume {
    pub costume_id: String,
    pub version: String,
    pub installation_time: u64,
    pub local_package_location: String,
    pub signature_status: String,
    pub entitlement_identifier: String,
    pub enabled: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CostumeRegistry {
    costumes: Vec<InstalledCostume>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledCostumeView {
    #[serde(flatten)]
    pub installed: InstalledCostume,
    pub name: String,
    pub creator: String,
    pub description: String,
    pub supported_bodies: Vec<String>,
    pub thumbnail_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostumeVisuals {
    pub costume_id: String,
    pub supported_bodies: Vec<String>,
    /// Every layer for a view, in manifest order. A list rather than a map
    /// keyed by variant: a costume is often several garments at once (a
    /// blazer AND spectacles), and keying by variant collapsed them to one.
    pub views: BTreeMap<String, Vec<CostumeVisualLayer>>,
    pub anchor: Option<CostumeAnchorSpec>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostumeVisualLayer {
    pub data_url: String,
    pub variant: String,
    pub anchor: String,
    pub offset_x: i32,
    pub offset_y: i32,
    pub scale: f32,
    pub opacity: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub costume_id: String,
    pub name: String,
    pub version: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInstallRequest {
    pub kind: String,
    pub source: String,
    pub token: Option<String>,
    pub package_path: Option<String>,
    pub product_id: Option<String>,
    pub costume_name: String,
    pub creator: String,
    pub version: String,
    pub package_size: u64,
    pub minimum_app_version: String,
    pub preview_data_url: Option<String>,
}

#[derive(Default)]
pub struct CostumeRequestState {
    pending: Mutex<Option<PendingInstallRequest>>,
    consumed_tokens: Mutex<HashSet<String>>,
}

struct VerifiedPackage {
    manifest: CostumeManifest,
    entitlement: EntitlementReceipt,
    files: BTreeMap<String, Vec<u8>>,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn costume_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("MewMuze could not locate its local data folder: {e}"))?
        .join("Costumes");
    fs::create_dir_all(&root)
        .map_err(|e| format!("MewMuze could not create its costume folder: {e}"))?;
    Ok(root)
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(costume_root(app)?.join(REGISTRY_FILE))
}

fn load_registry(app: &AppHandle) -> CostumeRegistry {
    let Ok(path) = registry_path(app) else {
        return CostumeRegistry::default();
    };
    let Ok(data) = fs::read(path) else {
        return CostumeRegistry::default();
    };
    serde_json::from_slice(&data).unwrap_or_default()
}

fn save_registry(app: &AppHandle, registry: &CostumeRegistry) -> Result<(), String> {
    let path = registry_path(app)?;
    let temp = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(registry).map_err(|e| e.to_string())?;
    fs::write(&temp, data)
        .map_err(|e| format!("MewMuze could not update the costume registry: {e}"))?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("MewMuze could not replace the costume registry: {e}"))?;
    }
    fs::rename(&temp, &path)
        .map_err(|e| format!("MewMuze could not finish updating the costume registry: {e}"))
}

fn has_install_capacity(registry: &CostumeRegistry, incoming_id: &str) -> bool {
    registry
        .costumes
        .iter()
        .any(|entry| entry.costume_id == incoming_id)
        || registry.costumes.len() < MAX_INSTALLED_COSTUMES
}

fn valid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (3..=80).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'))
}

fn valid_relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && !value.starts_with('/')
        && !value.starts_with('\\')
        && !value.contains('\\')
        && !value.contains(':')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn read_zip_entry<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    max: u64,
) -> Result<Vec<u8>, String> {
    let mut file = archive
        .by_name(name)
        .map_err(|_| format!("The package is missing {name}."))?;
    if file.size() > max {
        return Err(format!("{name} is larger than the allowed limit."));
    }
    let mut data = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut data)
        .map_err(|e| format!("MewMuze could not read {name}: {e}"))?;
    Ok(data)
}

fn default_max_aspect() -> f32 {
    1.15
}

fn store_public_key(key_id: &str) -> Option<&'static str> {
    match key_id {
        STORE_KEY_ID => Some(STORE_PUBLIC_KEY_B64),
        MECHA_KEY_ID => Some(MECHA_PUBLIC_KEY_B64),
        MECHA_V2_KEY_ID => Some(MECHA_V2_PUBLIC_KEY_B64),
        COSTUME_KEY_ID => Some(COSTUME_PUBLIC_KEY_B64),
        _ => None,
    }
}

fn verify_signature(data: &[u8], encoded: &[u8], label: &str, key_id: &str) -> Result<(), String> {
    let public_key = store_public_key(key_id)
        .ok_or_else(|| "This costume was signed by an unknown Store key.".to_string())?;
    let public_bytes = BASE64
        .decode(public_key)
        .map_err(|_| "The configured Store public key is invalid.".to_string())?;
    let public_array: [u8; 32] = public_bytes
        .try_into()
        .map_err(|_| "The configured Store public key has the wrong length.".to_string())?;
    let key = VerifyingKey::from_bytes(&public_array)
        .map_err(|_| "The configured Store public key is invalid.".to_string())?;
    let signature_text = std::str::from_utf8(encoded)
        .map_err(|_| format!("The {label} signature is not text."))?
        .trim();
    let signature_bytes = BASE64
        .decode(signature_text)
        .map_err(|_| format!("The {label} signature is not valid Base64."))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| format!("The {label} signature has the wrong length."))?;
    key.verify(data, &signature)
        .map_err(|_| format!("The {label} signature could not be verified."))
}

fn validate_manifest(manifest: &CostumeManifest, package_len: u64) -> Result<(), String> {
    // 1 = a flat overlay centred on the sprite. 2 adds anchors, so a garment
    // can follow the torso and head through every pose and species. Both are
    // accepted: a v1 package installed before the update must keep working.
    if !matches!(manifest.schema_version, 1 | 2) {
        return Err("This costume uses an unsupported manifest version.".into());
    }
    if manifest.schema_version >= 2 && manifest.anchor.is_none() {
        return Err("This costume declares schema 2 but carries no anchor data.".into());
    }
    if let Some(anchor) = &manifest.anchor {
        // An unbounded or nonsensical value would let a package smear its art
        // across the whole sprite, so it is range-checked like every other
        // number that reaches the renderer.
        if !anchor.max_aspect.is_finite() || !(1.0..=3.0).contains(&anchor.max_aspect) {
            return Err("The costume anchor has an invalid maxAspect.".into());
        }
        if !anchor.design_size.is_finite() || !(8.0..=512.0).contains(&anchor.design_size) {
            return Err("The costume anchor has an invalid designSize.".into());
        }
    }
    if !valid_id(&manifest.id) {
        return Err("The costume ID is invalid.".into());
    }
    if manifest.name.trim().is_empty() || manifest.name.len() > 80 {
        return Err("The costume name is invalid.".into());
    }
    if manifest.creator.trim().is_empty() || manifest.creator.len() > 80 {
        return Err("The costume creator is invalid.".into());
    }
    if manifest.description.len() > 500 || manifest.category.len() > 40 {
        return Err("The costume metadata is too long.".into());
    }
    if store_public_key(&manifest.signature_key_id).is_none() {
        return Err("This costume was signed by an unknown Store key.".into());
    }
    if package_len > MAX_PACKAGE_BYTES || manifest.package_size > MAX_PACKAGE_BYTES {
        return Err("This costume package is larger than MewMuze allows.".into());
    }
    let package_version = Version::parse(&manifest.version)
        .map_err(|_| "The costume version is not valid semantic versioning.".to_string())?;
    let minimum = Version::parse(&manifest.minimum_app_version)
        .map_err(|_| "The minimum app version is invalid.".to_string())?;
    let current = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
    if current < minimum {
        return Err(format!(
            "This costume requires MewMuze {} or later.",
            manifest.minimum_app_version
        ));
    }
    if let Some(maximum_text) = &manifest.maximum_app_version {
        let maximum = Version::parse(maximum_text)
            .map_err(|_| "The maximum app version is invalid.".to_string())?;
        if current > maximum {
            return Err("This costume is not compatible with this version of MewMuze.".into());
        }
    }
    let _ = package_version;
    let approved_bodies = ["classic", "chonk", "fluffy", "siamese", "kitten"];
    if manifest.supported_bodies.is_empty()
        || manifest.supported_bodies.len() > approved_bodies.len()
        || manifest
            .supported_bodies
            .iter()
            .any(|body| !approved_bodies.contains(&body.as_str()))
    {
        return Err("The supported body list is invalid.".into());
    }
    if manifest.assets.is_empty() || manifest.assets.len() > 12 {
        return Err("A costume must contain between 1 and 12 visual layers.".into());
    }
    let mut layers = HashSet::new();
    for asset in &manifest.assets {
        if !valid_relative_path(&asset.path)
            || !asset.path.starts_with("assets/")
            || !matches!(asset.view.as_str(), "front" | "side" | "back" | "all")
            || asset.layer != "overlay"
            || !matches!(asset.variant.as_str(), "base" | "maskOpen" | "eyeGlow")
            || !matches!(
                asset.anchor.as_deref().unwrap_or("sprite"),
                "sprite" | "torso" | "head"
            )
            || !asset.scale.is_finite()
            || !(0.25..=4.0).contains(&asset.scale)
            || !asset.opacity.is_finite()
            || !(0.0..=1.0).contains(&asset.opacity)
            || asset.offset_x.abs() > 512
            || asset.offset_y.abs() > 512
        {
            return Err(format!("The visual layer {} is invalid.", asset.path));
        }
        // Keyed by anchor as well as view+variant. A blazer rides the torso and
        // spectacles ride the head, so both are legitimately "side"/"base";
        // without the anchor in the key the second one is refused as a
        // duplicate. Two layers on the SAME body part are still a mistake.
        if !layers.insert((
            asset.view.as_str(),
            asset.variant.as_str(),
            asset.anchor.as_deref().unwrap_or("sprite"),
        )) {
            return Err(format!(
                "The package contains more than one {} {} visual layer.",
                asset.view, asset.variant
            ));
        }
    }
    for path in [&manifest.thumbnail, &manifest.preview] {
        if !valid_relative_path(path) {
            return Err("The preview path is invalid.".into());
        }
    }
    Ok(())
}

fn verify_package(path: &Path) -> Result<VerifiedPackage, String> {
    if path.extension().and_then(|v| v.to_str()) != Some("mewcostume") {
        return Err("Choose a file ending in .mewcostume.".into());
    }
    let metadata =
        fs::metadata(path).map_err(|_| "MewMuze could not read that package.".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_PACKAGE_BYTES {
        return Err("That package is missing or larger than 20 MB.".into());
    }
    let file = File::open(path).map_err(|e| format!("MewMuze could not open that package: {e}"))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| "That file is not a valid costume archive.".to_string())?;
    if archive.is_empty() || archive.len() > MAX_ENTRIES {
        return Err("The costume archive contains an invalid number of files.".into());
    }
    let mut total = 0u64;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| "MewMuze could not inspect the costume archive.".to_string())?;
        let name = entry.name().to_string();
        if !entry.is_dir() && !valid_relative_path(&name) {
            return Err("The package contains an unsafe file path.".into());
        }
        if !names.insert(name) {
            return Err("The package contains duplicate file names.".into());
        }
        if entry.size() > MAX_FILE_BYTES {
            return Err("A package file exceeds the 5 MB limit.".into());
        }
        total = total.saturating_add(entry.size());
        if total > MAX_UNCOMPRESSED_BYTES {
            return Err("The expanded costume package is too large.".into());
        }
    }

    let manifest_bytes = read_zip_entry(&mut archive, "manifest.json", 128 * 1024)?;
    let manifest: CostumeManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("The costume manifest is invalid: {e}"))?;
    let signature_bytes = read_zip_entry(&mut archive, "signature.ed25519", 1024)?;
    verify_signature(
        &manifest_bytes,
        &signature_bytes,
        "package",
        &manifest.signature_key_id,
    )?;
    validate_manifest(&manifest, metadata.len())?;

    let entitlement_bytes = read_zip_entry(&mut archive, "entitlement.json", 16 * 1024)?;
    let entitlement_signature = read_zip_entry(&mut archive, "entitlement.ed25519", 1024)?;
    verify_signature(
        &entitlement_bytes,
        &entitlement_signature,
        "entitlement",
        &manifest.signature_key_id,
    )?;
    let entitlement: EntitlementReceipt = serde_json::from_slice(&entitlement_bytes)
        .map_err(|_| "The local entitlement receipt is invalid.".to_string())?;
    if entitlement.costume_id != manifest.id
        || entitlement.entitlement_id.trim().is_empty()
        || !matches!(entitlement.mode.as_str(), "mock" | "production")
    {
        return Err("The entitlement does not match this costume.".into());
    }

    let declared: HashSet<&str> = manifest
        .assets
        .iter()
        .map(|asset| asset.path.as_str())
        .chain([manifest.thumbnail.as_str(), manifest.preview.as_str()])
        .collect();
    if manifest.asset_hashes.len() != declared.len()
        || manifest
            .asset_hashes
            .keys()
            .any(|path| !declared.contains(path.as_str()))
    {
        return Err("The asset hash list does not match the declared costume files.".into());
    }
    let allowed_fixed = [
        "manifest.json",
        "signature.ed25519",
        "entitlement.json",
        "entitlement.ed25519",
    ];
    for name in &names {
        if name.ends_with('/') {
            continue;
        }
        if !allowed_fixed.contains(&name.as_str()) && !declared.contains(name.as_str()) {
            return Err(format!("The package contains an unapproved file: {name}"));
        }
    }

    let mut files = BTreeMap::new();
    for asset_path in declared {
        let extension = Path::new(asset_path)
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "webp" | "png") {
            return Err(format!(
                "{asset_path} is not an approved PNG or WebP image."
            ));
        }
        let bytes = read_zip_entry(&mut archive, asset_path, MAX_FILE_BYTES)?;
        let expected = manifest
            .asset_hashes
            .get(asset_path)
            .ok_or_else(|| format!("{asset_path} has no SHA-256 hash."))?;
        if sha256_hex(&bytes) != expected.to_ascii_lowercase() {
            return Err(format!("{asset_path} failed its SHA-256 integrity check."));
        }
        let image = image::load_from_memory(&bytes)
            .map_err(|_| format!("{asset_path} is not a readable image."))?;
        let (width, height) = image.dimensions();
        if width == 0 || height == 0 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
        {
            return Err(format!("{asset_path} has unsupported image dimensions."));
        }
        files.insert(asset_path.to_string(), bytes);
    }
    files.insert("manifest.json".into(), manifest_bytes);
    files.insert("signature.ed25519".into(), signature_bytes);
    files.insert("entitlement.json".into(), entitlement_bytes);
    files.insert("entitlement.ed25519".into(), entitlement_signature);
    Ok(VerifiedPackage {
        manifest,
        entitlement,
        files,
    })
}

fn read_manifest_from_install(path: &Path) -> Result<CostumeManifest, String> {
    let data = fs::read(path.join("manifest.json")).map_err(|e| e.to_string())?;
    serde_json::from_slice(&data).map_err(|e| e.to_string())
}

fn data_url(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let mime = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        _ => return None,
    };
    Some(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

#[tauri::command]
pub fn install_costume_package(app: AppHandle, path: String) -> Result<InstallResult, String> {
    let source = PathBuf::from(path);
    let verified = verify_package(&source)?;
    let mut registry = load_registry(&app);
    if !has_install_capacity(&registry, &verified.manifest.id) {
        return Err(
            "MewMuze keeps at most 5 installed costumes. Delete one in Appearance Studio, then install this costume again."
                .into(),
        );
    }
    let root = costume_root(&app)?;
    let parent = root.join(&verified.manifest.id);
    fs::create_dir_all(&parent)
        .map_err(|e| format!("MewMuze could not prepare the costume folder: {e}"))?;
    let final_dir = parent.join(&verified.manifest.version);
    if final_dir.exists() {
        return Err("This costume version is already installed.".into());
    }
    let stamp = now_unix();
    let temp_dir = root.join(format!(".install-{}-{stamp}", verified.manifest.id));
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir)
            .map_err(|e| format!("MewMuze could not clear an old temporary install: {e}"))?;
    }
    let install_result = (|| -> Result<(), String> {
        fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
        for (relative, bytes) in &verified.files {
            let target = temp_dir.join(relative);
            if let Some(parent_dir) = target.parent() {
                fs::create_dir_all(parent_dir).map_err(|e| e.to_string())?;
            }
            let mut file = File::create(&target).map_err(|e| e.to_string())?;
            file.write_all(bytes).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }
        fs::rename(&temp_dir, &final_dir).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = install_result {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(format!(
            "The costume was not installed. Temporary data was cleaned up: {error}"
        ));
    }

    registry
        .costumes
        .retain(|entry| entry.costume_id != verified.manifest.id);
    registry.costumes.push(InstalledCostume {
        costume_id: verified.manifest.id.clone(),
        version: verified.manifest.version.clone(),
        installation_time: stamp,
        local_package_location: final_dir.to_string_lossy().to_string(),
        signature_status: "verified".into(),
        entitlement_identifier: verified.entitlement.entitlement_id,
        enabled: true,
    });
    if let Err(error) = save_registry(&app, &registry) {
        let _ = fs::remove_dir_all(&final_dir);
        return Err(error);
    }
    let _ = app.emit("costumes-changed", &verified.manifest.id);
    Ok(InstallResult {
        costume_id: verified.manifest.id,
        name: verified.manifest.name,
        version: verified.manifest.version,
        message: "Your new costume is ready.".into(),
    })
}

#[tauri::command]
pub fn list_installed_costumes(app: AppHandle) -> Vec<InstalledCostumeView> {
    load_registry(&app)
        .costumes
        .into_iter()
        .filter_map(|installed| {
            let location = PathBuf::from(&installed.local_package_location);
            let manifest = read_manifest_from_install(&location).ok()?;
            Some(InstalledCostumeView {
                name: manifest.name,
                creator: manifest.creator,
                description: manifest.description,
                supported_bodies: manifest.supported_bodies,
                thumbnail_data_url: data_url(&location.join(manifest.thumbnail)),
                installed,
            })
        })
        .collect()
}

#[tauri::command]
pub fn get_costume_visuals(app: AppHandle, costume_id: String) -> Result<CostumeVisuals, String> {
    let registry = load_registry(&app);
    let installed = registry
        .costumes
        .iter()
        .find(|entry| entry.costume_id == costume_id && entry.enabled)
        .ok_or_else(|| "That costume is not installed or is disabled.".to_string())?;
    let location = PathBuf::from(&installed.local_package_location);
    let manifest = read_manifest_from_install(&location)?;
    let mut views: BTreeMap<String, Vec<CostumeVisualLayer>> = BTreeMap::new();
    for asset in &manifest.assets {
        let url = data_url(&location.join(&asset.path))
            .ok_or_else(|| format!("MewMuze could not load {}.", asset.path))?;
        views
            .entry(asset.view.clone())
            .or_default()
            .push(CostumeVisualLayer {
                data_url: url,
                variant: asset.variant.clone(),
                // A v1 package has no anchors, so its art stays pinned to the
                // frame exactly as it was before this feature existed.
                anchor: asset.anchor.clone().unwrap_or_else(|| "sprite".to_string()),
                offset_x: asset.offset_x,
                offset_y: asset.offset_y,
                scale: asset.scale,
                opacity: asset.opacity,
            });
    }
    Ok(CostumeVisuals {
        costume_id,
        supported_bodies: manifest.supported_bodies,
        views,
        anchor: manifest.anchor,
    })
}

#[tauri::command]
pub fn set_costume_enabled(
    app: AppHandle,
    costume_id: String,
    enabled: bool,
) -> Result<(), String> {
    let mut registry = load_registry(&app);
    let entry = registry
        .costumes
        .iter_mut()
        .find(|entry| entry.costume_id == costume_id)
        .ok_or_else(|| "That costume is not installed.".to_string())?;
    entry.enabled = enabled;
    save_registry(&app, &registry)?;
    let _ = app.emit("costumes-changed", costume_id);
    Ok(())
}

#[tauri::command]
pub fn uninstall_costume(app: AppHandle, costume_id: String) -> Result<(), String> {
    let root = costume_root(&app)?;
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut registry = load_registry(&app);
    let index = registry
        .costumes
        .iter()
        .position(|entry| entry.costume_id == costume_id)
        .ok_or_else(|| "That costume is not installed.".to_string())?;
    let location = PathBuf::from(&registry.costumes[index].local_package_location);
    let canonical_location = location
        .canonicalize()
        .map_err(|_| "The installed costume folder is missing.".to_string())?;
    if !canonical_location.starts_with(&canonical_root) || canonical_location == canonical_root {
        return Err("MewMuze refused to remove a folder outside its costume directory.".into());
    }
    fs::remove_dir_all(&canonical_location)
        .map_err(|e| format!("MewMuze could not remove that costume: {e}"))?;
    registry.costumes.remove(index);
    save_registry(&app, &registry)?;
    let _ = app.emit("costumes-changed", costume_id);
    Ok(())
}

fn mock_product_name(product_id: &str) -> String {
    product_id
        .split('-')
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn validate_mock_token(token: &str) -> Result<(String, u64), String> {
    if token.len() < 20
        || token.len() > 300
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err("The installation token has an invalid format.".into());
    }
    let parts: Vec<&str> = token.split('_').collect();
    if parts.len() != 4 || parts[0] != "mock" || !valid_id(&format!("mewmuze.{}", parts[1])) {
        return Err("The installation token is not recognized.".into());
    }
    let expires = parts[2]
        .parse::<u64>()
        .map_err(|_| "The installation token expiry is invalid.".to_string())?;
    let now = now_unix();
    if expires < now {
        return Err(
            "This installation token has expired. Request a new one from the Store.".into(),
        );
    }
    if expires > now + 30 * 60 {
        return Err("The installation token expiry is outside the allowed window.".into());
    }
    if parts[3].len() < 8 {
        return Err("The installation token nonce is invalid.".into());
    }
    Ok((parts[1].to_string(), expires))
}

fn request_from_arg(arg: &str) -> Option<PendingInstallRequest> {
    if let Some(token) = arg.strip_prefix("mewmuze://install-costume?token=") {
        let (product_id, _) = validate_mock_token(token).ok()?;
        return Some(PendingInstallRequest {
            kind: "token".into(),
            source: "MewMuze Store".into(),
            token: Some(token.to_string()),
            package_path: None,
            product_id: Some(product_id.clone()),
            costume_name: mock_product_name(&product_id),
            creator: "MewMuze Studio".into(),
            version: "Mock preview".into(),
            package_size: 0,
            minimum_app_version: env!("CARGO_PKG_VERSION").into(),
            preview_data_url: None,
        });
    }
    let path = PathBuf::from(arg);
    let verified = verify_package(&path).ok()?;
    let preview_data_url = verified.files.get(&verified.manifest.preview).map(|bytes| {
        let mime = if verified.manifest.preview.ends_with(".webp") {
            "image/webp"
        } else {
            "image/png"
        };
        format!("data:{mime};base64,{}", BASE64.encode(bytes))
    });
    Some(PendingInstallRequest {
        kind: "package".into(),
        source: "Downloaded .mewcostume package".into(),
        token: None,
        package_path: Some(path.to_string_lossy().to_string()),
        product_id: Some(verified.manifest.id.clone()),
        costume_name: verified.manifest.name,
        creator: verified.manifest.creator,
        version: verified.manifest.version,
        package_size: fs::metadata(path).map(|m| m.len()).unwrap_or_default(),
        minimum_app_version: verified.manifest.minimum_app_version,
        preview_data_url,
    })
}

pub fn queue_launch_args(app: &AppHandle, args: &[String]) {
    let request = args.iter().skip(1).find_map(|arg| request_from_arg(arg));
    if let Some(request) = request {
        if let Ok(mut pending) = app.state::<CostumeRequestState>().pending.lock() {
            *pending = Some(request.clone());
        }
        let _ = app.emit("costume-install-request", request);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
        }
    }
}

#[tauri::command]
pub fn get_pending_costume_request(app: AppHandle) -> Option<PendingInstallRequest> {
    app.state::<CostumeRequestState>()
        .pending
        .lock()
        .ok()
        .and_then(|pending| pending.clone())
}

#[tauri::command]
pub fn clear_pending_costume_request(app: AppHandle) {
    if let Ok(mut pending) = app.state::<CostumeRequestState>().pending.lock() {
        *pending = None;
    }
}

#[tauri::command]
pub fn confirm_install_token(app: AppHandle, token: String) -> Result<String, String> {
    let (product_id, _) = validate_mock_token(&token)?;
    let state = app.state::<CostumeRequestState>();
    let mut consumed = state
        .consumed_tokens
        .lock()
        .map_err(|_| "MewMuze could not access its token state.".to_string())?;
    if !consumed.insert(token) {
        return Err("This installation token has already been used.".into());
    }
    Ok(format!(
        "{} is a mock purchase. Download its signed .mewcostume package when the Store backend is connected.",
        mock_product_name(&product_id)
    ))
}

#[tauri::command]
pub fn open_mewmuze_store() -> Result<(), String> {
    crate::clipboard::open_clipboard_link(STORE_URL.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal_and_executable_paths() {
        assert!(!valid_relative_path("../evil.dll"));
        assert!(!valid_relative_path("assets\\evil.webp"));
        assert!(!valid_relative_path("C:/evil.webp"));
        assert!(valid_relative_path("assets/body-front.webp"));
    }

    #[test]
    fn costume_ids_are_strict_and_portable() {
        assert!(valid_id("mewmuze.space-explorer.v1"));
        assert!(!valid_id("MewMuze Space Explorer"));
        assert!(!valid_id("../../escape"));
    }

    #[test]
    fn expired_and_malformed_tokens_are_rejected() {
        assert!(validate_mock_token("https://example.com/file").is_err());
        assert!(validate_mock_token("mock_space-explorer_1_abcdefgh").is_err());
    }

    #[test]
    fn limits_installed_costumes_to_five_but_allows_replacement() {
        let costumes = (0..MAX_INSTALLED_COSTUMES)
            .map(|index| InstalledCostume {
                costume_id: format!("mewmuze.test-{index}"),
                version: "1.0.0".into(),
                installation_time: 0,
                local_package_location: String::new(),
                signature_status: "verified".into(),
                entitlement_identifier: format!("test-{index}"),
                enabled: true,
            })
            .collect();
        let registry = CostumeRegistry { costumes };
        assert!(!has_install_capacity(&registry, "mewmuze.sixth"));
        assert!(has_install_capacity(&registry, "mewmuze.test-3"));
    }

    /// A costume is often several garments at once. The uniqueness rule used to
    /// key on (view, variant) alone, which refused a jacket and a pair of
    /// spectacles on the same view - the exact shape of the first real costume.
    #[test]
    fn accepts_one_layer_per_body_part_and_still_rejects_duplicates() {
        let asset = |path: &str, view: &str, anchor: &str| CostumeAsset {
            path: path.to_string(),
            view: view.to_string(),
            layer: "overlay".to_string(),
            variant: "base".to_string(),
            anchor: Some(anchor.to_string()),
            offset_x: 0,
            offset_y: 0,
            scale: 1.0,
            opacity: 1.0,
        };
        let base = |assets: Vec<CostumeAsset>| {
            let mut hashes = BTreeMap::new();
            for a in &assets {
                hashes.insert(a.path.clone(), "x".repeat(64));
            }
            hashes.insert("thumbnail.png".to_string(), "x".repeat(64));
            hashes.insert("preview.png".to_string(), "x".repeat(64));
            CostumeManifest {
                schema_version: 1,
                id: "mewmuze.test.v1".to_string(),
                name: "Test".to_string(),
                version: "1.0.0".to_string(),
                creator: "Test".to_string(),
                description: String::new(),
                category: "test".to_string(),
                supported_bodies: vec!["classic".to_string()],
                minimum_app_version: "0.1.0".to_string(),
                maximum_app_version: None,
                thumbnail: "thumbnail.png".to_string(),
                preview: "preview.png".to_string(),
                assets,
                asset_hashes: hashes,
                package_size: 0,
                license_id: "test".to_string(),
                signature_key_id: STORE_KEY_ID.to_string(),
                anchor: None,
            }
        };

        // A jacket on the torso and specs on the head: allowed.
        let ok = base(vec![
            asset("assets/blazer-side.png", "side", "torso"),
            asset("assets/specs-side.png", "side", "head"),
        ]);
        assert!(validate_manifest(&ok, 1024).is_ok());

        // Two things on the SAME body part is still a packaging mistake.
        let clash = base(vec![
            asset("assets/a.png", "side", "torso"),
            asset("assets/b.png", "side", "torso"),
        ]);
        assert!(validate_manifest(&clash, 1024).is_err());

        // An unknown anchor must be refused rather than silently ignored.
        let bogus = base(vec![asset("assets/a.png", "side", "elbow")]);
        assert!(validate_manifest(&bogus, 1024).is_err());
    }

    #[test]
    fn verifies_the_signed_original_sample_package() {
        let package = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("space-explorer-sample.mewcostume");
        let verified = verify_package(&package).expect("signed sample package should verify");
        assert_eq!(verified.manifest.id, "mewmuze.space-explorer.sample");
        assert_eq!(verified.entitlement.mode, "mock");
        assert_eq!(verified.manifest.assets.len(), 3);
    }

    #[test]
    fn verifies_the_signed_iron_man_cat_package_and_animation_layers() {
        let package = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("iron-man-cat.mewcostume");
        let verified = verify_package(&package).expect("signed Iron Man Cat package should verify");
        assert_eq!(verified.manifest.id, "mewmuze.iron-man-cat.v1");
        assert_eq!(verified.manifest.version, "1.0.1");
        assert_eq!(verified.manifest.signature_key_id, MECHA_V2_KEY_ID);
        assert_eq!(verified.manifest.assets.len(), 7);
        assert!(verified
            .manifest
            .assets
            .iter()
            .any(|asset| asset.variant == "maskOpen"));
        assert!(verified
            .manifest
            .assets
            .iter()
            .any(|asset| asset.variant == "eyeGlow"));
    }

    #[test]
    fn rejects_tampered_signatures_and_oversized_manifests() {
        assert!(verify_signature(b"tampered", b"AAAAAAAA", "package", STORE_KEY_ID).is_err());
        let package = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("space-explorer-sample.mewcostume");
        let mut verified = verify_package(&package).expect("sample should verify before mutation");
        verified.manifest.package_size = MAX_PACKAGE_BYTES + 1;
        assert!(validate_manifest(&verified.manifest, 1).is_err());
    }
}
