import * as ngrok from '@ngrok/ngrok';

export interface TunnelInfo {
  url: string;
  listener: ngrok.Listener;
}

/**
 * Creates an ngrok tunnel to the local server.
 */
export async function createTunnel(port: number, authtoken: string): Promise<TunnelInfo> {
  const listener = await ngrok.forward({
    addr: port,
    authtoken,
    proto: 'http',
  });

  const url = listener.url();
  if (!url) {
    throw new Error('ngrok tunnel created but no URL returned');
  }

  return { url, listener };
}

/**
 * Closes the ngrok tunnel.
 */
export async function closeTunnel(listener: ngrok.Listener): Promise<void> {
  await listener.close();
}
