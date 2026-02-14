const Logger = require('../Logger');

const HEALTH_STATES = { HEALTHY: 'healthy', DEGRADED: 'degraded', DOWN: 'down' };
const DEGRADED_THRESHOLD = 3;
const DOWN_THRESHOLD = 6;
const DEGRADED_COOLDOWN_MS = 60000;
const DOWN_COOLDOWN_MS = 300000;

class BackendRegistry {
  constructor() {
    this.backends = new Map();
  }

  register(id, backend) {
    this.backends.set(id, {
      id,
      backend,
      type: backend.type || id,
      priority: backend.priority || 99,
      models: backend.models || [],
      status: HEALTH_STATES.HEALTHY,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorTime: null,
      degradedUntil: null,
      requestCount: 0,
    });
    Logger.info('Backend registered: ' + id + ' (priority ' + backend.priority + ', models: ' + (backend.models || []).join(', ') + ')');
  }

  getBackend(model) {
    // Check by backend id first
    const byId = this.backends.get(model);
    if (byId && byId.status !== "down") return byId.backend;

    const now = Date.now();
    const candidates = [];

    for (const entry of this.backends.values()) {
      if (entry.degradedUntil && now >= entry.degradedUntil) {
        entry.status = HEALTH_STATES.HEALTHY;
        entry.consecutiveFailures = 0;
        entry.degradedUntil = null;
        Logger.info('Backend ' + entry.id + ' cooldown expired, marking healthy');
      }

      if (entry.status === HEALTH_STATES.DOWN) continue;

      if (model === 'auto' || !model) {
        candidates.push(entry);
      } else if (entry.models.includes(model)) {
        candidates.push(entry);
      }
    }

    candidates.sort((a, b) => {
      if (a.status !== b.status) {
        if (a.status === HEALTH_STATES.HEALTHY) return -1;
        if (b.status === HEALTH_STATES.HEALTHY) return 1;
      }
      return a.priority - b.priority;
    });

    return candidates.length > 0 ? candidates[0] : null;
  }

  getAllBackendsForModel(model) {
    const now = Date.now();
    const candidates = [];

    for (const entry of this.backends.values()) {
      if (entry.degradedUntil && now >= entry.degradedUntil) {
        entry.status = HEALTH_STATES.HEALTHY;
        entry.consecutiveFailures = 0;
        entry.degradedUntil = null;
      }

      if (model === 'auto' || !model || entry.models.includes(model)) {
        candidates.push(entry);
      }
    }

    candidates.sort((a, b) => {
      const stateOrder = { healthy: 0, degraded: 1, down: 2 };
      const stateDiff = (stateOrder[a.status] || 0) - (stateOrder[b.status] || 0);
      if (stateDiff !== 0) return stateDiff;
      return a.priority - b.priority;
    });

    return candidates;
  }

  markDegraded(backendId, reason, durationMs) {
    const entry = this.backends.get(backendId);
    if (!entry) return;

    entry.consecutiveFailures++;
    entry.lastError = reason;
    entry.lastErrorTime = new Date().toISOString();

    if (entry.consecutiveFailures >= DOWN_THRESHOLD) {
      entry.status = HEALTH_STATES.DOWN;
      entry.degradedUntil = Date.now() + (durationMs || DOWN_COOLDOWN_MS);
      Logger.warn('Backend ' + backendId + ' marked DOWN (' + entry.consecutiveFailures + ' failures): ' + reason);
    } else if (entry.consecutiveFailures >= DEGRADED_THRESHOLD) {
      entry.status = HEALTH_STATES.DEGRADED;
      entry.degradedUntil = Date.now() + (durationMs || DEGRADED_COOLDOWN_MS);
      Logger.warn('Backend ' + backendId + ' marked DEGRADED (' + entry.consecutiveFailures + ' failures): ' + reason);
    }
  }

  markHealthy(backendId) {
    const entry = this.backends.get(backendId);
    if (!entry) return;

    if (entry.status !== HEALTH_STATES.HEALTHY) {
      Logger.info('Backend ' + backendId + ' recovered, marking healthy');
    }
    entry.status = HEALTH_STATES.HEALTHY;
    entry.consecutiveFailures = 0;
    entry.degradedUntil = null;
  }

  incrementRequestCount(backendId) {
    const entry = this.backends.get(backendId);
    if (entry) entry.requestCount++;
  }

  // --- Aliases and convenience methods for server.js / router.js ---

  getAllBackends() {
    const result = {};
    for (const entry of this.backends.values()) {
      result[entry.id] = {
        enabled: entry.status !== 'down',
        priority: entry.priority,
        healthy: entry.status === 'healthy',
        models: entry.models,
        requestCount: entry.requestCount,
      };
    }
    return result;
  }

  getRequestCounts() {
    const counts = {};
    for (const entry of this.backends.values()) {
      counts[entry.id] = entry.requestCount;
    }
    return counts;
  }

  getDefaultBackend() {
    const entry = this.getBackend('auto');
    if (!entry) return null;
    return { name: entry.id, backend: entry.backend };
  }

  getById(id) {
    const entry = this.backends.get(id);
    if (!entry) return null;
    return entry;
  }

  getBackendsForModel(model) {
    return this.getAllBackendsForModel(model);
  }

  incrementCount(id) {
    return this.incrementRequestCount(id);
  }

  getStatus() {
    const result = [];
    for (const entry of this.backends.values()) {
      result.push({
        id: entry.id,
        type: entry.type,
        priority: entry.priority,
        status: entry.status,
        models: entry.models,
        consecutiveFailures: entry.consecutiveFailures,
        lastError: entry.lastError,
        lastErrorTime: entry.lastErrorTime,
        requestCount: entry.requestCount,
        healthy: entry.backend.isHealthy ? entry.backend.isHealthy() : entry.status === HEALTH_STATES.HEALTHY,
      });
    }
    return result;
  }
}

const registrySingleton = new BackendRegistry();
module.exports = registrySingleton;
module.exports.BackendRegistry = BackendRegistry;
module.exports.HEALTH_STATES = HEALTH_STATES;
