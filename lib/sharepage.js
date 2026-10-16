// Public "match the server's mods" page served at /share/<token>.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE = `
:root { --bg:#14110f; --panel:#1c1916; --line:#3a332c; --text:#ece4d8; --muted:#a0958a; --accent:#c8923c; --ink:#1a1208; }
@media (prefers-color-scheme: light) {
  :root { --bg:#f6f1ea; --panel:#fffdf9; --line:#e2d8ca; --text:#2a2219; --muted:#76695b; --accent:#a8711f; --ink:#fff; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 system-ui, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 28px 16px 60px; }
h1 { margin: 0 0 4px; font-size: 26px; }
h2 { font-size: 17px; margin: 0 0 8px; }
.sub { color: var(--muted); margin: 0 0 22px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px; margin-bottom: 16px; }
.btn { display:inline-block; background:var(--accent); color:var(--ink); font-weight:600; text-decoration:none; padding:10px 16px; border-radius:8px; margin: 4px 0 10px; }
ol { margin: 6px 0 0; padding-left: 20px; } li { margin: 3px 0; }
code { background: rgba(127,127,127,.15); padding: 1px 5px; border-radius: 4px; font-size: 13px; }
.mods { list-style: none; padding: 0; margin: 0; }
.mods li { display: flex; gap: 12px; align-items: center; padding: 9px 0; border-top: 1px solid var(--line); }
.mods li:first-child { border-top: 0; }
.mods img, .mods .ph { width: 40px; height: 40px; border-radius: 6px; flex: none; background: var(--line); }
.mods .meta { min-width: 0; }
.mods .name { font-weight: 600; word-break: break-word; }
.mods .desc { color: var(--muted); font-size: 13px; }
.tag { font-size: 11.5px; color: var(--muted); border: 1px solid var(--line); border-radius: 99px; padding: 0 7px; margin-left: 6px; white-space: nowrap; }
a { color: var(--accent); }
.muted { color: var(--muted); font-size: 13.5px; }
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

export function sharePage(server, info) {
  if (!server) {
    return page('Link not found', '<h1>Link not found</h1><p class="sub">This share link is invalid or was turned off. Ask the server owner for a new one.</p>');
  }
  const t = encodeURIComponent(server.share.token);
  const head = `<h1>${esc(server.serverName)}</h1>
    <p class="sub">World <b>${esc(server.worldName)}</b> · ${info.mods.length ? `${info.mods.length} mod${info.mods.length === 1 ? '' : 's'}` : 'no mods'}</p>`;

  if (!server.modFramework || server.modFramework === 'none' || !info.mods.length) {
    return page(`${server.serverName} — mods`, `${head}
      <div class="card"><h2>No mods needed</h2><p>This server runs ${server.modFramework === 'valheimplus' ? 'ValheimPlus without extra mods' : 'plain Valheim'}. Join it with the normal game.</p></div>`);
  }

  const configs = server.share.configs ? 'Mod settings (config files) are included.' : '';
  const profile = server.modFramework === 'bepinex' && !info.manual.length ? `
    <div class="card">
      <h2>Option 1 — mod manager (recommended)</h2>
      <a class="btn" href="${t}/profile.r2z" download>Download profile (.r2z)</a>
      <ol>
        <li>Install <a href="https://r2modman.com/" rel="noopener">r2modman</a> or <a href="https://thunderstore.io/c/valheim/p/Kesomannen/GaleModManager/" rel="noopener">Gale</a> and pick Valheim.</li>
        <li><b>r2modman:</b> Profiles → <i>Import / Update</i> → <i>Import new profile</i> → <i>From file</i>, choose the .r2z.<br>
            <b>Gale:</b> Import → <i>From file</i>, choose the .r2z.</li>
        <li>It downloads the exact mod versions this server uses. Launch with <i>Start modded</i>.</li>
      </ol>
      <p class="muted">${configs} To update later, download the profile again and import it over the old one.</p>
    </div>` : '';
  const manualNote = info.manual.length
    ? `<p class="muted">Some mods were uploaded by hand (${info.manual.map(esc).join(', ')}) and aren't on Thunderstore, so use this zip.</p>` : '';
  const zip = `
    <div class="card">
      <h2>${profile ? 'Option 2 — ' : ''}one zip, no mod manager</h2>
      <a class="btn" href="${t}/mods.zip" download>Download mods.zip</a>
      <ol>
        ${server.modFramework === 'valheimplus' ? '<li>Install the <a href="https://github.com/Grantapher/ValheimPlus/releases" rel="noopener">ValheimPlus client</a> first.</li>' : ''}
        <li>In Steam, right-click Valheim → <i>Manage</i> → <i>Browse local files</i>.</li>
        <li>Extract the zip into that folder (next to <code>valheim.exe</code>) and allow overwriting.</li>
        <li>Start Valheim as usual.${server.modFramework === 'bepinex' ? ' On Linux / Steam Deck, set the launch options to <code>./start_game_bepinex.sh %command%</code>.' : ''}</li>
      </ol>
      ${manualNote}
      <p class="muted">${configs} To remove the mods, delete the <code>BepInEx</code> folder and <code>winhttp.dll</code>.</p>
    </div>`;
  const list = `
    <div class="card">
      <h2>Mods on this server</h2>
      <ul class="mods">
        ${info.mods.map((m) => `<li>
          ${m.icon ? `<img src="${esc(m.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="ph"></span>'}
          <div class="meta">
            <div class="name">${m.url ? `<a href="${esc(m.url)}" rel="noopener">${esc(m.name)}</a>` : esc(m.name)}
              <span class="tag">${esc(m.version)}</span>${m.explicit ? '' : '<span class="tag">dependency</span>'}</div>
            ${m.description ? `<div class="desc">${esc(m.description)}</div>` : ''}
          </div></li>`).join('')}
      </ul>
    </div>`;
  return page(`${server.serverName} — mods`, head + profile + zip + list);
}
