// SPDX-License-Identifier: AGPL-3.0-or-later
export const DEFAULT_CONFIG = {
  version: 1,
  defaultBranches: ["main", "master"],
  sourceRoots: ["src", "app", "lib", "packages"],
  scriptRoots: ["scripts", "tools", "bin"],
  entrypoints: [
    "src/index.ts", "src/index.tsx", "src/index.js", "src/index.mjs",
    "app/page.tsx", "app/layout.tsx", "index.ts", "index.js"
  ],
  ignore: [
    ".git", "node_modules", "dist", "build", ".next", "coverage", ".turbo",
    ".cache", "vendor", "target", ".greenroom"
  ],
  ignorePatterns: [
    "**/*.min.js", "**/*.min.css", "**/*.generated.*", "**/__snapshots__/**"
  ],
  maxFileBytes: 1048576,
  rules: {
    suspiciousFilenames: true,
    duplicateFiles: true,
    duplicateBlocks: true,
    dependencyCycles: true,
    unreachableSourceFiles: false,
    scriptChains: true,
    scriptJunkDrawer: true,
    rawDesignValues: true,
    canonicalRegistry: true,
    trivialWrappers: true,
    strandedFeatures: true,
    competingResponsibilities: true,
    generatedArtifacts: true,
    unownedScripts: false,
    managedFiles: true
  },
  duplicateBlocks: {
    minLines: 8,
    minOccurrences: 2,
    ignorePatterns: ["**/*.test.*", "**/*.spec.*"]
  },
  naming: {
    allow: []
  },
  architecture: {
    allowTrivialWrappers: [],
    testPatterns: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "test/**", "tests/**"],
    excludeFromStranded: ["**/*.d.ts", "**/index.*"]
  },
  design: {
    roots: ["src", "app"],
    tokenFiles: [
      "src/styles/tokens.css", "src/design/tokens.css", "src/styles/theme.css",
      "app/globals.css"
    ],
    allow: [],
    forbidRawColors: true,
    forbidRawRadius: true,
    forbidRawSpacing: true,
    forbidRawTypography: true,
    forbidImportant: true
  },
  scripts: {
    allowScriptImports: [],
    allowPackageChains: [],
    allowLifecycleHooks: true,
    requireOwnership: false
  },
  providers: {
    fallow: { enabled: true, command: "", timeoutMs: 120000 },
    knip: { enabled: false, command: "", timeoutMs: 120000 },
    projectNative: { enabled: true, directory: ".greenroom/evidence" }
  },
  budgets: {},
  managed: {
    skillFile: ".greenroom/skills/repo-hygiene/SKILL.md",
    workflowFile: ".github/workflows/green-room.yml",
    requireSkill: true,
    requireWorkflow: true,
    enforceAgentBlockExact: true,
    enforceSkillExact: true,
    enforceWorkflowExact: true
  },
  registryFile: ".greenroom/registry.json",
  generatedFile: ".greenroom/generated.json",
  baselineFile: ".greenroom/baseline.json",
  waiversFile: ".greenroom/waivers.json",
  generatedAgentFiles: ["AGENTS.md", "CLAUDE.md"],
  distribution: {
    installCommand: "npm install --no-save github:AVANT-ICONIC/cleanroom#stable",
    checkCommand: "npx greenroom check"
  },
  entropyWeights: {
    "architecture/cycle": 10,
    "architecture/unreachable": 3,
    "architecture/trivial-wrapper": 4,
    "architecture/stranded-feature": 7,
    "architecture/competing-responsibility": 7,
    "scripts/unowned": 5,
    "generated/stale": 5,
    "generated/missing": 7,
    "duplication/file": 8,
    "duplication/block": 4,
    "scripts/chain": 6,
    "naming/suspicious": 3,
    "design/raw-color": 2,
    "design/important": 2,
    "design/raw-radius": 2,
    "design/raw-spacing": 2,
    "design/raw-typography": 2,
    "registry/duplicate-responsibility": 8,
    "registry/missing-canonical": 8,
    "registry/noncanonical-component": 6,
    "registry/outside-allowed-directory": 8,
    "registry/disallowed-caller": 8,
    "policy/config-changed": 20,
    "policy/baseline-changed": 20,
    "policy/waivers-changed": 20,
    "policy/registry-changed": 20,
    "policy/managed-file": 20,
    "policy/expired-waiver": 20,
    "policy/generated-registry-changed": 20,
    "policy/budget-exceeded": 20
  }
};

export const SOURCE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".css", ".scss", ".sass", ".less", ".php", ".rs", ".py", ".go", ".java"
]);

export const IMPORTABLE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"
];
