// Tiny DOM helper. Text is always inserted as text nodes, never as HTML.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'class') {
      el.className = v;
    } else if (k === 'value') {
      el.value = v;
    } else if (k === 'checked' || k === 'selected' || k === 'disabled') {
      el[k] = Boolean(v);
      if (v) el.setAttribute(k, '');
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let idSeq = 0;
export function uid(prefix = 'f') {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

/** A labelled form control: returns [labelEl, controlEl] wrapped in a div. */
export function field(labelText, control, hint) {
  const id = control.id || uid('fld');
  control.id = id;
  return h('div', { class: 'field' },
    h('label', { for: id }, labelText),
    control,
    hint ? h('p', { class: 'hint' }, hint) : null);
}
