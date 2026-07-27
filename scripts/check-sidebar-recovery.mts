import assert from "node:assert/strict";
import type { ViewType } from "../web/src/dashboard/types.ts";
import { needsSidebarFallback, shellBranchFor } from "../web/src/dashboard/shell/sidebar-recovery.ts";

(globalThis as Record<string, unknown>).__INTERNAL_BLOG_ENABLED__ = true;
const { VIEW_PATH } = await import("../web/src/dashboard/nav.ts");

const ALL_VIEWS: ViewType[] = [
  "chat",
  "channel",
  "settings",
  "search",
  "shell",
  "skills",
  "plugins",
  "agents",
  "automations",
];

assert.deepEqual(
  [...ALL_VIEWS].sort(),
  Object.keys(VIEW_PATH).sort(),
  "a view was added or removed without deciding whether it renders its own sidebar control",
);

const withTarget = { hasShellTarget: true };
const withoutTarget = { hasShellTarget: false };

assert.equal(shellBranchFor("chat", withoutTarget), "chat");

assert.equal(shellBranchFor("shell", withTarget), "view-header");
assert.equal(shellBranchFor("shell", withoutTarget), "placeholder");

for (const view of ALL_VIEWS) {
  if (view === "chat" || view === "shell") continue;
  assert.equal(shellBranchFor(view, withoutTarget), "view-header", `${view} must own its header`);
  assert.equal(shellBranchFor(view, withTarget), "view-header", `${view} must own its header`);
}

assert.equal(needsSidebarFallback(shellBranchFor("shell", withoutTarget), false), true);

assert.equal(needsSidebarFallback(shellBranchFor("shell", withoutTarget), true), false);
assert.equal(needsSidebarFallback(shellBranchFor("shell", withTarget), false), false);
assert.equal(needsSidebarFallback(shellBranchFor("chat", withoutTarget), false), false);
for (const view of ALL_VIEWS) {
  if (view === "shell") continue;
  assert.equal(needsSidebarFallback(shellBranchFor(view, withoutTarget), false), false, `${view} would double the control`);
}

console.log("OK sidebar-recovery: every headerless branch keeps a way back to the sidebar");
