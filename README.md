# Valheim Manager

Web UI to run several Valheim worlds on one host. Each world gets its own
container from [valheim-server-docker](https://github.com/community-valheim-tools/valheim-server-docker)
and its own UDP port range (port, port+1, port+2).

```
npm install
npm start            # http://127.0.0.1:8790
```

On first visit from the host itself you set an admin password (min 8 chars). Every API call
needs a login after that. You can also set or reset the password with `npm run set-password`,
or supply it with `VHM_PASSWORD`. Sessions last 30 days. Logins are limited to 10 failed
attempts per 15 minutes per IP.

Env: `PORT` (8790), `HOST` (127.0.0.1), `DATA_DIR` (./data), `VALHEIM_IMAGE`, `VHM_PASSWORD`.

**Playing with friends / remote access:** see [docs/TAILSCALE.md](docs/TAILSCALE.md).

**Hook URLs:** to start, stop/shutdown, restart, reload or get status with a secret key (no login),
use `/hook/<server>/<action>`. Create keys under **API keys** in the UI. See [docs/API.md](docs/API.md).

Features: create/start/stop/restart/delete servers; edit settings and container env vars
(changes apply on next start/restart, which re-creates the container and keeps the data);
world preset/modifiers/setkeys; upload existing worlds; per-world BepInEx/ValheimPlus mods from
Thunderstore (with dependencies), manual .dll/.zip upload, mod config editor; live logs and CPU/memory.

Data per server: `data/servers/<id>/{server.json,server.env,config/,data/}`.

Run it in the background as a systemd user service: see `contrib/valheim-manager.service`.
Game servers themselves keep running without the manager (`--restart unless-stopped`).
