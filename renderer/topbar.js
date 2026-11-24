// Top-bar overflow (Option A): as the window narrows, the tool pills first drop
// their text labels (icon-only), then any that still don't fit tuck into a "⋯ More"
// dropdown. Brand stays left; clock, shift and Exit stay pinned right. The app
// itself never scrolls sideways.
(function topbarOverflow() {
  const header  = document.querySelector('.topbar');
  const tools   = document.getElementById('topbar-tools');
  const moreBtn = document.getElementById('tb-more');
  const menu    = document.getElementById('tb-more-menu');
  if (!header || !tools || !moreBtn || !menu) return;

  // Collapsible pills in their natural bar order.
  const allPills = Array.from(tools.children).filter((el) =>
    el !== moreBtn && (el.classList.contains('pilltool') || el.classList.contains('pillbtn')));
  // Collapse order: these move into the menu first (lowest priority → highest).
  // Call tools (Phone / Inbound) are kept in the bar the longest.
  const pri = ['btn-sheets', 'sv-btn', 'bcc-btn', 'btn-direct', 'phone2-btn', 'inbound-btn', 'phone-btn']
    .map((id) => document.getElementById(id)).filter(Boolean);
  const ordered = allPills.filter((p) => pri.indexOf(p) === -1).concat(pri); // unlisted collapse first

  let laying = false;
  const overflowing = () => tools.scrollWidth > tools.clientWidth + 1;

  function layout() {
    if (laying) return; laying = true;
    // 1) reset — all pills back in the bar (original order), labels on, menu hidden
    menu.hidden = true; closeAria();
    allPills.forEach((p) => { if (p.parentNode !== tools) tools.insertBefore(p, moreBtn); p.classList.remove('in-menu'); });
    tools.classList.remove('icon-only');
    moreBtn.hidden = true;
    if (overflowing()) {
      // 2) compact to icon-only
      tools.classList.add('icon-only');
      if (overflowing()) {
        // 3) move lowest-priority pills into the menu until it fits
        moreBtn.hidden = false;
        for (const p of ordered) {
          if (p.hidden || p.offsetParent === null) continue; // skip pills that are themselves hidden
          if (!overflowing()) break;
          menu.appendChild(p); p.classList.add('in-menu');
        }
        if (!menu.querySelector('.pilltool, .pillbtn')) moreBtn.hidden = true;
      }
    }
    laying = false;
  }

  function closeAria() { moreBtn.setAttribute('aria-expanded', 'false'); }
  function openMenu() {
    menu.hidden = false;
    // Anchor under the More button, clamped on-screen.
    const maxLeft = header.clientWidth - menu.offsetWidth - 8;
    menu.style.right = 'auto';
    menu.style.left = Math.max(8, Math.min(moreBtn.offsetLeft, maxLeft)) + 'px';
    moreBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() { menu.hidden = true; closeAria(); }

  moreBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden ? openMenu() : closeMenu(); });
  menu.addEventListener('click', () => closeMenu());         // a pill inside was clicked
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== moreBtn) closeMenu(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) closeMenu(); });

  // Re-run on size changes and when pills show/hide (phones appear after login).
  let t = null;
  const relayout = () => { clearTimeout(t); t = setTimeout(layout, 80); };
  if (window.ResizeObserver) { try { new ResizeObserver(relayout).observe(header); } catch (_) {} }
  window.addEventListener('resize', relayout);
  const mo = new MutationObserver((muts) => { if (laying) return; for (const m of muts) { if (m.type === 'attributes') { relayout(); break; } } });
  allPills.forEach((p) => { try { mo.observe(p, { attributes: true, attributeFilter: ['hidden'] }); } catch (_) {} });

  layout();
  setTimeout(layout, 300);
  setTimeout(layout, 1500);
})();
