import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";

export function DialogFrame(props: { title: string; onClose: () => void; dismissible?: boolean; className?: string; children: ReactNode }) {
  const { title, onClose, dismissible = true, className = "dialog", children } = props;
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    // StrictMode runs this twice, and closing in a cleanup would fire onClose and drop the dialog.
    if (element !== null && !element.open) {
      element.showModal();
      element.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
  }, []);

  return (
    <dialog
      ref={dialog}
      className={className}
      aria-label={title}
      onClose={(event) => {
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current && dismissible) {
          onClose();
        }
      }}
    >
      {children}
    </dialog>
  );
}

export function Dialog(props: { title: string; onClose: () => void; dismissible?: boolean; children: ReactNode; footer?: ReactNode }) {
  const { title, onClose, dismissible = true, children, footer } = props;
  return (
    <DialogFrame title={title} onClose={onClose} dismissible={dismissible}>
      <div className="dialog-box">
        <div className="dialog-head">
          <span>{title}</span>
          <button type="button" className="icon-button" aria-label="Close" disabled={!dismissible} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer !== undefined && <div className="dialog-foot">{footer}</div>}
      </div>
    </DialogFrame>
  );
}
