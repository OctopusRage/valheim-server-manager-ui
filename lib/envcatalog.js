// Container env vars from the valheim-server-docker README that the UI offers as
// presets. Vars the UI manages directly (name, world, port, password, public,
// crossplay, world modifiers / SERVER_ARGS, mod framework, PUID/PGID) are intentionally absent.
export const ENV_CATALOG = [
  { group: 'Server', key: 'ADMINLIST_IDS', default: '', help: 'Space-separated SteamID64s of admins (overrides adminlist.txt)' },
  { group: 'Server', key: 'BANNEDLIST_IDS', default: '', help: 'Space-separated SteamID64s to ban (overrides bannedlist.txt)' },
  { group: 'Server', key: 'PERMITTEDLIST_IDS', default: '', help: 'Space-separated SteamID64 whitelist (overrides permittedlist.txt)' },
  { group: 'Server', key: 'TZ', default: 'Etc/UTC', help: 'Container time zone, e.g. Asia/Jakarta (affects cron schedules)' },
  { group: 'Updates', key: 'UPDATE_CRON', default: '*/15 * * * *', help: 'Cron for update checks; empty disables' },
  { group: 'Updates', key: 'UPDATE_IF_IDLE', default: 'true', help: 'Only update when no players are connected' },
  { group: 'Updates', key: 'RESTART_CRON', default: '10 5 * * *', help: 'Cron for daily restarts; empty disables' },
  { group: 'Updates', key: 'RESTART_IF_IDLE', default: 'true', help: 'Only restart when no players are connected' },
  { group: 'Updates', key: 'STEAMCMD_ARGS', default: 'validate', help: 'Additional steamcmd arguments' },
  { group: 'Updates', key: 'PUBLIC_TEST', default: 'false', help: 'Run the Public Test Beta build' },
  { group: 'Backups', key: 'BACKUPS', default: 'true', help: 'Create periodic world backups' },
  { group: 'Backups', key: 'BACKUPS_CRON', default: '5 * * * *', help: 'Cron for backups; empty disables' },
  { group: 'Backups', key: 'BACKUPS_MAX_AGE', default: '3', help: 'Days after which backups are deleted' },
  { group: 'Backups', key: 'BACKUPS_MAX_COUNT', default: '0', help: 'Max backups kept, 0 = unlimited' },
  { group: 'Backups', key: 'BACKUPS_IF_IDLE', default: 'true', help: 'Back up even when nobody has played for a while' },
  { group: 'Backups', key: 'BACKUPS_IDLE_GRACE_PERIOD', default: '3600', help: 'Seconds after last disconnect to keep backing up when BACKUPS_IF_IDLE=false' },
  { group: 'Backups', key: 'BACKUPS_ZIP', default: 'true', help: 'Compress backups with zip' },
  { group: 'Idle detection', key: 'IDLE_DATAGRAM_WINDOW', default: '3', help: 'Seconds to watch UDP traffic when deciding if a non-public server is idle' },
  { group: 'Idle detection', key: 'IDLE_DATAGRAM_MAX_COUNT', default: '30', help: 'UDP datagrams tolerated before a non-public server counts as busy' },
  { group: 'Mods', key: 'VALHEIM_PLUS_REPO', default: 'Grantapher/ValheimPlus', help: 'GitHub repo to fetch ValheimPlus from' },
  { group: 'Mods', key: 'VALHEIM_PLUS_RELEASE', default: 'latest', help: 'ValheimPlus release, e.g. tags/0.9.9.8' },
  { group: 'Misc', key: 'PERMISSIONS_UMASK', default: '022', help: 'Umask for backups and config files' },
  { group: 'Misc', key: 'SYSLOG_REMOTE_HOST', default: '', help: 'Send logs to this syslog host' },
  { group: 'Misc', key: 'SYSLOG_REMOTE_PORT', default: '514', help: 'Remote syslog UDP port' },
  { group: 'Misc', key: 'SYSLOG_REMOTE_AND_LOCAL', default: 'true', help: 'Also keep logs local when using remote syslog' },
];

// World modifiers for SERVER_ARGS (Valheim 0.217+ dedicated server flags).
export const WORLD_PRESETS = ['normal', 'casual', 'easy', 'hard', 'hardcore', 'immersive', 'hammer'];
export const WORLD_MODIFIERS = {
  combat: ['veryeasy', 'easy', 'hard', 'veryhard'],
  deathpenalty: ['casual', 'veryeasy', 'easy', 'hard', 'hardcore'],
  resources: ['muchless', 'less', 'more', 'muchmore', 'most'],
  raids: ['none', 'muchless', 'less', 'more', 'muchmore'],
  portals: ['casual', 'hard', 'veryhard'],
};
// Boolean world keys passed as -setkey <key>.
export const WORLD_KEYS = ['nobuildcost', 'playerevents', 'passivemobs', 'nomap'];
