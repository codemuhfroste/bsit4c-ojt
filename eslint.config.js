import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "uploads/", "coverage/"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "api/**/*.js", "test/**/*.js", "scripts/**/*.js", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
  { files: ["public/**/*.js"], languageOptions: { globals: globals.browser } },
];
