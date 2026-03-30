/**
 * Tunnels screen — filler structure, real content TBD.
 */
import { createCliRenderer, BoxRenderable, TextRenderable, ScrollBoxRenderable } from '@opentui/core';
import { C } from '../theme';

export async function showTunnels(): Promise<'back'> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  // Top bar
  const topBar = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', justifyContent: 'space-between', paddingX: 2, paddingY: 0, backgroundColor: C.panel });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: 'Tunnels', fg: C.slate, bg: C.panel }));
  root.add(topBar);

  // Content
  const content = new BoxRenderable(renderer, { width: '100%', flexGrow: 1, flexDirection: 'column', paddingX: 3, paddingTop: 2, backgroundColor: C.dark });
  content.add(new TextRenderable(renderer, { content: 'TUNNELS', fg: C.white, bg: C.dark }));
  content.add(new TextRenderable(renderer, { content: '─'.repeat(40), fg: C.dim, bg: C.dark }));
  content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));
  content.add(new TextRenderable(renderer, { content: 'No active tunnels.', fg: C.slate, bg: C.dark }));
  content.add(new TextRenderable(renderer, { content: ' ', fg: C.dim, bg: C.dark }));
  content.add(new TextRenderable(renderer, { content: '  N   new tunnel    (e.g. consensus tunnel http 3000)', fg: C.dim, bg: C.dark }));
  root.add(content);

  // Bottom bar
  const bottomBar = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', justifyContent: 'space-between', paddingX: 2, paddingY: 0, backgroundColor: C.panel });
  bottomBar.add(new TextRenderable(renderer, { content: '[B  back]  [N  new tunnel]', fg: C.slate, bg: C.panel }));
  bottomBar.add(new TextRenderable(renderer, { content: 'Tunnels', fg: C.dim, bg: C.panel }));
  root.add(bottomBar);

  return new Promise<'back'>((resolve) => {
    renderer.keyInput.on('keypress', (key) => {
      if (key.name === 'b' || key.name === 'B' || (key.ctrl && key.name === 'c')) {
        renderer.destroy();
        resolve('back');
      }
    });
  });
}
