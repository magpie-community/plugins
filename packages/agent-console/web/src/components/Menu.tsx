// Generic popup menu: anchored positioning, close on outside click/Esc.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | { kind: "item"; label: string; danger?: boolean; disabled?: boolean; checked?: boolean; onClick: () => void }
  | { kind: "sep" }
  | { kind: "label"; text: string };

export function Menu({
  x, y, items, onClose,
}: {
  x: number; y: number; items: MenuItem[]; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let { left, top } = pos;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
  }, [x, y]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="menu" style={pos} role="menu">
      {items.map((it, i) =>
        it.kind === "sep" ? (
          <div key={i} className="msep" />
        ) : it.kind === "label" ? (
          <div key={i} className="mlabel">{it.text}</div>
        ) : (
          <button
            key={i}
            className={`mi${it.danger ? " danger" : ""}`}
            disabled={it.disabled}
            role="menuitem"
            onClick={() => { onClose(); it.onClick(); }}
          >
            <span>{it.label}</span>
            {it.checked && <span className="mi-check">✓</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

// Trigger helper: turns onContextMenu/onClick into {x,y} state.
export function useMenu(): [{ x: number; y: number } | null, (e: React.MouseEvent) => void, () => void] {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPos({ x: e.clientX, y: e.clientY });
  };
  return [pos, open, () => setPos(null)];
}
