import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { StepResult, VerificationResult } from "../config/schema.js";

export type ReportViewerData = {
  projectRoot: string;
  reportPath?: string;
  resultPath?: string;
  reportMarkdown?: string;
  result?: VerificationResult;
};

export type ReportViewerServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function rel(projectRoot: string, target: string | undefined): string {
  return target ? path.relative(projectRoot, target) || target : "";
}

function statusClass(status: string): string {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  return "skipped";
}

function stepRows(steps: StepResult[]): string {
  if (!steps.length) return "<tr><td colspan=\"5\">No steps recorded.</td></tr>";

  return steps.map((step) => [
    "<tr>",
    `<td>${escapeHtml(step.name)}</td>`,
    `<td>${escapeHtml(step.kind)}</td>`,
    `<td><span class="badge ${statusClass(step.status)}">${escapeHtml(step.status)}</span></td>`,
    `<td>${step.required ? "yes" : "no"}</td>`,
    `<td class="number">${step.durationMs}ms</td>`,
    "</tr>"
  ].join("")).join("\n");
}

function failedStepSections(projectRoot: string, steps: StepResult[]): string {
  const failed = steps.filter((step) => step.status === "failed");
  if (!failed.length) return "<p>No failed steps.</p>";

  return failed.map((step) => {
    const command = step.command ? `<p><strong>Command:</strong> <code>${escapeHtml(step.command)}</code></p>` : "";
    const exitCode = typeof step.exitCode === "undefined" ? "" : `<p><strong>Exit code:</strong> ${step.exitCode}</p>`;
    const error = step.error ? `<h4>Error</h4><pre>${escapeHtml(step.error)}</pre>` : "";
    const stderr = step.stderrExcerpt ? `<h4>Stderr Excerpt</h4><pre>${escapeHtml(step.stderrExcerpt)}</pre>` : "";
    const stdout = step.stdoutExcerpt ? `<h4>Stdout Excerpt</h4><pre>${escapeHtml(step.stdoutExcerpt)}</pre>` : "";
    const artifacts = step.artifacts?.length
      ? `<h4>Artifacts</h4><ul>${step.artifacts.map((artifact) => `<li>${escapeHtml(artifact.label)}: <code>${escapeHtml(rel(projectRoot, artifact.path))}</code></li>`).join("")}</ul>`
      : "";

    return [
      "<article class=\"failure\">",
      `<h3>${escapeHtml(step.name)}</h3>`,
      `<p><strong>Kind:</strong> ${escapeHtml(step.kind)} <strong>Required:</strong> ${step.required ? "yes" : "no"}</p>`,
      command,
      exitCode,
      error,
      stderr,
      stdout,
      artifacts,
      "</article>"
    ].join("\n");
  }).join("\n");
}

function artifactList(data: ReportViewerData): string {
  const result = data.result;
  if (!result) return "<p>No structured artifact data available.</p>";

  const artifacts = [
    ...result.artifacts,
    ...result.steps.flatMap((step) => step.artifacts ?? [])
  ];

  if (!artifacts.length) return "<p>No artifacts captured.</p>";

  return `<ul>${artifacts.map((artifact) => `<li>${escapeHtml(artifact.kind)}: ${escapeHtml(artifact.label)} <code>${escapeHtml(rel(result.projectRoot, artifact.path))}</code></li>`).join("")}</ul>`;
}

function metadata(data: ReportViewerData): string {
  const result = data.result;
  if (!result) return "<p>No structured result JSON available.</p>";

  const rows: Array<[string, string]> = [
    ["Fresh mode", result.fresh ? "true" : "false"],
    ["Profile", result.profile],
    ["Package manager", result.packageManager],
    ["Project root", result.projectRoot],
    ["Verification root", result.verificationRoot],
    ["Started", result.startedAt],
    ["Ended", result.endedAt],
    ["Duration", `${result.durationMs}ms`],
    ["Report", rel(result.projectRoot, result.reportPath)]
  ];

  if (result.repairPromptPath) {
    rows.push(["Repair prompt", rel(result.projectRoot, result.repairPromptPath)]);
  }

  return `<dl>${rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
}

export async function loadReportViewerData(projectRoot: string): Promise<ReportViewerData> {
  const shipgateDir = path.join(projectRoot, ".shipgate");
  const reportPath = path.join(shipgateDir, "latest-report.md");
  const resultPath = path.join(shipgateDir, "latest-result.json");
  const hasReport = existsSync(reportPath);
  const hasResult = existsSync(resultPath);

  if (!hasReport && !hasResult) {
    throw new Error("No ShipGate report found. Run shipgate verify first.");
  }

  const reportMarkdown = hasReport ? await readFile(reportPath, "utf8") : undefined;
  const result = hasResult
    ? JSON.parse(await readFile(resultPath, "utf8")) as VerificationResult
    : undefined;

  return {
    projectRoot,
    reportPath: hasReport ? reportPath : undefined,
    resultPath: hasResult ? resultPath : undefined,
    reportMarkdown,
    result
  };
}

export function renderReportViewer(data: ReportViewerData): string {
  const status = data.result?.status ?? "unknown";
  const title = `ShipGate Report: ${status.toUpperCase()}`;
  const steps = data.result?.steps ?? [];

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    "body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}",
    "main{max-width:1100px;margin:0 auto;padding:32px}",
    "section,article{background:#111827;border:1px solid #334155;border-radius:12px;margin:16px 0;padding:20px}",
    "a{color:#93c5fd} table{border-collapse:collapse;width:100%;overflow:auto} th,td{border-bottom:1px solid #334155;padding:10px;text-align:left} th{color:#cbd5e1}",
    "pre{background:#020617;border:1px solid #334155;border-radius:8px;overflow:auto;padding:12px;white-space:pre-wrap}",
    "code{background:#020617;border-radius:4px;padding:2px 4px}.number{text-align:right}.badge{border-radius:999px;padding:2px 8px;font-weight:700}.passed{background:#064e3b;color:#bbf7d0}.failed{background:#7f1d1d;color:#fecaca}.skipped{background:#334155;color:#e2e8f0}",
    "dl{display:grid;grid-template-columns:max-content 1fr;gap:8px 16px}dt{color:#cbd5e1;font-weight:700}dd{margin:0;word-break:break-word}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(title)}</h1>`,
    `<p><a href="/latest-report.md">Raw markdown report</a> · <a href="/latest-result.json">Raw result JSON</a></p>`,
    "<section>",
    "<h2>Metadata</h2>",
    metadata(data),
    "</section>",
    "<section>",
    "<h2>Steps</h2>",
    "<table><thead><tr><th>Step</th><th>Kind</th><th>Status</th><th>Required</th><th>Duration</th></tr></thead><tbody>",
    stepRows(steps),
    "</tbody></table>",
    "</section>",
    "<section>",
    "<h2>Failed Steps</h2>",
    failedStepSections(data.result?.projectRoot ?? data.projectRoot, steps),
    "</section>",
    "<section>",
    "<h2>Artifacts</h2>",
    artifactList(data),
    "</section>",
    "<section>",
    "<h2>Raw Markdown Report</h2>",
    `<pre>${escapeHtml(data.reportMarkdown ?? "No latest-report.md found.")}</pre>`,
    "</section>",
    "</main>",
    "</body>",
    "</html>"
  ].join("\n");
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(body);
}

async function handleReportViewerRequest(projectRoot: string, requestUrl: string | undefined, response: ServerResponse): Promise<void> {
  const url = new URL(requestUrl ?? "/", "http://127.0.0.1");
  const data = await loadReportViewerData(projectRoot);

  if (url.pathname === "/") {
    send(response, 200, "text/html; charset=utf-8", renderReportViewer(data));
    return;
  }

  if (url.pathname === "/latest-report.md" && data.reportMarkdown) {
    send(response, 200, "text/markdown; charset=utf-8", data.reportMarkdown);
    return;
  }

  if (url.pathname === "/latest-result.json" && data.result) {
    send(response, 200, "application/json; charset=utf-8", `${JSON.stringify(data.result, null, 2)}\n`);
    return;
  }

  send(response, 404, "text/plain; charset=utf-8", "Not found\n");
}

export async function startReportViewer(options: {
  projectRoot: string;
  host?: string;
  port?: number;
}): Promise<ReportViewerServer> {
  await loadReportViewerData(options.projectRoot);

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const server = createServer((request, response) => {
    handleReportViewerRequest(options.projectRoot, request.url, response).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      send(response, 500, "text/plain; charset=utf-8", `${message}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;

  return {
    server,
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    })
  };
}
