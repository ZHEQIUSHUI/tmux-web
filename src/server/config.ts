import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  // dist/server.js sits next to dist/web/
  webDir: path.resolve(process.env.WEB_DIR || path.join(here, 'web')),
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // 'auto' = Secure cookie when the request arrived over https (directly or via X-Forwarded-Proto)
  cookieSecure: (process.env.COOKIE_SECURE || 'auto') as 'auto' | 'true' | 'false',
  trustProxy: process.env.TRUST_PROXY !== 'false',
  tmuxSocket: process.env.TMUX_SOCKET_NAME || 'tw',
  /**
   * First host created on an empty database. With HOST_USER set it is reached over SSH
   * (the normal Docker setup: the container SSHes into the machine it runs on); without it,
   * commands run directly as the current user (development).
   */
  defaultHost: {
    user: process.env.HOST_USER || '',
    address: process.env.SSH_HOST || '127.0.0.1',
    port: Number(process.env.SSH_PORT || 22),
    name: process.env.HOST_NAME || '本机',
  },
  defaultCols: 120,
  defaultRows: 36,
};
