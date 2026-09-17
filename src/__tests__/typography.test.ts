import { describe, it, expect } from "vitest";
// @ts-expect-error no @types/node, and Vite's ?raw loader cannot help here:
// vitest stubs stylesheets, so ui.css?raw and ?inline both come back empty.
import { readFileSync, existsSync } from "node:fs";

// Paths are relative to the project root, which is vitest's working directory.
const css: string = readFileSync("src/components/ui.css", "utf8");
const allCss: string = css + readFileSync("src/components/calctime.css", "utf8") + readFileSync("src/clipboard-assistant/clipboard.css", "utf8");

/**
 * Typography guards.
 *
 * jsdom does not apply stylesheets, so the resolved font of a rendered element
 * cannot be asserted here - that was verified in the real app. What these do
 * protect is the rule: one bundled typeface, Montserrat, on every surface -
 * menu, notices, panels and Settings alike - and a type scale with nothing
 * too small to read. Both are easy to break with a well-meaning CSS tidy-up.
 */
/** The declaration block for a top-level selector, up to its closing brace. */
function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `selector ${selector} not found`).toBeGreaterThan(-1);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}

describe("typography", () => {
  it("bundles Montserrat instead of naming a font that may not exist", () => {
    // Naming a font without shipping it is how this UI once spent months
    // asking for Inter and silently rendering Segoe UI on every machine.
    expect(css).toContain("@font-face");
    expect(css).toContain('font-family: "Montserrat"');
    for (const file of ["montserrat-latin.woff2", "montserrat-latin-ext.woff2"]) {
      expect(css, `${file} referenced`).toContain(file);
      expect(existsSync(`src/assets/fonts/${file}`) as boolean, `${file} actually shipped`).toBe(true);
    }
    // The previous face is gone, not left half-referenced.
    expect(allCss).not.toContain("Nunito");
  });

  it("serves the font token from the root so every surface resolves it", () => {
    // The dark token set is shared with the art that stays dark in the light theme.
    const root = block(":root,\n.mm-keep-dark,\n.mm-preview-stage");
    expect(root).toContain("--mm-font:");
    expect(root).toContain("Montserrat");
    // Devanagari (Hindi chat) falls through to a Windows font, not a box.
    expect(root).toContain("Nirmala UI");
  });

  it("puts every surface on the one typeface - the cat's notices included", () => {
    for (const selector of [".pixel-ui", ".mm-menu", ".quick-tools", ".mm-settings", ".retro-notice", ".cat-note", ".pomo-chip", ".session-timer", ".break-picker"]) {
      expect(block(selector), `${selector} uses the token`).toContain("font-family: var(--mm-font)");
      expect(block(selector), `${selector} has left the retro face`).not.toContain("Courier");
    }
  });

  it("makes form controls inherit the font instead of the browser's", () => {
    // Buttons, selects and inputs take their font-family from the user-agent
    // stylesheet, not from their container. One rule covers every control.
    const controls = block("button,\ninput,\nselect,\ntextarea,\noptgroup");
    expect(controls).toContain("font-family: inherit");
  });

  it("gives the document itself a default face", () => {
    expect(block("html,\nbody")).toContain("font-family: var(--mm-font)");
  });

  it("keeps the stacked mail cards matching the notice they belong to", () => {
    // .mail-card inherits .retro-notice's face; it must not set its own.
    expect(block(".mail-card")).not.toContain("font-family");
  });

  it("has no label smaller than 10.5 px anywhere", () => {
    // "No tiny unreadable labels": every literal font size in the stylesheets.
    const sizes = [...allCss.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(20);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10.5);
  });

  it("uses three weights, no more", () => {
    // Single weights only: the @font-face "100 900" is the variable file's range.
    const weights = new Set([...allCss.matchAll(/font-weight:\s*(\d{3});/g)].map((m) => m[1]));
    expect([...weights].sort()).toEqual(["400", "500", "600"]);
  });
});
