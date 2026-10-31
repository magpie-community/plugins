// Generic dialog primitive: scrim + card + close on Esc/scrim.
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n/index.js";

export function Dialog({
  title, children, footer, onClose, wide,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An open dropdown (SelectMenu) inside the dialog takes Esc first: it closes itself, not the dialog
      if (e.key === "Escape" && !document.querySelector("[data-select-menu]")) { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="dlg-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg" style={wide ? { width: 560 } : undefined} role="dialog" aria-label={title}>
        <div className="dlg-title">{title}</div>
        <div className="dlg-body">{children}</div>
        {footer && <div className="dlg-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// Confirmation dialog (second confirmation for delete/discard etc.).
export function ConfirmDialog({
  title, body, okLabel, danger, onOk, onClose,
}: {
  title: string; body: ReactNode; okLabel?: string; danger?: boolean;
  onOk: () => void; onClose: () => void;
}) {
  const ok = okLabel ?? t("common.ok");
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>{t("common.cancel")}</button>
          <button className={`btn${danger ? " danger" : " primary"}`} onClick={() => { onClose(); onOk(); }}>
            {ok}
          </button>
        </>
      }
    >
      <div className="dlg-hint" style={{ fontSize: "var(--fs-m)", color: "var(--fg)" }}>{body}</div>
    </Dialog>
  );
}
