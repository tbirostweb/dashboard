// Dokploy « en direct » : charge utile PETITE pour GET /api/infrastructure/live.
// Aucune interrogation de fond : Dokploy n'est appelé que lorsque la route est sollicitée (la présence pilote).
// Coalescence : single-flight global + TTL courts par composant (métriques 2 s, statuts 5 s, déploiements en cours 3 s),
// donc plusieurs onglets n'aggravent pas la charge. Jamais de débit inventé : null si indéterminable.
// La fraîcheur réelle des mesures est bornée par le `refreshRate` du monitoring configuré dans Dokploy (60 s par défaut).
import { DokployError, MON, emptyServer, NUM_MAX, extractServices, list, str, mapStatus, ID_RE, REDEPLOY_TYPES } from './dokploy.js';

const CALL_TIMEOUT_MS = 4000;
const CONFIG_TTL_MS = 60_000;
const FAILURE_TTL_MS = 10_000;
const STALE_AFTER_MS = 5 * 60_000;
const HISTORY_MAX = 24;
const MAX_RUNNING_LOOKUPS = 10;
export const HINT = 'Pour des mesures plus fréquentes, réduisez l’intervalle de rafraîchissement du monitoring dans Dokploy (minimum 2 s).';
const GIB = 1024 ** 3;
const MIB_BITS_PER_MBIT = (1024 * 1024 * 8) / 1_000_000; // 1 MiB = 8,388608 mégabits (décimaux)

const round = (v, d = 2) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

/** Débit réseau (Mbit/s) entre deux points à compteurs cumulés en MiB ; null si indéterminable ou compteur en régression. */
export function networkRate(prev, last, field) {
  if (!prev || !last) return null;
  const a = NUM_MAX(prev[field]), b = NUM_MAX(last[field]);
  const dt = (Date.parse(last.timestamp) - Date.parse(prev.timestamp)) / 1000;
  if (a === null || b === null || !Number.isFinite(dt) || dt <= 0 || b < a) return null;
  return round(((b - a) * MIB_BITS_PER_MBIT) / dt);
}

export class DokployLive {
  constructor({ client, now = () => Date.now(), metricsTtlMs = 2000, statusTtlMs = 5000, runningTtlMs = 3000 }) {
    Object.assign(this, { client, now, metricsTtlMs, statusTtlMs, runningTtlMs });
    this.inflight = null;
    this.metricsCfg = null;     // { until, value: { url, token } } — le jeton n'est jamais exposé
    this.metricsCache = null;   // { until, value }
    this.metricsInflight = null;
    this.statusCache = null;
    this.statusInflight = null;
    this.runningCache = null;
    this.runningInflight = null;
    this.history = [];          // horodatages (ms) d'échantillons déjà vus, pour estimer l'intervalle médian
    this.sig = null;
    this.changedAt = null;
    this.lastServices = [];
  }

  /** Single-flight : N requêtes simultanées = une seule lecture. */
  read() {
    if (!this.client.configured) return Promise.resolve(this.unconfigured());
    if (this.inflight) return this.inflight;
    this.inflight = this.compute().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  unconfigured() {
    const t = this.now();
    return {
      observedAt: new Date(t).toISOString(),
      connection: { status: 'not_configured', reason: 'configuration' },
      server: this.serverPayload(emptyServer('unknown', 'dokploy_not_configured', MON.not_checked), null),
      services: [], runningDeployments: [], changedAt: null
    };
  }

  async compute() {
    const [metrics, statuses] = await Promise.all([this.metrics(), this.statuses()]);
    const running = statuses.error ? (this.runningCache ? this.runningCache.value : []) : await this.running(statuses.services);
    const t = this.now();
    const services = statuses.services.map((s) => ({ id: s.id, type: s.type, status: s.status }));
    if (!statuses.error) {
      const sig = JSON.stringify([services.map((s) => `${s.type}:${s.id}:${s.status}`), [...running].sort()]);
      if (sig !== this.sig) { this.sig = sig; this.changedAt = new Date(t).toISOString(); }
    }
    return {
      observedAt: new Date(t).toISOString(),
      connection: statuses.error ? { status: 'error', reason: statuses.error } : { status: 'connected', reason: null },
      server: this.serverPayload(metrics.server, metrics.rows),
      services,
      runningDeployments: running,
      changedAt: this.changedAt
    };
  }

  // ---------------------------------------------------------------- Métriques (TTL 2 s)
  metrics() {
    const t = this.now();
    if (this.metricsCache && this.metricsCache.until > t) return Promise.resolve(this.metricsCache.value);
    if (this.metricsInflight) return this.metricsInflight;
    this.metricsInflight = this.readMetrics().then((value) => {
      const ok = value.server.status === 'available' || value.server.status === 'stale';
      this.metricsCache = { until: this.now() + (ok ? this.metricsTtlMs : Math.max(this.metricsTtlMs, FAILURE_TTL_MS)), value };
      return value;
    }).finally(() => { this.metricsInflight = null; });
    return this.metricsInflight;
  }

  async metricsConfig() {
    if (this.metricsCfg && this.metricsCfg.until > this.now()) return { value: this.metricsCfg.value };
    let config;
    try { config = await this.client.call('user.getMetricsToken', {}, 'GET', { timeoutMs: CALL_TIMEOUT_MS }); } catch (err) { return { failure: this.client.monitoringFailure(err, 'config') }; }
    const off = (status, reason, message) => ({ failure: emptyServer(status, reason, message) });
    const server = config?.metricsConfig?.server;
    if (!config || typeof config !== 'object' || !server || typeof server !== 'object') return off('incompatible_response', 'metrics_config_shape', MON.incompatible);
    const token = typeof server.token === 'string' ? server.token : '', callback = typeof server.urlCallback === 'string' ? server.urlCallback : '';
    if (!token && !callback) return off('not_configured', 'token_and_callback_empty', MON.not_configured);
    if (!token) return off('incomplete_config', 'token_missing', MON.incomplete_token);
    const host = config.serverIp, port = Number(server.port);
    if (typeof host !== 'string' || !/^[a-zA-Z0-9.:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return off('incomplete_config', 'host_or_port_missing', MON.incomplete_host);
    const value = { url: `http://${host.includes(':') ? `[${host}]` : host}:${port}/metrics`, token };
    this.metricsCfg = { until: this.now() + CONFIG_TTL_MS, value };
    return { value };
  }

  async readMetrics() {
    const cfg = await this.metricsConfig();
    let result = null;
    if (cfg.failure) result = { server: cfg.failure, rows: null };
    else {
      let rows;
      try { rows = await this.client.call('server.getServerMetrics', { url: cfg.value.url, token: cfg.value.token, dataPoints: '2' }, 'GET', { timeoutMs: CALL_TIMEOUT_MS }); } catch (err) {
        this.metricsCfg = null; // jeton peut-être renouvelé : relecture de la configuration au prochain tour
        result = { server: this.client.monitoringFailure(err, 'metrics'), rows: null };
      }
      if (!result) result = this.parseRows(rows);
    }
    if (result.server.status === 'available' || result.server.status === 'stale') return result;
    // Agent indisponible : même repli que le snapshot (collecte intégrée de Dokploy). Aucun débit réseau dans ce cas.
    if (!['permission', 'unsupported'].includes(result.server.status)) {
      try {
        const host = await this.client.hostMetrics(this.now() + CALL_TIMEOUT_MS * 2);
        if (host && (host.status === 'available' || host.status === 'stale')) return { server: host, rows: null, native: true };
      } catch { /* on garde l'état de l'agent */ }
    }
    return result;
  }

  parseRows(rows) {
    const off = (status, reason, message) => ({ server: emptyServer(status, reason, message), rows: null });
    if (!Array.isArray(rows)) return off('incompatible_response', 'not_an_array', MON.incompatible);
    if (!rows.length) return off('no_data', 'empty_series', MON.no_data);
    const points = rows.filter((r) => r && typeof r === 'object').map((r) => ({ ...r, ts: Date.parse(str(r.timestamp)) }));
    if (!points.length) return off('incompatible_response', 'row_shape', MON.incompatible);
    const sorted = [...points].sort((a, b) => (Number.isFinite(a.ts) ? a.ts : -Infinity) - (Number.isFinite(b.ts) ? b.ts : -Infinity));
    const row = sorted.at(-1);
    const gib = (v) => { const n = NUM_MAX(v); return n === null ? null : n * GIB; };
    const totalDisk = gib(row.totalDisk), diskPercent = NUM_MAX(row.diskUsed, 100);
    const cpuPercent = NUM_MAX(row.cpu, 100), ramUsedBytes = gib(row.memUsedGB), ramTotalBytes = gib(row.memTotal);
    const storageUsedBytes = totalDisk !== null && diskPercent !== null ? totalDisk * diskPercent / 100 : null;
    if ([cpuPercent, ramUsedBytes, ramTotalBytes, storageUsedBytes, totalDisk].every((v) => v === null)) return off('incompatible_response', 'no_usable_field', MON.incompatible);
    const known = Number.isFinite(row.ts);
    const fresh = known && this.now() - row.ts <= STALE_AFTER_MS;
    const status = fresh ? 'available' : known ? 'stale' : 'unknown';
    const server = {
      ...emptyServer(status, status === 'available' ? null : status === 'stale' ? 'older_than_5_min' : 'timestamp_invalid', fresh ? null : known ? MON.stale : MON.stale_unknown),
      observedAt: known ? new Date(row.ts).toISOString() : null, cpuPercent, ramUsedBytes, ramTotalBytes, storageUsedBytes, storageTotalBytes: totalDisk
    };
    const prev = sorted.length >= 2 ? sorted.at(-2) : null;
    const usable = known && prev && Number.isFinite(prev.ts);
    if (known) {
      for (const p of sorted) if (Number.isFinite(p.ts) && !this.history.includes(p.ts)) this.history.push(p.ts);
      this.history.sort((a, b) => a - b);
      if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    }
    return {
      server,
      rows: {
        uptimeSeconds: NUM_MAX(row.uptime),
        networkInMbps: usable ? networkRate({ ...prev, timestamp: new Date(prev.ts).toISOString() }, { ...row, timestamp: new Date(row.ts).toISOString() }, 'networkIn') : null,
        networkOutMbps: usable ? networkRate({ ...prev, timestamp: new Date(prev.ts).toISOString() }, { ...row, timestamp: new Date(row.ts).toISOString() }, 'networkOut') : null
      }
    };
  }

  /** Charge utile `server` : GiB, pourcentages, âge de l'échantillon calculé à la réponse ; null ≠ 0. */
  serverPayload(server, extra) {
    const t = this.now();
    const gib = (b) => (b === null || b === undefined ? null : round(b / GIB, 2));
    const used = server.ramUsedBytes ?? null, total = server.ramTotalBytes ?? null;
    const dUsed = server.storageUsedBytes ?? null, dTotal = server.storageTotalBytes ?? null;
    const at = server.observedAt ? Date.parse(server.observedAt) : NaN;
    const gaps = [];
    for (let i = 1; i < this.history.length; i++) gaps.push((this.history[i] - this.history[i - 1]) / 1000);
    const interval = extra && gaps.length ? Math.round(median(gaps)) : null;
    const out = {
      status: server.status,
      reason: server.reason ?? null,
      message: server.message ?? null,
      cpuPercent: server.cpuPercent ?? null,
      memoryUsedGiB: gib(used),
      memoryTotalGiB: gib(total),
      memoryPercent: used !== null && total !== null && total > 0 ? round((used / total) * 100, 1) : null,
      diskUsedGiB: gib(dUsed),
      diskTotalGiB: gib(dTotal),
      diskPercent: dUsed !== null && dTotal !== null && dTotal > 0 ? round((dUsed / dTotal) * 100, 1) : null,
      networkInMbps: extra ? extra.networkInMbps : null,
      networkOutMbps: extra ? extra.networkOutMbps : null,
      uptimeSeconds: extra ? extra.uptimeSeconds : null,
      sampleAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
      sampleAgeSeconds: Number.isFinite(at) ? Math.max(0, Math.round((t - at) / 1000)) : null,
      sampleIntervalSeconds: interval,
      hint: interval !== null && interval > 10 ? HINT : null
    };
    return out;
  }

  // ---------------------------------------------------------------- Statuts des services (TTL 5 s, un seul appel project.all)
  statuses() {
    const t = this.now();
    if (this.statusCache && this.statusCache.until > t) return Promise.resolve(this.statusCache.value);
    if (this.statusInflight) return this.statusInflight;
    this.statusInflight = this.readStatuses().then((value) => {
      this.statusCache = { until: this.now() + this.statusTtlMs, value };
      return value;
    }).finally(() => { this.statusInflight = null; });
    return this.statusInflight;
  }

  async readStatuses() {
    let raw;
    try { raw = list(await this.client.call('project.all', {}, 'GET', { timeoutMs: CALL_TIMEOUT_MS * 2 })).filter((p) => p && typeof p === 'object' && str(p.projectId)).slice(0, 100); } catch (err) {
      return { services: this.lastServices, error: err instanceof DokployError ? err.reason : 'http' };
    }
    const known = new Map(((this.client.cache && this.client.cache.value && this.client.cache.value.services) || []).map((s) => [`${s.type}:${s.id}`, s.status]));
    const byKey = new Map();
    for (const row of raw) {
      for (const s of extractServices(row, { projectId: str(row.projectId), projectName: str(row.name) })) {
        const key = `${s.type}:${s.id}`;
        const prev = byKey.get(key);
        const status = s.status ?? (prev && prev.status) ?? null;
        byKey.set(key, { id: s.id, type: s.type, status });
      }
    }
    const services = [...byKey.entries()].map(([key, s]) => ({ ...s, status: s.status ?? known.get(key) ?? 'Indisponible' }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
    this.lastServices = services;
    return { services, error: null };
  }

  // ---------------------------------------------------------------- Déploiements en cours (TTL 3 s, lecture ciblée)
  running(services) {
    const t = this.now();
    if (this.runningCache && this.runningCache.until > t) return Promise.resolve(this.runningCache.value);
    if (this.runningInflight) return this.runningInflight;
    this.runningInflight = this.readRunning(services).then((value) => {
      this.runningCache = { until: this.now() + this.runningTtlMs, value };
      return value;
    }).finally(() => { this.runningInflight = null; });
    return this.runningInflight;
  }

  /** Seuls les services dont le statut est « running » (déploiement en cours) sont relus : aucun N+1 sur tout le parc. */
  async readRunning(services) {
    const targets = services.filter((s) => REDEPLOY_TYPES.includes(s.type) && ID_RE.test(s.id) && String(s.status).toLowerCase() === 'running').slice(0, MAX_RUNNING_LOOKUPS);
    const ids = new Set();
    await Promise.all(targets.map(async (s) => {
      try {
        const rows = await this.client.deploymentRows(s.type, s.id, { timeoutMs: CALL_TIMEOUT_MS });
        for (const row of rows) if (mapStatus(row.status) === 'running' && str(row.deploymentId)) ids.add(str(row.deploymentId));
      } catch { /* lecture ciblée en échec : ce service n'ajoute rien */ }
    }));
    return [...ids].sort();
  }
}
