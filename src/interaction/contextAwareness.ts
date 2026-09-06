/**
 * Privacy-safe application-context categorisation.
 *
 * Input is ONLY the lowercase executable basename of the foreground process
 * (e.g. "winword.exe") supplied by the native layer — never window titles or
 * contents. The category picks which companion animation theme plays.
 *
 * macOS reports the application's owner NAME instead of an exe basename
 * ("code", "safari", "terminal"), so each set carries both spellings. Adding
 * the macOS names is purely additive: the Windows entries are untouched.
 */

export type AppCategory = "writing" | "coding" | "browser" | "other";

const WRITING = new Set([
  "winword.exe",
  "notepad.exe",
  "notepad++.exe",
  "onenote.exe",
  "onenoteim.exe",
  "wordpad.exe",
  "obsidian.exe",
  "notion.exe",
  "typora.exe",
  // macOS
  "microsoft word",
  "textedit",
  "notes",
  "pages",
  "obsidian",
  "notion",
  "typora",
  "bear",
  "ulysses",
  "scrivener",
]);

const CODING = new Set([
  "code.exe",
  "code - insiders.exe",
  "cursor.exe",
  "devenv.exe",
  "windowsterminal.exe",
  "wt.exe",
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "idea64.exe",
  "pycharm64.exe",
  "webstorm64.exe",
  "rider64.exe",
  "clion64.exe",
  "sublime_text.exe",
  "zed.exe",
  "neovide.exe",
  // macOS
  "code",
  "code - insiders",
  "cursor",
  "xcode",
  "terminal",
  "iterm2",
  "warp",
  "ghostty",
  "alacritty",
  "kitty",
  "intellij idea",
  "pycharm",
  "webstorm",
  "rider",
  "clion",
  "goland",
  "sublime text",
  "zed",
  "neovide",
  "android studio",
]);

const BROWSERS = new Set([
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "brave.exe",
  "opera.exe",
  "vivaldi.exe",
  "arc.exe",
  // macOS
  "safari",
  "google chrome",
  "google chrome canary",
  "microsoft edge",
  "firefox",
  "brave browser",
  "opera",
  "vivaldi",
  "arc",
  "orion",
  "zen",
]);

export function categorizeApp(exe: string | null | undefined): AppCategory {
  if (!exe) return "other";
  const name = exe.toLowerCase();
  if (WRITING.has(name)) return "writing";
  if (CODING.has(name)) return "coding";
  if (BROWSERS.has(name)) return "browser";
  return "other";
}

/** A friendly, local-only description used by "Explain this screen". */
export function describeContext(exe: string | null, category: AppCategory, mediaPlaying: boolean): string {
  const app = exe ? exe.replace(/\.exe$/, "") : "your desktop";
  const base =
    category === "writing"
      ? `You're in ${app} — writing time! I'll take notes with you. ✍️`
      : category === "coding"
        ? `You're in ${app} — looks like coding. I've got my glasses on. 🤓`
        : category === "browser"
          ? `You're browsing in ${app}. Scroll slowly and I'll read along. 📖`
          : `You're using ${app} right now.`;
  return mediaPlaying ? `${base} And something's playing — nice beat! 🎵` : base;
}
