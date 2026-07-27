import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { permissionSubject } from "../web/src/dashboard/session/timeline/permission-subject.ts";

const root = path.resolve(import.meta.dirname, "..");
const dictionaries = {
  en: fs.readFileSync(path.join(root, "web/src/i18n/en.ts"), "utf8"),
  zh: fs.readFileSync(path.join(root, "web/src/i18n/zh.ts"), "utf8"),
};
function lookup(dictionary: string, key: string): string | null {
  const match = new RegExp(`^\\s*"${key.replace(".", "\\.")}"\\s*:\\s*"([^"]*)"`, "m").exec(dictionary);
  return match ? match[1] : null;
}

const base = { toolCallId: "c1", requestId: "p1" };

assert.deepEqual(
  permissionSubject({ ...base, toolName: "bash", summary: "Run command: rm -rf build", command: "rm -rf build" }),
  { titleKey: "perm.askRun", confirmKey: "perm.doRun", refuseKey: "perm.dontRun", subject: "rm -rf build", kind: "command" },
);

for (const [toolName, verb] of [
  ["write_file", "Write"],
  ["edit_file", "Edit"],
  ["read_file", "Read"],
  ["list_files", "List"],
] as const) {
  assert.deepEqual(
    permissionSubject({ ...base, toolName, summary: "Something: src/app.ts", path: "src/app.ts" }),
    {
      titleKey: `perm.ask${verb}`,
      confirmKey: `perm.do${verb}`,
      refuseKey: `perm.dont${verb}`,
      subject: "src/app.ts",
      kind: "path",
    },
  );
}

assert.deepEqual(
  permissionSubject({ ...base, toolName: "some_future_tool", summary: "Do the thing: with this" }),
  { titleKey: "perm.askGeneric", confirmKey: "perm.doAllow", refuseKey: "perm.dontAllow", subject: "Do the thing: with this", kind: "prose" },
);

for (const request of [
  { ...base, toolName: "bash", summary: "Run command: x" },
  { ...base, toolName: "bash", summary: "Run command: x", command: "   " },
  { ...base, toolName: "write_file", summary: "Write file: y", path: "" },
]) {
  const result = permissionSubject(request);
  assert.equal(result.titleKey, "perm.askGeneric", `malformed ${request.toolName} must not claim a precise heading`);
  assert.equal(result.kind, "prose");
  assert.equal(result.subject, request.summary);
}

const everyRequest = [
  { ...base, toolName: "bash", summary: "s", command: "c" },
  { ...base, toolName: "write_file", summary: "s", path: "p" },
  { ...base, toolName: "edit_file", summary: "s", path: "p" },
  { ...base, toolName: "read_file", summary: "s", path: "p" },
  { ...base, toolName: "list_files", summary: "s", path: "p" },
  { ...base, toolName: "unknown", summary: "s" },
];
for (const request of everyRequest) {
  const { titleKey, confirmKey, refuseKey } = permissionSubject(request);
  for (const key of [titleKey, confirmKey, refuseKey]) {
    for (const [locale, dictionary] of Object.entries(dictionaries)) {
      const value = lookup(dictionary, key);
      assert.ok(value !== null, `${request.toolName} → ${key} is missing from ${locale}.ts`);
      assert.ok(value.trim(), `${key} is empty in ${locale}.ts`);
    }
  }
}

console.log("OK permission-subject: the question names the verb, the button does what it says, and every key exists");
