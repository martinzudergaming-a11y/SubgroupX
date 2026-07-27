import net from "node:net";
import type { Duplex } from "node:stream";
import type http from "node:http";

const RUNTIME_CONNECTOR_PATH = "/runtime/connector";

export function proxyConnectorUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  runtimeSocketPath: string,
): void {
  const upstream = net.connect(runtimeSocketPath);
  let connected = false;

  upstream.on("connect", () => {
    connected = true;
    const original = req.url ?? "/connector";
    const qIdx = original.indexOf("?");
    const query = qIdx >= 0 ? original.slice(qIdx) : "";
    const requestLine = `${req.method ?? "GET"} ${RUNTIME_CONNECTOR_PATH}${query} HTTP/${req.httpVersion}`;

    const lines = [requestLine];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) upstream.write(head);

    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  const destroyBoth = () => {
    upstream.destroy();
    socket.destroy();
  };
  socket.on("error", destroyBoth);
  socket.on("close", destroyBoth);
  socket.on("end", destroyBoth);
  upstream.on("error", () => {
    upstream.destroy();
    if (!connected) {
      if (socket.writable) {
        const done = () => socket.destroy();
        socket.once("finish", done);
        socket.once("error", done);
        setTimeout(done, 1_000).unref?.();
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      } else {
        socket.destroy();
      }
      return;
    }
    socket.destroy();
  });
  upstream.on("close", destroyBoth);
  upstream.on("end", destroyBoth);
}
