# Valheim Manager

Web UI to run several Valheim worlds on one host. Each world gets its own
container from [valheim-server-docker](https://github.com/community-valheim-tools/valheim-server-docker)
and its own UDP port range (port, port+1, port+2).

```
npm install
npm start            # http://127.0.0.1:8790
```

Env: `PORT` (8790), `HOST` (127.0.0.1; it controls Docker, so keep it local or put auth in front),
`DATA_DIR` (./data), `VALHEIM_IMAGE`.

Features: create/start/stop/restart/delete servers; edit settings and container env vars
(changes apply on next start/restart, which re-creates the container and keeps the data);
world preset/modifiers/setkeys; upload existing worlds; per-world BepInEx/ValheimPlus mods from
Thunderstore (with dependencies), manual .dll/.zip upload, mod config editor; live logs and CPU/memory.

Data per server: `data/servers/<id>/{server.json,server.env,config/,data/}`.

Run it in the background as a systemd user service: see `contrib/valheim-manager.service`.
Game servers themselves keep running without the manager (`--restart unless-stopped`).
