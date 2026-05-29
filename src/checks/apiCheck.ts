import type { ApiFlow, StepResult } from "../config/schema.js";
import { durationMs, nowIso } from "../utils/time.js";

export function resolveApiFlowUrl(url: string, appUrl?: string): string {
  try {
    return new URL(url).toString();
  } catch {
    if (!appUrl) {
      throw new Error(`API flow URL "${url}" is relative, but no app.url is configured.`);
    }
    return new URL(url, appUrl).toString();
  }
}

export async function runApiFlow(flow: ApiFlow, appUrl?: string): Promise<StepResult> {
  const startedAt = nowIso();
  const start = Date.now();
  let url = flow.url;

  try {
    url = resolveApiFlowUrl(flow.url, appUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), flow.timeoutMs ?? 15000);
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, { signal: controller.signal });
      text = await response.text();
    } finally {
      clearTimeout(timeout);
    }
    const expect = flow.expect ?? { status: 200, bodyIncludes: [] };
    const failures: string[] = [];

    if (response.status !== expect.status) {
      failures.push(`Expected HTTP ${expect.status}, got ${response.status}`);
    }

    for (const value of expect.bodyIncludes ?? []) {
      if (!text.includes(value)) failures.push(`Response body missing: ${value}`);
    }

    return {
      id: `api:${flow.name}`,
      name: flow.name,
      kind: "api",
      status: failures.length ? "failed" : "passed",
      required: true,
      startedAt,
      endedAt: nowIso(),
      durationMs: durationMs(start),
      error: failures.length ? failures.join("\n") : undefined,
      details: {
        url,
        status: response.status,
        bodyExcerpt: text.slice(0, 1000)
      }
    };
  } catch (error) {
    return {
      id: `api:${flow.name}`,
      name: flow.name,
      kind: "api",
      status: "failed",
      required: true,
      startedAt,
      endedAt: nowIso(),
      durationMs: durationMs(start),
      error: error instanceof Error ? error.message : String(error),
      details: {
        url
      }
    };
  }
}
