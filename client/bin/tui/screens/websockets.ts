import { showWsSetup } from './websocket/setup.ts';

export async function showWebsockets(): Promise<void> {
  return showWsSetup();
}
