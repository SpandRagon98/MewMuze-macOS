//! Chat through the user's OWN OpenAI or Anthropic key (Paper build).
//!
//! The key lives in the OS credential vault (Windows Credential Manager /
//! macOS Keychain) and never comes back out to the webview: the frontend can
//! store, remove and ask "is there one?", and it names a provider plus one of a
//! few fixed paths - this module owns the host and adds the key header itself.
//! So a compromised page can neither read the key nor send it anywhere else.
//! Nothing here logs a request, a response or the key.

use keyring::{Entry, Error as KeyringError};
use serde::Serialize;
use std::io::Read;
use std::time::Duration;

const KEYRING_SERVICE: &str = "com.spandan.pixelcat.paper";
const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_BODY: u64 = 1024 * 1024;

struct Provider {
    host: &'static str,
    account: &'static str,
    paths: &'static [&'static str],
}

fn provider(id: &str) -> Option<Provider> {
    Some(match id {
        "openai" => Provider { host: "https://api.openai.com", account: "openai-api-key", paths: &["/v1/responses", "/v1/models"] },
        "anthropic" => Provider { host: "https://api.anthropic.com", account: "anthropic-api-key", paths: &["/v1/messages", "/v1/models"] },
        _ => return None,
    })
}

fn entry(p: &Provider) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, p.account).map_err(|e| format!("The system credential vault is unavailable: {e}"))
}

/// A pasted key: printable ASCII, no spaces, a plausible length. Anything else
/// is a paste accident (a whole sentence, a newline) and is refused up front.
fn plausible_key(key: &str) -> bool {
    (20..=400).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_graphic())
}

#[tauri::command]
pub fn provider_key_set(provider_id: String, key: String) -> Result<(), String> {
    let p = provider(&provider_id).ok_or("Unknown provider.")?;
    let key = key.trim();
    if !plausible_key(key) {
        return Err("That doesn't look like an API key.".into());
    }
    entry(&p)?.set_password(key).map_err(|e| format!("Could not save the key: {e}"))
}

#[tauri::command]
pub fn provider_key_status(provider_id: String) -> Result<bool, String> {
    let p = provider(&provider_id).ok_or("Unknown provider.")?;
    match entry(&p)?.get_password() {
        Ok(_) => Ok(true),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(e) => Err(format!("Could not read the credential vault: {e}")),
    }
}

#[tauri::command]
pub fn provider_key_remove(provider_id: String) -> Result<(), String> {
    let p = provider(&provider_id).ok_or("Unknown provider.")?;
    match entry(&p)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not remove the key: {e}")),
    }
}

/// The provider's answer, whatever the status: the frontend turns non-2xx
/// bodies into plain-language messages. `Err` is only for "never got one".
#[derive(Serialize)]
pub struct ProviderResponse {
    status: u16,
    body: String,
}

/// POST `body` (or GET without one) to one of the provider's fixed paths.
#[tauri::command]
pub async fn provider_request(provider_id: String, path: String, body: Option<String>) -> Result<ProviderResponse, String> {
    let p = provider(&provider_id).ok_or("Unknown provider.")?;
    if !p.paths.contains(&path.as_str()) {
        return Err("Refused: unexpected request path.".into());
    }
    let key = match entry(&p)?.get_password() {
        Ok(k) => k,
        Err(KeyringError::NoEntry) => return Err("no-key".into()),
        Err(e) => return Err(format!("Could not read the credential vault: {e}")),
    };
    let url = format!("{}{}", p.host, path);
    let anthropic = provider_id == "anthropic";
    tauri::async_runtime::spawn_blocking(move || {
        // No redirects: the key header must never follow a response to another host.
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout(TIMEOUT).redirects(0).build();
        let req = match body {
            Some(_) => agent.post(&url).set("Content-Type", "application/json"),
            None => agent.get(&url),
        };
        let req = if anthropic {
            req.set("x-api-key", &key).set("anthropic-version", "2023-06-01")
        } else {
            req.set("Authorization", &format!("Bearer {key}"))
        };
        let sent = match &body {
            Some(b) => req.send_string(b),
            None => req.call(),
        };
        let resp = match sent {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            // A transport error never contains the key; say only what kind it was.
            Err(ureq::Error::Transport(t)) => return Err(format!("network: {}", t.kind())),
        };
        let status = resp.status();
        let mut buf = Vec::new();
        resp.into_reader().take(MAX_BODY).read_to_end(&mut buf).map_err(|e| format!("network: {}", e.kind()))?;
        Ok(ProviderResponse { status, body: String::from_utf8_lossy(&buf).into_owned() })
    })
    .await
    .map_err(|_| "The request could not run.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_two_providers_and_their_fixed_paths() {
        assert!(provider("openai").is_some() && provider("anthropic").is_some());
        assert!(provider("evil").is_none());
        let o = provider("openai").unwrap();
        assert_eq!(o.host, "https://api.openai.com");
        assert!(o.paths.contains(&"/v1/responses") && !o.paths.contains(&"/v1/messages"));
        let a = provider("anthropic").unwrap();
        assert_eq!(a.host, "https://api.anthropic.com");
        assert!(a.paths.contains(&"/v1/messages") && !a.paths.contains(&"/v1/files"));
    }

    #[test]
    fn a_path_off_the_list_is_refused_before_the_vault_is_touched() {
        let r = tauri::async_runtime::block_on(provider_request("openai".into(), "/v1/../admin".into(), None));
        assert_eq!(r.err().as_deref(), Some("Refused: unexpected request path."));
        let r = tauri::async_runtime::block_on(provider_request("google".into(), "/v1/models".into(), None));
        assert!(r.is_err());
    }

    #[test]
    fn keys_must_look_like_keys() {
        assert!(plausible_key("sk-proj-abcdefghijklmnopqrstuvwxyz0123"));
        assert!(plausible_key("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"));
        assert!(!plausible_key("short"));
        assert!(!plausible_key("sk-proj-abc def ghi jkl mno pqr stu vwx"));
        assert!(!plausible_key("sk-proj-abcdefghijklmnopqrstu\nvwxyz"));
    }
}
