// Valheim Manager UI — vanilla JS, no build step.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  meta: null,
  servers: [],
  selected: localStorage.getItem('vhm.selected') || null,
  tab: localStorage.getItem('vhm.tab') || 'settings',
  pollCount: 0,
  logsTimer: null,
  tabServer: null, // which server the tab body was rendered for
};

const TABS = [
  ['settings', 'Settings'],
  ['world', 'World'],
  ['mods', 'Mods'],
  ['configs', 'Mod configs'],
  ['logs', 'Logs'],
];

// --- api -------------------------------------------------------------------

async function api(method, url, body, { raw = false, text = false } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (raw) { opts.body = body; }
    else if (text) { opts.body = body; opts.headers['Content-Type'] = 'text/plain'; }
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && data?.auth) {
    showAuth('login');
    throw new Error('Login required');
  }
  if (!res.ok) throw new Error(data?.error || data || res.statusText);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}

function confirmBox(title, body, okLabel = 'Confirm') {
  const d = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmBody').innerHTML = body;
  $('#confirmOk').textContent = okLabel;
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const fmtDate = (d) => new Date(d).toLocaleString();
const fmtNum = (n) => Intl.NumberFormat(undefined, { notation: 'compact' }).format(n);

const current = () => state.servers.find((s) => s.id === state.selected);

function statusOf(s) {
  if (s.busy) return { cls: 'busy', label: s.busy.action + '…' };
  if (!s.container) return { cls: '', label: 'not created' };
  return { cls: s.container.state, label: s.container.state };
}

// --- polling ---------------------------------------------------------------

async function refresh() {
  const withStats = state.pollCount++ % 4 === 0;
  try {
    state.servers = await api('GET', `/api/servers${withStats ? '?stats=1' : ''}`);
  } catch (e) {
    return toast(`Could not load servers: ${e.message}`, 'err');
  }
  if (!withStats) {
    // keep last known stats between stat polls
    for (const s of state.servers) s.stats ??= state.prevStats?.[s.id] ?? null;
  }
  state.prevStats = Object.fromEntries(state.servers.map((s) => [s.id, s.stats]));
  if (state.selected && !current()) state.selected = null;
  renderSidebar();
  renderDetail();
}

// --- sidebar ---------------------------------------------------------------

function renderSidebar() {
  const ul = $('#serverList');
  ul.innerHTML = state.servers.map((s) => {
    const st = statusOf(s);
    return `<li class="server-item ${s.id === state.selected ? 'active' : ''}" data-id="${esc(s.id)}">
      <div class="name"><span class="dot ${st.cls}"></span>${esc(s.serverName)}</div>
      <div class="sub">${esc(s.worldName)} · UDP ${s.port} · ${esc(st.label)}${s.modFramework !== 'none' ? ` · ${Object.keys(s.mods || {}).length} mods` : ''}</div>
    </li>`;
  }).join('');
  $('#emptyHint').hidden = state.servers.length > 0;
}

$('#serverList').addEventListener('click', (e) => {
  const li = e.target.closest('.server-item');
  if (!li) return;
  select(li.dataset.id);
});

function select(id) {
  state.selected = id;
  localStorage.setItem('vhm.selected', id || '');
  renderSidebar();
  renderDetail(true);
}

// --- detail ----------------------------------------------------------------

function renderDetail(force = false) {
  const s = current();
  $('#placeholder').hidden = Boolean(s);
  const detail = $('#detail');
  detail.hidden = !s;
  if (!s) { stopLogs(); state.tabServer = null; return; }

  if (force || state.tabServer !== s.id || !$('#head', detail)) {
    detail.innerHTML = `<div id="head"></div>
      <nav class="tabs">${TABS.map(([k, l]) => `<button class="tab ${k === state.tab ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</nav>
      <div class="tab-body" id="tabBody"></div>`;
    state.tabServer = s.id;
    renderTab();
  }
  renderHead(s);
}

function connectAddress(s) {
  const ip = state.meta?.hostIps?.[0] || state.meta?.tailscale?.ip || 'localhost';
  return s.port === 2456 ? ip : `${ip}:${s.port}`;
}

function hookUrl(id, action) {
  return `${location.origin}/hook/${id}/${action}`;
}

function tsAddress(s) {
  const ip = state.meta.tailscale.ip;
  return s.port === 2456 ? ip : `${ip}:${s.port}`;
}

function renderHead(s) {
  const st = statusOf(s);
  const running = s.container?.state === 'running';
  const busy = Boolean(s.busy);
  const ips = state.meta?.hostIps || [];
  $('#head').innerHTML = `
    <div class="detail-head">
      <div>
        <h1>${esc(s.serverName)} <span class="pill ${st.cls}">${esc(st.label)}</span></h1>
        <div class="sub">World <b>${esc(s.worldName)}</b> · container <code>vhm-${esc(s.id)}</code></div>
      </div>
      <div class="controls">
        <button class="btn primary" data-act="start" ${busy || running ? 'disabled' : ''}>▶ Start</button>
        <button class="btn" data-act="restart" ${busy || !running ? 'disabled' : ''}>↻ Restart</button>
        <button class="btn" data-act="reload" ${busy || !s.container ? 'disabled' : ''} title="Re-create the container: re-applies settings and re-syncs mods, then starts">⟳ Reload mods &amp; settings</button>
        <button class="btn" data-act="stop" ${busy || !running ? 'disabled' : ''}>■ Stop</button>
      </div>
    </div>
    ${s.pendingChanges && !busy ? `<div class="banner warn"><span>Settings changed since the container was created. ${running ? 'Restart' : 'Start'} to apply (the container is re-created; world data is kept).</span>
      <button class="btn small" data-act="${running ? 'restart' : 'start'}">Apply now</button></div>` : ''}
    ${s.lastError ? `<div class="banner err"><span><b>${esc(s.lastError.action)} failed:</b> ${esc(s.lastError.message)}</span></div>` : ''}
    ${s.busy?.action === 'creating' || s.busy?.action === 'starting' ? `<div class="banner info">First start downloads the image and the Valheim server (~1–2 GB). Watch progress in Logs.</div>` : ''}
    <div class="stats">
      <div class="stat"><div class="k">Connect (Join IP)</div><div class="v"><span class="copy" data-copy="${esc(connectAddress(s))}" title="Click to copy">${esc(connectAddress(s))}</span></div></div>
      <div class="stat"><div class="k">UDP ports</div><div class="v">${s.port}–${s.port + 2}</div></div>
      <div class="stat"><div class="k">Visibility</div><div class="v">${s.public ? 'Public' : 'Private'}${s.crossplay ? ' · Crossplay' : ''}</div></div>
      <div class="stat"><div class="k">Mods</div><div class="v">${{ none: 'Vanilla', bepinex: 'BepInEx', valheimplus: 'ValheimPlus' }[s.modFramework]}${s.modFramework !== 'none' ? ` · ${Object.keys(s.mods || {}).length}` : ''}</div></div>
      <div class="stat"><div class="k">Map seed</div><div class="v">${s.seed ? `<span class="copy" data-copy="${esc(s.seed.name)}" title="Click to copy">${esc(s.seed.name)}</span> <a class="seed-map" href="https://valheim-map.world/?seed=${encodeURIComponent(s.seed.name)}" target="_blank" rel="noopener" title="Open on valheim-map.world">map ↗</a>` : '<span class="muted-v" title="The world file is created on first start">not generated yet</span>'}</div></div>
      <div class="stat"><div class="k">CPU / Memory</div><div class="v">${s.stats ? `${esc(s.stats.cpu)} · ${esc(s.stats.mem.split(' / ')[0])}` : '—'}</div></div>
      ${state.meta?.tailscale?.ip ? `<div class="stat"><div class="k">Via Tailscale</div><div class="v"><span class="copy" data-copy="${esc(tsAddress(s))}" title="Click to copy">${esc(tsAddress(s))}</span></div></div>` : ''}
      ${ips.length > 1 ? `<div class="stat"><div class="k">Other host IPs</div><div class="v">${ips.slice(1).map(esc).join(', ')}</div></div>` : ''}
    </div>`;
}

$('#detail').addEventListener('click', async (e) => {
  const tab = e.target.closest('.tab');
  if (tab) {
    state.tab = tab.dataset.tab;
    localStorage.setItem('vhm.tab', state.tab);
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    return renderTab();
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    await navigator.clipboard?.writeText(copy.dataset.copy).catch(() => {});
    return toast('Copied');
  }
  const act = e.target.closest('[data-act]');
  if (act) {
    const s = current();
    try {
      await api('POST', `/api/servers/${s.id}/${act.dataset.act}`);
      toast(`${act.dataset.act} requested`);
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  }
});

function renderTab() {
  stopLogs();
  const s = current();
  const body = $('#tabBody');
  if (!s || !body) return;
  ({ settings: tabSettings, world: tabWorld, mods: tabMods, configs: tabConfigs, logs: tabLogs })[state.tab](s, body);
}

// After a save, reload server list and re-render the tab with fresh data.
async function savedAndReload(msg) {
  toast(msg, 'ok');
  await refresh();
  renderTab();
}

// --- settings tab ----------------------------------------------------------

function tabSettings(s, body) {
  const catalog = state.meta.envCatalog;
  const groups = [...new Set(catalog.map((c) => c.group))];
  const env = Object.entries(s.env || {});
  body.innerHTML = `
    <form class="card form" id="coreForm">
      <h3>Server</h3>
      <div class="grid2">
        <label>Server name <input name="serverName" value="${esc(s.serverName)}" required maxlength="64"></label>
        <label>World name <input name="worldName" value="${esc(s.worldName)}" required><small>Changing this loads (or creates) a different world.</small></label>
        <label>Password <input name="password" type="text" autocomplete="off" placeholder="unchanged" minlength="5"></label>
        <label>UDP start port <input name="port" type="number" value="${s.port}" min="1024" max="65000"></label>
        <label>Mod framework
          <select name="modFramework">
            ${[['none', 'Vanilla'], ['bepinex', 'BepInEx'], ['valheimplus', 'ValheimPlus']].map(([v, l]) => `<option value="${v}" ${s.modFramework === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="checks">
        <label><input type="checkbox" name="public" ${s.public ? 'checked' : ''}> Public server browser</label>
        <label><input type="checkbox" name="crossplay" ${s.crossplay ? 'checked' : ''}> Crossplay</label>
      </div>
      <div class="actions"><button class="btn primary">Save</button></div>
    </form>

    <form class="card form" id="envForm">
      <h3>Environment variables <small>— passed to the container (see valheim-server-docker README)</small></h3>
      <table class="env-table"><tbody id="envRows"></tbody></table>
      <div class="row" style="margin-top:12px">
        <select id="envPreset">
          <option value="">Add a known variable…</option>
          ${groups.map((g) => `<optgroup label="${esc(g)}">${catalog.filter((c) => c.group === g).map((c) => `<option value="${esc(c.key)}">${esc(c.key)}</option>`).join('')}</optgroup>`).join('')}
        </select>
        <button type="button" class="btn" id="envCustom">+ Custom</button>
      </div>
      <div class="actions"><button class="btn primary">Save variables</button></div>
    </form>

    <div class="card">
      <h3>Hook URLs <small>— call with an API key (header or <code>?key=</code>); create keys under <b>API keys</b> at the top</small></h3>
      <table class="hooks"><tbody>
        ${[['status', 'JSON status'], ['start', 'Start'], ['stop', 'Shut down (alias: shutdown)'], ['restart', 'Restart (applies pending changes)'], ['reload', 'Reload mods & settings (always re-creates)']]
          .map(([a, l]) => `<tr><td>${l}</td><td><code>${esc(hookUrl(s.id, a))}</code></td><td><button type="button" class="btn small" data-copy="${esc(hookUrl(s.id, a))}">Copy</button></td></tr>`).join('')}
      </tbody></table>
      <pre class="snippet">${esc(`curl -X POST -H "Authorization: Bearer $VHM_KEY" ${hookUrl(s.id, 'restart')}

# or a plain link (browser, phone shortcut) — the key ends up in history/logs:
${hookUrl(s.id, 'restart')}?key=vhm_xxx

# wait for the result instead of returning immediately:
curl -X POST -H "X-API-Key: $VHM_KEY" "${hookUrl(s.id, 'reload')}?wait=1"`)}</pre>
    </div>

    <div class="card">
      <h3>Danger zone</h3>
      <div class="row">
        <button class="btn danger" id="delKeep">Remove container (keep world & files)</button>
        <button class="btn danger" id="delPurge">Delete server and all its data</button>
      </div>
    </div>`;

  const rows = $('#envRows');
  const addRow = (k = '', v = '') => {
    const help = catalog.find((c) => c.key === k);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input class="k" value="${esc(k)}" placeholder="NAME" pattern="[A-Z_][A-Z0-9_]*"></td>
      <td><input class="v" value="${esc(v)}" placeholder="${esc(help?.default ?? '')}">${help ? `<div class="env-help">${esc(help.help)}${help.default ? ` (default <code>${esc(help.default)}</code>)` : ''}</div>` : ''}</td>
      <td><button type="button" class="btn small danger rm">✕</button></td>`;
    rows.append(tr);
    return tr;
  };
  env.forEach(([k, v]) => addRow(k, v));
  rows.addEventListener('click', (e) => e.target.closest('.rm')?.closest('tr').remove());

  $('#envPreset').addEventListener('change', (e) => {
    const key = e.target.value;
    e.target.value = '';
    if (!key) return;
    const existing = [...rows.querySelectorAll('.k')].find((i) => i.value === key);
    if (existing) return existing.closest('tr').querySelector('.v').focus();
    const c = catalog.find((x) => x.key === key);
    addRow(key, c?.default ?? '').querySelector('.v').focus();
  });
  $('#envCustom').addEventListener('click', () => addRow().querySelector('.k').focus());

  $('#coreForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const payload = {
      serverName: f.get('serverName'), worldName: f.get('worldName'), port: Number(f.get('port')),
      modFramework: f.get('modFramework'), public: f.has('public'), crossplay: f.has('crossplay'),
    };
    if (f.get('password')) payload.password = f.get('password');
    try { await api('PUT', `/api/servers/${s.id}`, payload); await savedAndReload('Saved'); }
    catch (err) { toast(err.message, 'err'); }
  });

  $('#envForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const env = {};
    for (const tr of rows.querySelectorAll('tr')) {
      const k = tr.querySelector('.k').value.trim();
      if (k) env[k] = tr.querySelector('.v').value;
    }
    try { await api('PUT', `/api/servers/${s.id}`, { env }); await savedAndReload('Variables saved'); }
    catch (err) { toast(err.message, 'err'); }
  });

  const del = async (purge) => {
    const ok = await confirmBox(
      purge ? `Delete "${s.serverName}"?` : `Remove container for "${s.serverName}"?`,
      purge
        ? `This stops the server and <b>permanently deletes</b> the world, backups, mods and the downloaded server files in <code>data/servers/${esc(s.id)}</code>.`
        : 'The container is stopped and removed. The world, backups and mods stay on disk; pressing Start re-creates it.',
      purge ? 'Delete everything' : 'Remove container',
    );
    if (!ok) return;
    try {
      await api('DELETE', `/api/servers/${s.id}${purge ? '?purge=1' : ''}`);
      toast(purge ? 'Deleting…' : 'Removing container…');
      if (purge) setTimeout(() => select(null), 300);
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#delKeep').addEventListener('click', () => del(false));
  $('#delPurge').addEventListener('click', () => del(true));
}

// --- sharing mods with players ---------------------------------------------

function shareUrl(token) {
  return `${location.origin}/share/${token}`;
}

async function renderShare(s) {
  const card = $('#shareCard');
  if (!card) return;
  const p = await api('GET', `/api/servers/${s.id}/modpack`);
  const sh = p.share;
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  const dns = state.meta?.tailscale?.dnsName;
  const profileOk = s.modFramework === 'bepinex' && !p.manual.length;
  card.innerHTML = `
    <h3>Share with players <small>— so their game has the same mods</small></h3>
    ${p.mods.length ? '' : '<p class="hint">No mods installed yet — players can join with the normal game.</p>'}
    <div class="row">
      ${profileOk ? `<a class="btn small" data-pack="profile.r2z">Download r2modman / Gale profile</a>` : ''}
      <a class="btn small" data-pack="mods.zip">Download mods zip</a>
      <label class="inline"><input type="checkbox" id="packConfigs"> include mod config files</label>
    </div>
    <p class="hint">${profileOk ? 'The <b>profile</b> (.r2z) is tiny: r2modman or Gale downloads the exact versions from Thunderstore. ' : ''}The <b>zip</b> has BepInEx plus every plugin; players extract it into their Valheim folder.${p.manual.length ? ` Mods uploaded by hand (${p.manual.map(esc).join(', ')}) are only in the zip.` : ''}</p>
    <hr>
    ${sh ? `
      <p class="hint">Anyone with this link can see the mod list and download the pack — no login.</p>
      <div class="secret"><code>${esc(shareUrl(sh.token))}</code>
        <button type="button" class="btn small primary" data-copy="${esc(shareUrl(sh.token))}">Copy</button>
        <a class="btn small" href="${esc(shareUrl(sh.token))}" target="_blank" rel="noopener">Open</a></div>
      ${loopback ? `<p class="hint">⚠ This link uses <code>${esc(location.host)}</code>, which only works on this PC. Send friends the same path on an address they can reach${dns ? `, e.g. <code>https://${esc(dns)}/share/${esc(sh.token)}</code> with <code>tailscale serve</code> on` : ''} — see docs/TAILSCALE.md.</p>` : ''}
      <div class="row" style="margin-top:8px">
        <label class="inline"><input type="checkbox" id="shareConfigs" ${sh.configs ? 'checked' : ''}> include mod config files in the shared pack</label>
        <button type="button" class="btn small" id="shareRegen">New link</button>
        <button type="button" class="btn small danger" id="shareOff">Turn off link</button>
      </div>` : `
      <div class="row"><button type="button" class="btn primary small" id="shareOn">Create share link</button></div>
      <p class="hint">A public page with the mod list and download buttons, for players who can reach this manager. Or just download a file above and send it.</p>`}
    <p class="hint">Config files can hold server-only settings (admin lists, webhook URLs). Only include them if that's fine to share.</p>`;

  card.querySelectorAll('[data-pack]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    location.href = `/api/servers/${s.id}/modpack/${a.dataset.pack}${$('#packConfigs').checked ? '?configs=1' : ''}`;
  }));
  const put = async (body, msg) => {
    try { await api('PUT', `/api/servers/${s.id}/share`, body); toast(msg, 'ok'); await renderShare(s); }
    catch (err) { toast(err.message, 'err'); }
  };
  $('#shareOn')?.addEventListener('click', () => put({ enabled: true }, 'Share link created'));
  $('#shareConfigs')?.addEventListener('change', (e) => put({ configs: e.target.checked }, e.target.checked ? 'Shared pack now includes configs' : 'Shared pack no longer includes configs'));
  $('#shareRegen')?.addEventListener('click', async () => {
    if (!await confirmBox('Make a new link?', 'The old link stops working.', 'New link')) return;
    put({ regenerate: true }, 'New link created');
  });
  $('#shareOff')?.addEventListener('click', async () => {
    if (!await confirmBox('Turn off the share link?', 'The link stops working. You can create a new one later.', 'Turn off')) return;
    put({ enabled: false }, 'Share link turned off');
  });
}

// --- world tab -------------------------------------------------------------

async function tabWorld(s, body) {
  const { worldPresets, worldModifiers, worldKeys } = state.meta;
  const w = s.world || { preset: '', modifiers: {}, keys: [] };
  body.innerHTML = `
    <form class="card form" id="worldForm">
      <h3>World modifiers <small>— sent as server arguments, apply on next start</small></h3>
      <div class="grid2">
        <label>Preset
          <select name="preset"><option value="">Default (normal)</option>
          ${worldPresets.map((p) => `<option ${w.preset === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
        </label>
        ${Object.entries(worldModifiers).map(([k, vals]) => `
          <label>${k}
            <select name="mod_${k}"><option value="">Default</option>
            ${vals.map((v) => `<option ${w.modifiers?.[k] === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
          </label>`).join('')}
      </div>
      <div class="checks">
        ${worldKeys.map((k) => `<label><input type="checkbox" name="key_${k}" ${w.keys?.includes(k) ? 'checked' : ''}> ${k}</label>`).join('')}
      </div>
      <label style="margin-top:10px">Extra server arguments <input name="extraArgs" value="${esc(s.extraArgs || '')}" placeholder="e.g. -saveinterval 600 -backups 4"></label>
      <p class="hint">Resulting <code>SERVER_ARGS</code>:</p>
      <div class="preview" id="argsPreview">${esc(s.serverArgs) || '(none)'}</div>
      <div class="actions"><button class="btn primary">Save</button></div>
    </form>

    <div class="card">
      <h3>World files <small>— <code>config/worlds_local</code></small></h3>
      <div id="worldFiles" class="hint">Loading…</div>
      <div class="row" style="margin-top:12px">
        <input type="file" id="worldUpload" accept=".zip,.db,.fwl">
        <button class="btn" id="worldUploadBtn">Upload world</button>
      </div>
      <p class="hint">Upload a world folder as .zip, or the <code>.fwl</code> + <code>.db</code> files. Set <b>World name</b> in Settings to its name, then restart. Stop the server before replacing the world it is running.</p>
    </div>

    <div class="card">
      <h3>Backups <small>— <code>config/backups</code></small></h3>
      <div id="backupFiles" class="hint">Loading…</div>
    </div>`;

  const form = $('#worldForm');
  const collect = () => {
    const f = new FormData(form);
    return {
      world: {
        preset: f.get('preset'),
        modifiers: Object.fromEntries(Object.keys(worldModifiers).map((k) => [k, f.get(`mod_${k}`)]).filter(([, v]) => v)),
        keys: worldKeys.filter((k) => f.has(`key_${k}`)),
      },
      extraArgs: f.get('extraArgs'),
    };
  };
  form.addEventListener('input', () => {
    const { world, extraArgs } = collect();
    const a = [];
    if (world.preset) a.push('-preset', world.preset);
    for (const [k, v] of Object.entries(world.modifiers)) a.push('-modifier', k, v);
    for (const k of world.keys) a.push('-setkey', k);
    if (extraArgs.trim()) a.push(extraArgs.trim());
    $('#argsPreview').textContent = a.join(' ') || '(none)';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('PUT', `/api/servers/${s.id}`, collect()); await savedAndReload('World settings saved'); }
    catch (err) { toast(err.message, 'err'); }
  });

  $('#worldUploadBtn').addEventListener('click', async () => {
    const file = $('#worldUpload').files[0];
    if (!file) return toast('Choose a file first', 'err');
    try {
      const r = await api('POST', `/api/servers/${s.id}/worlds/upload?filename=${encodeURIComponent(file.name)}`, file, { raw: true });
      toast(`Uploaded ${r.written.length} file(s)`, 'ok');
      loadWorldFiles(s);
    } catch (err) { toast(err.message, 'err'); }
  });
  loadWorldFiles(s);
}

async function loadWorldFiles(s) {
  try {
    const { worlds, backups } = await api('GET', `/api/servers/${s.id}/worlds`);
    const table = (items, empty) => items.length
      ? `<table><thead><tr><th>Name</th><th>Size</th><th>Modified</th></tr></thead><tbody>${items.map((i) => `<tr><td>${i.dir ? '📁 ' : ''}${esc(i.name)}${i.name === s.worldName || i.name.replace(/\.(db|fwl)$/, '') === s.worldName ? ' <span class="tag server">active</span>' : ''}</td><td class="num">${i.dir ? '' : fmtBytes(i.size)}</td><td class="num">${fmtDate(i.modified)}</td></tr>`).join('')}</tbody></table>`
      : `<p class="hint">${empty}</p>`;
    $('#worldFiles').innerHTML = table(worlds, 'No world yet — it is generated on first start.');
    $('#backupFiles').innerHTML = table(backups.slice(0, 30), 'No backups yet.');
  } catch (err) { toast(err.message, 'err'); }
}

// --- mods tab --------------------------------------------------------------

async function tabMods(s, body) {
  if (s.modFramework === 'none') {
    body.innerHTML = `<div class="card">
      <h3>This server is vanilla</h3>
      <p class="hint">Pick a mod loader for this world. Each world has its own mod set.</p>
      <div class="row">
        <button class="btn primary" data-fw="bepinex">Enable BepInEx (Thunderstore mods)</button>
        <button class="btn" data-fw="valheimplus">Enable ValheimPlus</button>
      </div></div>`;
    body.querySelectorAll('[data-fw]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('PUT', `/api/servers/${s.id}`, { modFramework: b.dataset.fw }); await savedAndReload('Mod framework set — restart to apply'); }
      catch (err) { toast(err.message, 'err'); }
    }));
    return;
  }

  body.innerHTML = `
    <div class="card">
      <h3>Installed mods <small>— ${s.modFramework === 'bepinex' ? 'BepInEx' : 'ValheimPlus'}; restart the server after changes</small></h3>
      <div id="installed" class="hint">Loading…</div>
      <div class="row" style="margin-top:10px">
        <button class="btn small" id="checkUpdates">Check for updates</button>
      </div>
    </div>
    <div class="card" id="shareCard"><p class="hint">Loading…</p></div>
    <div class="card">
      <h3>Add from Thunderstore</h3>
      <form class="row" id="searchForm">
        <input id="q" placeholder="Search mods (e.g. Jotunn, PlantEverything, ServerCharacters)…">
        <button class="btn primary">Search</button>
      </form>
      <p class="hint">Most gameplay mods must also be installed on every player's client. <span class="tag server">Server-side</span> mods only need to be here.</p>
      <div id="results"></div>
    </div>
    <div class="card">
      <h3>Upload a mod</h3>
      <div class="row">
        <input type="file" id="modFile" accept=".dll,.zip">
        <button class="btn" id="modUploadBtn">Upload</button>
      </div>
      <p class="hint">A <code>.dll</code> goes to <code>plugins/_manual/</code>; a Thunderstore-style <code>.zip</code> is installed as its own package.</p>
    </div>`;

  let updates = {};
  const loadInstalled = async () => {
    const { mods, manualFiles } = await api('GET', `/api/servers/${s.id}/mods`);
    const entries = Object.entries(mods).sort(([, a], [, b]) => Number(b.explicit) - Number(a.explicit));
    $('#installed').innerHTML = entries.length ? entries.map(([name, m]) => `
      <div class="mod">
        ${m.icon ? `<img src="${esc(m.icon)}" alt="">` : '<div class="noicon"></div>'}
        <div>
          <div class="title">${esc(name)} <span class="tag">${esc(m.version)}</span>${m.explicit ? '' : '<span class="tag">dependency</span>'}${updates[name] && updates[name] !== m.version ? `<span class="tag update">update ${esc(updates[name])}</span>` : ''}</div>
          <div class="desc">${name === '_manual' ? manualFiles.map(esc).join(', ') : esc(m.description)}</div>
          ${m.deps?.length ? `<div class="meta">needs ${m.deps.map(esc).join(', ')}</div>` : ''}
        </div>
        <div class="row">
          ${updates[name] && updates[name] !== m.version ? `<button class="btn small primary" data-update="${esc(name)}">Update</button>` : ''}
          <button class="btn small danger" data-remove="${esc(name)}">Remove</button>
        </div>
      </div>`).join('') : '<p class="hint">No mods installed.</p>';
    return mods;
  };
  let installed = await loadInstalled().catch((e) => { toast(e.message, 'err'); return {}; });
  renderShare(s).catch((e) => { $('#shareCard').innerHTML = `<p class="error">${esc(e.message)}</p>`; });

  $('#installed').addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-remove]');
    const up = e.target.closest('[data-update]');
    if (rm) {
      const name = rm.dataset.remove;
      if (!await confirmBox(`Remove ${name}?`, 'Dependencies no other mod needs are removed too. Its config file is kept.', 'Remove')) return;
      try {
        const r = await api('DELETE', `/api/servers/${s.id}/mods/${encodeURIComponent(name)}`);
        toast(`Removed ${r.removed.join(', ')}`, 'ok');
        installed = await loadInstalled();
        refresh();
      } catch (err) { toast(err.message, 'err'); }
    }
    if (up) {
      up.disabled = true;
      try {
        await api('POST', `/api/servers/${s.id}/mods`, { name: up.dataset.update });
        toast(`Updated ${up.dataset.update}`, 'ok');
        installed = await loadInstalled();
        refresh();
      } catch (err) { toast(err.message, 'err'); up.disabled = false; }
    }
  });

  $('#checkUpdates').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      updates = await api('GET', `/api/servers/${s.id}/mods/updates`);
      installed = await loadInstalled();
      const n = Object.entries(updates).filter(([k, v]) => installed[k] && installed[k].version !== v).length;
      toast(n ? `${n} update(s) available` : 'All mods up to date', 'ok');
    } catch (err) { toast(err.message, 'err'); }
    e.target.disabled = false;
  });

  let page = 1;
  const doSearch = async (append = false) => {
    const q = $('#q').value.trim();
    const results = $('#results');
    if (!append) { page = 1; results.innerHTML = '<p class="hint">Searching…</p>'; }
    try {
      const r = await api('GET', `/api/thunderstore/search?q=${encodeURIComponent(q)}&page=${page}`);
      const html = r.results.map((m) => {
        const cats = m.categories;
        const tags = [
          cats.includes('Server-side') ? '<span class="tag server">Server-side</span>' : '',
          cats.includes('Client-side') ? '<span class="tag client">Client-side</span>' : '',
          ...cats.filter((c) => !['Server-side', 'Client-side', 'Mods'].includes(c)).slice(0, 3).map((c) => `<span class="tag">${esc(c)}</span>`),
        ].join('');
        const have = installed[m.fullName];
        return `<div class="mod">
          ${m.icon ? `<img src="${esc(m.icon)}" alt="" loading="lazy">` : '<div class="noicon"></div>'}
          <div>
            <div class="title"><a href="https://thunderstore.io/c/valheim/p/${esc(m.namespace)}/${esc(m.name)}/" target="_blank" rel="noopener">${esc(m.name)}</a> <span class="meta">by ${esc(m.namespace)} · ${fmtNum(m.downloads)} downloads</span></div>
            <div class="desc">${esc(m.description)}</div>
            <div class="meta">${tags}</div>
          </div>
          <button class="btn small ${have ? '' : 'primary'}" data-install="${esc(m.fullName)}" ${have?.explicit ? 'disabled' : ''}>${have?.explicit ? 'Installed' : 'Install'}</button>
        </div>`;
      }).join('');
      $('#moreBtn')?.remove();
      if (append) results.insertAdjacentHTML('beforeend', html);
      else results.innerHTML = html || '<p class="hint">No results.</p>';
      if (r.hasMore) results.insertAdjacentHTML('beforeend', '<div class="actions"><button class="btn" id="moreBtn">Load more</button></div>');
    } catch (err) {
      results.innerHTML = '';
      toast(err.message, 'err');
    }
  };
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch(); });
  $('#results').addEventListener('click', async (e) => {
    if (e.target.id === 'moreBtn') { page++; return doSearch(true); }
    const b = e.target.closest('[data-install]');
    if (!b) return;
    b.disabled = true;
    b.textContent = 'Installing…';
    try {
      const r = await api('POST', `/api/servers/${s.id}/mods`, { name: b.dataset.install });
      toast(`Installed ${r.installed.join(', ')} — restart to load`, 'ok');
      b.textContent = 'Installed';
      installed = await loadInstalled();
      refresh();
    } catch (err) {
      toast(err.message, 'err');
      b.disabled = false;
      b.textContent = 'Install';
    }
  });
  doSearch();

  $('#modUploadBtn').addEventListener('click', async () => {
    const file = $('#modFile').files[0];
    if (!file) return toast('Choose a file first', 'err');
    try {
      const r = await api('POST', `/api/servers/${s.id}/mods/upload?filename=${encodeURIComponent(file.name)}`, file, { raw: true });
      toast(`Installed ${r.installed.join(', ')} — restart to load`, 'ok');
      installed = await loadInstalled();
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

// --- configs tab -----------------------------------------------------------

async function tabConfigs(s, body) {
  if (s.modFramework === 'none') {
    body.innerHTML = '<div class="card"><p class="hint">Vanilla server — enable a mod framework in the Mods tab first.</p></div>';
    return;
  }
  body.innerHTML = `<div class="card">
    <h3>Mod config files <small>— a mod writes its .cfg / .yml on first start with it loaded</small></h3>
    <div class="row"><select id="cfgSel"><option value="">Loading…</option></select><button class="btn small" id="cfgReload">↻</button></div>
    <form id="cfgForm" style="margin-top:12px" hidden>
      <textarea class="code" id="cfgText" spellcheck="false"></textarea>
      <div class="actions"><span class="hint" style="margin-right:auto">The previous version is saved as <code>.bak</code>. Restart to apply.</span><button class="btn primary">Save</button></div>
    </form></div>`;

  const sel = $('#cfgSel');
  const loadList = async () => {
    const files = await api('GET', `/api/servers/${s.id}/configs`);
    const keep = sel.value;
    sel.innerHTML = files.length
      ? `<option value="">Choose a file…</option>${files.map((f) => `<option value="${esc(f.name)}">${esc(f.name)} (${fmtBytes(f.size)})</option>`).join('')}`
      : '<option value="">No config files yet — start the server once with mods enabled</option>';
    if (keep && files.some((f) => f.name === keep)) sel.value = keep;
  };
  const open = async () => {
    const name = sel.value;
    $('#cfgForm').hidden = !name;
    if (!name) return;
    $('#cfgText').value = await api('GET', `/api/servers/${s.id}/configs/${encodeURIComponent(name)}`);
  };
  sel.addEventListener('change', () => open().catch((e) => toast(e.message, 'err')));
  $('#cfgReload').addEventListener('click', () => loadList().then(open).catch((e) => toast(e.message, 'err')));
  $('#cfgForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', `/api/servers/${s.id}/configs/${encodeURIComponent(sel.value)}`, $('#cfgText').value, { text: true });
      toast(`Saved ${sel.value} — restart to apply`, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });
  loadList().catch((e) => toast(e.message, 'err'));
}

// --- logs tab --------------------------------------------------------------

function tabLogs(s, body) {
  body.innerHTML = `<div class="row" style="margin-bottom:10px">
      <label class="checks" style="margin:0"><label><input type="checkbox" id="follow" checked> Follow (refresh every 3 s)</label></label>
      <select id="tail" style="max-width:160px"><option>200</option><option selected>500</option><option>2000</option></select>
    </div>
    <pre class="logs" id="logs">Loading…</pre>`;
  const pre = $('#logs');
  const load = async () => {
    try {
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
      const txt = await api('GET', `/api/servers/${s.id}/logs?tail=${$('#tail').value}`);
      pre.textContent = txt || '(no logs — container not created yet)';
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    } catch (err) { pre.textContent = err.message; }
  };
  load().then(() => { pre.scrollTop = pre.scrollHeight; });
  $('#tail').addEventListener('change', load);
  state.logsTimer = setInterval(() => { if ($('#follow')?.checked) load(); }, 3000);
}

function stopLogs() {
  clearInterval(state.logsTimer);
  state.logsTimer = null;
}

// --- new server dialog -----------------------------------------------------

$('#newBtn').addEventListener('click', async () => {
  state.meta = await api('GET', '/api/meta');
  const f = $('#newForm');
  f.reset();
  f.port.value = state.meta.suggestedPort;
  $('#newPreset').innerHTML = `<option value="">Default (normal)</option>${state.meta.worldPresets.map((p) => `<option>${p}</option>`).join('')}`;
  $('#newError').textContent = '';
  $('#newDialog').showModal();
});

$('#newForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const payload = {
    serverName: f.get('serverName'), worldName: f.get('worldName'), password: f.get('password'),
    port: Number(f.get('port')), modFramework: f.get('modFramework'),
    public: f.has('public'), crossplay: f.has('crossplay'), start: f.has('start'),
    world: { preset: f.get('preset'), modifiers: {}, keys: [] },
  };
  $('#newSubmit').disabled = true;
  try {
    const s = await api('POST', '/api/servers', payload);
    $('#newDialog').close();
    toast(`Created ${s.serverName}${payload.start ? ' — starting' : ''}`, 'ok');
    await refresh();
    select(s.id);
  } catch (err) {
    $('#newError').textContent = err.message;
  } finally {
    $('#newSubmit').disabled = false;
  }
});

// --- auth ------------------------------------------------------------------

let authMode = 'login';
function showAuth(mode, hint = '') {
  const d = $('#authDialog');
  if (d.open && authMode === mode) return; // polling hits 401 repeatedly; don't wipe the form
  authMode = mode;
  const f = $('#authForm');
  f.reset();
  const titles = { login: 'Log in', setup: 'Set an admin password', password: 'Change password', blocked: 'Not set up yet' };
  $('#authTitle').textContent = titles[mode];
  $('#authHint').textContent = hint;
  $('#authError').textContent = '';
  $('#authFields').hidden = mode === 'blocked';
  $('#currentWrap').hidden = mode !== 'password';
  $('#confirmWrap').hidden = mode === 'login';
  f.current.required = mode === 'password';
  f.confirm.required = mode === 'setup' || mode === 'password';
  f.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#authSubmit').hidden = mode === 'blocked';
  $('#authSubmit').textContent = mode === 'login' ? 'Log in' : 'Save password';
  $('#authCancel').hidden = mode !== 'password';
  if (!d.open) d.showModal();
}

// Escape must not dismiss the login screen.
$('#authDialog').addEventListener('cancel', (e) => { if (authMode !== 'password') e.preventDefault(); });
$('#authCancel').addEventListener('click', () => $('#authDialog').close());

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (authMode !== 'login' && f.get('password') !== f.get('confirm')) {
    $('#authError').textContent = 'Passwords do not match';
    return;
  }
  const url = { login: '/api/auth/login', setup: '/api/auth/setup', password: '/api/auth/password' }[authMode];
  try {
    await api('POST', url, { password: f.get('password'), current: f.get('current') || undefined });
    $('#authDialog').close();
    if (authMode === 'password') return toast('Password changed', 'ok');
    start();
  } catch (err) {
    $('#authError').textContent = err.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  location.reload();
});
$('#pwBtn').addEventListener('click', () => showAuth('password'));

// --- API keys --------------------------------------------------------------

const KEY_ACTIONS = [['status', 'status'], ['start', 'start'], ['stop', 'stop / shutdown'], ['restart', 'restart'], ['reload', 'reload']];

async function loadKeys() {
  const keys = await api('GET', '/api/keys');
  const name = (id) => state.servers.find((x) => x.id === id)?.serverName || id;
  $('#keyList').innerHTML = keys.length ? `<table><thead><tr><th>Name</th><th>Key</th><th>Servers</th><th>Actions</th><th>Last used</th><th></th></tr></thead><tbody>
    ${keys.map((k) => `<tr>
      <td>${esc(k.name)}</td>
      <td><code>${esc(k.prefix)}…</code></td>
      <td>${k.servers.length ? k.servers.map((id) => esc(name(id))).join(', ') : 'all'}</td>
      <td>${k.actions.map(esc).join(', ')}</td>
      <td class="num">${k.lastUsedAt ? fmtDate(k.lastUsedAt) : 'never'}</td>
      <td><button class="btn small danger" data-revoke="${esc(k.id)}" data-name="${esc(k.name)}">Revoke</button></td>
    </tr>`).join('')}</tbody></table>` : '<p class="hint">No keys yet.</p>';
}

$('#keysBtn').addEventListener('click', async () => {
  const f = $('#keyForm');
  f.reset();
  $('#keyServers').hidden = true;
  $('#keyServers').innerHTML = state.servers.map((s) => `<label><input type="checkbox" name="srv" value="${esc(s.id)}" ${s.id === state.selected ? 'checked' : ''}> ${esc(s.serverName)}</label>`).join('') || '<span class="hint">No servers yet.</span>';
  $('#keyActions').innerHTML = KEY_ACTIONS.map(([v, l]) => `<label><input type="checkbox" name="act" value="${v}" checked> ${l}</label>`).join('');
  $('#keyCreated').hidden = true;
  $('#keysDialog').showModal();
  loadKeys().catch((e) => toast(e.message, 'err'));
});
$('#keysClose').addEventListener('click', () => $('#keysDialog').close());
$('#keyForm').scope.addEventListener('change', (e) => { $('#keyServers').hidden = e.target.value !== 'some'; });

$('#keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const servers = f.scope.value === 'some' ? [...f.querySelectorAll('[name=srv]:checked')].map((i) => i.value) : [];
  if (f.scope.value === 'some' && !servers.length) return toast('Select at least one server', 'err');
  try {
    const k = await api('POST', '/api/keys', {
      name: f.name.value,
      servers,
      actions: [...f.querySelectorAll('[name=act]:checked')].map((i) => i.value),
    });
    const sample = servers[0] || state.selected || state.servers[0]?.id || '<server>';
    const box = $('#keyCreated');
    box.hidden = false;
    box.innerHTML = `<h3>Key “${esc(k.name)}” created — copy it now, it won't be shown again</h3>
      <div class="secret"><code>${esc(k.secret)}</code><button class="btn small primary" data-copy="${esc(k.secret)}">Copy</button></div>
      <pre class="snippet">${esc(`curl -X POST -H "Authorization: Bearer ${k.secret}" ${hookUrl(sample, 'restart')}
${hookUrl(sample, 'status')}?key=${k.secret}`)}</pre>`;
    f.reset();
    $('#keyServers').hidden = true;
    loadKeys();
  } catch (err) { toast(err.message, 'err'); }
});

$('#keysDialog').addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    await navigator.clipboard?.writeText(copy.dataset.copy).catch(() => {});
    return toast('Copied');
  }
  const rv = e.target.closest('[data-revoke]');
  if (!rv) return;
  if (!confirm(`Revoke key "${rv.dataset.name}"? Anything using it stops working.`)) return;
  try { await api('DELETE', `/api/keys/${rv.dataset.revoke}`); toast('Key revoked', 'ok'); loadKeys(); }
  catch (err) { toast(err.message, 'err'); }
});

// --- boot ------------------------------------------------------------------

let started = false;
async function boot() {
  const st = await api('GET', '/api/auth/status').catch((e) => { toast(`Backend unreachable: ${e.message}`, 'err'); return null; });
  if (!st) return;
  if (!st.configured) {
    return st.canSetup
      ? showAuth('setup', `First run: choose the password that protects this manager (min ${st.minLength} characters).`)
      : showAuth('blocked', 'No admin password has been set. Open the manager on the host itself (http://127.0.0.1:8790) to set one.');
  }
  if (!st.authenticated) return showAuth('login');
  start();
}

async function start() {
  if (started) return;
  started = true;
  $('#userMenu').hidden = false;
  try {
    state.meta = await api('GET', '/api/meta');
  } catch (e) {
    toast(`Backend unreachable: ${e.message}`, 'err');
    return;
  }
  $('#meta').innerHTML = `<span>Image: <code>${esc(state.meta.image.replace(/^ghcr\.io\//, ''))}</code> ${state.meta.imagePresent ? '' : '(pulled on first start)'}</span>
    <span>Host: ${esc(state.meta.hostIps.join(', ') || state.meta.hostname)}</span>`;
  if (state.meta.tailscale) $('#meta').insertAdjacentHTML('beforeend', `<span>Tailscale: ${esc(state.meta.tailscale.dnsName || state.meta.tailscale.ip)}</span>`);
  await refresh();
  setInterval(refresh, 3000);
}
boot();

// --- help: friends / public access -----------------------------------------

function relayScript(tsIp) {
  const ranges = state.servers.map((s) => `${s.port}:${s.port + 2}`).join(' ') || '2456:2458';
  return `HOME_TS=${tsIp || '<this PC\'s Tailscale IP>'}
PORTS="${ranges}"

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
netfilter-persistent save         # keep the rules after reboot`;
}

function renderHelp(which) {
  const ts = state.meta?.tailscale;
  const worlds = state.servers.length
    ? `<table class="keys"><thead><tr><th>World</th><th>UDP ports</th><th>Friends join with (Tailscale)</th><th>Public via VPS</th></tr></thead><tbody>
      ${state.servers.map((s) => `<tr><td>${esc(s.serverName)}</td><td>${s.port}–${s.port + 2}</td>
        <td>${ts?.ip ? `<code>${esc(tsAddress(s))}</code>` : '—'}</td>
        <td><code>VPS_IP${s.port === 2456 ? '' : `:${s.port}`}</code></td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">No worlds yet.</p>';
  $('#helpBody').innerHTML = which === 'friends' ? `
    <p>Friends install <a href="https://tailscale.com/download" target="_blank" rel="noopener">Tailscale</a> (free) and get access to this PC. Nothing is exposed to the internet.</p>
    <ol class="steps">
      <li>Open the <a href="https://login.tailscale.com/admin/machines" target="_blank" rel="noopener">Tailscale admin console → Machines</a>, click <b>⋯</b> next to this PC${ts?.dnsName ? ` (<code>${esc(ts.dnsName.split('.')[0])}</code>)` : ''}, then <b>Share…</b>, and send the invite link.</li>
      <li>Your friend logs in to Tailscale, accepts the invite, and keeps Tailscale connected while playing.</li>
      <li>In Valheim: <b>Join Game → Join IP</b>, enter the address below, then the world password.</li>
    </ol>
    ${ts?.ip ? '' : '<p class="error">Tailscale is not running on this PC. Install it and run <code>tailscale up</code> first.</p>'}
    ${worlds}
    <p class="hint">Mods: send friends the share link from the server's <b>Mods</b> tab. More (ACLs, lag, opening this manager from other devices): <code>docs/TAILSCALE.md</code>.</p>` : `
    <div class="banner warn"><span><b>Tailscale Funnel can't do this.</b> Funnel only carries TCP (HTTPS), and Valheim uses UDP. Don't point Funnel at this manager either: it would put the admin UI on the internet.</span></div>

    <h3>Option 1 — Crossplay join code <small>— easiest, nothing to set up</small></h3>
    <ol class="steps">
      <li>Open the server's <b>Settings</b>, tick <b>Crossplay</b>, save, then <b>Restart</b>.</li>
      <li>In <b>Logs</b>, find <code>Session "…" registered with join code 123456</code>.</li>
      <li>Players go to <b>Join Game → Add server</b>, enter the code, then the password. Steam, Xbox and Game Pass players can all join.</li>
    </ol>
    <p class="hint">The code changes on every restart. Traffic goes through Valheim's relay, so latency is a bit higher. Xbox and Game Pass players can't use BepInEx mods.</p>

    <h3>Option 2 — Your own public IP: a VPS relay over Tailscale</h3>
    <p>Rent a small VPS with a public IPv4 (the cheapest plan is enough), then run this as root on it (Debian/Ubuntu). It forwards each world's UDP ports through Tailscale to this PC. Your IP and ports are already filled in:</p>
    <div class="codebox"><pre><code id="relayScript">${esc(relayScript(ts?.ip))}</code></pre>
      <button type="button" class="btn small primary" data-copy-el="relayScript">Copy</button></div>
    <ol class="steps">
      <li>In the VPS provider's firewall or security group, allow <b>inbound UDP</b> on those ports. If the VPS uses ufw, also run <code>ufw route allow proto udp to any port 2456:2458</code> for each range.</li>
      <li>If you restricted friends with a Tailscale ACL, allow the VPS to reach this PC's game ports too.</li>
      <li>Players: <b>Join Game → Join IP</b> → <code>VPS_IP:port</code>.</li>
      <li>Leave <b>List in public server browser</b> off. It would advertise your home IP, not the VPS.</li>
    </ol>
    ${worlds}

    <h3>Option 3 — Router port forwarding</h3>
    <p class="hint">Only if your ISP gives you a real public IPv4 address (no CGNAT). Forward UDP <i>port</i>–<i>port+2</i> for each world to this PC, then tick <b>List in public server browser</b>.</p>
    <p class="hint">Full guide: <code>docs/PUBLIC.md</code>.</p>`;
}

$('#helpBtn').addEventListener('click', () => {
  document.querySelectorAll('[data-help]').forEach((t) => t.classList.toggle('active', t.dataset.help === 'friends'));
  renderHelp('friends');
  $('#helpDialog').showModal();
});
$('#helpClose').addEventListener('click', () => $('#helpDialog').close());
$('#helpDialog').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-help]');
  if (t) {
    document.querySelectorAll('[data-help]').forEach((x) => x.classList.toggle('active', x === t));
    renderHelp(t.dataset.help);
  }
  const c = e.target.closest('[data-copy-el]');
  if (c) {
    await navigator.clipboard?.writeText($(`#${c.dataset.copyEl}`).textContent).catch(() => {});
    toast('Copied');
  }
});
