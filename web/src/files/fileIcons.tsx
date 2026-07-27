import type { ComponentType, CSSProperties, ReactNode } from "react";
import { FileCode2, FileText } from "lucide-react";
import { LANG_TO_EXT } from "./languages";
import {
  SiTypescript, SiJavascript, SiReact, SiPython, SiRust, SiGo, SiOpenjdk,
  SiKotlin, SiSwift, SiRuby, SiPhp, SiCplusplus, SiC, SiDotnet, SiHtml5,
  SiCss, SiSass, SiLess, SiJson, SiYaml, SiToml, SiGnubash, SiDocker,
  SiNpm, SiGit, SiLua, SiDart, SiVuedotjs, SiSvelte, SiGraphql, SiSqlite,
  SiTailwindcss,
} from "react-icons/si";
import { VscMarkdown, VscFileMedia, VscFileBinary } from "react-icons/vsc";

type IconCmp = ComponentType<{ size?: number; className?: string; style?: CSSProperties }>;
type Spec = { Icon: IconCmp; color: string };

const BY_EXT: Record<string, Spec> = {
  txt: { Icon: FileText, color: "#6F7B70" },
  log: { Icon: FileText, color: "#6F7B70" },
  ts: { Icon: SiTypescript, color: "#3178C6" },
  mts: { Icon: SiTypescript, color: "#3178C6" },
  cts: { Icon: SiTypescript, color: "#3178C6" },
  tsx: { Icon: SiReact, color: "#149ECA" },
  jsx: { Icon: SiReact, color: "#149ECA" },
  js: { Icon: SiJavascript, color: "#E8B309" },
  mjs: { Icon: SiJavascript, color: "#E8B309" },
  cjs: { Icon: SiJavascript, color: "#E8B309" },
  py: { Icon: SiPython, color: "#3776AB" },
  pyw: { Icon: SiPython, color: "#3776AB" },
  rs: { Icon: SiRust, color: "#C76B2E" },
  go: { Icon: SiGo, color: "#00ADD8" },
  java: { Icon: SiOpenjdk, color: "#E76F00" },
  kt: { Icon: SiKotlin, color: "#7F52FF" },
  kts: { Icon: SiKotlin, color: "#7F52FF" },
  swift: { Icon: SiSwift, color: "#F05138" },
  rb: { Icon: SiRuby, color: "#CC342D" },
  php: { Icon: SiPhp, color: "#8892BF" },
  c: { Icon: SiC, color: "#659AD2" },
  h: { Icon: SiC, color: "#659AD2" },
  cpp: { Icon: SiCplusplus, color: "#00599C" },
  cc: { Icon: SiCplusplus, color: "#00599C" },
  cxx: { Icon: SiCplusplus, color: "#00599C" },
  hpp: { Icon: SiCplusplus, color: "#00599C" },
  hxx: { Icon: SiCplusplus, color: "#00599C" },
  cs: { Icon: SiDotnet, color: "#8A4FD3" },
  html: { Icon: SiHtml5, color: "#E34F26" },
  htm: { Icon: SiHtml5, color: "#E34F26" },
  css: { Icon: SiCss, color: "#3D8FD1" },
  scss: { Icon: SiSass, color: "#CC6699" },
  sass: { Icon: SiSass, color: "#CC6699" },
  less: { Icon: SiLess, color: "#3E73B9" },
  json: { Icon: SiJson, color: "#C9A227" },
  jsonc: { Icon: SiJson, color: "#C9A227" },
  yaml: { Icon: SiYaml, color: "#CB171E" },
  yml: { Icon: SiYaml, color: "#CB171E" },
  toml: { Icon: SiToml, color: "#A8704F" },
  md: { Icon: VscMarkdown, color: "#519975" },
  mdx: { Icon: VscMarkdown, color: "#519975" },
  markdown: { Icon: VscMarkdown, color: "#519975" },
  sh: { Icon: SiGnubash, color: "#4EAA25" },
  bash: { Icon: SiGnubash, color: "#4EAA25" },
  zsh: { Icon: SiGnubash, color: "#4EAA25" },
  sql: { Icon: SiSqlite, color: "#5A8CB0" },
  lua: { Icon: SiLua, color: "#6E72C4" },
  dart: { Icon: SiDart, color: "#2F9FD8" },
  vue: { Icon: SiVuedotjs, color: "#42B883" },
  svelte: { Icon: SiSvelte, color: "#FF3E00" },
  graphql: { Icon: SiGraphql, color: "#E10098" },
  gql: { Icon: SiGraphql, color: "#E10098" },
};

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"]);

function specialFile(lower: string): Spec | null {
  if (lower === "dockerfile" || lower.startsWith("dockerfile.") || lower === ".dockerignore")
    return { Icon: SiDocker, color: "#2496ED" };
  if (lower === "package.json" || lower === "package-lock.json" || lower === ".npmrc")
    return { Icon: SiNpm, color: "#CB3837" };
  if (lower.startsWith("tsconfig") && lower.endsWith(".json"))
    return { Icon: SiTypescript, color: "#3178C6" };
  if (lower.startsWith("tailwind.config"))
    return { Icon: SiTailwindcss, color: "#06B6D4" };
  if (lower === ".gitignore" || lower === ".gitattributes" || lower === ".gitmodules")
    return { Icon: SiGit, color: "#F05032" };
  return null;
}

export function fileIconFor(name: string, size = 14): ReactNode {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const spec = specialFile(lower) ?? BY_EXT[ext];
  if (spec) {
    const { Icon, color } = spec;
    return <Icon size={size} style={{ color }} className="shrink-0" />;
  }
  if (IMAGE_EXT.has(ext)) return <VscFileMedia size={size} className="shrink-0 text-[#A0739C]" />;
  return <VscFileBinary size={size} className="shrink-0 text-[#7C828C] dark:text-[#9AA0AA]" />;
}

export function langIconFor(language: string, size = 14): ReactNode {
  const spec = BY_EXT[LANG_TO_EXT[language.toLowerCase()] ?? ""];
  if (spec) {
    const { Icon, color } = spec;
    return <Icon size={size} style={{ color }} className="shrink-0" />;
  }
  return <FileCode2 size={size} className="shrink-0 text-[#888] dark:text-[#9aa]" />;
}
