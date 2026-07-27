import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export const MODAL_EXIT_DURATION_MS = 180;

const Modal = DialogPrimitive.Root;
const ModalTrigger = DialogPrimitive.Trigger;
const ModalPortal = DialogPrimitive.Portal;
const ModalClose = DialogPrimitive.Close;

const ModalOverlay = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay> & {
  ref?: React.Ref<React.ElementRef<typeof DialogPrimitive.Overlay>>;
}) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-white/76 dark:bg-black/40 backdrop-blur-[6px]",
      "data-[state=open]:animate-[modal-overlay-in_220ms_ease-out] data-[state=closed]:animate-[modal-overlay-out_180ms_ease-in]",
      "motion-reduce:animate-none",
      className,
    )}
    {...props}
  />
);
ModalOverlay.displayName = DialogPrimitive.Overlay.displayName;

const ModalContent = ({
  className,
  overlayClassName,
  overlayTestId,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  ref?: React.Ref<React.ElementRef<typeof DialogPrimitive.Content>>;
  overlayClassName?: string;
  overlayTestId?: string;
}) => (
  <ModalPortal>
    <ModalOverlay className={overlayClassName} data-testid={overlayTestId} />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed inset-0 z-50 m-auto flex h-fit max-h-[min(88vh,760px)] w-[calc(100%-2rem)] max-w-[520px] flex-col overflow-hidden",
        "bg-white dark:bg-[#151516]",
        "border border-black/[0.08] dark:border-white/[0.1]",
        "oiia-shadow-modal",
        "rounded-[16px] outline-none overflow-hidden",
        "data-[state=open]:animate-[modal-content-in_360ms_cubic-bezier(0.16,1,0.3,1)] data-[state=closed]:animate-[modal-content-out_180ms_ease-in]",
        "motion-reduce:animate-none",
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </ModalPortal>
);
ModalContent.displayName = DialogPrimitive.Content.displayName;

const ModalHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col space-y-1.5 px-5 pt-5 pb-3", className)}
    {...props}
  />
);
ModalHeader.displayName = "ModalHeader";

const ModalBody = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("px-5 pb-5", className)} {...props} />
);
ModalBody.displayName = "ModalBody";

const ModalFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-3 px-5 py-4", className)}
    {...props}
  />
);
ModalFooter.displayName = "ModalFooter";

const ModalTitle = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title> & {
  ref?: React.Ref<React.ElementRef<typeof DialogPrimitive.Title>>;
}) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-[15px] font-medium leading-none tracking-tight text-[#171717] dark:text-[#EDEDED]", className)}
    {...props}
  />
);
ModalTitle.displayName = DialogPrimitive.Title.displayName;

const ModalDescription = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description> & {
  ref?: React.Ref<React.ElementRef<typeof DialogPrimitive.Description>>;
}) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-[13px] text-[#737373] dark:text-[#A3A3A3] leading-relaxed", className)}
    {...props}
  />
);
ModalDescription.displayName = DialogPrimitive.Description.displayName;

const ModalDismiss = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close> & {
  ref?: React.Ref<React.ElementRef<typeof DialogPrimitive.Close>>;
}) => (
  <DialogPrimitive.Close
    ref={ref}
    className={cn(
      "absolute right-4 top-4 rounded-md p-1 text-[#888] transition-colors hover:bg-[#F3F4F6] hover:text-[#333] dark:text-[#A0A0A0] dark:hover:bg-[#2A2A2A] dark:hover:text-[#E0E0E0]",
      className,
    )}
    {...props}
  >
    <X className="size-4" />
    <span className="sr-only">Close</span>
  </DialogPrimitive.Close>
);
ModalDismiss.displayName = "ModalDismiss";

export {
  Modal,
  ModalPortal,
  ModalOverlay,
  ModalTrigger,
  ModalClose,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalTitle,
  ModalDescription,
  ModalDismiss,
};
