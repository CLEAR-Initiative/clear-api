/**
 * Shared form controls for portal surfaces (admin, developer portal).
 *
 * Tokens live in shell `:root`. This layer owns field chrome and the
 * custom select listbox so page templates do not restyle native widgets.
 */

const SELECT_CHEVRON = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M2.15 4.2 6 8.05 9.85 4.2 10.9 5.25 6 10.15 1.1 5.25z"/></svg>`;

export function renderPortalControlStyles(): string {
  return `
    /* Form controls — single source for inputs and dropdowns */
    .field, .field-select,
    .form-field input, .form-field select {
      width: 100%;
      padding: 0.55rem 0.7rem;
      border-radius: var(--radius-sm);
      border: 1px solid var(--color-border);
      background-color: var(--color-bg);
      color: var(--color-text);
      font-family: var(--font);
      font-size: 0.875rem;
      line-height: 1.3;
      color-scheme: dark;
    }
    .field, .field-select,
    .form-field input, .form-field select {
      height: var(--control-height);
    }
    .field:hover, .field-select:hover,
    .form-field input:hover, .form-field select:hover {
      border-color: var(--color-border-2);
    }
    .field:focus, .field-select:focus,
    .form-field input:focus, .form-field select:focus {
      outline: none;
      border-color: var(--color-accent);
    }
    .form-field select, .field-select {
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23999999' d='M2.15 4.2 6 8.05 9.85 4.2 10.9 5.25 6 10.15 1.1 5.25z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 0.7rem center;
      background-size: 12px 12px;
      padding-right: 2rem;
      cursor: pointer;
    }
    .form-field select:disabled, .field-select:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .form-field select option, .field-select option {
      background: var(--color-surface);
      color: var(--color-text);
    }
    .inline-form .field,
    .inline-form .field-select {
      width: auto;
      min-width: 9.5rem;
      max-width: 16rem;
      height: auto;
      padding: 0.35rem 0.6rem;
      border-radius: var(--radius-sm);
      font-size: 0.8rem;
    }
    .inline-form .field-select {
      min-width: 8.75rem;
      padding-right: 1.75rem;
      background-position: right 0.5rem center;
    }

    /* Custom select — open menu uses portal chrome, not the OS picker */
    .select {
      position: relative;
      display: block;
      width: 100%;
      height: var(--control-height);
    }
    .select--inline {
      display: inline-block;
      width: auto;
      min-width: 8.75rem;
      max-width: 16rem;
      height: auto;
      vertical-align: middle;
    }
    .select.is-enhanced > select.field-select {
      position: absolute;
      inset: 0;
      opacity: 0;
      pointer-events: none;
      width: 100%;
      height: 100%;
      margin: 0;
    }
    .select-trigger {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      height: 100%;
      min-height: var(--control-height);
      padding: 0.55rem 0.7rem;
      border-radius: var(--radius-sm);
      border: 1px solid var(--color-border);
      background: var(--color-bg);
      color: var(--color-text);
      font-family: var(--font);
      font-size: 0.875rem;
      line-height: 1.3;
      text-align: left;
      cursor: pointer;
      box-sizing: border-box;
    }
    .select--inline .select-trigger {
      min-height: 0;
      height: auto;
      padding: 0.35rem 0.6rem;
      font-size: 0.8rem;
    }
    .select-trigger:hover {
      border-color: var(--color-border-2);
    }
    .select.is-open .select-trigger,
    .select-trigger:focus {
      outline: none;
      border-color: var(--color-accent);
    }
    .select-trigger:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .select-trigger-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .select-trigger-icon {
      flex-shrink: 0;
      display: flex;
      color: var(--color-muted);
      transition: transform 0.15s ease;
    }
    .select.is-open .select-trigger-icon {
      transform: rotate(180deg);
      color: var(--color-text);
    }
    .select-menu {
      display: none;
      position: fixed;
      z-index: 280;
      min-width: 8rem;
      max-width: min(24rem, 90vw);
      max-height: 16rem;
      overflow-y: auto;
      padding: 4px;
      background: var(--color-surface-2);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
      color-scheme: dark;
    }
    .select-menu.is-open {
      display: block;
    }
    .select-option {
      display: block;
      width: 100%;
      padding: 0.45rem 0.7rem;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--color-text);
      font-family: var(--font);
      font-size: 0.875rem;
      line-height: 1.35;
      text-align: left;
      cursor: pointer;
    }
    .select--inline .select-option {
      font-size: 0.8rem;
    }
    .select-option:hover,
    .select-option.is-active {
      background: var(--color-surface-3);
    }
    .select-option.is-selected {
      background: var(--color-accent-soft);
      color: var(--color-text);
    }
    .select-option.is-selected.is-active,
    .select-option.is-selected:hover {
      background: var(--color-accent);
      color: var(--on-accent);
    }
    .select-option:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
`;
}

export function renderPortalControlScript(): string {
  return `
    (function enhancePortalSelects() {
      var chevron = ${JSON.stringify(SELECT_CHEVRON)};
      var openWrap = null;

      function selectedLabel(select) {
        var opt = select.options[select.selectedIndex];
        return opt ? opt.text : '';
      }

      function closeSelect(wrap) {
        if (!wrap) return;
        wrap.classList.remove('is-open');
        var trigger = wrap.querySelector('.select-trigger');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        var menu = wrap._selectMenu;
        if (menu) menu.classList.remove('is-open');
        if (openWrap === wrap) openWrap = null;
      }

      function closeAll() {
        document.querySelectorAll('.select.is-open').forEach(closeSelect);
      }

      function positionMenu(wrap) {
        var trigger = wrap.querySelector('.select-trigger');
        var menu = wrap._selectMenu;
        if (!trigger || !menu) return;
        menu.classList.add('is-open');
        var rect = trigger.getBoundingClientRect();
        var top = rect.bottom + 4;
        var spaceBelow = window.innerHeight - top;
        if (spaceBelow < 120 && rect.top > spaceBelow) {
          menu.style.top = 'auto';
          menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
        } else {
          menu.style.bottom = 'auto';
          menu.style.top = top + 'px';
        }
        menu.style.left = rect.left + 'px';
        menu.style.minWidth = Math.max(rect.width, 140) + 'px';
      }

      function syncOptions(wrap) {
        var select = wrap.querySelector('select.field-select');
        var menu = wrap._selectMenu || wrap.querySelector('.select-menu');
        var trigger = wrap.querySelector('.select-trigger-label');
        if (!select || !menu || !trigger) return;
        trigger.textContent = selectedLabel(select) || 'Select…';
        menu.innerHTML = '';
        Array.prototype.forEach.call(select.options, function (opt, i) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'select-option' + (opt.selected ? ' is-selected' : '');
          btn.setAttribute('role', 'option');
          btn.setAttribute('data-index', String(i));
          if (opt.disabled) btn.disabled = true;
          if (opt.selected) btn.setAttribute('aria-selected', 'true');
          btn.textContent = opt.text;
          menu.appendChild(btn);
        });
      }

      function setActive(wrap, index) {
        var menu = wrap._selectMenu;
        if (!menu) return;
        var options = menu.querySelectorAll('.select-option');
        options.forEach(function (el, i) {
          el.classList.toggle('is-active', i === index);
        });
        var active = options[index];
        if (active) active.scrollIntoView({ block: 'nearest' });
      }

      function choose(wrap, index) {
        var select = wrap.querySelector('select.field-select');
        if (!select || !select.options[index] || select.options[index].disabled) return;
        select.selectedIndex = index;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        syncOptions(wrap);
        closeSelect(wrap);
        var trigger = wrap.querySelector('.select-trigger');
        if (trigger) trigger.focus();
      }

      function openSelect(wrap) {
        var select = wrap.querySelector('select.field-select');
        if (!select || select.disabled) return;
        closeAll();
        syncOptions(wrap);
        wrap.classList.add('is-open');
        var trigger = wrap.querySelector('.select-trigger');
        if (trigger) trigger.setAttribute('aria-expanded', 'true');
        openWrap = wrap;
        positionMenu(wrap);
        setActive(wrap, select.selectedIndex >= 0 ? select.selectedIndex : 0);
      }

      function enhance(select) {
        if (select.closest('.select')) return;
        var wrap = document.createElement('div');
        wrap.className = 'select' + (select.closest('.inline-form') ? ' select--inline' : '');
        wrap.classList.add('is-enhanced');
        select.parentNode.insertBefore(wrap, select);
        wrap.appendChild(select);
        select.setAttribute('tabindex', '-1');
        select.setAttribute('aria-hidden', 'true');

        var trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'select-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.disabled = select.disabled;
        trigger.innerHTML = '<span class="select-trigger-label"></span><span class="select-trigger-icon">' + chevron + '</span>';

        var menu = document.createElement('div');
        menu.className = 'select-menu';
        menu.setAttribute('role', 'listbox');

        wrap.appendChild(trigger);
        document.body.appendChild(menu);
        wrap._selectMenu = menu;
        syncOptions(wrap);

        trigger.addEventListener('click', function (e) {
          e.preventDefault();
          if (wrap.classList.contains('is-open')) closeSelect(wrap);
          else openSelect(wrap);
        });
        trigger.addEventListener('keydown', function (e) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!wrap.classList.contains('is-open')) openSelect(wrap);
          }
        });
        menu.addEventListener('click', function (e) {
          var btn = e.target.closest('.select-option');
          if (!btn || btn.disabled) return;
          choose(wrap, Number(btn.getAttribute('data-index')));
        });
        menu.addEventListener('mouseover', function (e) {
          var btn = e.target.closest('.select-option');
          if (!btn) return;
          setActive(wrap, Number(btn.getAttribute('data-index')));
        });
        wrap.addEventListener('keydown', function (e) {
          if (!wrap.classList.contains('is-open')) return;
          var selectEl = wrap.querySelector('select.field-select');
          var max = selectEl.options.length - 1;
          var current = Array.prototype.findIndex.call(
            (wrap._selectMenu ? wrap._selectMenu.querySelectorAll('.select-option') : []),
            function (el) { return el.classList.contains('is-active'); }
          );
          if (current < 0) current = selectEl.selectedIndex;
          if (e.key === 'Escape') {
            e.preventDefault();
            closeSelect(wrap);
            trigger.focus();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive(wrap, Math.min(max, current + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive(wrap, Math.max(0, current - 1));
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            choose(wrap, current);
          } else if (e.key === 'Tab') {
            closeSelect(wrap);
          }
        });
        select.addEventListener('change', function () {
          syncOptions(wrap);
        });
      }

      function boot() {
        document.querySelectorAll('select.field-select').forEach(enhance);
      }

      document.addEventListener('mousedown', function (e) {
        if (!openWrap) return;
        var menu = openWrap._selectMenu;
        if (openWrap.contains(e.target) || (menu && menu.contains(e.target))) return;
        closeAll();
      });
      window.addEventListener('scroll', function () {
        if (openWrap) positionMenu(openWrap);
      }, true);
      document.addEventListener('DOMContentLoaded', boot);
      if (document.readyState !== 'loading') boot();
    })();

    (function bindRoleForms() {
      document.querySelectorAll('form.js-role-form').forEach(function (form) {
        var select = form.querySelector('select');
        var btn = form.querySelector('.btn-row-action');
        if (!select || !btn) return;
        var saved = select.getAttribute('data-stored') || select.value;

        function setDirty() {
          var dirty = select.value !== saved;
          btn.classList.toggle('is-dirty', dirty);
          btn.disabled = !dirty;
          if (dirty) hideCheck();
        }

        function checkEl() {
          var row = form.closest('.swipe-delete') || form.closest('tr') || form.closest('article');
          return row ? row.querySelector('.row-save-check') : null;
        }

        function hideCheck() {
          var check = checkEl();
          if (!check) return;
          check.classList.remove('is-visible');
          check.setAttribute('aria-hidden', 'true');
          check.removeAttribute('aria-label');
        }

        function showCheck() {
          var check = checkEl();
          if (!check) return;
          check.classList.add('is-visible');
          check.setAttribute('aria-hidden', 'false');
          check.setAttribute('aria-label', 'Saved');
        }

        select.addEventListener('change', setDirty);
        setDirty();

        form.addEventListener('submit', function (e) {
          e.preventDefault();
          if (select.value === saved) return;
          btn.disabled = true;
          var body = new URLSearchParams(new FormData(form));
          fetch(form.action, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
            credentials: 'same-origin',
          })
            .then(function (res) {
              return res.json().then(
                function (data) {
                  return { ok: !!(data && data.ok), message: data && data.message };
                },
                function () {
                  return { ok: false, message: 'Could not update role.' };
                },
              );
            })
            .then(function (result) {
              if (result.ok) {
                saved = select.value;
                select.removeAttribute('data-stored');
                setDirty();
                showCheck();
              } else {
                setDirty();
                btn.title = result.message || 'Could not update role.';
              }
            })
            .catch(function () {
              setDirty();
            });
        });
      });
    })();
`;
}
