import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

export type AppMenuOption = { value: string; label: string };

type AppMenuProps = {
  label: string;
  value: string;
  options: AppMenuOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
};

/** A Magpie-style listbox trigger, with native keyboard semantics. */
export function AppMenu({ label, value, options, onChange, disabled = false }: AppMenuProps) {
  const id = useId();
  const listId = `app-menu-${id.replace(/:/g, '')}`;
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const keyboardNavigation = useRef(true);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [active, setActive] = useState(selected);

  useEffect(() => setActive(selected), [selected]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!button.current || !list.current) return;
      const rect = button.current.getBoundingClientRect();
      const margin = 8;
      const gap = 4;
      const width = Math.min(
        Math.max(rect.width, 170),
        Math.max(0, window.innerWidth - margin * 2),
      );
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
      const above = Math.max(0, rect.top - gap - margin);
      const desired = Math.min(280, list.current.scrollHeight + 2);
      const upward = below < desired && above > below;
      const maxHeight = Math.min(280, upward ? above : below);
      const height = Math.min(desired, maxHeight);
      setPosition({
        top: upward ? rect.top - gap - height : rect.bottom + gap,
        left: Math.max(margin, Math.min(rect.left, window.innerWidth - margin - width)),
        width,
        maxHeight,
      });
    };
    place();
    window.addEventListener('resize', place);
    const onScroll = (event: Event) => {
      if (event.target !== list.current) place();
    };
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, options.length]);
  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open || !list.current || !keyboardNavigation.current) return;
    const option = list.current.querySelector<HTMLElement>(`[id="${listId}-option-${active}"]`);
    if (!option) return;
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < list.current.scrollTop) list.current.scrollTop = top;
    else if (bottom > list.current.scrollTop + list.current.clientHeight)
      list.current.scrollTop = bottom - list.current.clientHeight;
  }, [active, listId, open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent | PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !list.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  const choose = (next: number) => {
    const option = options[next];
    if (!option) return;
    setActive(next);
    onChange(option.value);
    setOpen(false);
    button.current?.focus();
  };

  const move = (delta: number) => {
    if (!options.length) return;
    setActive((current) => (current + delta + options.length) % options.length);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    keyboardNavigation.current = true;
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      if (!open) setOpen(true);
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(0, options.length - 1));
    } else if (event.key === 'Tab') {
      setOpen(false);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(active);
    }
  };

  return (
    <div className="app-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="app-menu-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          keyboardNavigation.current = true;
          setActive(selected);
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (
            event.key === 'ArrowDown' ||
            event.key === 'ArrowUp' ||
            event.key === 'Enter' ||
            event.key === ' '
          ) {
            event.preventDefault();
            keyboardNavigation.current = true;
            setActive(selected);
            setOpen(true);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      >
        <span>{options.find((option) => option.value === value)?.label ?? value}</span>
        <span className="app-menu-chevron" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open &&
        createPortal(
          <div
            id={listId}
            ref={list}
            className="app-menu-list"
            role="listbox"
            aria-label={label}
            aria-activedescendant={`${listId}-option-${active}`}
            tabIndex={0}
            style={position ? { ...position, visibility: 'visible' } : { visibility: 'hidden' }}
            onKeyDown={onListKeyDown}
            onBlur={(event) => {
              if (
                !root.current?.contains(event.relatedTarget as Node) &&
                !list.current?.contains(event.relatedTarget as Node)
              )
                setOpen(false);
            }}
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                id={`${listId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={[
                  option.value === value ? 'selected' : '',
                  index === active ? 'active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                tabIndex={-1}
                onMouseMove={(event) => {
                  if (!event.movementX && !event.movementY) return;
                  keyboardNavigation.current = false;
                  setActive(index);
                }}
                onClick={() => choose(index)}
              >
                <span>{option.label}</span>
                {option.value === value && <span aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
