import { chromium } from "@playwright/test";
import fs from "node:fs";

const B = "http://localhost:4318";
const dir = "docs/screens";
fs.mkdirSync(dir, { recursive: true });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const shot = async (name) => { await p.waitForTimeout(700); await p.screenshot({ path: `${dir}/${name}.png` }); console.log("shot:", name); };
const send = async (t) => { await p.getByTestId("composer").fill(t); await p.getByTestId("send").click(); };
const idle = async () => { await p.getByTestId("send").waitFor({ timeout: 15000 }).catch(() => {}); };
async function newSession(title, approval) {
  await p.getByTestId("new-session").click();
  await p.getByTestId("ns-title").fill(title);
  await p.getByTestId("ns-model").selectOption("mock::mock-coder");
  await p.getByTestId("ns-approval").selectOption(approval);
  await p.getByTestId("ns-create").click();
  await p.getByTestId("composer").waitFor();
}

await p.goto(B);
await shot("01-login");

await p.getByTestId("toggle-mode").click();
await p.getByTestId("email").fill(`demo${Date.now()}@agent.dev`);
await p.getByTestId("password").fill("password123");
await p.getByTestId("auth-submit").click();
await p.getByTestId("new-session").waitFor();

await newSession("Refactor the auth module", "never");
await send("/write notes.md\n# Plan\n- inspect providers.ts\n- add OPENAI_BASE_URL override\n- verify model list");
await idle();
await send("/subagent /write report.md\n# Findings\nThe key is saved per-provider; adding a base-url layer.");
await p.getByTestId("subagent-timeline").waitFor();
await idle();
await shot("02-chat-subagent");

await p.getByTestId("tool-write_file").first().getByTestId("tool-file-link").click({ force: true }).catch(() => {});
await shot("03-files");

await p.getByRole("button", { name: "Agent Team", exact: true }).first().click().catch(() => {});
await shot("04-agent-team");

await p.getByText("# all", { exact: true }).first().click().catch(() => {});
await shot("05-channels");

await p.getByTestId("open-settings").click();
await shot("06-settings");

await newSession("Deploy script", "on-request");
await send("/bash echo deploying > deploy.log");
await p.getByTestId("permission").waitFor();
await shot("07-approval");

await b.close();
console.log("done");
