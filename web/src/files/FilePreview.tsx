import { useEffect, useRef, useState } from "react";
import { X, Copy, Check, ExternalLink } from "lucide-react";
import { fileIconFor } from "./fileIcons";
import { FileContentView, FileViewToggle, renderKindOf, type FileViewMode } from "./FileContentView";
import { writeClipboard } from "../platform/clipboard";
import { api, type FilePreviewSource } from "../platform/api";
import { logClient } from "../platform/client-log";
import { useT } from "../i18n";
import { useCopyFlag } from "../ui/useCopyFlag";
import { acquireFilePreviewSource, mediaPreviewKind, type MediaPreviewKind } from "./media-preview-source";
import { fetchBlobWithProgress } from "../platform/progressive-media";
import { ByteProgressRing, type ByteProgress } from "../ui/ByteProgressRing";

type PdfPreviewModule = typeof import("./PdfPreview");
type PdfPreviewComponent = PdfPreviewModule["PdfPreview"];
let pdfPreviewModule: Promise<PdfPreviewModule> | null = null;
const loadPdfPreview = () => pdfPreviewModule ??= import("./PdfPreview").catch((error) => {
  pdfPreviewModule = null;
  throw error;
});
export function warmPdfPreviewRuntime(): void {
  void loadPdfPreview().catch(() => {});
}

function MediaPreview({ sessionId, path, kind, fragment, locationNonce, versionHint, integratedToolbar = false }: { sessionId: string; path: string; kind: MediaPreviewKind; fragment?: string; locationNonce?: number; versionHint: string; integratedToolbar?: boolean }) {
  const t = useT();
  const key = JSON.stringify([sessionId, path, versionHint]);
  const autoRetriedKey = useRef("");
  const [retryRequest, setRetryRequest] = useState<{ nonce: number; key: string; replaceGeneration?: number }>({ nonce: 0, key: "" });
  const [PdfRenderer, setPdfRenderer] = useState<PdfPreviewComponent | null>(null);
  const [runtimeError, setRuntimeError] = useState("");
  const [result, setResult] = useState<{ key: string; sessionId: string; path: string; source: FilePreviewSource | null; generation?: number; release?: () => void; failed: boolean; reason?: string }>(() => ({
    key,
    sessionId,
    path,
    source: null,
    failed: false,
  }));
  const fresh = result.key === key;
  const source = result.sessionId === sessionId && result.path === path ? result.source : null;
  const failed = (fresh && result.failed) || Boolean(runtimeError);
  const failureReason = runtimeError || result.reason;
  useEffect(() => {
    if (kind !== "pdf" || PdfRenderer) return;
    let live = true;
    loadPdfPreview().then(
      (module) => { if (live) setPdfRenderer(() => module.PdfPreview); },
      (err: unknown) => {
        const reason = err instanceof Error ? err.message : "PDF runtime failed to load";
        logClient("preview_failed", reason, { sessionId, path });
        if (live) setRuntimeError(reason);
      },
    );
    return () => { live = false; };
  }, [kind, PdfRenderer, retryRequest.nonce, sessionId, path]);
  useEffect(() => {
    if (kind === "pdf") warmPdfPreviewRuntime();
    let live = true;
    const replaceGeneration = retryRequest.key === key ? retryRequest.replaceGeneration : undefined;
    acquireFilePreviewSource(sessionId, path, versionHint, replaceGeneration).then(
      (lease) => {
        if (live) {
          setResult({ key, sessionId, path, source: lease.source, generation: lease.generation, release: lease.release, failed: false });
        } else {
          lease.release();
        }
      },
      (err: unknown) => {
        const reason = err instanceof Error ? err.message : "";
        logClient("preview_failed", reason || "media preview load failed", { sessionId, path });
        if (live) setResult({ key, sessionId, path, source: null, failed: true, reason });
      },
    );
    return () => {
      live = false;
    };
  }, [sessionId, path, kind, versionHint, key, retryRequest]);
  useEffect(() => () => { result.release?.(); }, [result.release]);

  const retryPreview = (automatic = false): boolean => {
    if (automatic) {
      if (autoRetriedKey.current === key) return false;
      autoRetriedKey.current = key;
    } else {
      autoRetriedKey.current = "";
    }
    if (!automatic && runtimeError) {
      window.location.reload();
      return true;
    }
    setRuntimeError("");
    setResult((current) => ({
      key,
      sessionId,
      path,
      source: automatic && current.sessionId === sessionId && current.path === path ? current.source : null,
      generation: current.sessionId === sessionId && current.path === path ? current.generation : undefined,
      release: automatic && current.sessionId === sessionId && current.path === path ? current.release : undefined,
      failed: false,
    }));
    setRetryRequest((current) => ({
      nonce: current.nonce + 1,
      key,
      replaceGeneration: result.sessionId === sessionId && result.path === path ? result.generation : undefined,
    }));
    return true;
  };
  const markImageFailed = () => {
    const reason = "image decode failed";
    logClient("preview_failed", reason, { sessionId, path });
    setResult((current) => ({
      key,
      sessionId,
      path,
      source: null,
      generation: current.sessionId === sessionId && current.path === path ? current.generation : undefined,
      failed: true,
      reason,
    }));
  };
  const markSourceReady = () => { autoRetriedKey.current = ""; };
  const openFullViewer = (page?: number) => {
    const popup = window.open("about:blank", "_blank");
    if (!popup) return;
    popup.opener = null;
    void api.filePreviewSource(sessionId, path, "full-viewer").then(
      (detached) => {
        const location = page ? `page=${page}` : fragment;
        popup.location.replace(`${detached.url}${location ? `#${location}` : ""}`);
      },
      () => popup.close(),
    );
  };

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
        <div className="text-[12.5px] text-[#B4453B] dark:text-[#E59A92]">{t("file.previewFailed")}</div>
        {failureReason && (
          <div className="max-w-[420px] text-[11.5px] leading-relaxed text-[#999] dark:text-[#777] break-words">{failureReason}</div>
        )}
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <button type="button" onClick={() => retryPreview(false)} className="rounded-md border border-[#D8D9D2] bg-white px-3 py-1.5 text-[11.5px] text-[#555] transition-[transform,background-color] duration-150 ease-[cubic-bezier(.16,1,.3,1)] active:scale-[.97] hover:bg-[#F1F1EC] motion-reduce:transition-none dark:border-[#444] dark:bg-[#252525] dark:text-[#CCC] dark:hover:bg-[#303030]">{t(runtimeError ? "file.reload" : "pdf.retry")}</button>
          {kind === "pdf" && source && (
            <button type="button" onClick={() => openFullViewer()} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11.5px] text-[#777] hover:text-[#333] dark:text-[#999] dark:hover:text-[#DDD]">
              <ExternalLink className="size-3.5" />{t("pdf.openFullViewer")}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!source || (kind === "pdf" && !PdfRenderer)) {
    return <div className="flex h-full items-center justify-center text-[12.5px] text-[#999] dark:text-[#777]">{t("file.previewLoading")}</div>;
  }
  if (kind === "pdf" && PdfRenderer) {
    return (
      <PdfRenderer url={source.url} path={path} size={source.size} version={source.version} fragment={fragment} locationNonce={locationNonce} integratedToolbar={integratedToolbar} onRetry={() => { retryPreview(false); }} onSourceInvalid={() => retryPreview(true)} onSourceReady={markSourceReady} onOpenFullViewer={openFullViewer} />
    );
  }
  return (
    <ProgressiveImagePane
      url={source.url}
      path={path}
      expectedSize={source.size}
      onReady={markSourceReady}
      onFail={markImageFailed}
    />
  );
}

function ProgressiveImagePane({ url, path, expectedSize, onReady, onFail }: {
  url: string;
  path: string;
  expectedSize?: number;
  onReady: () => void;
  onFail: () => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<ByteProgress | null>(null);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    const controller = new AbortController();
    setObjectUrl(null);
    setProgress(null);
    setFallback(false);
    fetchBlobWithProgress(url, {
      signal: controller.signal,
      onProgress: (p) => {
        if (live) setProgress({ loaded: p.loaded, total: p.total ?? (expectedSize && expectedSize > 0 ? expectedSize : null) });
      },
    }).then(
      ({ url: fetched }) => {
        if (!live) {
          URL.revokeObjectURL(fetched);
          return;
        }
        made = fetched;
        setObjectUrl(fetched);
      },
      () => {
        if (live) setFallback(true);
      },
    );
    return () => {
      live = false;
      controller.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [url, expectedSize]);
  const src = fallback ? url : objectUrl;
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-4">
      {src ? (
        <img src={src} alt={path} decoding="async" onLoad={onReady} onError={onFail} className="max-h-full max-w-full object-contain" />
      ) : (
        <ByteProgressRing progress={progress} className="text-[#989A92] dark:text-[#74776F]" />
      )}
    </div>
  );
}

export function FilePreview({
  sessionId,
  fileName,
  content,
  fragment,
  locationNonce,
  mediaVersion = "",
  onClose,
  openFiles,
  onSelectFile,
  integratedPdfToolbar = false,
}: {
  sessionId: string;
  fileName: string;
  content: string;
  fragment?: string;
  locationNonce?: number;
  mediaVersion?: string;
  onClose: () => void;
  openFiles?: string[];
  onSelectFile?: (path: string) => void;
  integratedPdfToolbar?: boolean;
}) {
  const t = useT();
  const { copied, flash } = useCopyFlag(1500);

  const mediaKind = mediaPreviewKind(fileName);
  const renderKind = renderKindOf(fileName);
  const [mode, setMode] = useState<FileViewMode>("preview");
  useEffect(() => { setMode("preview"); }, [fileName]);
  const documentTabs = openFiles?.length ? openFiles : [fileName];

  async function copyAll() {
    if (await writeClipboard(content)) {
      flash();
    }
  }

  return (
    <div className="@container/file flex-1 h-full min-w-0 bg-[var(--app-surface)] dark:bg-[#1A1A1A] flex flex-col z-0">
      <div data-testid="file-header" className="flex items-center gap-1.5 px-2 h-12 border-b border-[#E8EBE3] dark:border-[#333] shrink-0 bg-[var(--app-surface)] dark:bg-[#1A1A1A]">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
          {documentTabs.map((file) => {
            const label = file.split('/').pop() ?? file;
            const active = file === fileName;
            return (
              <button
                key={file}
                type="button"
                aria-label={label}
                title={file}
                onClick={() => onSelectFile?.(file)}
                className={`flex h-8 min-w-0 max-w-[11rem] shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] outline-none transition-[transform,background-color,color] duration-150 ease-[cubic-bezier(.16,1,.3,1)] active:scale-[.98] focus-visible:ring-2 focus-visible:ring-[#C77D2E]/35 motion-reduce:transition-none ${active ? 'bg-[#ECEFE8] font-medium text-[#3C403A] dark:bg-[#2C2E2B] dark:text-[#E0E2DD]' : 'text-[#858981] hover:bg-[#F0F2ED] hover:text-[#4B4F48] dark:text-[#858A82] dark:hover:bg-[#272927] dark:hover:text-[#CBCDCA]'}`}
              >
                <span className="shrink-0">{fileIconFor(label)}</span>
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>
        {integratedPdfToolbar && mediaKind === "pdf" && (
          <div aria-hidden="true" className="h-10 w-52 shrink-0 @sm/file:w-[21rem]" />
        )}
        <div className="flex items-center gap-1 shrink-0">

          {!mediaKind && renderKind && <FileViewToggle mode={mode} onChange={setMode} />}

          {!mediaKind && (
            <button type="button"
              onClick={copyAll}
              aria-label={t("file.copyContents")}
              title={t("file.copyContents")}
              className="p-2.5 md:p-1 min-h-10 min-w-10 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md hover:bg-[#EAEAEA] dark:hover:bg-[#333] text-[#888] hover:text-[#333] dark:hover:text-[#E0E0E0] transition-colors"
            >
              {copied ? <Check className="size-4 text-[#2E7D45]" /> : <Copy className="size-4" />}
            </button>
          )}
          <button type="button"
            onClick={onClose}
            aria-label={t("file.closeNamed", { name: fileName.split('/').pop() ?? fileName })}
            className="p-2.5 md:p-1 min-h-10 min-w-10 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md hover:bg-[#EAEAEA] dark:hover:bg-[#333] text-[#888] hover:text-[#333] dark:hover:text-[#E0E0E0] transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 w-full text-[13px] bg-[var(--app-surface)] dark:bg-[#1A1A1A] [--cb-surface:var(--app-surface)] dark:[--cb-surface:#1A1A1A] flex flex-col p-2">
        {mediaKind ? (
          <MediaPreview sessionId={sessionId} path={fileName} kind={mediaKind} fragment={fragment} locationNonce={locationNonce} versionHint={mediaVersion} integratedToolbar={integratedPdfToolbar} />
        ) : (
          <FileContentView fileName={fileName} content={content} mode={renderKind ? mode : undefined} />
        )}
      </div>
    </div>
  );
}
