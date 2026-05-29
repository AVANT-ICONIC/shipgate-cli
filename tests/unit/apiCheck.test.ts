import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { resolveApiFlowUrl, runApiFlow } from "../../src/checks/apiCheck.js";

describe("api checks", () => {
  it("resolves relative API flow URLs against the configured app URL", () => {
    expect(resolveApiFlowUrl("/health", "http://127.0.0.1:4173")).toBe("http://127.0.0.1:4173/health");
  });

  it("keeps absolute API flow URLs unchanged", () => {
    expect(resolveApiFlowUrl("https://api.example.test/status", "http://127.0.0.1:4173"))
      .toBe("https://api.example.test/status");
  });

  it("requires app.url for relative API flow URLs", () => {
    expect(() => resolveApiFlowUrl("/health")).toThrow(
      'API flow URL "/health" is relative, but no app.url is configured.'
    );
  });

  it("times out when a response body never finishes", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });

      const port = (server.address() as AddressInfo).port;
      const result = await Promise.race([
        runApiFlow({
          name: "hanging body",
          kind: "api",
          url: `http://127.0.0.1:${port}`,
          timeoutMs: 50
        }),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1000))
      ]);

      expect(result).not.toBe("hung");
      if (result !== "hung") {
        expect(result.status).toBe("failed");
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
