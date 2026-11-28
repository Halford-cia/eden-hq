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

/**
 * One submission at a time (review P1-7): while `fn` is pending, further
 * calls are ignored and the given controls are disabled; they are enabled
 * again when it settles, so a failure can be retried.
 *   const run = inFlight(async () => { ... }, () => [button]);
 */
export function inFlight(fn, controls = () => []) {
  let busy = false;
  const run = async (...args) => {
    if (busy) return undefined;
    busy = true;
    const disabled = controls().filter(Boolean);
    for (const c of disabled) c.disabled = true;
    try {
      return await fn(...args);
    } finally {
      busy = false;
      for (const c of disabled) c.disabled = false;
    }
  };
  run.isBusy = () => busy;
  return run;
}

/**
 * For every action's failure (review round 3, P0): an `unavailable` answer
 * means the database no longer lets this account see what is on screen (a
 * roster change or a closed gate). The screen is taken down through
 * ctx.accessLost, which drops every cache and the membership list, and the
 * next screen asks afresh. Returns true when it did; the caller then stops.
 */
export async function lostAccess(ctx, err) {
  if (err?.kind !== 'unavailable' || !ctx.accessLost) return false;
  await ctx.accessLost();
  return true;
}

/**
 * A "Show more" control (review round 2, P1-6): `load` fetches and paints the
 * next page. While it runs the button is disabled; if it fails, what is on
 * screen stays, and a message beside the button says so and how to retry.
 * A page that arrives after the account changed is dropped by `load` itself
 * (ctx.current()). If the database now refuses access, the screen is taken
 * down (ctx.accessLost, review round 2, P0-1).
 * Returns the nodes to place in the `.more` container.
 */
export function moreControl(ctx, label, load) {
  const msg = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { type: 'button' }, label);
  const run = inFlight(async () => {
    msg.textContent = '';
    try {
      await load();
    } catch (e) {
      if (await lostAccess(ctx, e)) return;
      const why = e?.kind === 'network' || !e?.message
        ? 'Eden HQ could not be reached.'
        : e.message;
      msg.textContent = `Could not load more. ${why} What is shown is unchanged; tap ${label} to try again.`;
    }
  }, () => [btn]);
  btn.addEventListener('click', () => run());
  return [btn, msg];
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
