import { Template, defaultBuildLogger } from "e2b";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const secrets = JSON.parse(fs.readFileSync(path.join(root, "data/secrets.json"), "utf8"));
const apiKey = secrets.AGENT_WEB_E2B_KEY;
const name = secrets.AGENT_WEB_E2B_TEMPLATE || "oiia-pentest";
if (!apiKey) {
  console.error("missing AGENT_WEB_E2B_KEY in data/secrets.json");
  process.exit(1);
}

const dockerfile = fs.readFileSync(path.join(root, "e2b/e2b.Dockerfile"), "utf8");
console.log(`[build] template="${name}" from e2b/e2b.Dockerfile`);

const template = Template().fromDockerfile(dockerfile);
const info = await Template.build(template, name, {
  apiKey,
  onBuildLogs: defaultBuildLogger({ minLevel: "info" }),
});
console.log("[build] DONE:", JSON.stringify(info));
