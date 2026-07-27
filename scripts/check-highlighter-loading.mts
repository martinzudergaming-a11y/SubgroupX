import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  getHighlighter,
  highlightCodeToHtml,
  highlightSegmentsToHtml,
  SHIKI_DARK_THEME,
  SHIKI_LIGHT_THEME,
} from "../web/src/conversation/markdown/highlighter.ts";

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const importFromWeb = (specifier: string) => import(pathToFileURL(webRequire.resolve(specifier)).href);
const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
  importFromWeb("shiki/core"),
  importFromWeb("shiki/engine/javascript"),
]);
const webLoader = (specifier: string) => () => importFromWeb(specifier);

const canonicalLanguages = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "bash",
  "json",
  "css",
  "html",
  "markdown",
  "python",
  "yaml",
  "sql",
  "diff",
  "go",
  "rust",
  "java",
  "cpp",
  "csharp",
  "php",
  "ruby",
  "swift",
  "kotlin",
  "dart",
  "powershell",
  "ini",
] as const;

const highlighter = await getHighlighter();
assert.deepEqual(
  highlighter.getLoadedLanguages().filter((language) => canonicalLanguages.includes(language as never)),
  [],
  "the shared highlighter must not compile a grammar before a visible block requests it",
);

const typescript = await highlightCodeToHtml("const answer: number = 42", "typescript");
assert.match(typescript, /class="line"/);
assert(highlighter.getLoadedLanguages().includes("typescript"));
assert(!highlighter.getLoadedLanguages().includes("python"));
assert(!highlighter.getLoadedLanguages().includes("cpp"));

const originalLoadLanguage = highlighter.loadLanguage;
let loadLanguageCalls = 0;
highlighter.loadLanguage = (...languages) => {
  loadLanguageCalls += 1;
  return originalLoadLanguage.call(highlighter, ...languages);
};
const pythonBlocks = await Promise.all(
  Array.from({ length: 24 }, (_, index) => highlightCodeToHtml(`value_${index} = ${index}`, "python")),
);
highlighter.loadLanguage = originalLoadLanguage;
assert.equal(loadLanguageCalls, 1);
assert(pythonBlocks.every((html) => html.includes('class="line"')));
assert(highlighter.getLoadedLanguages().includes("python"));
assert(!highlighter.getLoadedLanguages().includes("cpp"));

await highlightSegmentsToHtml([
  { lang: "bash", code: "python3 - <<'PY'" },
  { lang: "python", code: "print('ok')" },
  { lang: "bash", code: "PY" },
]);
const beforeUnknown = new Set(highlighter.getLoadedLanguages());
const unknown = await highlightCodeToHtml("sample", "not-a-real-language");
assert.match(unknown, /class="shiki/);
assert.deepEqual(new Set(highlighter.getLoadedLanguages()), beforeUnknown);

const nestedMarkdown = [
  "# Example",
  "",
  "```javascript",
  "const answer = 42",
  "```",
].join("\n");
const reference = await createHighlighterCore({
  themes: [
    webLoader("@shikijs/themes/vitesse-light"),
    webLoader("@shikijs/themes/vitesse-dark"),
  ],
  langs: [
    webLoader("shiki/langs/markdown.mjs"),
    webLoader("shiki/langs/javascript.mjs"),
    webLoader("shiki/langs/yaml.mjs"),
  ],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});
const referenceHtml = reference.codeToHtml(nestedMarkdown, {
  lang: "markdown",
  themes: { light: SHIKI_LIGHT_THEME, dark: SHIKI_DARK_THEME },
});
assert.equal(await highlightCodeToHtml(nestedMarkdown, "markdown"), referenceHtml);
assert(highlighter.getLoadedLanguages().includes("javascript"));
assert(!highlighter.getLoadedLanguages().includes("cpp"));

const frontMatter = "---\ntitle: Example\ncount: 2\n---\n# Report";
const referenceFrontMatter = reference.codeToHtml(frontMatter, {
  lang: "markdown",
  themes: { light: SHIKI_LIGHT_THEME, dark: SHIKI_DARK_THEME },
});
assert.equal(await highlightCodeToHtml(frontMatter, "markdown"), referenceFrontMatter);
assert(highlighter.getLoadedLanguages().includes("yaml"));

const [html, css] = await Promise.all([
  highlightCodeToHtml("<style>body { color: red }</style>", "html"),
  highlightCodeToHtml("body { color: red }", "css"),
]);
assert.match(html, /--shiki-dark/);
assert.match(css, /--shiki-dark/);

await reference.loadLanguage(webLoader("shiki/langs/cpp.mjs"));
const cppMacro = "#define VALUE(x) ((x) + 1)";
const referenceCppMacro = reference.codeToHtml(cppMacro, {
  lang: "cpp-macro",
  themes: { light: SHIKI_LIGHT_THEME, dark: SHIKI_DARK_THEME },
});
assert.equal(await highlightCodeToHtml(cppMacro, "cpp-macro"), referenceCppMacro);

const loadedCanonical = canonicalLanguages.filter((language) => highlighter.getLoadedLanguages().includes(language));
assert.deepEqual(loadedCanonical.sort(), ["bash", "cpp", "css", "html", "javascript", "markdown", "python", "sql", "typescript", "yaml"]);

console.log("highlighter loading checks passed");
