import { z } from "zod";

export const commandStepSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  required: z.boolean().default(true),
  env: z.record(z.string()).optional()
});

export const commandConfigSchema = z.object({
  install: z.union([z.string(), commandStepSchema]).optional(),
  typecheck: z.union([z.string(), commandStepSchema]).optional(),
  lint: z.union([z.string(), commandStepSchema]).optional(),
  test: z.union([z.string(), commandStepSchema]).optional(),
  build: z.union([z.string(), commandStepSchema]).optional(),
  start: z.union([z.string(), commandStepSchema]).optional(),
  custom: z.array(commandStepSchema).default([])
}).default({});

export const commandHooksConfigSchema = z.object({
  beforeVerify: z.array(commandStepSchema).default([]),
  beforeFlows: z.array(commandStepSchema).default([]),
  afterFlows: z.array(commandStepSchema).default([]),
  afterVerify: z.array(commandStepSchema).default([])
}).default({});

export const workspaceConfigSchema = z.object({
  root: z.string().default("."),
  projectDir: z.string().optional()
}).default({});

export const browserExpectationSchema = z.object({
  titleContains: z.string().optional(),
  textIncludes: z.array(z.string()).default([]),
  selectorsVisible: z.array(z.string()).default(["body"])
}).default({ selectorsVisible: ["body"] });

export const cliExpectationSchema = z.object({
  exitCode: z.number().int().default(0),
  stdoutIncludes: z.array(z.string()).default([]),
  stderrIncludes: z.array(z.string()).default([])
}).default({ exitCode: 0 });

export const apiExpectationSchema = z.object({
  status: z.number().int().default(200),
  bodyIncludes: z.array(z.string()).default([])
}).default({ status: 200 });

export const fileExpectationSchema = z.object({
  exists: z.boolean().default(true)
}).default({ exists: true });

export const browserFlowSchema = z.object({
  name: z.string().min(1),
  kind: z.literal("browser"),
  path: z.string().default("/"),
  expect: browserExpectationSchema.optional(),
  timeoutMs: z.number().int().positive().optional()
});

export const cliFlowSchema = z.object({
  name: z.string().min(1),
  kind: z.literal("cli"),
  command: z.string().min(1),
  expect: cliExpectationSchema.optional(),
  timeoutMs: z.number().int().positive().optional()
});

export const apiFlowSchema = z.object({
  name: z.string().min(1),
  kind: z.literal("api"),
  url: z.string().min(1),
  expect: apiExpectationSchema.optional(),
  timeoutMs: z.number().int().positive().optional()
});

export const fileFlowSchema = z.object({
  name: z.string().min(1),
  kind: z.literal("file"),
  path: z.string().min(1),
  expect: fileExpectationSchema.optional()
});

export const flowSchema = z.discriminatedUnion("kind", [
  browserFlowSchema,
  cliFlowSchema,
  apiFlowSchema,
  fileFlowSchema
]);

export const appSchema = z.object({
  kind: z.enum(["browser", "api"]).default("browser"),
  url: z.string().min(1),
  startTimeoutMs: z.number().int().positive().default(30000),
  readyTimeoutMs: z.number().int().positive().default(30000),
  readyText: z.string().optional(),
  failOnConsoleError: z.boolean().default(true),
  failOnPageError: z.boolean().default(true),
  failOnNetworkError: z.boolean().default(true),
  allowedNetworkFailures: z.array(z.string()).default([])
}).optional();

export const artifactConfigSchema = z.object({
  dir: z.string().default(".shipgate/artifacts"),
  screenshots: z.boolean().default(true),
  traces: z.boolean().default(true),
  logs: z.boolean().default(true)
}).default({});

export const freshConfigSchema = z.object({
  exclude: z.array(z.string()).default([]),
  keepTemp: z.boolean().default(false)
}).default({});

export const failurePolicySchema = z.object({
  stopOnFirstCommandFailure: z.boolean().default(true),
  failOnConsoleError: z.boolean().default(true),
  failOnPageError: z.boolean().default(true),
  failOnNetworkError: z.boolean().default(true),
  allowWarnings: z.boolean().default(true),
  maxConsoleWarnings: z.number().int().nonnegative().default(20)
}).default({});

export const discoveryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxRoutes: z.number().int().positive().default(10),
  maxInteractions: z.number().int().positive().default(25),
  safeMode: z.boolean().default(true),
  formMode: z.enum(["inspect", "safe-fill"]).default("inspect"),
  accessibilityScan: z.boolean().default(false),
  screenshotBaselineMode: z.enum(["off", "capture", "compare"]).default("off"),
  screenshotBaselineDir: z.string().default(".shipgate/discovery-screenshots"),
  outputSpec: z.string().default("tests/shipgate/generated-discovery.smoke.spec.ts"),
  denyTextPatterns: z.array(z.string()).default([
    "delete",
    "remove",
    "destroy",
    "archive",
    "logout",
    "log out",
    "sign out",
    "pay",
    "purchase",
    "checkout",
    "charge",
    "refund",
    "unsubscribe",
    "cancel subscription",
    "reset",
    "disable",
    "revoke",
    "ban",
    "submit"
  ])
}).default({});


const safePolicyPathSchema = z.string().min(1).refine((value) => {
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/")
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..");
}, "Policy config path must be relative and remain inside the project root");

export const cleanroomPolicyConfigSchema = z.object({
  enabled: z.boolean().default(false),
  configFile: safePolicyPathSchema.default(".shipgate/policies/cleanroom.json"),
  compareAgainst: z.union([z.literal("auto"), z.string().min(1)]).default("auto")
}).default({});

export const policiesConfigSchema = z.object({
  cleanroom: cleanroomPolicyConfigSchema
}).strict().default({});

export const shipGateConfigSchema = z.object({
  profile: z.string().default("generic"),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "auto"]).default("auto"),
  workspace: workspaceConfigSchema,
  commands: commandConfigSchema,
  hooks: commandHooksConfigSchema,
  app: appSchema,
  flows: z.array(flowSchema).default([]),
  requiredFiles: z.array(z.string()).default(["README.md", "package.json"]),
  artifacts: artifactConfigSchema,
  fresh: freshConfigSchema,
  failurePolicy: failurePolicySchema,
  discovery: discoveryConfigSchema,
  policies: policiesConfigSchema,
  env: z.record(z.string()).default({})
});

export type CommandStepConfig = z.infer<typeof commandStepSchema>;
export type CommandConfig = z.infer<typeof commandConfigSchema>;
export type CommandHooksConfig = z.infer<typeof commandHooksConfigSchema>;
export type CommandHookPhase = keyof CommandHooksConfig;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type BrowserFlow = z.infer<typeof browserFlowSchema>;
export type CliFlow = z.infer<typeof cliFlowSchema>;
export type ApiFlow = z.infer<typeof apiFlowSchema>;
export type FileFlow = z.infer<typeof fileFlowSchema>;
export type FlowConfig = z.infer<typeof flowSchema>;
export type CleanroomPolicyConfig = z.infer<typeof cleanroomPolicyConfigSchema>;
export type PoliciesConfig = z.infer<typeof policiesConfigSchema>;
export type ShipGateConfig = z.infer<typeof shipGateConfigSchema>;
export type ShipGateConfigInput = z.input<typeof shipGateConfigSchema>;

export type ArtifactRef = {
  kind: "log" | "screenshot" | "trace" | "json" | "markdown" | "temp" | "generated-test";
  label: string;
  path: string;
};

export type StepStatus = "passed" | "failed" | "skipped";

export type StepResult = {
  id: string;
  name: string;
  kind: "command" | "browser" | "api" | "file" | "preflight" | "discovery" | "policy";
  status: StepStatus;
  required: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  error?: string;
  artifacts?: ArtifactRef[];
  details?: Record<string, unknown>;
};

export type VerificationResult = {
  status: "passed" | "failed";
  fresh: boolean;
  profile: string;
  packageManager: string;
  projectRoot: string;
  verificationRoot: string;
  workspaceRoot?: string;
  verificationWorkspaceRoot?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  steps: StepResult[];
  artifacts: ArtifactRef[];
  reportPath: string;
  repairPromptPath?: string;
};
