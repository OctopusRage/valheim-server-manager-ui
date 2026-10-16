# Playing over Tailscale

With Tailscale, friends can join your worlds without router port forwarding.
You also don't need a public IP or `SERVER_PUBLIC=true`. Each world's UDP ports
are reachable on this machine's Tailscale IP, and the manager shows that address
on every server as **Via Tailscale**.

Find your address:

```
tailscale ip -4          # e.g. 100.126.72.61
tailscale status         # MagicDNS name, e.g. mypc.tailXXXX.ts.net
```

## 1. Give friends access to this machine

Pick one option.

### Option A — share just this machine (recommended for friends)

Friends use their own (free) Tailscale account. They only see this one machine, not
the rest of your tailnet, and they don't count against your user limit.

1. Open the [admin console → Machines](https://login.tailscale.com/admin/machines).
2. Click **⋯** next to this PC, then choose **Share…**.
3. Send the invite link. Your friend installs Tailscale, logs in and accepts the
   invite. Your PC then appears in their machine list.

### Option B — invite them into your tailnet

Go to [admin console → Users](https://login.tailscale.com/admin/users) and choose
**Invite users**. Invited users become members, and by default they can reach
every device in your tailnet. Check the user limit on your plan. Use this option
only for people you trust with your network.

## 2. Friends join the game

In Valheim, go to **Join Game → Join IP** and enter the address shown in the
manager:

| World port | What to type      |
| ---------- | ----------------- |
| 2456       | `100.x.y.z`       |
| 2466       | `100.x.y.z:2466`  |
| 2476       | `100.x.y.z:2476`  |

Then enter the world's server password. The friend's Tailscale app must be
connected while they play.

You don't need to set anything for each world. The containers publish their ports
on all interfaces, including `tailscale0`. Docker's port publishing also isn't
affected by ufw, so no firewall rule is needed for the game ports.

## 3. Check the connection is direct

Tailscale tries to connect peers directly. If it can't, traffic goes through a
DERP relay, which adds latency. Lag in Valheim usually comes from this.

```
tailscale ping <friend-device-name>
# "pong from … via 1.2.3.4:41641"  → direct, good
# "pong from … via DERP(sin)"       → relayed, expect extra latency
```

Tailscale usually manages a direct connection. If it stays on DERP, both sides
are behind strict NAT. Opening UDP 41641 on one router often fixes it.

## 4. Keep friends away from everything else (optional)

A shared machine exposes every port it listens on to the people you share it
with. That includes this manager if you bind it to all interfaces. To limit
friends to the game ports, edit the
[access controls](https://login.tailscale.com/admin/acls). Replace the default
"allow all" rule with something like:

```jsonc
{
  "hosts": {
    "valheim-host": "100.126.72.61"   // this PC's Tailscale IP
  },
  "acls": [
    // you and your own devices: everything
    { "action": "accept", "src": ["autogroup:member"], "dst": ["*:*"] },
    // friends: only the Valheim UDP ranges (2456–2458, 2466–2468, …)
    { "action": "accept", "src": ["friend1@gmail.com", "friend2@gmail.com"], "dst": ["valheim-host:2456-2499"] }
  ]
}
```

Widen `2456-2499` if you run more than four worlds. Each world takes a block of
10 ports.

## 5. Open the manager from your other devices

The manager listens on `127.0.0.1` by default. There are two ways to reach it from
your laptop or phone over Tailscale.

**A. `tailscale serve` (recommended).** You get HTTPS on your MagicDNS name, and
the manager stays bound to localhost:

```
tailscale serve --bg 8790
# → https://mypc.tailXXXX.ts.net
tailscale serve status     # check it
tailscale serve --https=443 off   # stop it
```

The first run may ask you to enable HTTPS certificates for your tailnet. Click the
link it prints to do so.

**B. Bind to all interfaces.** Run the manager with `HOST=0.0.0.0`, then open
`http://100.x.y.z:8790`. ufw blocks this port by default, so allow it on the
Tailscale interface only:

```
sudo ufw allow in on tailscale0 to any port 8790 proto tcp
```

Either way, the manager asks for its admin password. The **first-time password
setup is only accepted from the host itself**: `http://127.0.0.1:8790`, or
`npm run set-password`. Requests that come through a proxy (including
`tailscale serve`) never count as local. So nobody on the tailnet can claim a
fresh install.

Don't use **Tailscale Funnel** for the manager. Funnel puts it on the public
internet. Funnel also can't carry the game's UDP traffic.
