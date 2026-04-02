import { TextRenderable } from '@opentui/core';
import { C } from '../theme';

export type FieldDef = {
  id:       string;
  label:    string;
  hint:     string;
  type:     'text' | 'toggle';
  value:    string;
  options?: string[];
  ref?:     TextRenderable;
};

export type FormState = {
  cursor:  number;
  editing: boolean;
  editBuf: string;
};

type KeyEvent = { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean };

export function renderField(field: FieldDef, idx: number, state: FormState): void {
  if (!field.ref) return;
  const sel  = idx === state.cursor;
  const ed   = sel && state.editing;
  const raw  = ed ? state.editBuf : field.value;
  const slot = ed
    ? (raw + '_').slice(-15).padEnd(14)
    : raw.padEnd(14).slice(0, 14);
  field.ref.content = `${sel ? '▶ ' : '  '}  ${field.label.padEnd(16)}  [ ${slot} ]   ${field.hint}`;
  field.ref.fg = sel ? C.white : C.slate;
  field.ref.bg = sel ? C.panel : C.dark;
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
      const opts = f.options ?? [];
      f.value = opts[(opts.indexOf(f.value) + 1) % opts.length] ?? f.value;
      renderAll();
    } else {
      state.editBuf = f.value;
      state.editing = true;
      renderAll();
    }
  } else if (key.name === 's' || key.name === 'S') {
    return 'start';
  } else if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
    return 'back';
  }
  return null;
}
