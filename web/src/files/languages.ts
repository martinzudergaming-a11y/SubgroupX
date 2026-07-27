const LANG_ALIASES: Record<string, string> = {
  js: "javascript", cjs: "javascript", mjs: "javascript",
  ts: "typescript", cts: "typescript", mts: "typescript",
  py: "python", sh: "bash", shell: "bash", shellscript: "bash", zsh: "bash",
  yml: "yaml", md: "markdown", ps: "powershell", ps1: "powershell",
  text: "plaintext", htm: "html", c: "cpp", "c++": "cpp",
  cs: "csharp", "c#": "csharp", rs: "rust", rb: "ruby",
  kt: "kotlin", kts: "kotlin", properties: "ini", regex: "regexp", gql: "graphql",
};

export function normalizeLanguage(language?: string): string {
  const lang = (language || "plaintext").toLowerCase().trim();
  return LANG_ALIASES[lang] || lang || "plaintext";
}

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  py: "python", pyw: "python",
  rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "cpp", h: "cpp", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  cs: "csharp", php: "php", swift: "swift", kt: "kotlin", kts: "kotlin", dart: "dart",
  sh: "bash", bash: "bash", zsh: "bash",
  yaml: "yaml", yml: "yaml",
  json: "json", jsonc: "json",
  css: "css", html: "html", htm: "html",
  md: "markdown", markdown: "markdown",
  sql: "sql", diff: "diff", patch: "diff",
  ps1: "powershell",
  ini: "ini", cfg: "ini", conf: "ini", toml: "ini",
};

const SPECIAL_FILES: Record<string, string> = {
  ".bashrc": "bash", ".bash_profile": "bash", ".bash_aliases": "bash", ".bash_logout": "bash",
  ".profile": "bash", ".zshrc": "bash", ".zprofile": "bash", ".zshenv": "bash", ".zlogin": "bash",
  ".gitconfig": "ini", ".npmrc": "ini", ".editorconfig": "ini", ".inputrc": "ini",
};

function fromShebang(content: string): string | null {
  const first = content.slice(0, 256).split("\n", 1)[0];
  if (!first.startsWith("#!")) return null;
  if (/\b(bash|sh|zsh|dash|ksh)\b/.test(first)) return "bash";
  if (/\bpython[0-9.]*\b/.test(first)) return "python";
  if (/\bnode\b/.test(first)) return "javascript";
  if (/\bruby\b/.test(first)) return "ruby";
  if (/\bphp\b/.test(first)) return "php";
  return null;
}

export function detectLanguage(file: string, content: string): string {
  const base = (file.split("/").pop() ?? file).toLowerCase();
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return EXT_LANGUAGE[ext] || SPECIAL_FILES[base] || fromShebang(content) || "plaintext";
}

export const LANG_TO_EXT: Record<string, string> = {
  typescript: "ts", javascript: "js", tsx: "tsx", jsx: "jsx",
  python: "py", go: "go", rust: "rs", java: "java", cpp: "cpp",
  csharp: "cs", php: "php", ruby: "rb", swift: "swift", kotlin: "kt",
  dart: "dart", bash: "sh", shell: "sh", sh: "sh", yaml: "yaml", yml: "yaml",
  json: "json", css: "css", scss: "scss", sass: "sass", less: "less",
  html: "html", markdown: "md", sql: "sql", lua: "lua", vue: "vue",
  svelte: "svelte", graphql: "graphql", toml: "toml",
};

export const INTERP_LANG: Record<string, string> = {
  python: "python", python3: "python", python2: "python",
  node: "javascript", nodejs: "javascript", deno: "javascript", bun: "javascript",
  ruby: "ruby", php: "php",
  psql: "sql", sqlite3: "sql", mysql: "sql",
  bash: "bash", sh: "bash", zsh: "bash", dash: "bash",
};
