# Hook API (secret keys)

You can start, stop, restart and reload a server from scripts, cron, a Discord
bot, a phone shortcut or a browser bookmark, without logging in to the UI.

## 1. Create a key

In the UI, click **API keys** (top right), then:

- **Name** — what uses the key, e.g. `discord-bot`.
- **Servers** — all servers (including ones you create later), or only the ones you select.
- **Actions** — any of `status`, `start`, `stop`, `restart`, `reload`.

The key (`vhm_…`) is shown **once**. Only its SHA-256 hash is stored, in
`data/apikeys.json`. If you lose the key, revoke it and create a new one. The
list shows when each key was last used.

## 2. Call it

```
GET or POST  <manager-url>/hook/<server-id>/<action>
```

`<server-id>` is the id in the URL and container name, e.g. `midgard` for `vhm-midgard`.
Every server's **Settings** tab lists its exact URLs, with copy buttons.

| Action     | What it does |
| ---------- | ------------ |
| `status`   | Returns JSON: state, busy, pending changes, last error. Changes nothing. |
| `start`    | Starts the server. If settings changed since the container was made, it is re-created first. |
| `stop`     | Graceful shutdown: the world is saved (up to 120 s). `shutdown` is an alias. |
| `restart`  | Restarts the server. Re-creates the container if settings changed. Mods are re-synced on every start. |
| `reload`   | **Always** re-creates the container, then starts it. Use it after changing mods, mod configs or settings, or to start from a clean container. World data is kept. |

There are three ways to pass the key:

```
Authorization: Bearer vhm_…     # preferred
X-API-Key: vhm_…
?key=vhm_…                      # for plain links, but the key ends up in browser history and proxy logs
```

### Examples

```bash
VHM_KEY=vhm_xxxxxxxx
BASE=https://mypc.tailXXXX.ts.net     # or http://127.0.0.1:8790

curl -X POST -H "Authorization: Bearer $VHM_KEY" $BASE/hook/midgard/restart
curl -H "X-API-Key: $VHM_KEY" $BASE/hook/midgard/status

# wait until it has finished (max 5 min) and get the outcome
curl -X POST -H "Authorization: Bearer $VHM_KEY" "$BASE/hook/midgard/reload?wait=1"

# nightly restart from cron
0 5 * * * curl -fsS -X POST -H "Authorization: Bearer vhm_xxx" http://127.0.0.1:8790/hook/midgard/restart
```

A browser bookmark or phone shortcut can be a plain link:
`https://mypc.tailXXXX.ts.net/hook/midgard/start?key=vhm_xxx`

## Responses

```json
{ "ok": true, "action": "restart", "server": "midgard", "name": "My Server",
  "world": "Midgard", "port": 2456, "state": "running", "busy": "restarting",
  "pendingChanges": false, "lastError": null }
```

| Status | Meaning |
| ------ | ------- |
| 200    | `status` result, or a `?wait=1` action that finished. `ok:false` + `error` (HTTP 500) if it failed. |
| 202    | Action accepted and running in the background. Poll `status` to follow it. |
| 401    | Missing or wrong key. After 20 bad keys from one IP within 15 minutes, that IP gets **429**. |
| 403    | The key is valid, but not for this server or action. |
| 404    | Unknown server or action. |
| 409    | The server is busy with another action. |

## Reaching it from outside this PC

Hooks work wherever the manager is reachable. See [TAILSCALE.md](TAILSCALE.md),
section 5. `tailscale serve` gives you an HTTPS URL, so the key isn't sent in
plain text. Use HTTPS (or localhost) for anything that carries a key.
