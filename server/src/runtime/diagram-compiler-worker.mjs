const MAX_SOURCE_BYTES = 48 * 1024;

function errorText(error) {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown compiler error");
  try {
    const diagnostics = JSON.parse(raw);
    if (Array.isArray(diagnostics)) {
      const lines = diagnostics
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const range = typeof item.range === "string" ? item.range : "";
          const message = typeof item.errmsg === "string" ? item.errmsg : "";
          return message || range;
        })
        .filter(Boolean);
      if (lines.length) return lines.join("\n").slice(0, 4_000);
    }
  } catch {
  }
  return raw.replaceAll(process.cwd(), "<runtime>").slice(0, 4_000);
}

async function readRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_SOURCE_BYTES + 1_024) throw new Error("diagram lint request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function compileMermaid(source) {
  const { default: purifyFactory } = await import("dompurify");
  if (typeof purifyFactory.addHook !== "function") {
    purifyFactory.addHook = () => {};
    purifyFactory.removeAllHooks = () => {};
    purifyFactory.sanitize = (value) => String(value);
  }
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  const parsed = await mermaid.parse(source);
  return { diagramType: parsed.diagramType };
}

async function compileD2(source) {
  const { D2 } = await import("@terrastruct/d2");
  const d2 = new D2();
  const result = await d2.compile(source, {
    layout: "dagre",
    themeID: 0,
    darkThemeID: 200,
    center: true,
    pad: 24,
    noXMLTag: true,
  });
  const svg = await d2.render(result.diagram, result.renderOptions);
  return {
    shapes: result.diagram.shapes.length,
    connections: result.diagram.connections.length,
    svgBytes: Buffer.byteLength(svg),
  };
}

async function main() {
  const request = await readRequest();
  const language = request?.language;
  const source = typeof request?.source === "string" ? request.source : "";
  if (language !== "mermaid" && language !== "d2") throw new Error("language must be mermaid or d2");
  if (!source.trim()) throw new Error("diagram source is empty");
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw new Error("diagram source exceeds 48 KiB");
  const details = language === "mermaid" ? await compileMermaid(source) : await compileD2(source);
  return { valid: true, language, details };
}

let response;
try {
  response = await main();
} catch (error) {
  response = { valid: false, error: errorText(error) };
}
process.stdout.write(`${JSON.stringify(response)}\n`, () => process.exit(0));
