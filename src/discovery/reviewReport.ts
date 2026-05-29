import path from "node:path";
import type {
  AccessibilityViolation,
  DiscoveredRoute,
  SafeFormInteraction,
  UnsafeDiscoveryCandidate
} from "./routeCrawler.js";
import type { ScreenshotComparison } from "./screenshotBaseline.js";

export type DiscoveryReviewReportInput = {
  projectRoot: string;
  url: string;
  generatedSpec: string;
  discoveryJson: string;
  reviewReport: string;
  maxRoutes: number;
  maxInteractions: number;
  formMode: string;
  accessibilityScan: boolean;
  screenshotBaselineMode: string;
  routes: DiscoveredRoute[];
  inspectedElementCount: number;
  unsafeCandidates: UnsafeDiscoveryCandidate[];
  safeFormInteractions: SafeFormInteraction[];
  accessibilityViolations: AccessibilityViolation[];
  screenshotComparisons: ScreenshotComparison[];
  consoleErrors: string[];
};

function rel(projectRoot: string, target: string): string {
  return path.relative(projectRoot, target) || target;
}

function tableCell(value: string | number | null): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function routeLabel(route: DiscoveredRoute): string {
  return route.path || new URL(route.url).pathname || "/";
}

function summarizeUnsafe(candidate: UnsafeDiscoveryCandidate): string {
  const label = candidate.text || candidate.href || candidate.formAction || candidate.tag;
  const matches = candidate.matches
    .map((match) => `${match.pattern} via ${match.source}`)
    .join(", ");
  return `${label} (${matches})`;
}

function summarizeAccessibilityViolation(violation: AccessibilityViolation): string {
  const impact = violation.impact ? `${violation.impact}: ` : "";
  const targets = violation.nodes
    .flatMap((node) => node.target)
    .slice(0, 3)
    .join(", ");
  const targetSummary = targets ? ` Targets: ${targets}.` : "";
  return `${impact}${violation.help} (${violation.id}).${targetSummary}`;
}

export function makeDiscoveryReviewReport(input: DiscoveryReviewReportInput): string {
  const lines: string[] = [];
  const routeCount = input.routes.length;
  const unsafeCount = input.unsafeCandidates.length;
  const consoleErrorCount = input.consoleErrors.length;
  const accessibilityViolationCount = input.accessibilityViolations.length;
  const screenshotChangedCount = input.screenshotComparisons.filter((comparison) => comparison.status === "changed").length;
  const screenshotMissingCount = input.screenshotComparisons.filter((comparison) => comparison.status === "missing-baseline").length;

  lines.push("# ShipGate Discovery Review");
  lines.push("");
  lines.push("This report is a review aid for a generated smoke-test draft. It is not an acceptance result.");
  lines.push("");
  lines.push("## Generated Artifacts");
  lines.push("");
  lines.push(`- Entry URL: \`${input.url}\``);
  lines.push(`- Playwright draft: \`${rel(input.projectRoot, input.generatedSpec)}\``);
  lines.push(`- Discovery JSON: \`${rel(input.projectRoot, input.discoveryJson)}\``);
  lines.push(`- Review report: \`${rel(input.projectRoot, input.reviewReport)}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Item | Count |");
  lines.push("| --- | ---: |");
  lines.push(`| Routes crawled | ${routeCount} / ${input.maxRoutes} |`);
  lines.push(`| Elements inspected | ${input.inspectedElementCount} |`);
  lines.push(`| Max elements per route | ${input.maxInteractions} |`);
  lines.push(`| Unsafe candidates skipped | ${unsafeCount} |`);
  lines.push(`| Safe form interactions | ${input.safeFormInteractions.length} |`);
  lines.push(`| Accessibility violations | ${accessibilityViolationCount} |`);
  lines.push(`| Screenshot comparisons | ${input.screenshotComparisons.length} |`);
  lines.push(`| Screenshot changes | ${screenshotChangedCount} changed, ${screenshotMissingCount} missing baseline |`);
  lines.push(`| Console errors observed | ${consoleErrorCount} |`);
  lines.push("");
  lines.push(`Form mode: \`${input.formMode}\``);
  lines.push(`Accessibility scan: \`${input.accessibilityScan ? "enabled" : "disabled"}\``);
  lines.push(`Screenshot baseline mode: \`${input.screenshotBaselineMode}\``);
  lines.push("");
  lines.push("## Required Review");
  lines.push("");
  lines.push("- [ ] Confirm every crawled route is intentional for this app state.");
  lines.push("- [ ] Convert useful generated steps into named product flows with stable selectors.");
  lines.push("- [ ] Add business assertions for expected outcomes; body-visible checks are not enough.");
  lines.push("- [ ] Review skipped unsafe candidates and cover any necessary destructive flows in controlled fixtures.");
  lines.push("- [ ] Run `shipgate verify --fresh` after promoting any generated draft into the project test suite.");
  lines.push("");

  lines.push("## Crawled Routes");
  lines.push("");
  if (!input.routes.length) {
    lines.push("No routes were crawled.");
  } else {
    lines.push("| Route | Status | Title | Links | Elements | Unsafe | A11y |");
    lines.push("| --- | ---: | --- | ---: | ---: | ---: | ---: |");
    for (const route of input.routes) {
      lines.push(`| ${tableCell(routeLabel(route))} | ${tableCell(route.status)} | ${tableCell(route.title)} | ${route.links.length} | ${route.elements.length} | ${route.unsafeCandidates.length} | ${route.accessibilityViolations.length} |`);
    }
  }
  lines.push("");

  lines.push("## Unsafe Candidates");
  lines.push("");
  if (!input.unsafeCandidates.length) {
    lines.push("No unsafe candidates were skipped.");
  } else {
    for (const candidate of input.unsafeCandidates.slice(0, 25)) {
      lines.push(`- \`${candidate.route}\`: ${summarizeUnsafe(candidate)}`);
    }
    if (input.unsafeCandidates.length > 25) {
      lines.push(`- ${input.unsafeCandidates.length - 25} more unsafe candidate(s) omitted from this summary.`);
    }
  }
  lines.push("");

  lines.push("## Safe Form Interactions");
  lines.push("");
  if (!input.safeFormInteractions.length) {
    lines.push("No safe form interactions were generated.");
  } else {
    for (const interaction of input.safeFormInteractions) {
      const action = interaction.action === "fill"
        ? `fill ${interaction.selector} with ${JSON.stringify(interaction.value)}`
        : `select option in ${interaction.selector}`;
      lines.push(`- \`${interaction.route}\`: ${action}`);
    }
  }
  lines.push("");

  lines.push("## Accessibility Violations");
  lines.push("");
  if (!input.accessibilityScan) {
    lines.push("Accessibility scanning was disabled for this discovery run.");
  } else if (!input.accessibilityViolations.length) {
    lines.push("No axe accessibility violations were observed during discovery.");
  } else {
    for (const violation of input.accessibilityViolations.slice(0, 25)) {
      lines.push(`- \`${violation.route}\`: ${summarizeAccessibilityViolation(violation)}`);
    }
    if (input.accessibilityViolations.length > 25) {
      lines.push(`- ${input.accessibilityViolations.length - 25} more accessibility violation(s) omitted from this summary.`);
    }
  }
  lines.push("");

  lines.push("## Screenshot Baselines");
  lines.push("");
  if (input.screenshotBaselineMode === "off") {
    lines.push("Screenshot baseline mode was disabled for this discovery run.");
  } else if (!input.screenshotComparisons.length) {
    lines.push("No screenshot baseline entries were generated.");
  } else {
    lines.push("| Route | Status | Baseline | Current |");
    lines.push("| --- | --- | --- | --- |");
    for (const comparison of input.screenshotComparisons) {
      lines.push(`| ${tableCell(comparison.routePath || comparison.route)} | ${comparison.status} | ${tableCell(rel(input.projectRoot, comparison.baselinePath))} | ${tableCell(comparison.currentPath ? rel(input.projectRoot, comparison.currentPath) : "")} |`);
    }
  }
  lines.push("");

  lines.push("## Console Errors");
  lines.push("");
  if (!input.consoleErrors.length) {
    lines.push("No browser console errors were observed during discovery.");
  } else {
    for (const error of input.consoleErrors.slice(0, 25)) {
      lines.push(`- ${error}`);
    }
    if (input.consoleErrors.length > 25) {
      lines.push(`- ${input.consoleErrors.length - 25} more console error(s) omitted from this summary.`);
    }
  }
  lines.push("");

  lines.push("## Limitations");
  lines.push("");
  lines.push("- Generated discovery checks only catch crashes, console errors, and obvious route interaction failures.");
  lines.push("- They do not prove authorization, persistence, ordering, calculations, or business intent.");
  lines.push("- Keep discovery output out of acceptance gates until a human or agent adds concrete assertions.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}
