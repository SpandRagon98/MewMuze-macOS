import { describe, it, expect } from "vitest";
// @ts-expect-error no @types/node, and Vite's ?raw loader cannot help here:
// vitest stubs stylesheets, so ui.css?raw and ?inline both come back empty.
import { readFileSync, existsSync } from "node:fs";

// Paths are relative to the project root, which is vitest's working directory.
const css: string = readFileSync("src/components/ui.css", "utf8");

/**
 * Typography guards.
 *
 * jsdom does not apply stylesheets, so the resolved font of a rendered element
 * cannot be asserted here — that was verified in a browser. What these do
 * protect is the *rule*: the UI surfaces share one bundled typeface, and the
 * cat's retro dialogue (notices, notes, chips) deliberately does not. Both are
 * easy to break with a well-meaning tidy-up of the CSS.
 */
/** The declaration block for a top-level selector, up to its closing brace. */
function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `selector ${selector} not found`).toBeGreaterThan(-1);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}

describe("typography", () => {
  it("bundles the typeface instead of naming one that may not exist", () => {
    // Naming a font without shipping it is how this UI spent months asking for
    // Inter and silently rendering Segoe UI on every machine.
    expect(css).toContain("@font-face");
    expect(css).toContain('font-family: "Nunito"');
    for (const file of ["nunito-latin.woff2", "nunito-latin-ext.woff2"]) {
      expect(css, `${file} referenced`).toContain(file);
      expect(
        existsSync(`src/assets/fonts/${file}`) as boolean,
        `${file} actually shipped`,
      ).toBe(true);
    }
  });

  it("serves the font token from the root so every surface resolves it", () => {
    // Scoped to a handful of panel classes, anything outside that list got an
    // invalid value and fell back to the browser default serif.
    const root = block(":root");
    expect(root).toContain("--sk-font");
    expect(root).toContain("Nunito");
  });

  it("uses the shared token for the app's panels and menus", () => {
    for (const selector of [".pixel-ui", ".cat-menu", ".quick-tools", ".sk-panel"]) {
      expect(block(selector), `${selector} uses the token`).toContain("font-family: var(--sk-font)");
    }
  });

  it("leaves every notification on the retro monospace face", () => {
    // Deliberate product decision: the cat's dialogue is pixel-retro, the app's
    // chrome is not. Changing these would make the notices look like the
    // settings panel, which is exactly what was asked NOT to happen.
    for (const selector of [".retro-notice", ".cat-note", ".pomo-chip", ".session-timer", ".break-picker"]) {
      expect(block(selector), `${selector} stays monospace`).toContain('"Courier New"');
      expect(block(selector), `${selector} must not take the UI font`).not.toContain("var(--sk-font)");
    }
  });

  it("makes form controls inherit the font instead of the browser's", () => {
    // Buttons, selects and inputs take their font-family from the user-agent
    // stylesheet, not from their container. The settings sidebar tabs are
    // <button>s and rendered in the system font for exactly this reason, next
    // to a panel that did not. One rule covers every control, present and
    // future — the alternative is remembering `font-family: inherit` forever.
    const controls = block("button,\ninput,\nselect,\ntextarea,\noptgroup");
    expect(controls).toContain("font-family: inherit");
  });

  it("gives the document itself a default face", () => {
    // Without this, anything inheriting rather than declaring would land on
    // the browser's default serif once controls started inheriting.
    expect(block("html,\nbody")).toContain("font-family: var(--sk-font)");
  });

  it("keeps the stacked mail cards matching the notice they belong to", () => {
    // .mail-card inherits .retro-notice's face; it must not set its own.
    expect(block(".mail-card")).not.toContain("font-family: var(--sk-font)");
  });
});
