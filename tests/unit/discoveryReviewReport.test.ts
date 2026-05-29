import { describe, expect, it } from "vitest";
import { makeDiscoveryReviewReport } from "../../src/discovery/reviewReport.js";
import type { DiscoveredElement, DiscoveredRoute } from "../../src/discovery/routeCrawler.js";

function element(overrides: Partial<DiscoveredElement>): DiscoveredElement {
  return {
    route: "https://app.example.test/",
    tag: "a",
    role: null,
    text: "",
    type: null,
    href: null,
    ariaLabel: null,
    title: null,
    name: null,
    value: null,
    placeholder: null,
    formAction: null,
    formMethod: null,
    inForm: false,
    disabled: false,
    readOnly: false,
    ...overrides
  };
}

describe("makeDiscoveryReviewReport", () => {
  it("summarizes discovery artifacts, review duties, unsafe candidates, and form interactions", () => {
    const projectRoot = "/repo";
    const routes: DiscoveredRoute[] = [
      {
        url: "https://app.example.test/",
        path: "/",
        title: "Home",
        status: 200,
        links: ["https://app.example.test/settings"],
        elements: [element({ text: "Settings", href: "https://app.example.test/settings" })],
        unsafeCandidates: [],
        accessibilityViolations: []
      },
      {
        url: "https://app.example.test/settings",
        path: "/settings",
        title: "Settings",
        status: 200,
        links: [],
        elements: [element({ tag: "button", text: "Delete account", type: "button" })],
        unsafeCandidates: [
          {
            route: "https://app.example.test/settings",
            tag: "button",
            role: null,
            text: "Delete account",
            type: "button",
            href: null,
            formAction: null,
            formMethod: null,
            matches: [
              {
                pattern: "delete",
                source: "text",
                value: "Delete account"
              }
            ]
          }
        ],
        accessibilityViolations: [
          {
            route: "https://app.example.test/settings",
            id: "button-name",
            impact: "critical",
            description: "Ensures buttons have discernible text",
            help: "Buttons must have discernible text",
            helpUrl: "https://dequeuniversity.com/rules/axe/4.11/button-name",
            nodes: [
              {
                target: ["button.icon-only"],
                html: "<button class=\"icon-only\"></button>",
                failureSummary: "Fix any of the following: Element does not have inner text"
              }
            ]
          }
        ]
      }
    ];

    const report = makeDiscoveryReviewReport({
      projectRoot,
      url: "https://app.example.test/",
      generatedSpec: "/repo/tests/shipgate/generated-discovery.smoke.spec.ts",
      discoveryJson: "/repo/.shipgate/latest-discovery.json",
      reviewReport: "/repo/.shipgate/latest-discovery-review.md",
      maxRoutes: 10,
      maxInteractions: 25,
      formMode: "safe-fill",
      accessibilityScan: true,
      screenshotBaselineMode: "compare",
      routes,
      inspectedElementCount: 2,
      unsafeCandidates: routes.flatMap((route) => route.unsafeCandidates),
      accessibilityViolations: routes.flatMap((route) => route.accessibilityViolations),
      screenshotComparisons: [
        {
          route: "https://app.example.test/",
          routePath: "/",
          status: "matched",
          baselinePath: "/repo/.shipgate/discovery-screenshots/baseline/root-a.png",
          currentPath: "/repo/.shipgate/discovery-screenshots/latest/root-a.png",
          baselineHash: "same",
          currentHash: "same"
        },
        {
          route: "https://app.example.test/settings",
          routePath: "/settings",
          status: "changed",
          baselinePath: "/repo/.shipgate/discovery-screenshots/baseline/settings-b.png",
          currentPath: "/repo/.shipgate/discovery-screenshots/latest/settings-b.png",
          baselineHash: "old",
          currentHash: "new"
        }
      ],
      safeFormInteractions: [
        {
          route: "https://app.example.test/settings",
          selector: "input[name=\"email\"]",
          action: "fill",
          value: "shipgate@example.test",
          tag: "input",
          type: "email",
          label: "email"
        }
      ],
      consoleErrors: ["Failed to load settings widget"]
    });

    expect(report).toContain("# ShipGate Discovery Review");
    expect(report).toContain("Playwright draft: `tests/shipgate/generated-discovery.smoke.spec.ts`");
    expect(report).toContain("Discovery JSON: `.shipgate/latest-discovery.json`");
    expect(report).toContain("| Routes crawled | 2 / 10 |");
    expect(report).toContain("| Accessibility violations | 1 |");
    expect(report).toContain("| Screenshot changes | 1 changed, 0 missing baseline |");
    expect(report).toContain("- [ ] Convert useful generated steps into named product flows");
    expect(report).toContain("Delete account (delete via text)");
    expect(report).toContain("critical: Buttons must have discernible text (button-name). Targets: button.icon-only.");
    expect(report).toContain("fill input[name=\"email\"] with \"shipgate@example.test\"");
    expect(report).toContain("| /settings | changed | .shipgate/discovery-screenshots/baseline/settings-b.png | .shipgate/discovery-screenshots/latest/settings-b.png |");
    expect(report).toContain("Failed to load settings widget");
    expect(report).toContain("They do not prove authorization, persistence, ordering, calculations, or business intent.");
  });
});
