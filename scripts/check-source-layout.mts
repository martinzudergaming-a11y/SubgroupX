import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-compiler-api";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceExtension = /(?:\.d)?\.(?:ts|tsx|mts)$/;

function rel(file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(file));
    else if (sourceExtension.test(entry.name)) out.push(file);
  }
  return out;
}

function directSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && sourceExtension.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function assertDirectFiles(dir: string, allowed: readonly string[]): void {
  const unexpected = directSourceFiles(path.join(root, dir)).filter((file) => !allowed.includes(file));
  assert.deepEqual(unexpected, [], `${dir} gained root-level source files; place them in a named capability: ${unexpected.join(", ")}`);
}

function moduleSpecifiers(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const specs: string[] = [];
  const add = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) specs.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node)) add(node.argument.literal);
    else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0
    ) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specs;
}

function importMetaAssetSpecifiers(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "URL"
      && node.arguments?.length === 2
      && ts.isStringLiteralLike(node.arguments[0])
      && node.arguments[0].text.startsWith(".")
      && node.arguments[1].getText(sourceFile) === "import.meta.url"
    ) specs.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specs;
}

function isInside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function resolveRelative(file: string, specifier: string): string | null {
  return specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : null;
}

const serverSrc = path.join(root, "server/src");
const webSrc = path.join(root, "web/src");
const sharedSrc = path.join(root, "shared/src");

for (const sourceRoot of [serverSrc, webSrc, sharedSrc]) {
  for (const file of walk(sourceRoot)) {
    for (const specifier of importMetaAssetSpecifiers(file)) {
      const asset = path.resolve(path.dirname(file), specifier);
      assert(fs.existsSync(asset), `${rel(file)} references missing import.meta asset ${specifier}`);
    }
  }
}

assertDirectFiles("server/src", ["config.ts", "index.ts", "runtime-entrypoint.ts"]);
assertDirectFiles("web/src", ["App.tsx", "main.tsx", "mvdan-sh.d.ts", "vite-env.d.ts"]);
assertDirectFiles("web/src/dashboard", ["App.tsx", "app-helpers.tsx", "nav.ts", "types.ts"]);
assertDirectFiles("shared", []);
assert(!fs.existsSync(path.join(webSrc, "dashboard/components")), "dashboard/components is a retired dumping ground");

for (const directory of [
  "server/src/http",
  "server/src/foundation",
  "server/src/identity",
  "server/src/persistence",
  "server/src/runtime",
  "server/src/transport",
  "web/src/conversation",
  "web/src/dashboard/features",
  "web/src/dashboard/session",
  "web/src/dashboard/shell",
  "web/src/files",
  "web/src/platform",
  "web/src/ui",
  "shared/src",
]) {
  assert(fs.statSync(path.join(root, directory)).isDirectory(), `missing source capability: ${directory}`);
}

for (const file of walk(sharedSrc)) {
  for (const specifier of moduleSpecifiers(file)) {
    assert(specifier.startsWith("."), `${rel(file)} imports runtime dependency ${specifier}`);
    const target = resolveRelative(file, specifier);
    assert(target && isInside(target, sharedSrc), `${rel(file)} escapes shared/src via ${specifier}`);
  }
}

const persistence = path.join(serverSrc, "persistence");
for (const file of walk(persistence)) {
  for (const specifier of moduleSpecifiers(file)) {
    const target = resolveRelative(file, specifier);
    if (!target || !isInside(target, serverSrc)) continue;
    const allowed = isInside(target, persistence)
      || target === path.join(serverSrc, "config.ts")
      || isInside(target, path.join(serverSrc, "foundation"));
    assert(allowed, `${rel(file)} reaches outward through ${specifier}`);
  }
}

for (const [directory, allowedRoots] of [
  [path.join(webSrc, "ui"), [path.join(webSrc, "ui"), path.join(webSrc, "i18n")]],
  [path.join(webSrc, "platform"), [path.join(webSrc, "platform"), path.join(webSrc, "i18n")]],
  [path.join(webSrc, "telemetry"), [path.join(webSrc, "telemetry"), path.join(webSrc, "i18n")]],
] as const) {
  for (const file of walk(directory)) {
    for (const specifier of moduleSpecifiers(file)) {
      const target = resolveRelative(file, specifier);
      if (!target || !isInside(target, webSrc)) continue;
      assert(allowedRoots.some((allowed) => isInside(target, allowed)), `${rel(file)} reaches into a feature through ${specifier}`);
    }
  }
}

const dashboard = path.join(webSrc, "dashboard");
for (const directory of [path.join(webSrc, "conversation"), path.join(webSrc, "files")]) {
  for (const file of walk(directory)) {
    for (const specifier of moduleSpecifiers(file)) {
      const target = resolveRelative(file, specifier);
      assert(!target || !isInside(target, dashboard), `${rel(file)} couples back to dashboard via ${specifier}`);
    }
  }
}

console.log("check-source-layout: source roots and inward dependency boundaries are valid");
