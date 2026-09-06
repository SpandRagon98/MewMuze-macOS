import { defineConfig } from "vite";

/**
 * Builds the marketing site in `site/` into `site-dist/`, ready to drop on
 * GitHub Pages, Netlify or Cloudflare Pages.
 *
 * It deliberately imports the real sprite renderer from `src/`, so the live
 * hero cat always matches the shipping app.
 *
 *   npm run site:dev     # preview locally
 *   npm run site:build   # emit site-dist/
 */
export default defineConfig({
  root: "site",
  base: "./",
  build: { outDir: "../site-dist", emptyOutDir: true, target: "es2020" },
});
