/**
 * Shared whatsapp-web.js Client options (LocalAuth + Puppeteer + local web cache).
 */

import path from 'node:path';
import { buildWhatsappPuppeteerOpts } from './puppeteer-opts.js';

export function webCachePath(authPath, env = process.env) {
  const override = String(env.WHATSAPP_WEB_CACHE_PATH || '').trim();
  if (override) return override;
  return path.join(authPath, 'webcache');
}

/**
 * @param {object} opts
 * @param {Function} opts.LocalAuth
 * @param {string} opts.authPath
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
export function buildWhatsappClientOptions({ LocalAuth, authPath, env = process.env }) {
  const webVersion = String(env.WHATSAPP_WEB_VERSION || '').trim();
  const options = {
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: buildWhatsappPuppeteerOpts(env),
    webVersionCache: {
      type: 'local',
      path: webCachePath(authPath, env),
    },
    restartOnAuthFail: false,
    takeoverOnConflict: false,
  };
  if (webVersion) options.webVersion = webVersion;
  return options;
}
