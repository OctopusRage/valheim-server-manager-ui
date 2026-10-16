// Tailscale address of this host, if tailscale is installed and up.
import { execFile } from 'node:child_process';

let cache = { at: 0, value: null };

export const isTailscaleIp = (ip) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10 (CGNAT range Tailscale uses)
};

export function info() {
  if (Date.now() - cache.at < 60_000) return Promise.resolve(cache.value);
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 5000 }, (err, stdout) => {
      let value = null;
      if (!err) {
        try {
          const d = JSON.parse(stdout);
          if (d.BackendState === 'Running' && d.Self) {
            value = {
              ip: (d.Self.TailscaleIPs || []).find((i) => i.includes('.')) || null,
              dnsName: (d.Self.DNSName || '').replace(/\.$/, '') || null,
            };
          }
        } catch { /* not running / unexpected output */ }
      }
      cache = { at: Date.now(), value };
      resolve(value);
    });
  });
}
