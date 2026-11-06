import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";

export function Dialog(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const { title, onClose, children, footer } = props;
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
      className="dialog"
      aria-label={title}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) {
          onClose();
        }
      }}
    >
      <div className="dialog-box">
        <div className="dialog-head">
          <span>{title}</span>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer !== undefined && <div className="dialog-foot">{footer}</div>}
      </div>
    </dialog>
  );
}
