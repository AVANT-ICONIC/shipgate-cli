import type { Page } from "playwright";
import type { AxeResults } from "axe-core";

export type DiscoveryFormMode = "inspect" | "safe-fill";

export type AccessibilityViolationNode = {
  target: string[];
  html: string;
  failureSummary: string | null;
};

export type AccessibilityViolation = {
  route: string;
  id: string;
  impact: string | null;
  description: string;
  help: string;
  helpUrl: string;
  nodes: AccessibilityViolationNode[];
};

export type DiscoveredElement = {
  route: string;
  tag: string;
  role: string | null;
  text: string;
  type: string | null;
  href: string | null;
  ariaLabel: string | null;
  title: string | null;
  name: string | null;
  value: string | null;
  placeholder: string | null;
  formAction: string | null;
  formMethod: string | null;
  inForm: boolean;
  disabled: boolean;
  readOnly: boolean;
};

export type UnsafeDiscoveryMatch = {
  pattern: string;
  source: string;
  value: string;
};

export type UnsafeDiscoveryCandidate = {
  route: string;
  tag: string;
  role: string | null;
  text: string;
  type: string | null;
  href: string | null;
  formAction: string | null;
  formMethod: string | null;
  matches: UnsafeDiscoveryMatch[];
};

type SafeFormInteractionBase = {
  route: string;
  selector: string;
  tag: string;
  type: string | null;
  label: string;
};

export type SafeFormInteraction =
  | (SafeFormInteractionBase & { action: "fill"; value: string })
  | (SafeFormInteractionBase & { action: "select" });

export type DiscoveredRoute = {
  url: string;
  path: string;
  title: string;
  status: number | null;
  links: string[];
  elements: DiscoveredElement[];
  unsafeCandidates: UnsafeDiscoveryCandidate[];
  accessibilityViolations: AccessibilityViolation[];
};

export type RouteCrawlResult = {
  startUrl: string;
  routes: DiscoveredRoute[];
  inspectedElements: DiscoveredElement[];
  unsafeCandidates: UnsafeDiscoveryCandidate[];
  accessibilityViolations: AccessibilityViolation[];
};

export type RouteCrawlOptions = {
  startUrl: string;
  maxRoutes: number;
  maxInteractions: number;
  safeMode: boolean;
  denyTextPatterns: string[];
  accessibilityScan: boolean;
};

const interactiveSelector = "a,button,[role=button],input,select,textarea";

function routePath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function normalizedTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizedPhrase(value: string): string {
  return normalizedTokens(value).join(" ");
}

function patternMatchesValue(value: string, pattern: string): boolean {
  const normalizedPattern = normalizedPhrase(pattern);
  if (!normalizedPattern) return false;

  const normalizedValue = normalizedPhrase(value);
  if (!normalizedValue) return false;

  if (normalizedPattern.includes(" ")) {
    return normalizedValue.includes(normalizedPattern);
  }

  return normalizedTokens(value).includes(normalizedPattern);
}

function candidateSignals(candidate: DiscoveredElement): UnsafeDiscoveryMatch[] {
  const signals = [
    { source: "text", value: candidate.text },
    { source: "aria-label", value: candidate.ariaLabel },
    { source: "title", value: candidate.title },
    { source: "name", value: candidate.name },
    { source: "value", value: candidate.value },
    { source: "placeholder", value: candidate.placeholder },
    { source: "href", value: candidate.href },
    { source: "formAction", value: candidate.formAction },
    { source: "formMethod", value: candidate.formMethod },
    { source: "type", value: candidate.type },
    { source: "role", value: candidate.role },
    { source: "route", value: candidate.route }
  ];

  return signals
    .filter((signal): signal is { source: string; value: string } => Boolean(signal.value?.trim()))
    .map((signal) => ({
      pattern: "",
      source: signal.source,
      value: signal.value
    }));
}

function cssAttributeSelector(name: string, value: string): string {
  return `[${name}=${JSON.stringify(value)}]`;
}

function formControlSelector(candidate: DiscoveredElement): string | null {
  if (!["input", "textarea", "select"].includes(candidate.tag)) return null;

  if (candidate.name) return `${candidate.tag}${cssAttributeSelector("name", candidate.name)}`;
  if (candidate.ariaLabel) return `${candidate.tag}${cssAttributeSelector("aria-label", candidate.ariaLabel)}`;
  if (candidate.placeholder) return `${candidate.tag}${cssAttributeSelector("placeholder", candidate.placeholder)}`;
  if (candidate.type) return `${candidate.tag}${cssAttributeSelector("type", candidate.type)}`;

  return candidate.tag;
}

function formControlValue(candidate: DiscoveredElement): string | null {
  if (candidate.tag === "textarea") return "ShipGate smoke test";
  if (candidate.tag !== "input") return null;

  switch (candidate.type ?? "text") {
    case "email":
      return "shipgate@example.test";
    case "number":
      return "1";
    case "search":
      return "shipgate";
    case "tel":
      return "5550100";
    case "text":
      return "ShipGate smoke test";
    case "url":
      return "https://example.test";
    default:
      return null;
  }
}

function formControlLabel(candidate: DiscoveredElement): string {
  return candidate.text ||
    candidate.ariaLabel ||
    candidate.title ||
    candidate.placeholder ||
    candidate.name ||
    `${candidate.tag}${candidate.type ? `:${candidate.type}` : ""}`;
}

function isMutableFormControl(candidate: DiscoveredElement): boolean {
  return ["input", "select", "textarea"].includes(candidate.tag) &&
    !candidate.disabled &&
    !candidate.readOnly;
}

export function makeSafeFormInteractions(
  routes: DiscoveredRoute[],
  denyTextPatterns: string[],
  formMode: DiscoveryFormMode
): SafeFormInteraction[] {
  if (formMode !== "safe-fill") return [];

  const interactions: SafeFormInteraction[] = [];

  for (const route of routes) {
    for (const element of route.elements) {
      if (!isMutableFormControl(element)) continue;
      if (isUnsafeDiscoveryCandidate(element, denyTextPatterns)) continue;

      const selector = formControlSelector(element);
      if (!selector) continue;

      if (element.tag === "select") {
        interactions.push({
          route: route.url,
          selector,
          action: "select",
          tag: element.tag,
          type: element.type,
          label: formControlLabel(element)
        });
        continue;
      }

      const value = formControlValue(element);
      if (!value) continue;

      interactions.push({
        route: route.url,
        selector,
        action: "fill",
        value,
        tag: element.tag,
        type: element.type,
        label: formControlLabel(element)
      });
    }
  }

  return interactions.slice(0, 25);
}

export function findUnsafeMatches(candidate: DiscoveredElement, denyTextPatterns: string[]): UnsafeDiscoveryMatch[] {
  const matches: UnsafeDiscoveryMatch[] = [];
  const patterns = denyTextPatterns
    .map((pattern) => pattern.trim())
    .filter(Boolean);

  for (const signal of candidateSignals(candidate)) {
    for (const pattern of patterns) {
      if (patternMatchesValue(signal.value, pattern)) {
        matches.push({
          pattern,
          source: signal.source,
          value: signal.value
        });
      }
    }
  }

  return matches;
}

export function toUnsafeCandidate(
  candidate: DiscoveredElement,
  denyTextPatterns: string[]
): UnsafeDiscoveryCandidate | null {
  const matches = findUnsafeMatches(candidate, denyTextPatterns);
  if (!matches.length) return null;

  return {
    route: candidate.route,
    tag: candidate.tag,
    role: candidate.role,
    text: candidate.text,
    type: candidate.type,
    href: candidate.href,
    formAction: candidate.formAction,
    formMethod: candidate.formMethod,
    matches
  };
}

export function isUnsafeDiscoveryCandidate(candidate: DiscoveredElement, denyTextPatterns: string[]): boolean {
  return findUnsafeMatches(candidate, denyTextPatterns).length > 0;
}

export function normalizeCrawlUrl(candidate: string, baseUrl: string, allowedOrigin?: string): string | null {
  try {
    const url = new URL(candidate, baseUrl);
    const origin = allowedOrigin ?? new URL(baseUrl).origin;

    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.origin !== origin) return null;

    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function shouldCrawlLink(candidate: DiscoveredElement, denyTextPatterns: string[], safeMode: boolean): boolean {
  if (!safeMode) return true;
  return !isUnsafeDiscoveryCandidate(candidate, denyTextPatterns);
}

export function selectNewRouteLinks(links: string[], knownUrls: Iterable<string>, maxRoutes: number): string[] {
  const known = new Set(knownUrls);
  const selected: string[] = [];

  for (const link of links) {
    if (known.has(link)) continue;
    if (known.size >= maxRoutes) break;

    known.add(link);
    selected.push(link);
  }

  return selected;
}

function unsafeCandidateKey(candidate: UnsafeDiscoveryCandidate): string {
  return [
    candidate.route,
    candidate.tag,
    candidate.role ?? "",
    candidate.text,
    candidate.type ?? "",
    candidate.href ?? "",
    candidate.formAction ?? "",
    candidate.formMethod ?? ""
  ].join("\0");
}

function dedupeUnsafeCandidates(candidates: UnsafeDiscoveryCandidate[]): UnsafeDiscoveryCandidate[] {
  const seen = new Set<string>();
  const deduped: UnsafeDiscoveryCandidate[] = [];

  for (const candidate of candidates) {
    const key = unsafeCandidateKey(candidate);
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

async function collectLinks(
  page: Page,
  routeUrl: string,
  allowedOrigin: string,
  denyTextPatterns: string[],
  safeMode: boolean
): Promise<{ links: string[]; unsafeCandidates: UnsafeDiscoveryCandidate[] }> {
  const anchors = await page.locator("a[href]").evaluateAll((nodes, route) => nodes.map((node) => {
    const element = node as HTMLAnchorElement;
    const form = element.closest("form") as HTMLFormElement | null;
    return {
      route,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      href: element.href || element.getAttribute("href") || "",
      text: (element.innerText || element.getAttribute("aria-label") || element.getAttribute("title") || "").trim(),
      type: element.getAttribute("type"),
      ariaLabel: element.getAttribute("aria-label"),
      title: element.getAttribute("title"),
      name: element.getAttribute("name"),
      value: element.getAttribute("value"),
      placeholder: element.getAttribute("placeholder"),
      formAction: element.getAttribute("formaction"),
      formMethod: element.getAttribute("formmethod") || form?.method || null,
      inForm: Boolean(form),
      disabled: false,
      readOnly: false
    };
  }), routeUrl);

  const unsafeCandidates = anchors
    .map((anchor) => toUnsafeCandidate(anchor, denyTextPatterns))
    .filter((candidate): candidate is UnsafeDiscoveryCandidate => Boolean(candidate));

  const links = anchors
    .filter((anchor) => shouldCrawlLink(anchor, denyTextPatterns, safeMode))
    .map((anchor) => normalizeCrawlUrl(anchor.href, routeUrl, allowedOrigin))
    .filter((url): url is string => Boolean(url));

  return {
    links: [...new Set(links)],
    unsafeCandidates
  };
}

async function collectElements(page: Page, routeUrl: string, maxInteractions: number): Promise<DiscoveredElement[]> {
  return page.locator(interactiveSelector).evaluateAll(
    (nodes, payload) => nodes.slice(0, payload.maxInteractions).map((node) => {
      const element = node as HTMLElement;
      const anchor = element instanceof HTMLAnchorElement ? element : null;
      const input = element instanceof HTMLInputElement ? element : null;
      const textarea = element instanceof HTMLTextAreaElement ? element : null;
      const select = element instanceof HTMLSelectElement ? element : null;
      const button = element instanceof HTMLButtonElement ? element : null;
      const form = element.closest("form") as HTMLFormElement | null;

      return {
        route: payload.routeUrl,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        text: (
          element.innerText ||
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          input?.value ||
          element.getAttribute("placeholder") ||
          ""
        ).trim(),
        type: input?.type || button?.type || element.getAttribute("type"),
        href: anchor?.href || element.getAttribute("href"),
        ariaLabel: element.getAttribute("aria-label"),
        title: element.getAttribute("title"),
        name: input?.name || button?.name || element.getAttribute("name"),
        value: input?.value || button?.value || element.getAttribute("value"),
        placeholder: input?.placeholder || textarea?.placeholder || element.getAttribute("placeholder"),
        formAction: input?.formAction || button?.formAction || form?.action || element.getAttribute("formaction"),
        formMethod: input?.formMethod || button?.formMethod || form?.method || element.getAttribute("formmethod"),
        inForm: Boolean(form),
        disabled: Boolean(input?.disabled || textarea?.disabled || select?.disabled || button?.disabled),
        readOnly: Boolean(input?.readOnly || textarea?.readOnly)
      };
    }),
    { routeUrl, maxInteractions }
  );
}

function toAccessibilityViolations(routeUrl: string, results: AxeResults): AccessibilityViolation[] {
  return results.violations.map((violation) => ({
    route: routeUrl,
    id: violation.id,
    impact: violation.impact ?? null,
    description: violation.description,
    help: violation.help,
    helpUrl: violation.helpUrl,
    nodes: violation.nodes.slice(0, 10).map((node) => ({
      target: node.target.map(String),
      html: node.html,
      failureSummary: node.failureSummary ?? null
    }))
  }));
}

async function runAccessibilityScan(page: Page, routeUrl: string, enabled: boolean): Promise<AccessibilityViolation[]> {
  if (!enabled) return [];

  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const results = await new AxeBuilder({ page }).analyze();
  return toAccessibilityViolations(routeUrl, results);
}

export async function crawlRoutes(page: Page, options: RouteCrawlOptions): Promise<RouteCrawlResult> {
  const startUrl = normalizeCrawlUrl(options.startUrl, options.startUrl);
  if (!startUrl) {
    throw new Error(`Discovery URL must be an absolute http(s) URL: ${options.startUrl}`);
  }

  const allowedOrigin = new URL(startUrl).origin;
  const queue = [startUrl];
  const queued = new Set(queue);
  const crawled = new Set<string>();
  const routes: DiscoveredRoute[] = [];

  while (queue.length > 0 && routes.length < options.maxRoutes) {
    const routeUrl = queue.shift();
    if (!routeUrl || crawled.has(routeUrl)) continue;

    crawled.add(routeUrl);
    const response = await page.goto(routeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    const [elements, linkResult, title, accessibilityViolations] = await Promise.all([
      collectElements(page, routeUrl, options.maxInteractions),
      collectLinks(page, routeUrl, allowedOrigin, options.denyTextPatterns, options.safeMode),
      page.title().catch(() => ""),
      runAccessibilityScan(page, routeUrl, options.accessibilityScan)
    ]);
    const unsafeCandidates = dedupeUnsafeCandidates([
      ...linkResult.unsafeCandidates,
      ...elements
        .map((element) => toUnsafeCandidate(element, options.denyTextPatterns))
        .filter((candidate): candidate is UnsafeDiscoveryCandidate => Boolean(candidate))
    ]);

    routes.push({
      url: routeUrl,
      path: routePath(routeUrl),
      title,
      status: response?.status() ?? null,
      links: linkResult.links,
      elements,
      unsafeCandidates,
      accessibilityViolations
    });

    for (const link of selectNewRouteLinks(linkResult.links, [...queued, ...crawled], options.maxRoutes)) {
      queued.add(link);
      queue.push(link);
    }
  }

  return {
    startUrl,
    routes,
    inspectedElements: routes.flatMap((route) => route.elements),
    unsafeCandidates: dedupeUnsafeCandidates(routes.flatMap((route) => route.unsafeCandidates)),
    accessibilityViolations: routes.flatMap((route) => route.accessibilityViolations)
  };
}
