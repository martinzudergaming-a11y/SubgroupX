import { useEffect, useState } from "react";
import { Code2, Eye } from "lucide-react";
import CodeBlock from "../conversation/markdown/CodeBlock";
import MarkdownRenderer from "../conversation/markdown/MarkdownRenderer";
import { detectLanguage } from "./languages";
import { useT } from "../i18n";

export const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
export const HTML_EXT = new Set(["html", "htm"]);
export const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"]);

export function extOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  return base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
}

export type FileViewMode = "preview" | "source";

export function renderKindOf(fileName: string): "markdown" | "html" | null {
  const ext = extOf(fileName);
  return MARKDOWN_EXT.has(ext) ? "markdown" : HTML_EXT.has(ext) ? "html" : null;
}

export function FileViewToggle({ mode, onChange }: { mode: FileViewMode; onChange: (m: FileViewMode) => void }) {
  const t = useT();
  return (
    <div className="inline-flex items-center rounded-md bg-[#F2F2F2] dark:bg-[#242424] p-[2px]">
      {([
        { m: "preview" as const, label: t("file.viewPreview"), Icon: Eye },
        { m: "source" as const, label: t("file.viewSource"), Icon: Code2 },
      ]).map(({ m, label, Icon }) => (
        <button key={m} type="button"
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          className={`flex items-center gap-1 px-2 h-[22px] rounded-[5px] text-[11px] font-medium transition-colors ${
            mode === m
              ? "bg-white dark:bg-[#383838] text-[#333] dark:text-[#E8E8E8] shadow-[0_1px_1.5px_rgba(0,0,0,0.08)]"
              : "text-[#8A8A8A] dark:text-[#888] hover:text-[#555] dark:hover:text-[#BBB]"
          }`}
        >
          <Icon className="size-[12px]" strokeWidth={2} />
          {label}
        </button>
      ))}
    </div>
  );
}

export function FileContentView({
  fileName,
  content,
  fill = true,
  mode,
}: {
  fileName: string;
  content: string;
  fill?: boolean;
  mode?: FileViewMode;
}) {
  const renderKind = renderKindOf(fileName);
  const controlled = mode !== undefined;
  const [innerMode, setInnerMode] = useState<FileViewMode>("preview");
  useEffect(() => { if (!controlled) setInnerMode("preview"); }, [fileName, controlled]);
  const effectiveMode = controlled ? mode! : innerMode;
  const rendered = renderKind !== null && effectiveMode === "preview";
  const scrollRegion = fill ? "flex-1 min-h-0" : "max-h-[70vh]";

  return (
    <div className={`markdown-theme flex flex-col min-w-0 ${fill ? "flex-1 min-h-0" : ""}`}>

      {renderKind && !controlled && (
        <div className="flex justify-start mb-1.5 shrink-0">
          <FileViewToggle mode={innerMode} onChange={setInnerMode} />
        </div>
      )}
      {rendered && renderKind === "markdown" ? (
        <div className={`${scrollRegion} overflow-y-auto select-text px-1`}>
          <MarkdownRenderer>{content}</MarkdownRenderer>
        </div>
      ) : rendered && renderKind === "html" ? (
        <iframe title={fileName} sandbox="allow-scripts" srcDoc={content}
          className={`w-full border-0 bg-white ${fill ? "flex-1 min-h-[400px]" : "h-[70vh]"}`} />
      ) : (
        <div className={`${scrollRegion} overflow-auto select-text [scrollbar-width:thin]`}>
          <CodeBlock code={content} language={detectLanguage(fileName, content)} hideHeader lineNumbers />
        </div>
      )}
    </div>
  );
}
