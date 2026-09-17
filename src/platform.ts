//! Which desktop this is, for the few words and defaults that differ.

export const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");

/** Where API keys and licences are kept, in the platform's own words. */
export const VAULT_NAME = IS_MAC ? "the macOS Keychain" : "Windows Credential Manager";
