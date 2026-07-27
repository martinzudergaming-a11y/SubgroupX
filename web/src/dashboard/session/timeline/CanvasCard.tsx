import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Spinner } from "../../../ui/Spinner";
import { ChevronDown, ChevronRight, Code2, Eye, PanelRight } from "lucide-react";
import { useT } from "../../../i18n";
import CodeBlock from "../../../conversation/markdown/CodeBlock";
import { canvasBootstrapScript, CANVAS_MSG_NS, type CanvasFrameMessage } from "./canvas-bootstrap";
import { canvasThemeStyle } from "./canvas-themes";
import { reportCanvasSnapshot } from "./canvas-state";

const CANVAS_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' 'unsafe-eval' data:; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none';";

function wrapHtml(html: string, theme?: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">`;
  const head = meta + canvasThemeStyle(theme);
  const boot = canvasBootstrapScript();
  const withBoot = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${boot}</body>`) : html + boot;
  if (/<head[\s>]/i.test(withBoot)) return withBoot.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  if (/<html[\s>]/i.test(withBoot)) return withBoot.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
  return `<!doctype html><html><head>${head}<style>html,body{margin:0}</style></head><body>${withBoot}</body></html>`;
}

export function CanvasCard({
  canvasId,
  title,
  html,
  height,
  theme,
  status,
  onExpand,
}: {
  canvasId?: string;
  title: string;
  html: string;
  height?: number;
  theme?: string;
  status: string;
  onExpand?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const [showSource, setShowSource] = useState(false);
  const [edited, setEdited] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const srcdoc = useMemo(() => (html ? wrapHtml(html, theme) : ""), [html, theme]);
  const h = Math.min(720, Math.max(120, Math.round(height || 360)));
  const titleRef = useRef(title);
  titleRef.current = title;

  useEffect(() => {
    if (!canvasId) return;
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== frameRef.current?.contentWindow) return;
      const d = ev.data as CanvasFrameMessage | undefined;
      if (!d || d.ns !== CANVAS_MSG_NS || (d.type !== "init" && d.type !== "update")) return;
      if (!Array.isArray(d.fields)) return;
      reportCanvasSnapshot(canvasId, d.title || titleRef.current, d.type, d.fields);
      if (d.type === "update") setEdited(true);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [canvasId]);
  const building = status === "streaming_args" || (!html && status !== "success" && status !== "error" && status !== "denied");

  const iconBtn =
    "flex items-center justify-center size-7 rounded-md text-[#888] dark:text-[#8C8C8C] hover:text-[#1A1A1A] dark:hover:text-[#EDEDED] hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors";

  return (
    <div
      data-testid="canvas-card"
      className="my-2 w-full max-w-[calc(var(--reader-w)*var(--chat-scale,1))] rounded-xl border border-[#E4E2D3] dark:border-[#333] bg-[var(--app-surface)] dark:bg-[#1E1E1E] overflow-hidden oiia-shadow-pop"
      style={{ zoom: "var(--canvas-unzoom, 1)", contain: "paint" } as CSSProperties}
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-[#EFEDE3] dark:border-[#2C2C2C]">
        <button type="button" onClick={() => setOpen((v) => !v)} className={iconBtn} aria-label={t(open ? "canvas.collapse" : "canvas.expand")}>
          {open ? <ChevronDown className="size-[15px]" /> : <ChevronRight className="size-[15px]" />}
        </button>
        <span className="flex-1 min-w-0 truncate text-[12.5px] font-medium text-[#444] dark:text-[#CFCFCF]">
          {title || t("canvas.title")}
        </span>

        {edited && canvasId && (
          <span className="text-[10.5px] leading-none px-1.5 py-0.5 rounded text-[#8A6D2E] dark:text-[#CBAE6E] bg-[#F7F0E2] dark:bg-[#2A2519]" title={t("canvas.editedHint")}>
            {t("canvas.edited")}
          </span>
        )}
        {building && <Spinner className="size-[13px] text-[#999]" strokeWidth={2.4} />}
        {open && !building && (
          <>
            <button
              type="button"
              onClick={() => setShowSource((v) => !v)}
              className={`${iconBtn} ${showSource ? "!text-[#1A1A1A] dark:!text-[#EDEDED] bg-black/[0.05] dark:bg-white/[0.06]" : ""}`}
              title={t(showSource ? "canvas.preview" : "canvas.source")}
              aria-label={t(showSource ? "canvas.preview" : "canvas.source")}
            >
              {showSource ? <Eye className="size-[14px]" /> : <Code2 className="size-[14px]" />}
            </button>
            {onExpand && (
              <button type="button" onClick={onExpand} className={iconBtn} title={t("canvas.openSide")} aria-label={t("canvas.openSide")}>
                <PanelRight className="size-[14px]" />
              </button>
            )}
          </>
        )}
      </div>

      {building ? (
        open && (
          <div className="flex items-center justify-center gap-2 text-[12.5px] text-[#999] dark:text-[#777]" style={{ height: h }}>
            <Spinner className="size-[14px]" strokeWidth={2.2} /> {t("canvas.building")}
          </div>
        )
      ) : (
        <div style={{ display: open ? undefined : "none" }}>
          {showSource && (
            <div className="max-h-[520px] overflow-auto">
              <CodeBlock code={html} language="html" />
            </div>
          )}
          <iframe
            ref={frameRef}
            data-testid="canvas-frame"
            title={title || "canvas"}
            sandbox="allow-scripts"
            srcDoc={srcdoc}
            className="w-full block bg-white"
            style={{ height: h, border: 0, display: showSource ? "none" : "block" }}
            loading="lazy"
          />
        </div>
      )}
    </div>
  );
}
