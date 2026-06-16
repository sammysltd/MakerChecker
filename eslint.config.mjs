import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/.turbo/**", "**/node_modules/**"],
  },
  ...tseslint.configs.recommended,
  // SAST (Layer 1): eslint-plugin-security recommended ruleset. The recommended
  // config registers the plugin and sets every rule to "warn"; below we promote
  // the high-signal rules to errors and turn off the one notoriously noisy rule.
  security.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],

      // High-signal security rules: real RCE / path-traversal / SSRF / ReDoS /
      // weak-randomness sinks. Promoted from the recommended "warn" to "error"
      // so they block CI (lint is part of the green gate).
      "security/detect-child-process": "error",
      "security/detect-non-literal-fs-filename": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-non-literal-require": "error",
      "security/detect-unsafe-regex": "error",
      "security/detect-pseudoRandomBytes": "error",
      "security/detect-buffer-noassert": "error",

      // detect-object-injection fires on nearly every obj[key] access and is
      // almost all false positives (it cannot tell a typed/validated key from an
      // attacker-controlled one). Turned off deliberately to keep the signal high.
      "security/detect-object-injection": "off",
    },
  },
  {
    // Tests write fixtures to OS temp dirs with computed paths; they are not a
    // production attack surface, so the non-literal-fs-filename sink is noise here.
    files: ["**/*.test.ts"],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },
);
