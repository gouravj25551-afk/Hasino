/**
 * A TLS front door for local phone testing. Debug only — never deployed.
 *
 *   node scripts/lan-https.mjs
 *
 * Terminates HTTPS on the LAN and proxies to the ordinary dev server on
 * :3000. Nothing about the application changes: it is the same process, the
 * same database, the same routes.
 *
 * Why this exists rather than pointing the phone at http://<lan-ip>:3000
 * ---------------------------------------------------------------------
 * A plain-HTTP LAN origin is not a secure context. `crypto.subtle` is
 * undefined there, which Clerk needs, and Android blocks cleartext traffic
 * outright at targetSdk 36. Measured on this machine:
 *
 *   http://10.7.14.4:3000   isSecureContext false   crypto.subtle undefined
 *   https://…               isSecureContext true    crypto.subtle object
 *
 * The certificate is self-signed, and the debug APK trusts it through
 * android/app/src/debug/res/xml/network_security_config.xml. That trust
 * applies to debug builds only — a release build will not accept it.
 *
 * This replaces the Cloudflare quick tunnel, which was unusable here: free
 * quick tunnels run a single edge connection (cloudflared overrides
 * --ha-connections to 1), so any blip took the whole thing down, and every
 * restart minted a new hostname that made the installed APK point at a dead
 * URL.
 */
import { createServer } from 'node:https';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const PORT = Number(process.env.LAN_HTTPS_PORT ?? 3443);
const TARGET_PORT = Number(process.env.PORT ?? 3000);

const options = {
  key: readFileSync(new URL('../.certs/hasino-lan.key', import.meta.url)),
  cert: readFileSync(new URL('../.certs/hasino-lan.crt', import.meta.url)),
};

const server = createServer(options, (req, res) => {
  // Straight pass-through. The host header is preserved so the app still sees
  // the origin the phone used, which is what Clerk's redirect depends on.
  const upstream = request(
    { host: '127.0.0.1', port: TARGET_PORT, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    // Almost always "the dev server is not running".
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`Cannot reach the Hasino dev server on :${TARGET_PORT}\n${err.message}\n`);
  });
  req.pipe(upstream);
});

function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanAddress();
  console.log(`\n  Hasino over HTTPS   https://${ip}:${PORT}`);
  console.log(`  proxying to         http://127.0.0.1:${TARGET_PORT}`);
  console.log('  For the debug APK on a phone on this Wi-Fi. Not for deployment.\n');
  if (!process.env.CI) {
    console.log(`  If the APK stops working, check this IP still matches: ${ip}`);
    console.log('  A DHCP lease change gives the Mac a new address and the APK needs rebuilding.\n');
  }
});
