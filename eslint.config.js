import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", ".shipgate/**"]
  },
  ...tseslint.configs.recommended,
  {
    // Ported Cleanroom .mjs files stay lint-exempt except the zero-exit rule
    // below (spec section 2.2 rule 1: the one rule that applies to the
    // otherwise lint-exempt subtree).
    files: ["src/policies/cleanroom/**/*.mjs"],
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": "off",
      "no-useless-escape": "off",
      "prefer-const": "off"
    }
  },
  {
    files: ["src/policies/**/*.ts", "src/policies/**/*.mjs"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='process'][callee.property.name='exit']",
          message: "src/policies must return { exitCode } and never call process.exit (spec section 2.2)."
        }
      ]
    }
  }
);
