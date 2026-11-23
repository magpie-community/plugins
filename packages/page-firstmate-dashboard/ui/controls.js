// MagPie kernel.js menu/row conventions, f9807c5e844b. The service iframe
// cannot call the window's openProtoMenu across its sandbox boundary.
(() => {
  let active;
  const el = (tag, text, cls) => { const x = document.createElement(tag); if (text) x.textContent = text; if (cls) x.className = cls; return x; };
  function close(returnFocus = false) {
    if (!active) return;
    const { anchor, popup } = active;
    popup.remove(); anchor.setAttribute('aria-expanded', 'false'); active = null;
    if (returnFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
  }
  function bindMenu(anchor, options, value, onPick) {
    anchor.type = 'button'; anchor.classList.add('menu-pick');
    anchor.setAttribute('role', 'combobox'); anchor.setAttribute('aria-haspopup', 'listbox'); anchor.setAttribute('aria-expanded', 'false');
    const paint = () => {
      const selected = options.find(x => x.value === anchor.value);
      anchor.replaceChildren(...(selected?.render ? [selected.render()] : []), el('span', selected?.label || anchor.value || '请选择'), el('i', '', 'menu-arrows'));
    };
    anchor.setOptions = (next, selected) => { options = next; anchor.value = String(selected ?? ''); paint(); };
    anchor.setOptions(options, value);
    const show = () => {
      if (anchor.disabled) return;
      if (active?.anchor === anchor) { close(true); return; }
      close();
      const popup = el('div', '', 'fm-menu'); popup.setAttribute('role', 'listbox');
      popup.setAttribute('aria-label', anchor.getAttribute('aria-label') || '选择配置');
      const items = options.map(option => {
        const button = el('button', '', 'fm-menu-item'); button.type = 'button'; button.tabIndex = -1;
        button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(String(option.value) === anchor.value));
        button.append(el('span', String(option.value) === anchor.value ? '✓' : '', 'menu-tick'), ...(option.render ? [option.render()] : []), el('span', option.label));
        if (option.note) button.append(el('small', option.note));
        button.addEventListener('click', () => { anchor.value = String(option.value); paint(); close(true); onPick?.(anchor.value); });
        popup.append(button); return button;
      });
      document.body.append(popup); active = { anchor, popup }; anchor.setAttribute('aria-expanded', 'true');
      const rect = anchor.getBoundingClientRect();
      const below = innerHeight - rect.bottom - 12, above = rect.top - 12;
      const room = Math.max(80, below >= 180 || below >= above ? below : above);
      popup.style.maxHeight = `${Math.min(340, room)}px`;
      popup.style.width = `${Math.min(Math.max(rect.width, 210), innerWidth - 24)}px`;
      popup.style.left = `${Math.max(12, Math.min(rect.right - popup.offsetWidth, innerWidth - popup.offsetWidth - 12))}px`;
      popup.style.top = `${below >= 180 || below >= above ? rect.bottom + 5 : Math.max(8, rect.top - popup.offsetHeight - 5)}px`;
      let index = Math.max(0, options.findIndex(x => String(x.value) === anchor.value));
      const focus = () => { const item = items[index]; if (!item) return; item.focus({ preventScroll: true }); if (item.offsetTop < popup.scrollTop) popup.scrollTop = item.offsetTop; if (item.offsetTop + item.offsetHeight > popup.scrollTop + popup.clientHeight) popup.scrollTop = item.offsetTop + item.offsetHeight - popup.clientHeight; };
      focus();
      popup.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === 'Tab') { event.preventDefault(); close(true); }
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; focus();
        }
      });
    };
    anchor.addEventListener('click', show);
    anchor.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); } });
    return anchor;
  }
  function menu(label, options, value, onPick) { const b = el('button'); b.setAttribute('aria-label', label); return bindMenu(b, options, value, onPick); }
  document.addEventListener('pointerdown', event => { if (active && !active.popup.contains(event.target) && !active.anchor.contains(event.target)) close(); }, true);
  window.addEventListener('resize', () => close());
  document.addEventListener('scroll', event => { if (active && !active.popup.contains(event.target)) close(); }, true);
  window.FMControls = { menu, bindMenu, close };
})();
