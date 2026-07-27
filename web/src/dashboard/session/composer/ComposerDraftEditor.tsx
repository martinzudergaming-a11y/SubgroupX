import { useRef } from "react";
import { Modal, ModalContent, ModalDescription, ModalDismiss, ModalTitle } from "../../../ui/Modal";
import { ComposerActionButton } from "./composer-controls";
import { useT } from "../../../i18n";
import type { SessionStatus } from "@shared/protocol";

const PRIMARY_CHORD = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform) ? "⌘↵" : "Ctrl↵";

export function ComposerDraftEditor({
  open,
  onOpenChange,
  text,
  onChangeText,
  status,
  uploading,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  text: string;
  onChangeText: (text: string) => void;
  status: SessionStatus;
  uploading: boolean;
  onSend: (mode?: "steer" | "queue") => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const running = status === "running";
  const dispatchable = text.trim().length > 0 && !uploading;
  const lines = text.length === 0 ? 0 : text.split("\n").length;

  const dispatch = (mode?: "steer" | "queue") => {
    if (!dispatchable) return;
    onSend(mode);
    onOpenChange(false);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        data-testid="draft-editor"
        className="max-w-[720px] max-h-[min(86vh,720px)]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 pt-4 pb-2.5">
          <ModalTitle>{t("composer.draftEditorTitle")}</ModalTitle>
          <ModalDescription className="hidden sm:block text-[11.5px]">{t("composer.draftEditorHint")}</ModalDescription>
        </div>
        <textarea
          ref={inputRef}
          data-testid="draft-editor-input"
          value={text}
          onChange={(event) => onChangeText(event.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
            if (composingRef.current) return;
            event.preventDefault();
            dispatch(running ? "steer" : undefined);
          }}
          className="mx-5 h-[min(56vh,540px)] resize-none rounded-xl border border-[#E3E6DD] bg-[var(--app-surface)] px-4 py-3 text-[14.5px] leading-6 text-gray-800 outline-none focus-visible:border-[#AEB4AA] focus-visible:ring-1 focus-visible:ring-black/[0.08] dark:border-[#3A3C38] dark:bg-[#232421] dark:text-[#E0E0E0] dark:focus-visible:border-[#555751]"
        />
        <div className="flex items-center gap-2 px-5 py-3.5">
          <span className="text-[11px] tabular-nums text-[#99968D] dark:text-[#77736A]">
            {t("composer.draftStats", { lines, chars: text.length })}
          </span>
          <span className="flex-1" />
          <ComposerActionButton data-testid="draft-editor-done" tone="quiet" onClick={() => onOpenChange(false)}>
            {t("composer.draftEditorDone")}
          </ComposerActionButton>
          {running ? (
            <>
              <ComposerActionButton tone="quiet" disabled={!dispatchable} title={t("chat.queueHint")} onClick={() => dispatch("queue")}>
                {t("chat.queue")}
              </ComposerActionButton>
              <ComposerActionButton data-testid="draft-editor-send" tone="strong" disabled={!dispatchable} title={t("chat.steerHint")} hint={PRIMARY_CHORD} onClick={() => dispatch("steer")}>
                {t("chat.steer")}
              </ComposerActionButton>
            </>
          ) : (
            <ComposerActionButton data-testid="draft-editor-send" tone="strong" disabled={!dispatchable} hint={PRIMARY_CHORD} onClick={() => dispatch()}>
              {t("composer.draftEditorSend")}
            </ComposerActionButton>
          )}
        </div>
        <ModalDismiss />
      </ModalContent>
    </Modal>
  );
}
