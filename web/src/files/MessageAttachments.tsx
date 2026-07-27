import { useEffect, useRef, useState } from "react";
import { fileIconFor } from "./fileIcons";
import type { ParsedAttachment } from "./MessageAttachments-helpers";
import { acquireFilePreviewSource } from "./media-preview-source";

function AttachmentChip({
  sessionId,
  file,
  onOpenFile,
}: {
  sessionId: string;
  file: ParsedAttachment;
  onOpenFile?: (path: string) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (!file.isImage || !buttonRef.current) return;
    if (!("IntersectionObserver" in window)) {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry.isIntersecting),
      { rootMargin: "600px 0px" },
    );
    observer.observe(buttonRef.current);
    return () => observer.disconnect();
  }, [file.isImage]);
  useEffect(() => {
    if (!file.isImage || !nearViewport) {
      setThumb(null);
      return;
    }
    let live = true;
    let release = () => {};
    acquireFilePreviewSource(sessionId, file.path)
      .then((lease) => {
        if (live) {
          release = lease.release;
          setThumb(lease.source.url);
        } else {
          lease.release();
        }
      })
      .catch(() => {
      });
    return () => {
      live = false;
      release();
    };
  }, [sessionId, file.path, file.isImage, nearViewport]);

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => onOpenFile?.(file.path)}
      title={file.path}
      data-testid="msg-attachment"
      className="group flex max-w-[220px] items-center gap-2 rounded-lg border border-[#E8E8E8] dark:border-[#3A3A3A] bg-[#FAFAFA] dark:bg-[#222] py-1.5 pl-1.5 pr-2.5 text-left transition-colors hover:border-[#D0D0D0] dark:hover:border-[#4A4A4A]"
    >
      {file.isImage && thumb ? (
        <img src={thumb} alt={file.name} loading="lazy" decoding="async" onError={() => setThumb(null)} className="size-8 shrink-0 rounded object-cover" />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded bg-[#EEE] dark:bg-[#333]">
          {fileIconFor(file.name, 16)}
        </span>
      )}
      <span className="truncate text-[12px] text-[#333] dark:text-[#D0D0D0]">{file.name}</span>
    </button>
  );
}

export function MessageAttachments({
  sessionId,
  files,
  onOpenFile,
}: {
  sessionId: string;
  files: ParsedAttachment[];
  onOpenFile?: (path: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap justify-end gap-2" data-testid="msg-attachments">
      {files.map((f) => (
        <AttachmentChip key={f.path} sessionId={sessionId} file={f} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}
