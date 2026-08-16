import { createServer, type Server } from "node:http";
import type { DashboardModel } from "./dashboard.js";
import { renderOpsDashboard } from "./dashboard.js";
import type { OperationalReadiness } from "./readiness.js";

export interface OpsStateProvider {
  readiness(): OperationalReadiness;
  dashboard(): DashboardModel;
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

export function createOpsServer(
  provider: OpsStateProvider,
  options: { readonly host?: string; readonly port?: number } = {},
): { readonly server: Server; readonly host: string; readonly port: number } {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8_787;
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (request.url === "/health") {
      sendJson(response, 200, { status: "alive" });
      return;
    }
    if (request.url === "/ready") {
      const readiness = provider.readiness();
      sendJson(response, readiness.ready ? 200 : 503, readiness);
      return;
    }
    if (request.url === "/dashboard") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
      response.end(renderOpsDashboard(provider.dashboard()));
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  });
  return Object.freeze({ server, host, port });
}
