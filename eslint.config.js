const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

const globals = require("globals");

module.exports = tseslint.config(
  {
    ignores: ["dist", "node_modules", "eslint.config.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "public/**/*.js"],
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        LightweightCharts: "readonly",
      },
    },
  }
);
