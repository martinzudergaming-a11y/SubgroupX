import fs from "node:fs";
import path from "node:path";

const expectedVersion = "0.80.10";
const packageRoots = [
  "node_modules/@earendil-works/pi-ai",
  "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai",
];
const target = "dist/api/openai-responses-shared.js";
const before = `        else if (event.type === "response.completed" || event.type === "response.incomplete") {
            finalizeResponse(event.response);
        }`;
const after = `        else if (event.type === "response.completed" || event.type === "response.incomplete") {
            finalizeResponse(event.response);
            // The terminal event is the semantic end of the response. Do not wait for a
            // Responses-compatible gateway to close an otherwise idle HTTP body.
            return;
        }`;

for (const packageRoot of packageRoots) {
  const manifestPath = path.resolve(packageRoot, "package.json");
  const targetPath = path.resolve(packageRoot, target);
  if (!fs.existsSync(manifestPath) || !fs.existsSync(targetPath)) {
    throw new Error(`pi terminal patch target missing: ${packageRoot}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `pi terminal patch expected ${expectedVersion}, found ${String(manifest.version)} at ${packageRoot}; review upstream before upgrading`,
    );
  }
  const source = fs.readFileSync(targetPath, "utf8");
  if (source.includes(after)) {
    console.log(`pi terminal patch already applied: ${packageRoot}`);
    continue;
  }
  const occurrences = source.split(before).length - 1;
  if (occurrences !== 1) {
    throw new Error(`pi terminal patch expected one source seam, found ${occurrences}: ${targetPath}`);
  }
  fs.writeFileSync(targetPath, source.replace(before, after));
  console.log(`pi terminal patch applied: ${packageRoot}`);
}
