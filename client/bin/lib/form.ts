import { TextRenderable } from '@opentui/core';
import { C } from '../theme';

export type FieldDef = {
  id:            string;
  label:         string;
  hint:          string;
  type:          'text' | 'toggle';
  value:         string;
  options?:      string[];
  /**
   * Optional display labels for each option (1-to-1 with `options`).
   * When present, the label is shown in the toggle slot instead of the raw
   * value.  The raw value is shown as the hint so users can always see the
   * underlying identifier.
   */
  optionLabels?: string[];
  ref?:          TextRenderable;
};

export type FormState = {
  cursor:  number;
  editing: boolean;
  editBuf: string;
};

type KeyEvent = { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean };

/** Returns the string to display inside the toggle slot for a given field. */
function slotText(field: FieldDef, state: FormState, idx: number): string {
  const ed = state.editing && idx === state.cursor;
  if (ed) return state.editBuf;
  if (field.type === 'toggle' && field.optionLabels && field.options) {
    const i = field.options.indexOf(field.value);
    if (i >= 0 && field.optionLabels[i] != null) return field.optionLabels[i]!;
  }
  return field.value;
}

export function renderField(field: FieldDef, idx: number, state: FormState): void {
  if (!field.ref) return;
  const sel  = idx === state.cursor;
  const ed   = sel && state.editing;
  const raw  = slotText(field, state, idx);
  const slot = ed
    ? (raw + '_').slice(-15).padEnd(14)
    : raw.padEnd(14).slice(0, 14);

  // When optionLabels are in use, show the underlying raw CAIP-2 value as the
  // hint so users always know what will actually be sent.
  const hintText = (field.type === 'toggle' && field.optionLabels && field.value !== '')
    ? field.value
    : field.hint;

  field.ref.content = `${sel ? '▶ ' : '  '}  ${field.label.padEnd(16)}  [ ${slot} ]   ${hintText}`;
  field.ref.fg = sel ? C.white : C.slate;
  field.ref.bg = sel ? C.panel : C.dark;
}

/** Advance a toggle field forward by one step. */
function toggleNext(field: FieldDef): void {
  const opts = field.options ?? [];
  field.value = opts[(opts.indexOf(field.value) + 1) % opts.length] ?? field.value;
}

/** Advance a toggle field backward by one step. */
function togglePrev(field: FieldDef): void {
  const opts = field.options ?? [];
  field.value = opts[(opts.indexOf(field.value) - 1 + opts.length) % opts.length] ?? field.value;
}

export function handleKey(
  key: KeyEvent,
  fields: FieldDef[],
  state: FormState,
  renderAll: () => void,
): 'start' | 'back' | null {
  if (state.editing) {
    if (key.name === 'return' || key.name === 'enter') {
      fields[state.cursor]!.value = state.editBuf;
      state.editing = false;
      state.editBuf = '';
      renderAll();
    } else if (key.name === 'escape') {
      state.editing = false;
      state.editBuf = '';
      renderAll();
    } else if (key.name === 'backspace') {
      state.editBuf = state.editBuf.slice(0, -1);
      renderField(fields[state.cursor]!, state.cursor, state);
    } else if (key.sequence?.length === 1 && !key.ctrl && !key.meta && key.sequence >= ' ') {
      state.editBuf += key.sequence;
      renderField(fields[state.cursor]!, state.cursor, state);
    }
    return null;
  }

  if (key.name === 'up' || key.name === 'k') {
    state.cursor = (state.cursor - 1 + fields.length) % fields.length;
    renderAll();
  } else if (key.name === 'down' || key.name === 'j') {
    state.cursor = (state.cursor + 1) % fields.length;
    renderAll();
  } else if (key.name === 'return' || key.name === 'enter') {
    const f = fields[state.cursor]!;
    if (f.type === 'toggle') {
      toggleNext(f);
      renderAll();
    } else {
      state.editBuf = f.value;
      state.editing = true;
      renderAll();
    }
  } else if (key.name === 'right') {
    // ← / → cycle toggles without pressing Enter
    const f = fields[state.cursor]!;
    if (f.type === 'toggle') { toggleNext(f); renderAll(); }
  } else if (key.name === 'left') {
    const f = fields[state.cursor]!;
    if (f.type === 'toggle') { togglePrev(f); renderAll(); }
  } else if (key.name === 's' || key.name === 'S') {
    return 'start';
  } else if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
    return 'back';
  }
  return null;
}
