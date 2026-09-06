import { describe, it, expect } from "vitest";
import { categorizeApp, describeContext } from "../interaction/contextAwareness";

describe("contextAwareness", () => {
  it("categorises writing, coding, and browser apps by exe name only", () => {
    expect(categorizeApp("winword.exe")).toBe("writing");
    expect(categorizeApp("NOTEPAD.EXE")).toBe("writing");
    expect(categorizeApp("code.exe")).toBe("coding");
    expect(categorizeApp("windowsterminal.exe")).toBe("coding");
    expect(categorizeApp("chrome.exe")).toBe("browser");
    expect(categorizeApp("explorer.exe")).toBe("other");
    expect(categorizeApp(null)).toBe("other");
  });

  it("categorises macOS owner names, which carry no .exe suffix", () => {
    // macOS reports the application name, so a Windows-only table would
    // silently return "other" for everything and kill the context reactions.
    expect(categorizeApp("Microsoft Word")).toBe("writing");
    expect(categorizeApp("Notes")).toBe("writing");
    expect(categorizeApp("Code")).toBe("coding");
    expect(categorizeApp("iTerm2")).toBe("coding");
    expect(categorizeApp("Xcode")).toBe("coding");
    expect(categorizeApp("Safari")).toBe("browser");
    expect(categorizeApp("Google Chrome")).toBe("browser");
    expect(categorizeApp("Finder")).toBe("other");
  });

  it("describes context without ever needing screen content", () => {
    const text = describeContext("code.exe", "coding", false);
    expect(text).toContain("code");
    expect(describeContext("spotify.exe", "other", true)).toContain("🎵");
  });
});
