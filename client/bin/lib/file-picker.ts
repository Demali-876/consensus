import { readdirSync, statSync } from 'node:fs';
import { join, dirname }         from 'node:path';
import { TextRenderable, BoxRenderable } from '@opentui/core';
import { C } from '../theme';

const SHOWN_ROWS  = 7;
const SOURCE_EXTS = new Set(['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx']);

interface Entry {
  name:  string;
  isDir: boolean;
  path:  string;
}

type KeyEvent = { name?: string; sequence?: string; ctrl?: boolean };

export class FilePicker {
  private cwd:     string  = process.cwd();
  private entries: Entry[] = [];
  private cursor:  number  = 0;
  private scroll:  number  = 0;
  private _isOpen: boolean = false;

  readonly container: BoxRenderable;
  private readonly rows: TextRenderable[];
  private readonly cwdRef: TextRenderable;

  constructor(private readonly renderer: any) {
    this.container = new BoxRenderable(renderer, {
      id:              'file-picker',
      flexDirection:   'column',
      backgroundColor: C.dark,
    });

    this.cwdRef = new TextRenderable(renderer, { content: '', fg: C.dim, bg: C.dark });
    this.container.add(this.cwdRef);

    this.rows = [];
    for (let i = 0; i < SHOWN_ROWS; i++) {
      const t = new TextRenderable(renderer, { content: '', fg: C.slate, bg: C.dark });
      this.container.add(t);
      this.rows.push(t);
    }
  }

  get isOpen(): boolean { return this._isOpen; }

  open(startDir: string = process.cwd()): void {
    this._isOpen = true;
    this.cwd     = startDir;
    this.cursor  = 0;
    this.scroll  = 0;
    this.loadEntries();
    this.render();
  }

  close(): void {
    this._isOpen    = false;
    this.cwdRef.content = '';
    for (const r of this.rows) r.content = '';
  }

  private loadEntries(): void {
    try {
      const raw: Entry[] = [];
      const parent = dirname(this.cwd);
      if (parent !== this.cwd) raw.push({ name: '..', isDir: true, path: parent });

      for (const name of readdirSync(this.cwd).sort()) {
        if (name.startsWith('.')) continue;
        try {
          const path = join(this.cwd, name);
          const stat = statSync(path);
          if (stat.isDirectory()) {
            raw.push({ name, isDir: true, path });
          } else {
            const ext = '.' + name.split('.').pop()!;
            if (SOURCE_EXTS.has(ext)) raw.push({ name, isDir: false, path });
          }
        } catch { /* skip unreadable */ }
      }
      this.entries = raw;
    } catch {
      this.entries = [];
    }
  }

  private render(): void {
    // Truncate cwd display from the left if long
    const maxCwd = 48;
    const cwdDisplay = this.cwd.length > maxCwd
      ? '…' + this.cwd.slice(-(maxCwd - 1))
      : this.cwd;
    this.cwdRef.content = `    ${cwdDisplay}`;

    const visible = this.entries.slice(this.scroll, this.scroll + SHOWN_ROWS);
    for (let i = 0; i < SHOWN_ROWS; i++) {
      const entry = visible[i];
      if (!entry) { this.rows[i]!.content = ''; continue; }
      const absIdx = this.scroll + i;
      const sel    = absIdx === this.cursor;
      const icon   = entry.isDir ? '▸ ' : '  ';
      const name   = entry.isDir ? `${entry.name}/` : entry.name;
      this.rows[i]!.content = `    ${sel ? '▶' : ' '} ${icon}${name}`;
      this.rows[i]!.fg      = sel ? C.accent : (entry.isDir ? C.white : C.slate);
      this.rows[i]!.bg      = sel ? C.panel  : C.dark;
    }
  }

  /**
   * Feed keypress events here when the picker is open.
   * Returns:
   *   string   — absolute path of the selected file
   *   'escape' — user cancelled
   *   null     — consumed, still navigating
   */
  handleKey(key: KeyEvent): string | 'escape' | null {
    if (!this._isOpen) return null;

    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return 'escape';

    if (key.name === 'up' || key.name === 'k') {
      if (this.cursor > 0) {
        this.cursor--;
        if (this.cursor < this.scroll) this.scroll = this.cursor;
      }
      this.render();
      return null;
    }

    if (key.name === 'down' || key.name === 'j') {
      if (this.cursor < this.entries.length - 1) {
        this.cursor++;
        if (this.cursor >= this.scroll + SHOWN_ROWS) this.scroll = this.cursor - SHOWN_ROWS + 1;
      }
      this.render();
      return null;
    }

    if (key.name === 'left') {
      const parent = dirname(this.cwd);
      if (parent !== this.cwd) {
        this.cwd    = parent;
        this.cursor = 0;
        this.scroll = 0;
        this.loadEntries();
        this.render();
      }
      return null;
    }

    if (key.name === 'right' || key.name === 'return' || key.name === 'enter') {
      const entry = this.entries[this.cursor];
      if (!entry) return null;
      if (entry.isDir) {
        this.cwd    = entry.path;
        this.cursor = 0;
        this.scroll = 0;
        this.loadEntries();
        this.render();
        return null;
      }
      return entry.path;
    }

    return null;
  }
}
