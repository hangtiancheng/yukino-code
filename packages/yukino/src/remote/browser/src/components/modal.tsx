import { useRef, type ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "#/components/ui/dialog.js";
import { DIALOG_WIDTHS } from "#/constants.js";
import { ModalCloseContext } from "#/lib/modal-context.js";

interface ModalProps {
  label: string;
  children: ReactNode;
  onEscape?: () => void;
  maxWidth?: keyof typeof DIALOG_WIDTHS;
}
export function Modal({
  label,
  children,
  onEscape,
  maxWidth = "max-w-lg",
}: ModalProps) {
  const actions = useRef<{ close(): void; unmount(): void } | null>(null);
  return (
    <Dialog
      defaultOpen
      actionsRef={actions}
      onOpenChangeComplete={(open) => {
        if (!open) {
          onEscape?.();
        }
      }}
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (
          !open &&
          (!onEscape ||
            !["escape-key", "close-press", "imperative-action"].includes(
              details.reason,
            ))
        ) {
          details.cancel();
        }
      }}
    >
      <ModalCloseContext.Provider value={() => actions.current?.close()}>
        <DialogContent
          aria-label={label}
          showCloseButton={false}
          finalFocus={() =>
            document.querySelector<HTMLElement>(
              'textarea[aria-label="Message input"]',
            )
          }
          style={{ maxWidth: DIALOG_WIDTHS[maxWidth] }}
          className={`max-h-[85dvh] w-[calc(100%-1.5rem)] max-w-none sm:max-w-none flex flex-col gap-0 overflow-hidden rounded-2xl border border-rule bg-bg p-0 text-base shadow-2xl`}
        >
          {children}
        </DialogContent>
      </ModalCloseContext.Provider>
    </Dialog>
  );
}
export function ModalHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="border-b border-border bg-surface px-5 py-5 sm:px-6">
      <DialogTitle className="text-base font-semibold tracking-tight text-custom-label">
        {title}
      </DialogTitle>
      {subtitle && (
        <DialogDescription className="mt-1.5 text-xs leading-relaxed text-muted">
          {subtitle}
        </DialogDescription>
      )}
    </div>
  );
}
