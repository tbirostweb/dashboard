import WebSocket from 'ws';

const AGE = 5 * 60_000;
const finite = (v, max = Infinity) => (typeof v === 'number' || typeof v === 'string' && v.trim()) && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= max ? Number(v) : null;
const size = (v) => {
  const m = typeof v === 'string' && v.match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)$/);
  if (!m) return null;
  const units = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4 };
  return finite(Number(m[1]) * units[m[2]]);
};

// Only the literal appName=dokploy branch is host monitoring; never feed application/container series here.
export function nativeMetrics(data, now, mode = 'snapshot') {
  const out = { status: 'no_data', scope: 'vps', source: 'dokploy_native', monitoringMode: mode, storageScope: 'root_filesystem', observedAt: null, reason: 'empty_series', message: 'Aucune mesure système intégrée reçue. Ouvrez Monitoring dans Dokploy ou vérifiez la connexion de collecte.', cpuPercent: null, ramUsedBytes: null, ramTotalBytes: null, storageUsedBytes: null, storageTotalBytes: null };
  if (!data || typeof data !== 'object') return out;
  let latest = null, stale = false, unknown = false;
  for (const key of ['cpu', 'memory', 'disk']) {
    const rows = Array.isArray(data[key]) ? data[key] : data[key] ? [data[key]] : [];
    const row = rows.at(-1);
    if (!row || typeof row !== 'object') continue;
    const at = typeof row.time === 'string' ? Date.parse(row.time) : NaN;
    if (!Number.isFinite(at) || at > now + 30_000) { unknown = true; continue; }
    latest = Math.max(latest ?? at, at);
    if (now - at > AGE) { stale = true; continue; }
    if (key === 'cpu' && typeof row.value === 'string' && /^\d+(?:\.\d+)?%$/.test(row.value)) out.cpuPercent = finite(row.value.slice(0, -1), 100);
    if (key === 'memory') {
      const used = size(row.value?.used), total = size(row.value?.total);
      // Dokploy itself falls back to 0GiB/0GiB on OS collection failure; this is not a real zero-capacity VPS.
      if (total !== null && total > 0 && used !== null && used <= total) { out.ramUsedBytes = used; out.ramTotalBytes = total; }
    }
    if (key === 'disk') {
      const used = finite(row.value?.diskUsage), total = finite(row.value?.diskTotal);
      // node-os-utils toGB(): decimal GB. This is '/', not the aggregate capacity of all VPS disks.
      if (total !== null && total > 0 && used !== null && used <= total) { out.storageUsedBytes = used * 1000 ** 3; out.storageTotalBytes = total * 1000 ** 3; }
    }
  }
  out.observedAt = latest === null ? null : new Date(latest).toISOString();
  if (['cpuPercent','ramUsedBytes','storageUsedBytes'].some((k) => out[k] !== null)) { out.status = 'available'; out.reason = null; out.message = stale || unknown ? 'Certaines mesures sont indisponibles ou anciennes. Le stockage concerne le système de fichiers racine observé par Dokploy.' : 'Mesures système intégrées Dokploy. Le stockage concerne le système de fichiers racine observé par Dokploy.'; }
  else if (stale) { out.status = 'stale'; out.reason = 'older_than_5_min'; out.message = 'Dernières mesures intégrées anciennes (plus de 5 min) : collecte interrompue ou indisponible.'; }
  else if (unknown) { out.status = 'unknown'; out.reason = 'timestamp_invalid'; out.message = 'Fraîcheur des mesures intégrées inconnue : horodatage absent ou invalide.'; }
  return out;
}

// URLs never contain credentials. These two fixed native websocket routes are verified only in Dokploy v0.26.5.
export class NativeDokploy {
  constructor({ url, apiKey, createSocket = (url, opts) => new WebSocket(url, opts), now = () => Date.now() }) {
    this.base = url; this.apiKey = apiKey; this.createSocket = createSocket; this.now = now;
    this.socket = null; this.data = null; this.failures = 0; this.retryAt = 0; this.closed = false; this.activeLogs = new Set();
  }
  connect(path, query, maxPayload) {
    const u = new URL(this.base); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = `${u.pathname.replace(/\/$/, '')}/${path}`; u.search = '';
    for (const [k,v] of Object.entries(query)) if (v !== null && v !== undefined) u.searchParams.set(k,v);
    return this.createSocket(u, { headers: { 'x-api-key': this.apiKey }, handshakeTimeout: 5000, followRedirects: false, maxPayload });
  }
  watch() {
    if (this.closed) return;
    this.lastRequested = this.now();
    if (this.socket || this.now() < this.retryAt) return;
    let ws;
    try { ws = this.connect('listen-docker-stats-monitoring', { appName: 'dokploy' }, 256 * 1024); } catch { this.failed(); return; }
    this.socket = ws;
    let timer = setTimeout(() => ws.terminate(), 10_000); timer.unref?.();
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => ws.terminate(), 10_000); timer.unref?.(); };
    ws.on('message', (buf) => {
      try { const j = JSON.parse(buf.toString()); const dto = nativeMetrics(j.data, this.now(), 'stream'); if (dto.status === 'available') { this.data = dto; this.failures = 0; } } catch { /* untrusted message, no raw output */ }
      if (this.now() - this.lastRequested > 120_000) ws.terminate(); else arm();
    });
    ws.on('error', () => { /* close handles backoff; never log URLs or errors */ });
    ws.on('close', () => { clearTimeout(timer); if (this.socket === ws) this.socket = null; this.failed(); });
  }
  failed() { this.failures++; this.retryAt = this.now() + Math.min(300_000, 5000 * 2 ** Math.min(this.failures - 1, 6)); }
  current() { return this.data && this.now() - Date.parse(this.data.observedAt) <= AGE ? this.data : null; }
  logs(logPath, serverId) {
    // Upstream-controlled values are still untrusted: remote Dokploy interpolates this path into a shell command.
    if (typeof logPath !== 'string' || !/^\/etc\/dokploy\/logs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._:-]+\.log$/.test(logPath) || logPath.split('/').some((p) => p === '..' || p === '.')) return Promise.resolve({ state: 'unsupported', text: null });
    if (serverId !== null && serverId !== undefined && (typeof serverId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(serverId))) return Promise.resolve({ state: 'unsupported', text: null });
    if (this.closed || this.activeLogs.size >= 4) return Promise.resolve({ state: 'temporary', text: null });
    return new Promise((resolve) => {
      let ws, timer, idle, text = '', ended = false, truncated = false;
      const finish = (state) => { if (ended) return; ended = true; clearTimeout(timer); clearTimeout(idle); this.activeLogs.delete(ws); ws?.terminate(); resolve({ state, text: text || null, truncated }); };
      try { ws = this.connect('listen-deployment', { logPath, serverId }, 256 * 1024); } catch { finish('temporary'); return; }
      this.activeLogs.add(ws);
      timer = setTimeout(() => finish(text ? 'available' : 'temporary'), 8000); timer.unref?.();
      ws.on('message', (buf) => {
        const chunk = buf.toString();
        // These are transport/file/SSH errors, never expose paths or remote error text.
        if (/^(tail error:|SSH error:)/i.test(chunk)) { finish('temporary'); return; }
        text += chunk;
        if (Buffer.byteLength(text) > 256 * 1024) { text = text.slice(-64 * 1024); truncated = true; finish('available'); return; }
        clearTimeout(idle); idle = setTimeout(() => finish('available'), 600); idle.unref?.();
      });
      ws.on('unexpected-response', (_req, response) => { response.resume?.(); finish([401,403].includes(response.statusCode) ? 'permission' : 'temporary'); });
      ws.on('error', () => finish('temporary'));
      ws.on('close', () => finish(text ? 'available' : 'temporary'));
    });
  }
  close() { this.closed = true; this.socket?.terminate(); for (const ws of this.activeLogs) ws.terminate(); }
}
