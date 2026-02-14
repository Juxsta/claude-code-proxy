const Logger = require('../Logger');

class BackendRegistry {
  constructor() {
    this.backends = new Map();
    this.requestCounts = { anthropic: 0, gemini: 0 };
  }

  register(name, backend) {
    this.backends.set(name, backend);
    Logger.info('Registered backend: ' + name + ' (priority=' + backend.priority + ', enabled=' + backend.enabled + ')');
  }

  getBackend(name) {
    return this.backends.get(name);
  }

  /**
   * Find the best healthy backend that supports the given model.
   * Returns array of backends sorted by priority (lower = higher priority).
   */
  getBackendsForModel(model) {
    const results = [];
    for (const [name, backend] of this.backends) {
      if (!backend.enabled) continue;
      if (backend.models && backend.models.includes(model)) {
        results.push({ name, backend });
      }
    }
    results.sort((a, b) => a.backend.priority - b.backend.priority);
    return results;
  }

  /**
   * Get the highest-priority healthy backend (for "auto" alias).
   */
  getDefaultBackend() {
    const entries = [...this.backends.entries()]
      .filter(([, b]) => b.enabled && b.isHealthy())
      .sort((a, b) => a[1].priority - b[1].priority);
    return entries.length > 0 ? { name: entries[0][0], backend: entries[0][1] } : null;
  }

  getAllBackends() {
    const result = {};
    for (const [name, backend] of this.backends) {
      result[name] = {
        type: backend.type,
        enabled: backend.enabled,
        priority: backend.priority,
        healthy: backend.isHealthy(),
        models: backend.models || []
      };
    }
    return result;
  }

  getRequestCounts() {
    return { ...this.requestCounts };
  }

  incrementCount(backendName) {
    if (this.requestCounts[backendName] !== undefined) {
      this.requestCounts[backendName]++;
    }
  }
}

// Singleton
module.exports = new BackendRegistry();
