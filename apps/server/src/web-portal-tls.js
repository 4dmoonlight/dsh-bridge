import { createServer } from 'node:https';
import { PORTAL_DATA_ALT_PORT, PORTAL_DATA_MUX_PATH } from './web-portal-proxy.js';
import { sendJson } from './util.js';

const NOT_FOUND = { error: { code: 'not_found' } };
const DENY_HEADERS = { 'cache-control': 'no-store', connection: 'close' };

export function startPortalTls({ portal, cert, key, port = Number(PORTAL_DATA_ALT_PORT), host = '0.0.0.0' }) {
  if (!portal) throw new Error('Portal TLS requires a configured Web portal');
  if (portal.dataPort !== PORTAL_DATA_ALT_PORT || port !== Number(PORTAL_DATA_ALT_PORT)) {
    throw new Error('Portal TLS requires BRIDGE_PORTAL_DATA_PORT=8443 and listener port 8443');
  }
  if (!cert?.length || !key?.length) throw new Error('Portal TLS requires both a certificate and a key');

  function dataOnly(req) {
    // Use the TLS connection's actual SNI, not any forwarding header.
    const sni = req.socket.servername;
    return typeof sni === 'string' && req.headers.host === sni + ':' + PORTAL_DATA_ALT_PORT && portal.isDataRequest(req);
  }

  async function handle(req, res) {
    const path = req.url?.split('?', 1)[0];
    if (dataOnly(req) && path?.startsWith('/') && path !== '/remote' && !path.startsWith('/remote/')) {
      // No OAuth start function or ordinary Hub handler is mounted here.
      if (await portal.handleHttp(req, res)) return;
    }
    sendJson(res, 404, NOT_FOUND, DENY_HEADERS);
  }

  const server = createServer({ cert, key, minVersion: 'TLSv1.2', handshakeTimeout: 10_000,
    headersTimeout: 10_000, requestTimeout: 120_000, keepAliveTimeout: 5_000, connectionsCheckingInterval: 1_000,
  }, (req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  server.setTimeout(125_000);
  server.on('checkContinue', (_req, res) => res.writeHead(417, DENY_HEADERS).end());
  server.on('upgrade', (req, socket, head) => {
    try {
      if (dataOnly(req) && req.method === 'GET' && req.url === PORTAL_DATA_MUX_PATH &&
          portal.handleUpgrade(req, socket, head)) return;
      socket.once('error', () => socket.destroy());
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n');
    } catch {
      socket.destroy();
    }
  });

  // Bound draining includes incomplete TLS handshakes and upgraded sockets,
  // which server.closeAllConnections() alone would not reliably cover.
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const listening = new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve({ port, host });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  return {
    listening,
    async close() {
      try { await listening; } catch { return; }
      await new Promise(resolve => {
        const deadline = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
        }, 1_000);
        deadline.unref();
        server.close(() => {
          clearTimeout(deadline);
          resolve();
        });
      });
    },
  };
}
