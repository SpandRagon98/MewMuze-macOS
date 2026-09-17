import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // site/hero-video is its own Remotion project (own package.json, tsconfig and typecheck).
  { ignores: ["dist", "site-dist", "src-tauri/target", "node_modules", "site/hero-video"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    // `site/` holds the landing page, which imports the app's sprite renderer.
    // `bench/` (Paper) holds the companion cost benchmark.
    files: ["src/**/*.{ts,tsx}", "site/**/*.ts", "bench/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2021,
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
