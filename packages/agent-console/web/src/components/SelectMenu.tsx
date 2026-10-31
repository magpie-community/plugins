// The page's own dropdown (Magpie's UI never shows a native <select> popup): a button trigger plus a small listbox menu.
// Keyboard: on the trigger ArrowDown/ArrowUp/Enter/Space open it; in the menu ArrowUp/ArrowDown/Home/End move, a letter jumps,
// Enter/Space pick, Esc/Tab close (Esc returns focus to the trigger). Click outside closes. The menu is portaled to <body> with
// fixed positioning, opens below the trigger or flips above it when there's no room (the composer sits at the bottom), and is
// kept inside the window; no browser popup is involved, so it behaves the same inside Magpie's sandboxed iframe.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type SelectOption<T extends string = string> = {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
};

const GAP = 4;
const EDGE = 8;

export function SelectMenu<T extends string>({
  value, options, onChange, ariaLabel, title, className, children, prefer = "down", matchWidth = false, menuClassName, upAnchor,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
  title?: string;
  className?: string;
  /** trigger content (icon + label); defaults to the selected option's label */
  children?: ReactNode;
  /** "up" for triggers at the bottom of the window (composer) */
  prefer?: "down" | "up";
  /** menu at least as wide as the trigger (form fields) */
  matchWidth?: boolean;
  menuClassName?: string;
  /** when opening upwards, sit above this ancestor of the trigger (e.g. ".cp-card": above the whole composer, not over its text) */
  upAnchor?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number; maxHeight: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const cur = options.find((o) => o.value === value);
  const enabled = (i: number) => i >= 0 && i < options.length && !options[i]!.disabled;

  const step = useCallback((from: number, dir: 1 | -1) => {
    for (let k = 1; k <= options.length; k++) {
      const i = (from + dir * k + options.length * 2) % options.length;
      if (!options[i]!.disabled) return i;
    }
    return from;
  }, [options]);

  const show = (at?: "first" | "last") => {
    const sel = options.findIndex((o) => o.value === value);
    let i = at === "first" ? step(-1, 1) : at === "last" ? step(0, -1) : sel;
    if (!enabled(i)) i = step(-1, 1);
    setActive(i);
    setPos(null);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };
  const pick = (i: number) => {
    if (!enabled(i)) return;
    close(true);
    if (options[i]!.value !== value) onChange(options[i]!.value);
  };

  // Position: below or above the trigger, whichever fits (prefer first), clamped to the window
  useLayoutEffect(() => {
    if (!open) return;
    const b = btnRef.current?.getBoundingClientRect();
    const m = menuRef.current;
    if (!b || !m) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minWidth = matchWidth ? b.width : 0;
    m.style.minWidth = `${minWidth}px`;
    const w = m.offsetWidth;
    const h = m.scrollHeight;
    const below = vh - b.bottom - GAP - EDGE;
    const anchorTop = (upAnchor && btnRef.current?.closest(upAnchor)?.getBoundingClientRect().top) || b.top;
    const above = anchorTop - GAP - EDGE;
    const up = prefer === "up" ? !(above < h && below > above) : below < h && above > below;
    const room = up ? above : below;
    const height = Math.min(h, room);
    const top = up ? anchorTop - GAP - height : b.bottom + GAP;
    const left = Math.max(EDGE, Math.min(b.left, vw - w - EDGE));
    setPos({ left, top: Math.max(EDGE, top), minWidth, maxHeight: Math.max(80, room) });
  }, [open, prefer, matchWidth, options.length, upAnchor]);

  // Focus the menu once it is placed, and keep the active option in view
  useEffect(() => {
    if (open && pos) menuRef.current?.focus({ preventScroll: true });
  }, [open, pos]);
  useEffect(() => {
    if (!open || active < 0) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  // Outside click / window resize close it
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close(false);
    };
    const onResize = () => close(false);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onResize);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onResize);
    };
  }, [open]);

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) close(false);
      else show(e.key === "ArrowUp" ? "last" : undefined);
    }
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === "ArrowDown") setActive((i) => step(i < 0 ? -1 : i, 1));
    else if (k === "ArrowUp") setActive((i) => step(i < 0 ? 0 : i, -1));
    else if (k === "Home") setActive(step(-1, 1));
    else if (k === "End") setActive(step(0, -1));
    else if (k === "Enter" || k === " ") pick(active);
    else if (k === "Escape") close(true);
    else if (k === "Tab") { close(true); return; }
    else if (k.length === 1 && /\S/.test(k)) {
      const ch = k.toLowerCase();
      for (let n = 1; n <= options.length; n++) {
        const i = (Math.max(active, 0) + n) % options.length;
        if (!options[i]!.disabled && options[i]!.label.toLowerCase().startsWith(ch)) { setActive(i); break; }
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={className}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-lb` : undefined}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onTriggerKey}
      >
        {children ?? <span className="sm-val">{cur?.label ?? ""}</span>}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={`${id}-lb`}
          className={`menu select-menu${menuClassName ? ` ${menuClassName}` : ""}`}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={active >= 0 ? `${id}-o${active}` : undefined}
          tabIndex={-1}
          data-select-menu=""
          style={pos ? { left: pos.left, top: pos.top, minWidth: pos.minWidth, maxHeight: pos.maxHeight } : { left: -9999, top: 0, visibility: "hidden" }}
          onKeyDown={onMenuKey}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              id={`${id}-o${i}`}
              data-i={i}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={`mi sm-opt${i === active ? " on" : ""}${o.disabled ? " off" : ""}${o.danger ? " danger" : ""}${o.hint ? " has-hint" : ""}`}
              onPointerMove={() => { if (!o.disabled && active !== i) setActive(i); }}
              onClick={() => pick(i)}
            >
              <span className="sm-text">
                <span className="sm-label">{o.label}</span>
                {o.hint && <span className="sm-hint">{o.hint}</span>}
              </span>
              <span className="sm-check" aria-hidden="true">{o.value === value ? (
                <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.2 5 8.6l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              ) : null}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
