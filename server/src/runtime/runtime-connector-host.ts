import http from "node:http";
import { WebSocketServer } from "ws";
import { connectorManager } from "./connector-manager.ts";

const CONNECTOR_PATH = "/runtime/connector";

export function attachRuntimeConnectorHost(
  server: http.Server,
  connectorWss: WebSocketServer = connectorManager.createServer(),
  path = CONNECTOR_PATH,
): WebSocketServer {
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== path) return;
    connectorWss.handleUpgrade(req, socket, head, (ws) => connectorWss.emit("connection", ws, req));
  });
  return connectorWss;
}
