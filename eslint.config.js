import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", ".shipgate/**", "src/policies/cleanroom/**/*.mjs"]
  },
  ...tseslint.configs.recommended
);
