/**
 * Reverse-proxy screen — displays a "coming soon" notice.
 *
 * The server-side reverse-proxy API is not yet live. This screen is wired up
 * so implementation can be dropped in here once the endpoint is available.
 */
import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { C } from '../../../theme';

const TITLE = 'REVERSE-PROXY';

export async function showReverseProxy(): Promise<'back'> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 15, useMouse: false, useAlternateScreen: true });
  renderer.start();

  const root = renderer.root;
  root.flexDirection = 'column';
  root.padding = 0;

  const topBar = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', justifyContent: 'space-between', paddingX: 2, paddingY: 0, backgroundColor: C.panel });
  topBar.add(new TextRenderable(renderer, { content: 'CONSENSUS', fg: C.white, bg: C.panel }));
  topBar.add(new TextRenderable(renderer, { content: TITLE, fg: C.slate, bg: C.panel }));
  root.add(topBar);

  const content = new BoxRenderable(renderer, { width: '100%', flexGrow: 1, flexDirection: 'column', paddingX: 3, paddingTop: 3, backgroundColor: C.dark });
  const add = (text: string, fg = C.slate) =>
    content.add(new TextRenderable(renderer, { content: text, fg, bg: C.dark }));

  add(TITLE, C.white);
  add('─'.repeat(40), C.dim);
  add(' ');
  add('⚠  This feature is not yet live on the consensus network.', C.amber);
  add(' ');
  add('Reverse proxy exposes a locally-running service to the internet', C.slate);
  add('through a consensus node — without opening firewall ports.', C.slate);
  add(' ');
  add('Stay tuned at canister.software for availability.', C.dim);

  root.add(content);

  const bottomBar = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', justifyContent: 'space-between', paddingX: 2, paddingY: 0, backgroundColor: C.panel });
  bottomBar.add(new TextRenderable(renderer, { content: '[B  back]', fg: C.slate, bg: C.panel }));
  bottomBar.add(new TextRenderable(renderer, { content: TITLE, fg: C.dim, bg: C.panel }));
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
