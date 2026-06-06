import {
  type CliRenderer,
  type Renderable,
  BoxRenderable,
  TextRenderable,
  TextAttributes,
} from '@opentui/core';
import { C } from '../../theme';

export interface PaletteCommand {
  id:        string;
  label:     string;
  hint?:     string;
  keywords?: string[];
  shortcut?: string;
  run:       () => void; 
}

export interface PaletteOptions {
  commands: PaletteCommand[];
  recents?: string[];
  onPick?:  (id: string) => void;
}

const MAX_VISIBLE = 8;

export async function showPalette(
  renderer: CliRenderer,
  root: Renderable,
  opts: PaletteOptions,
): Promise<PaletteCommand | null> {

  const overlay = new BoxRenderable(renderer, {
    id: 'palette-overlay',
    position: 'absolute',
    top: '20%', left: '25%', width: '50%',
    flexDirection: 'column',
    border: true, borderStyle: 'rounded', borderColor: C.accent,
    backgroundColor: C.panel,
    title: ' COMMAND PALETTE ', titleAlignment: 'left',
    padding: 1,
  });

  const searchRow = new BoxRenderable(renderer, {
    flexDirection: 'row', gap: 1, backgroundColor: C.panel,
  });
  searchRow.add(new TextRenderable(renderer, {
    content: '▸', fg: C.accent, bg: C.panel,
    attributes: TextAttributes.BOLD,
  }));
  const queryRef = new TextRenderable(renderer, {
    content: '_', fg: C.white, bg: C.panel,
  });
  searchRow.add(queryRef);
  overlay.add(searchRow);

  overlay.add(new TextRenderable(renderer, {
    content: '─'.repeat(60), fg: C.line2, bg: C.panel,
  }));

  const rowRefs: Array<{ box: BoxRenderable; label: TextRenderable; hint: TextRenderable }> = [];
  for (let i = 0; i < MAX_VISIBLE; i++) {
    const row = new BoxRenderable(renderer, {
      flexDirection: 'row', justifyContent: 'space-between',
      paddingX: 1, backgroundColor: C.panel,
    });
    const label = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.panel });
    const hint  = new TextRenderable(renderer, { content: '', fg: C.dim,   bg: C.panel });
    row.add(label);
    row.add(hint);
    overlay.add(row);
    rowRefs.push({ box: row, label, hint });
  }

  const emptyRef = new TextRenderable(renderer, {
    content: '', fg: C.dim, bg: C.panel,
  });
  overlay.add(emptyRef);

  let query    = '';
  let cursor   = 0;
  let filtered: PaletteCommand[] = [];

  const recents = opts.recents ?? [];

  const filterAndRender = (): void => {
    const q = query.trim().toLowerCase();
    if (q === '') {
      const recentSet = new Set(recents);
      const recentCmds = recents
        .map(id => opts.commands.find(c => c.id === id))
        .filter((c): c is PaletteCommand => Boolean(c));
      const rest = opts.commands.filter(c => !recentSet.has(c.id));
      filtered = [...recentCmds, ...rest];
    } else {
      filtered = opts.commands.filter(c => {
        const hay = [c.label, ...(c.keywords ?? []), c.hint ?? ''].join(' ').toLowerCase();
        return hay.includes(q);
      });
    }

    if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);

    queryRef.content = query.length === 0 ? 'type to filter…' : query + '_';
    queryRef.fg      = query.length === 0 ? C.dim : C.white;

    const visible = filtered.slice(0, MAX_VISIBLE);
    for (let i = 0; i < MAX_VISIBLE; i++) {
      const cmd = visible[i];
      const ref = rowRefs[i]!;
      if (!cmd) {
        ref.label.content = '';
        ref.hint.content  = '';
        ref.box.backgroundColor = C.panel;
        continue;
      }
      const selected = i === cursor;
      const marker   = selected ? '▸ ' : '  ';
      const isRecent = query === '' && recents.includes(cmd.id);
      ref.label.content    = marker + cmd.label + (isRecent ? '  ↻' : '');
      ref.label.fg         = selected ? C.white : C.slate;
      ref.label.attributes = selected ? TextAttributes.BOLD : 0;
      ref.label.bg         = selected ? C.dark  : C.panel;
      ref.hint.content     = cmd.hint ?? cmd.shortcut ?? '';
      ref.hint.fg          = selected ? C.slate : C.dim;
      ref.hint.bg          = selected ? C.dark  : C.panel;
      ref.box.backgroundColor = selected ? C.dark : C.panel;
    }

    if (filtered.length === 0) {
      emptyRef.content = '  no commands match';
    } else if (filtered.length > MAX_VISIBLE) {
      emptyRef.content = `  +${filtered.length - MAX_VISIBLE} more — keep typing`;
    } else {
      emptyRef.content = '';
    }
  };

  filterAndRender();
  root.add(overlay);

  return new Promise<PaletteCommand | null>((resolve) => {
    let resolved = false;

    const cleanup = (result: PaletteCommand | null): void => {
      if (resolved) return;
      resolved = true;
      renderer.keyInput.off('keypress', onKey);
      root.remove('palette-overlay');
      resolve(result);
    };

    const onKey = (key: { name?: string; sequence?: string; ctrl?: boolean }): void => {
      if (resolved) return;

      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup(null);
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const picked = filtered[cursor];
        if (picked) {
          opts.onPick?.(picked.id);
          cleanup(picked);
          picked.run();
        }
        return;
      }
      if (key.name === 'up') {
        cursor = Math.max(0, cursor - 1);
        filterAndRender();
        return;
      }
      if (key.name === 'down') {
        const max = Math.min(MAX_VISIBLE, filtered.length) - 1;
        cursor = Math.min(max, cursor + 1);
        filterAndRender();
        return;
      }
      if (key.name === 'backspace') {
        if (query.length > 0) {
          query  = query.slice(0, -1);
          cursor = 0;
          filterAndRender();
        }
        return;
      }
      const ch = key.sequence;
      if (typeof ch === 'string' && ch.length === 1 && ch >= ' ' && ch <= '~') {
        query += ch;
        cursor = 0;
        filterAndRender();
        return;
      }
    };

    renderer.keyInput.on('keypress', onKey);
  });
}
