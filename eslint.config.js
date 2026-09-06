import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "site-dist", "src-tauri/target", "node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    // `site/` holds the landing page, which imports the app's sprite renderer.
    files: ["src/**/*.{ts,tsx}", "site/**/*.ts"],
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
