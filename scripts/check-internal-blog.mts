import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BLOG_UI_COPY, ENGINEERING_NOTES } from "../web/src/dashboard/features/blog/blog-content.ts";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const serialized = JSON.stringify({
  notes: ENGINEERING_NOTES.map((note) => ({ ...note, references: (note.references ?? []).map((r) => ({ label: r.label })) })),
  ui: BLOG_UI_COPY,
});
for (const note of ENGINEERING_NOTES) {
  for (const reference of note.references ?? []) {
    assert.ok(/^https:\/\/[a-z0-9.-]+\//i.test(reference.url), `${note.slug}: reference must be a public https URL: ${reference.url}`);
    assert.ok(reference.label.en.trim() && reference.label.zh.trim(), `${note.slug}: reference labels need both locales`);
  }
}
const englishCopy: Array<{ label: string; text: string }> = Object.entries(BLOG_UI_COPY.en)
  .map(([label, text]) => ({ label: `ui.${label}`, text }));

assert.ok(ENGINEERING_NOTES.length >= 6, "internal blog should remain a real collection, not a placeholder");
assert.equal(new Set(ENGINEERING_NOTES.map((note) => note.slug)).size, ENGINEERING_NOTES.length, "blog slugs must be unique");
assert.equal(new Set(ENGINEERING_NOTES.map((note) => note.sequence)).size, ENGINEERING_NOTES.length, "blog sequence numbers must be unique");

for (const note of ENGINEERING_NOTES) {
  assert.match(note.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `invalid blog slug: ${note.slug}`);
  assert.match(note.sequence, /^\d{2}$/, `invalid blog sequence: ${note.sequence}`);
  assert.ok(note.readingMinutes >= 3 && note.readingMinutes <= 12, `${note.slug}: implausible reading time`);
  assert.ok(note.investigation.length >= 4, `${note.slug}: investigation is too shallow`);
  assert.ok(note.changes.length >= 3, `${note.slug}: changes are too shallow`);
  assert.ok(note.principles.length >= 2, `${note.slug}: principles are too shallow`);

  const localizedValues: Array<Readonly<Record<"en" | "zh", string>>> = [
    note.category,
    note.title,
    note.summary,
    note.outcome,
    note.signal,
    note.boundary,
    ...note.changes,
    ...note.principles,
    ...note.investigation.flatMap((item) => [item.title, item.body]),
  ];
  for (const value of localizedValues) {
    assert.ok(value.en.trim().length > 0 && value.zh.trim().length > 0, `${note.slug}: both locales are required`);
  }
  englishCopy.push(...localizedValues.map((value, index) => ({
    label: `${note.slug}.copy.${index}`,
    text: value.en,
  })));
}

for (const { label, text } of englishCopy) {
  assert.ok(!/[;\u2013\u2014]/.test(text), `${label}: use short sentences instead of semicolons or dashes`);
  assert.ok(!/\b\w+'(?:s|re|ve|ll|d|m|t)\b/i.test(text), `${label}: do not use contractions`);
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [text];
  for (const sentence of sentences) {
    const words = sentence.match(/[A-Za-z0-9]+(?:[.+/-][A-Za-z0-9]+)*/g) ?? [];
    assert.ok(words.length <= 20, `${label}: sentence has ${words.length} words (maximum 20): ${sentence.trim()}`);
  }
}

const forbidden: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/, "email address"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i, "UUID/thread id"],
  [/\bs_[0-9a-f-]{16,}\b/i, "product session id"],
  [/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/, "absolute home path"],
  [/agents:\/\//i, "raw agent URI"],
  [/https?:\/\//i, "URL copied from a transcript"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, "IP address"],
  [/\b[0-9a-f]{32,}\b/i, "opaque token/hash"],
  [/<INSTRUCTIONS>|<environment_context>|# AGENTS\.md/i, "raw prompt/instruction marker"],
];
for (const [pattern, label] of forbidden) {
  assert.ok(!pattern.test(serialized), `internal blog contains forbidden ${label}`);
}

const vite = read("web/vite.config.ts");
const route = read("web/src/platform/blog-route.ts");
const app = read("web/src/App.tsx");
const sidebar = read("web/src/dashboard/shell/LeftSidebar.tsx");
const dockerfile = read("Dockerfile");
assert.ok(vite.includes('process.env.AGENT_WEB_INTERNAL_BLOG !== "0"'), "blog must default on with an explicit build-time opt-out");
assert.ok(route.includes("INTERNAL_BLOG_ENABLED"), "route recognition must share the build gate");
assert.ok(app.includes("parseBlogRoute") && app.includes('lazy(() => import("@internal-blog-view")'), "blog must be gated and lazy");
assert.ok(!/VIEW_PATH[\s\S]*?blog:/.test(read("web/src/dashboard/nav.ts")), "the notes must not reappear as a dashboard view");
assert.ok(vite.includes('"@internal-blog-view"') && vite.includes("BlogDisabled.tsx"), "opt-out module graph must resolve Blog to a content-free stub");
assert.ok(sidebar.includes("INTERNAL_BLOG_ENABLED") && sidebar.includes('testId="open-blog"'), "sidebar entry must share the build gate");
assert.ok(dockerfile.includes("ARG AGENT_WEB_INTERNAL_BLOG=1"), "normal container builds must include the authenticated Blog route");

console.log(`OK internal-blog: ${ENGINEERING_NOTES.length} bilingual sanitized STE-style notes; route is build-gated and lazy`);
