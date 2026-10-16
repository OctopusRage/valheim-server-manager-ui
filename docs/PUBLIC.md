# Making a world public (anyone can join)

[TAILSCALE.md](TAILSCALE.md) covers playing with friends who install Tailscale.
This page covers letting **anyone** join, without Tailscale on their side and
without opening ports on your home router.

The manager's **Help** button generates the commands below with your real
Tailscale IP and every world's ports filled in.

> **Why not Tailscale Funnel?** Funnel only carries TCP (HTTPS on ports 443,
> 8443 and 10000). Valheim uses **UDP**, so Funnel can't carry the game. Never
> point Funnel at the manager either: it would put the admin UI on the internet.

## Option 1 — Crossplay join code (easiest, no extra machine)

With crossplay on, the server registers with Valheim's PlayFab relay and gets a
6-digit **join code**. Players connect through that relay, so you don't need
port forwarding or Tailscale. Steam, Xbox and Game Pass players can all join.

1. Open the server's **Settings** tab, tick **Crossplay**, save, then **Restart**.
2. Open **Logs** and look for:
   `Session "My Server" registered with join code 123456`
3. Players go to **Join Game → Add server**, enter the code, then the world password.

Notes:
- The code changes whenever the server restarts. Check Logs again after each restart.
- Traffic goes through the relay, so latency is a little higher than a direct connection.
- Xbox and Game Pass players can't install BepInEx mods, so on a modded world only
  PC players with the same mods can join. Share those with the link in the **Mods** tab.

## Option 2 — Public relay on a VPS over Tailscale (your own IP and ports)

Rent a small VPS with a public IPv4 address. 1 vCPU and 512 MB RAM is plenty,
since it only forwards packets. Then join it to your tailnet. The VPS takes UDP
on its public IP and forwards it through Tailscale to this PC:

```
player ──UDP 2456──▶ VPS public IP ──tailscale──▶ this PC 100.x.y.z:2456 ──▶ container
```

### On the VPS (Debian/Ubuntu, as root)

Replace `HOME_TS` with this PC's Tailscale IP (`tailscale ip -4`) and `PORTS`
with each world's range (port to port+2):

```sh
HOME_TS=100.126.72.61
PORTS="2456:2458 2466:2468"

curl -fsSL https://tailscale.com/install.sh | sh
tailscale up                      # log in to the SAME tailnet as this PC

echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-valheim-relay.conf
sysctl --system >/dev/null

WAN=$(ip route show default | awk '{print $5; exit}')
rule() { t=$1; shift; iptables -t "$t" -C "$@" 2>/dev/null || iptables -t "$t" -A "$@"; }
for r in $PORTS; do
  rule nat    PREROUTING -i "$WAN" -p udp --dport "$r" -j DNAT --to-destination "$HOME_TS"
  rule filter FORWARD    -i "$WAN" -o tailscale0 -p udp -d "$HOME_TS" --dport "$r" -j ACCEPT
done
rule nat    POSTROUTING -o tailscale0 -d "$HOME_TS" -j MASQUERADE
rule filter FORWARD     -i tailscale0 -o "$WAN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
netfilter-persistent save         # keep the rules after reboot
```

Then:

1. In the VPS provider's firewall or security group, allow **inbound UDP** on the
   same ranges. If the VPS runs ufw, also run `ufw route allow proto udp to any port 2456:2458`
   for each range.
2. If you use the restrictive ACL from TAILSCALE.md section 4, let the VPS reach the
   game ports. For example, tag it `tag:relay` and add
   `{ "action": "accept", "src": ["tag:relay"], "dst": ["valheim-host:2456-2499"] }`.
3. Players join with **Join Game → Join IP**: `VPS_PUBLIC_IP:2456` (or the world's port).

To test it, have someone outside your tailnet join. (UDP port checkers can't tell
open from filtered, so they aren't much help.)

Notes:
- **Leave "List in public server browser" off.** The server would advertise your
  home IP, not the VPS. Share the VPS address instead.
- Every player shows up as coming from the VPS's Tailscale IP. Valheim bans and
  permits by Steam ID, so that's fine.
- Check `tailscale ping <this-pc>` on the VPS. A direct path is much better than
  a DERP relay.
- Add new worlds by adding their range to `PORTS` and re-running the `rule` lines.
  Running them again doesn't add duplicates.

## Option 3 — Port forwarding on your router

If your ISP gives you a public IPv4 address (no CGNAT), forward UDP
`port`–`port+2` for each world to this PC (192.168.88.x) and tick **List in
public server browser**. Docker publishes the ports past ufw, so no firewall
rule is needed here. Players join with your public IP, or find the server in
the browser.
