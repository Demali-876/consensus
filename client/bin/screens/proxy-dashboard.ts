// proxy-dashboard.ts — Live stats dashboard for a running proxy worker.

import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C }               from '../theme';
import type { WorkerEntry } from './proxy-hub.js';

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`;
  if (m > 0) return `${m}m ${String(sec).padStart(2,'0')}s`;
  return `${sec}s`;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1_048_576).toFixed(2)} MB`;
}

function fmtRate(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(1)} B/s`;
  if (bps < 1_048_576) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1_048_576).toFixed(1)} MB/s`;
}

function budgetBar(spent: number, limit: number, width = 16): string {
  const filled = Math.round(Math.min(spent / limit, 1) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export async function showProxyDashboard(
  entry: WorkerEntry,
  onStop?: () => void,
): Promise<'back'> {
  const isForward = entry.handle.type === 'forward';
  const TITLE     = isForward ? 'FORWARD PROXY' : 'REVERSE PROXY';

  const renderer = await createCliRenderer({
    exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true,
  });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  const topBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: TITLE,       fg: C.slate, bg: C.panel }));
  root.add(topBar);

  const content = new BoxRenderable(renderer, {
    width: '100%', flexGrow: 1, flexDirection: 'column',
    paddingX: 3, paddingTop: 2, backgroundColor: C.dark,
  });
  root.add(content);

  const bottomBar = new BoxRenderable(renderer, {
    width: '100%', flexDirection: 'row', justifyContent: 'space-between',
    paddingX: 2, paddingY: 0, backgroundColor: C.panel,
  });
  bottomBar.add(new TextRenderable(renderer, { content: '[S  stop]  [B  back]', fg: C.slate, bg: C.panel }));
  bottomBar.add(new TextRenderable(renderer, { content: TITLE, fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  const addText = (text: string, fg = C.slate): TextRenderable => {
    const t = new TextRenderable(renderer, { content: text, fg, bg: C.dark });
    content.add(t);
    return t;
  };

  const mkRow = (label: string) => {
    const row   = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', backgroundColor: C.dark });
    const lRef  = new TextRenderable(renderer, { content: label, fg: C.slate, bg: C.dark });
    const vRef  = new TextRenderable(renderer, { content: '',    fg: C.white, bg: C.dark });
    const rRef  = new TextRenderable(renderer, { content: '',    fg: C.dim,   bg: C.dark });
    row.add(lRef); row.add(vRef); row.add(rRef);
    content.add(row);
    return { vRef, rRef };
  };

  const statusRef = addText('', C.emerald);
  const uptimeRef = addText('', C.dim);
  addText(' ');

  addText('TRAFFIC  ' + '─'.repeat(44), C.dim);
  addText(' ');
  const req   = mkRow('  requests    ');
  const cache = mkRow('  cache hits  ');
  const sent  = mkRow('  sent        ');
  const recv  = mkRow('  received    ');

  // Forward-only: spend + connect sections
  let spend: { val: TextRenderable; rate: TextRenderable } | null = null;
  let rate:  { val: TextRenderable } | null = null;
  let budget: { bar: TextRenderable; pct: TextRenderable; rem: TextRenderable } | null = null;

  if (isForward) {
    addText(' ');
    addText('SPEND  ' + '─'.repeat(46), C.dim);
    addText(' ');

    const spendRow = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', backgroundColor: C.dark });
    const spentLabel = new TextRenderable(renderer, { content: '  spent       ', fg: C.slate, bg: C.dark });
    const spentVal   = new TextRenderable(renderer, { content: '$0.000000',     fg: C.slate, bg: C.dark });
    const spentRate  = new TextRenderable(renderer, { content: '',              fg: C.dim,   bg: C.dark });
    spendRow.add(spentLabel); spendRow.add(spentVal); spendRow.add(spentRate);
    content.add(spendRow);
    spend = { val: spentVal, rate: spentRate };

    const rateRow = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', backgroundColor: C.dark });
    const rateLabel = new TextRenderable(renderer, { content: '  rate        ', fg: C.slate, bg: C.dark });
    const rateVal   = new TextRenderable(renderer, { content: '$0.000000 / min', fg: C.slate, bg: C.dark });
    rateRow.add(rateLabel); rateRow.add(rateVal);
    content.add(rateRow);
    rate = { val: rateVal };

    const budgetRow = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', backgroundColor: C.dark });
    const budgetLabel = new TextRenderable(renderer, { content: '  budget      ', fg: C.slate, bg: C.dark });
    const budgetBar_  = new TextRenderable(renderer, { content: '░'.repeat(16),  fg: C.slate, bg: C.dark });
    const budgetPct   = new TextRenderable(renderer, { content: '   0%',         fg: C.slate, bg: C.dark });
    const budgetRem   = new TextRenderable(renderer, { content: '',              fg: C.dim,   bg: C.dark });
    budgetRow.add(budgetLabel); budgetRow.add(budgetBar_); budgetRow.add(budgetPct); budgetRow.add(budgetRem);
    content.add(budgetRow);
    budget = { bar: budgetBar_, pct: budgetPct, rem: budgetRem };

    addText(' ');
    addText('CONNECT  ' + '─'.repeat(44), C.dim);
    addText(' ');
    addText(`  export HTTP_PROXY=http://127.0.0.1:${entry.handle.port}`, C.cyan);
    addText(`  export HTTPS_PROXY=http://127.0.0.1:${entry.handle.port}`, C.cyan);
  }

  let prevStats = entry.handle.stats();
  let prevTime  = Date.now();

  function render() {
    const stats = entry.handle.stats();
    const now   = Date.now();
    const dt    = Math.max((now - prevTime) / 1000, 1);

    const reqRate  = ((stats.requests  - prevStats.requests)  / dt) * 60;
    const sentRate = (stats.bytesSent  - prevStats.bytesSent)  / dt;
    const recvRate = (stats.bytesRecv  - prevStats.bytesRecv)  / dt;
    prevStats = stats; prevTime = now;

    const exhausted = isForward && entry.budget != null && (stats.spend ?? 0) >= entry.budget * 0.99;
    statusRef.fg      = exhausted ? C.red : C.emerald;
    statusRef.content = `● ${exhausted ? 'EXHAUSTED' : 'RUNNING'}    :${entry.handle.port}    ${entry.label}`;
    uptimeRef.content = `  uptime  ${fmtMs(stats.uptime)}`;

    req.vRef.content   = String(stats.requests);
    req.rRef.content   = `        ${reqRate.toFixed(1)} / min`;

    const cacheHits = stats.cacheHits ?? 0;
    const hitPct = stats.requests > 0 ? Math.round((cacheHits / stats.requests) * 100) : 0;
    cache.vRef.content = isForward ? 'n/a' : String(cacheHits);
    cache.vRef.fg      = !isForward && cacheHits > 0 ? C.emerald : C.slate;
    cache.rRef.content = isForward ? '   reverse only' : `   ${hitPct}%    hit rate`;
    cache.rRef.fg      = !isForward && cacheHits > 0 ? C.emerald : C.slate;

    sent.vRef.content = fmtBytes(stats.bytesSent);
    sent.rRef.content = `        ${fmtRate(sentRate)}`;
    recv.vRef.content = fmtBytes(stats.bytesRecv);
    recv.rRef.content = `        ${fmtRate(recvRate)}`;

    if (isForward && spend && rate && budget) {
      const s      = stats.spend ?? 0;
      const perReq = stats.requests > 0 ? s / stats.requests : 0;
      const perMin = s / (stats.uptime / 60_000 || 1);
      const fg     = s > 0 ? C.amber : C.slate;

      spend.val.content  = `$${s.toFixed(6)}`;
      spend.val.fg       = fg;
      spend.rate.content = `     $${perReq.toFixed(6)} / req`;

      rate.val.content   = `$${perMin.toFixed(6)} / min`;
      rate.val.fg        = fg;

      if (entry.budget != null) {
        const pct = Math.min(s / entry.budget, 1);
        const barFg = pct > 0.8 ? C.red : pct > 0.5 ? C.amber : C.slate;
        budget.bar.content = budgetBar(s, entry.budget);
        budget.bar.fg      = barFg;
        budget.pct.content = `   ${Math.round(pct * 100)}%`;
        budget.rem.content = `   $${Math.max(entry.budget - s, 0).toFixed(6)} remaining`;
      } else {
        budget.bar.content = 'unlimited';
        budget.bar.fg      = C.dim;
        budget.pct.content = '';
        budget.rem.content = '';
      }
    }
  }

  render();
  const ticker = setInterval(render, 1000);

  return new Promise<'back'>((resolve) => {
    renderer.keyInput.on('keypress', async (key) => {
      if (key.name === 's' || key.name === 'S') {
        clearInterval(ticker);
        renderer.destroy();
        await entry.handle.stop();
        onStop?.();
        resolve('back');
        return;
      }
      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
        clearInterval(ticker);
        renderer.destroy();
        resolve('back');
      }
    });
  });
}
