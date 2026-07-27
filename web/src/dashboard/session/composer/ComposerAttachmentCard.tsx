import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Expand, X } from "lucide-react";
import { fileIconFor } from "../../../files/fileIcons";
import { useT } from "../../../i18n";
import {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalDismiss,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from "../../../ui/Modal";

export type Attachment = {
  name: string;
  size: number;
  type: string;
  url?: string;
  file: File;
  kind?: "pasted-text";
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 100 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ComposerAttachmentCard({
  attachment,
  index,
  onRemove,
  onUpdatePastedText,
}: {
  attachment: Attachment;
  index: number;
  onRemove: (index: number) => void;
  onUpdatePastedText: (index: number, text: string) => string | null;
}) {
  const t = useT();
  const editable = attachment.kind === "pasted-text";
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const pendingTextRef = useRef("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState("");

  const changeOpen = (nextOpen: boolean) => {
    if (nextOpen) {
      setLoading(true);
      setLoadError(false);
      setSaveError("");
      setOpen(true);
      return;
    }
    pendingTextRef.current = "";
    setOpen(false);
  };

  useEffect(() => {
    if (!open || !editable) return;
    let live = true;
    setLoading(true);
    setLoadError(false);
    setSaveError("");
    void attachment.file.text().then(
      (text) => {
        if (!live) return;
        pendingTextRef.current = text;
        setLoading(false);
      },
      () => {
        if (!live) return;
        setLoadError(true);
        setLoading(false);
      },
    );
    return () => { live = false; };
  }, [attachment.file, editable, open]);

  useLayoutEffect(() => {
    if (!open || loading || loadError || !editorRef.current) return;
    const editor = editorRef.current;
    editor.value = pendingTextRef.current;
    pendingTextRef.current = "";
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(0, 0);
    editor.scrollTop = 0;
    editor.scrollLeft = 0;
  }, [loadError, loading, open]);

  const save = () => {
    const text = editorRef.current?.value;
    if (text == null) return;
    const error = onUpdatePastedText(index, text);
    if (error) {
      setSaveError(error);
      return;
    }
    changeOpen(false);
  };

  const fileVisual = (
    <>
      {attachment.url ? (
        <img src={attachment.url} alt={attachment.name} className="size-8 shrink-0 rounded object-cover" />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded bg-[#EEE] dark:bg-[#333]">
          {fileIconFor(attachment.name, 16)}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] text-[#333] dark:text-[#D0D0D0]">
          {editable ? t("chat.pastedText") : attachment.name}
        </span>
        <span className="truncate text-[10.5px] text-[#999] dark:text-[#777]">
          {editable ? `${t("chat.pastedTextType")} · ${formatFileSize(attachment.size)}` : formatFileSize(attachment.size)}
        </span>
      </span>
      {editable && <Expand className="size-3 shrink-0 text-[#AAA] transition-colors group-hover/edit:text-[#666] dark:text-[#666] dark:group-hover/edit:text-[#AAA]" />}
    </>
  );

  return (
    <Modal open={open} onOpenChange={changeOpen}>
      <div
        data-testid={editable ? "pasted-text-attachment" : "composer-attachment"}
        data-file-name={attachment.name}
        className="group relative flex max-w-[220px] items-stretch rounded-lg border border-[#E8E8E8] bg-[#FAFAFA] dark:border-[#3A3A3A] dark:bg-[#222]"
      >
        {editable ? (
          <button
            type="button"
            onClick={() => changeOpen(true)}
            aria-label={t("chat.editPastedText")}
            title={t("chat.pastedTextHint")}
            className="group/edit flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-1.5 pr-7 text-left outline-none transition-[transform,background-color] duration-150 ease-[cubic-bezier(.16,1,.3,1)] hover:bg-[#F4F3EF] active:scale-[.985] focus-visible:ring-2 focus-visible:ring-[#C77D2E]/35 motion-reduce:transition-none dark:hover:bg-[#292824]"
          >
            {fileVisual}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 pr-7">
            {fileVisual}
          </div>
        )}
        <button
          type="button"
          onClick={() => onRemove(index)}
          aria-label={t("chat.removeAttachment", { name: attachment.name })}
          className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-[#444] text-white opacity-70 outline-none transition-[transform,opacity] duration-150 ease-[cubic-bezier(.16,1,.3,1)] hover:opacity-100 active:scale-[.92] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[#C77D2E]/40 sm:opacity-0 sm:group-hover:opacity-100 motion-reduce:transition-none dark:bg-[#666]"
        >
          <X className="size-2.5" strokeWidth={3} />
        </button>
      </div>

      {editable && (
        <ModalContent
          data-testid="pasted-text-editor"
          className="!h-[min(82vh,760px)] !max-h-[760px] !max-w-[820px] !rounded-[18px] !bg-[var(--app-surface)] dark:!bg-[#1B1B19]"
          overlayClassName="!bg-[#E9ECE5]/88 dark:!bg-black/68"
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!loading && !loadError) save();
            }
          }}
        >
          <ModalDismiss />
          <ModalHeader className="border-b border-[#E4E7DF] px-6 pb-4 pt-5 dark:border-[#34342F]">
            <div className="flex items-center gap-3 pr-10">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#EEF0EA] dark:bg-[#292A26]">
                {fileIconFor(attachment.name, 17)}
              </span>
              <div className="min-w-0">
                <ModalTitle className="text-[16px]">{t("chat.pastedTextEditorTitle")}</ModalTitle>
                <ModalDescription className="mt-1 truncate text-[11.5px]">
                  {attachment.name} · {t("chat.pastedTextEditorDescription")}
                </ModalDescription>
              </div>
            </div>
          </ModalHeader>
          <ModalBody className="min-h-0 flex-1 p-0">
            {loading ? (
              <div className="flex h-full items-center justify-center text-[12px] text-[#999]">{t("chat.pastedTextLoading")}</div>
            ) : loadError ? (
              <div className="flex h-full items-center justify-center p-8 text-center text-[12px] text-[#A14B42]">{t("chat.pastedTextLoadFailed")}</div>
            ) : (
              <textarea
                ref={editorRef}
                data-testid="pasted-text-editor-input"
                onInput={() => { if (saveError) setSaveError(""); }}
                spellCheck={false}
                aria-label={t("chat.pastedTextEditorTitle")}
                className="size-full resize-none bg-[#FBFAF7] px-6 py-5 font-mono text-[16px] leading-[1.65] text-[#34342F] outline-none selection:bg-[#E9D7BF] sm:text-[13px] dark:bg-[#171714] dark:text-[#DDDAD1] dark:selection:bg-[#61472E]"
              />
            )}
          </ModalBody>
          <ModalFooter className="min-h-[62px] !flex-row items-center justify-between gap-3 space-x-0 border-t border-[#E4E7DF] bg-[var(--app-surface)] px-5 py-3 dark:border-[#34342F] dark:bg-[#1B1B19] sm:space-x-0">
            <div
              title={saveError || undefined}
              className={`min-w-0 flex-1 truncate text-[11px] ${saveError ? "text-[#A14B42] dark:text-[#E89B9B]" : "text-[#999] dark:text-[#777]"}`}
            >
              {saveError || t("chat.pastedTextSaveHint")}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ModalClose asChild>
                <button type="button" className="rounded-lg px-3 py-2 text-[12px] font-medium text-[#777] transition-[transform,background-color,color] duration-150 ease-[cubic-bezier(.16,1,.3,1)] hover:bg-[#F0F1EC] hover:text-[#333] active:scale-[.97] motion-reduce:transition-none dark:text-[#999] dark:hover:bg-[#292A26] dark:hover:text-[#DDD]">
                  {t("common.cancel")}
                </button>
              </ModalClose>
              <button
                type="button"
                data-testid="pasted-text-save"
                onClick={save}
                disabled={loading || Boolean(loadError)}
                className="rounded-lg bg-[#262722] px-3.5 py-2 text-[12px] font-medium text-white shadow-sm outline-none transition-[transform,background-color,opacity] duration-150 ease-[cubic-bezier(.16,1,.3,1)] hover:bg-[#151611] active:scale-[.97] focus-visible:ring-2 focus-visible:ring-[#C77D2E]/40 disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none dark:bg-[#E2DFD5] dark:text-[#24241F] dark:hover:bg-white"
              >
                {t("chat.pastedTextSave")}
              </button>
            </div>
          </ModalFooter>
        </ModalContent>
      )}
    </Modal>
  );
}
