import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { BROWSER_WS_PER_MESSAGE_DEFLATE, browserWsPerMessageDeflate } from "../server/src/transport/ws-compression.ts";

type WsWithSocket = WebSocket & { _socket: { bytesRead: number } };

function replayPayload(rows = 2_400, charsPerRow = 4_096): string {
  const tokens = ["const", "await", "function", "return", "workspace", "result", "message", "timeline", "tool", "path", "error", "session"];
  let state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const body = () => {
    let text = "";
    while (text.length < charsPerRow) {
      const value = next();
      text += `${tokens[value % tokens.length]}_${value.toString(36)} `;
    }
    return text.slice(0, charsPerRow);
  };
  return JSON.stringify({
    type: "timeline_replay",
    sessionId: "s_compression_check",
    epoch: "epoch_compression_check",
    items: Array.from({ length: rows }, (_, index) => ({
      kind: index % 2 === 0 ? "user" : "assistant",
      id: `item_${index}`,
      seq: index + 1,
      text: `${index}:${body()}`,
      ts: 1_700_000_000_000 + index,
    })),
    pending: [],
  });
}

async function transfer(payload: string, compressed: boolean): Promise<{ wireBytes: number; durationMs: number; extension: string }> {
  const wss = new WebSocketServer({
    port: 0,
    perMessageDeflate: compressed ? BROWSER_WS_PER_MESSAGE_DEFLATE : false,
  });
  await once(wss, "listening");
  const address = wss.address();
  assert.ok(address && typeof address === "object");

  wss.on("connection", (socket) => {
    socket.once("message", () => socket.send(payload));
  });

  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`, { perMessageDeflate: compressed });
  try {
    await once(ws, "open");
    const before = (ws as WsWithSocket)._socket.bytesRead;
    const start = performance.now();
    ws.send("send replay");
    const [data] = await once(ws, "message") as [Buffer];
    const durationMs = performance.now() - start;
    const after = (ws as WsWithSocket)._socket.bytesRead;
    assert.equal(data.toString(), payload, "compression must not change the replay payload");
    return { wireBytes: after - before, durationMs, extension: ws.extensions };
  } finally {
    ws.close();
    await once(ws, "close").catch(() => undefined);
    await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
  }
}

const payload = replayPayload();
const rawBytes = Buffer.byteLength(payload);
const plain = await transfer(payload, false);
const deflated = await transfer(payload, true);
const ratio = deflated.wireBytes / plain.wireBytes;

assert.equal(browserWsPerMessageDeflate(), BROWSER_WS_PER_MESSAGE_DEFLATE, "compression is enabled by default");
process.env.AGENT_WEB_WS_COMPRESSION = "0";
assert.equal(browserWsPerMessageDeflate(), false, "deployment kill switch disables negotiation");
delete process.env.AGENT_WEB_WS_COMPRESSION;
assert.equal(plain.extension, "", "baseline must not negotiate an extension");
assert.match(deflated.extension, /permessage-deflate/, "browser socket negotiates permessage-deflate");
assert.ok(plain.wireBytes >= rawBytes, "uncompressed frame should carry at least the JSON bytes");
assert.ok(ratio < 0.5, `expected replay wire size below 50%, got ${(ratio * 100).toFixed(1)}%`);

console.log(JSON.stringify({
  rawBytes,
  plainWireBytes: plain.wireBytes,
  compressedWireBytes: deflated.wireBytes,
  wireRatio: Number(ratio.toFixed(4)),
  savedPct: Number(((1 - ratio) * 100).toFixed(1)),
  plainMs: Number(plain.durationMs.toFixed(1)),
  compressedMs: Number(deflated.durationMs.toFixed(1)),
  extension: deflated.extension,
}));
console.log("OK ws-compression: negotiated + transparent + bounded + wire-size reduction");
