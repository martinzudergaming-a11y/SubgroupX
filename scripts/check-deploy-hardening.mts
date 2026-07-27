import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const deployText = fs.readFileSync(path.join(root, "scripts/deploy.sh"), "utf8");
const hardenText = fs.readFileSync(path.join(root, "scripts/host-hardening.sh"), "utf8");
const workflowPath = path.join(root, ".github/workflows/build.yml");
const workflowText = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, "utf8") : "";

let failed = 0;
const check = (name: string, ok: boolean) => {
  if (ok) {
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
};

check("deploy.sh: --memory= cap on docker run",            deployText.includes("--memory="));
check("deploy.sh: --memory-swap= cap on docker run",       deployText.includes("--memory-swap="));
check("deploy.sh: --memory-reservation= cap on docker run",deployText.includes("--memory-reservation="));
check("deploy.sh: --oom-score-adj= on docker run",         deployText.includes("--oom-score-adj="));

check("deploy.sh: pulls from GHCR (ghcr.io/n-wn/agent-web)",
  deployText.includes("ghcr.io/n-wn/agent-web") && deployText.includes("docker pull"));
check("deploy.sh: does NOT build on the host (no docker build)",
  !deployText.includes("docker build"));
check("deploy.sh: uploads secrets.json to the data volume",
  deployText.includes("secrets.json"));

check("workflow: build.yml exists",                        workflowText.length > 0);
check("workflow: pushes to ghcr.io/n-wn/agent-web",        workflowText.includes("ghcr.io/n-wn/agent-web"));
check("workflow: has packages: write permission",          /packages:\s*write/.test(workflowText));
check("workflow: bakes BUILD_VERSION build-arg",           workflowText.includes("BUILD_VERSION="));

check("host-hardening.sh: set -euo pipefail",              hardenText.includes("set -euo pipefail"));
check("host-hardening.sh: root check via id -u",           hardenText.includes("id -u"));

check("host-hardening.sh: swap guard checks swapon --show",hardenText.includes("swapon --show"));

check("host-hardening.sh: vm.swappiness configured",       hardenText.includes("vm.swappiness"));

check("host-hardening.sh: sshd drop-in OOMScoreAdjust=-1000",hardenText.includes("OOMScoreAdjust=-1000"));

check("host-hardening.sh: earlyoom --avoid regex includes sshd",
  hardenText.includes("--avoid") && hardenText.includes("sshd"));

check("host-hardening.sh: --avoid regex is bare (not single-quoted) — contains --avoid ^(",
  hardenText.includes("--avoid ^("));
check("host-hardening.sh: --avoid regex is bare (not single-quoted) — no --avoid ' pattern",
  !hardenText.includes("--avoid '"));

check("host-hardening.sh: earlyoom explicitly restarted to apply config",
  hardenText.includes("systemctl restart earlyoom"));
check("host-hardening.sh: earlyoom not gated solely behind enable --now",
  !hardenText.includes("enable --now earlyoom"));

if (failed) {
  console.error(`\n${failed} hardening check${failed === 1 ? "" : "s"} FAILED`);
  process.exit(1);
}
console.log("\nall hardening checks passed");
