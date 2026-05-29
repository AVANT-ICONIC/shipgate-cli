import { describe, expect, it } from "vitest";
import { makeDiscoverySpec } from "../../src/commands/discover.js";
import {
  findUnsafeMatches,
  makeSafeFormInteractions,
  normalizeCrawlUrl,
  selectNewRouteLinks,
  shouldCrawlLink,
  type DiscoveredElement,
  type DiscoveredRoute
} from "../../src/discovery/routeCrawler.js";

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

describe("discovery route crawling helpers", () => {
  const baseUrl = "https://app.example.test/dashboard?tab=home";
  const origin = "https://app.example.test";

  it("normalizes same-origin http URLs and rejects unsafe or external targets", () => {
    expect(normalizeCrawlUrl("/settings#team", baseUrl, origin)).toBe("https://app.example.test/settings");
    expect(normalizeCrawlUrl("https://app.example.test/billing?plan=pro#checkout", baseUrl, origin)).toBe(
      "https://app.example.test/billing?plan=pro"
    );
    expect(normalizeCrawlUrl("https://cdn.example.test/app.js", baseUrl, origin)).toBeNull();
    expect(normalizeCrawlUrl("https://app.example.test.attacker.invalid/dashboard", baseUrl, origin)).toBeNull();
    expect(normalizeCrawlUrl("mailto:support@example.test", baseUrl, origin)).toBeNull();
  });

  it("keeps destructive-looking links out of the crawl queue in safe mode", () => {
    const safeLink = element({ href: "/settings", text: "Settings" });
    const unsafeLink = element({ href: "/logout", text: "Sign out" });

    expect(shouldCrawlLink(safeLink, ["logout", "delete"], true)).toBe(true);
    expect(shouldCrawlLink(unsafeLink, ["logout", "sign out"], true)).toBe(false);
    expect(shouldCrawlLink(unsafeLink, ["logout", "sign out"], false)).toBe(true);
  });

  it("matches destructive signals beyond visible text without substring false positives", () => {
    const matches = findUnsafeMatches(
      element({
        tag: "button",
        text: "Continue",
        type: "submit",
        ariaLabel: "Delete account",
        formAction: "https://app.example.test/users/123/destroy",
        route: "https://app.example.test/settings"
      }),
      ["delete", "destroy", "submit", "pay"]
    );

    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: "delete", source: "aria-label" }),
      expect.objectContaining({ pattern: "destroy", source: "formAction" }),
      expect.objectContaining({ pattern: "submit", source: "type" })
    ]));
    expect(findUnsafeMatches(element({ href: "/api/payloads", text: "Payloads" }), ["pay"])).toEqual([]);
  });

  it("deduplicates queued routes and respects the max route cap", () => {
    expect(selectNewRouteLinks(
      [
        "https://app.example.test/settings",
        "https://app.example.test/dashboard",
        "https://app.example.test/billing"
      ],
      ["https://app.example.test/", "https://app.example.test/dashboard"],
      3
    )).toEqual(["https://app.example.test/settings"]);
  });

  it("plans only safe form field mutations in safe-fill mode", () => {
    const routes: DiscoveredRoute[] = [
      {
        url: "https://app.example.test/contact",
        path: "/contact",
        title: "Contact",
        status: 200,
        links: [],
        elements: [
          element({
            route: "https://app.example.test/contact",
            tag: "input",
            type: "email",
            name: "email",
            inForm: true
          }),
          element({
            route: "https://app.example.test/contact",
            tag: "textarea",
            name: "message",
            placeholder: "Message",
            inForm: true
          }),
          element({
            route: "https://app.example.test/contact",
            tag: "select",
            name: "topic",
            inForm: true
          }),
          element({
            route: "https://app.example.test/contact",
            tag: "input",
            type: "file",
            name: "avatar",
            inForm: true
          }),
          element({
            route: "https://app.example.test/contact",
            tag: "input",
            type: "text",
            name: "deleteReason",
            inForm: true
          }),
          element({
            route: "https://app.example.test/contact",
            tag: "input",
            type: "text",
            name: "disabledField",
            disabled: true,
            inForm: true
          })
        ],
        unsafeCandidates: [],
        accessibilityViolations: []
      }
    ];

    expect(makeSafeFormInteractions(routes, ["delete"], "inspect")).toEqual([]);
    expect(makeSafeFormInteractions(routes, ["delete"], "safe-fill")).toEqual([
      expect.objectContaining({
        selector: "input[name=\"email\"]",
        action: "fill",
        value: "shipgate@example.test"
      }),
      expect.objectContaining({
        selector: "textarea[name=\"message\"]",
        action: "fill",
        value: "ShipGate smoke test"
      }),
      expect.objectContaining({
        selector: "select[name=\"topic\"]",
        action: "select"
      })
    ]);
  });
});

describe("makeDiscoverySpec", () => {
  it("generates route checks and safe route-scoped clicks", () => {
    const routes: DiscoveredRoute[] = [
      {
        url: "https://app.example.test/",
        path: "/",
        title: "Home",
        status: 200,
        links: ["https://app.example.test/settings"],
        elements: [
          element({
            route: "https://app.example.test/",
            tag: "a",
            role: null,
            text: "Settings",
            type: null,
            href: "https://app.example.test/settings"
          })
        ],
        unsafeCandidates: [],
        accessibilityViolations: []
      },
      {
        url: "https://app.example.test/settings",
        path: "/settings",
        title: "Settings",
        status: 200,
        links: [],
        elements: [
          element({
            route: "https://app.example.test/settings",
            tag: "button",
            role: null,
            text: "Delete account",
            type: "button",
            href: null
          }),
          element({
            route: "https://app.example.test/settings",
            tag: "button",
            role: null,
            text: "Continue",
            type: "button",
            href: null,
            ariaLabel: "Destroy account"
          }),
          element({
            route: "https://app.example.test/settings",
            tag: "div",
            role: "button",
            text: "Open panel",
            type: null,
            href: null
          })
        ],
        unsafeCandidates: [],
        accessibilityViolations: []
      }
    ];

    const spec = makeDiscoverySpec("https://app.example.test/", routes, ["delete", "destroy"]);

    expect(spec).toContain("route: /settings");
    expect(spec).toContain("new URL(\"/settings\", baseUrl).toString()");
    expect(spec).toContain("getByRole(\"link\", { name: new RegExp(\"Settings\", \"i\") })");
    expect(spec).toContain("getByRole(\"button\", { name: new RegExp(\"Open panel\", \"i\") })");
    expect(spec).not.toContain("Delete account");
    expect(spec).not.toContain("Destroy account");
  });

  it("generates safe-fill form mutations without form submission", () => {
    const routes: DiscoveredRoute[] = [
      {
        url: "https://app.example.test/contact",
        path: "/contact",
        title: "Contact",
        status: 200,
        links: [],
        elements: [
          element({
            route: "https://app.example.test/contact",
            tag: "input",
            type: "email",
            name: "email",
            inForm: true
          }),
          element({
            route: "https://app.example.test/contact",
            tag: "button",
            type: "submit",
            text: "Send",
            inForm: true
          })
        ],
        unsafeCandidates: [],
        accessibilityViolations: []
      }
    ];

    const spec = makeDiscoverySpec("https://app.example.test/", routes, ["submit"], "safe-fill");

    expect(spec).toContain("type Page");
    expect(spec).toContain("blockFormSubmissions(page)");
    expect(spec).toContain("event.preventDefault()");
    expect(spec).toContain("page.locator(\"input[name=\\\"email\\\"]\").first().fill(\"shipgate@example.test\")");
    expect(spec).not.toContain("button 1: Send");
  });
});
