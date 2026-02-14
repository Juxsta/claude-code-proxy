var Logger = require('./Logger');
var BackendRegistry = require('./backends/registry').BackendRegistry;
var AnthropicBackend = require('./backends/anthropic');
var GeminiBackend = require('./backends/gemini');

var MODEL_ALIASES = {
  auto: null,
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-20250514',
  haiku: 'claude-haiku-4-5-20250514',
  gemini: 'gemini-2.5-pro',
  flash: 'gemini-2.5-flash',
};

class Router {
  constructor(config) {
    this.registry = new BackendRegistry();
    this.config = config;
    this.startTime = Date.now();
    this._initBackends(config);
  }

  _initBackends(config) {
    if (config.backend_anthropic_enabled !== 'false') {
      var anthropic = new AnthropicBackend({
        priority: parseInt(config.backend_anthropic_priority) || 1,
        models: config.backend_anthropic_models
          ? config.backend_anthropic_models.split(',').map(function(s) { return s.trim(); })
          : undefined,
      });
      this.registry.register('anthropic', anthropic);
    }

    if (config.backend_gemini_enabled === 'true') {
      var gemini = new GeminiBackend({
        priority: parseInt(config.backend_gemini_priority) || 2,
        models: config.backend_gemini_models
          ? config.backend_gemini_models.split(',').map(function(s) { return s.trim(); })
          : undefined,
        disableSearch: config.backend_gemini_disable_search === 'true',
      });
      this.registry.register('gemini', gemini);
    }
  }

  resolveModel(model) {
    if (!model) return { resolved: null, isAlias: false };
    var lower = model.toLowerCase();
    if (lower in MODEL_ALIASES) {
      return { resolved: MODEL_ALIASES[lower], isAlias: true, alias: lower };
    }
    return { resolved: model, isAlias: false };
  }

  async handleRequest(req, res, body, presetName) {
    var resolveResult = this.resolveModel(body.model);
    var model = resolveResult.resolved;

    if (resolveResult.isAlias) {
      Logger.info('Model alias: ' + body.model + ' -> ' + (model || 'auto'));
    }

    var backends = this.registry.getAllBackendsForModel(model || 'auto');

    if (backends.length === 0) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'No backends available for model: ' + (body.model || 'auto') },
      }));
      return;
    }

    var lastError = null;
    for (var i = 0; i < backends.length; i++) {
      var entry = backends[i];
      var backend = entry.backend;

      if (!backend.isHealthy()) {
        Logger.debug('Skipping unhealthy backend: ' + entry.id);
        continue;
      }

      try {
        Logger.info('Routing to backend: ' + entry.id + ' (model: ' + (model || body.model || 'default') + ')');
        this.registry.incrementRequestCount(entry.id);

        if (entry.id === 'anthropic') {
          await backend.sendRequest(req, res, body, presetName);
        } else {
          var backendBody = Object.assign({}, body);
          if (model) backendBody.model = model;
          await backend.sendRequest(req, res, backendBody, presetName);
        }

        this.registry.markHealthy(entry.id);
        return;
      } catch (error) {
        lastError = error;
        Logger.warn('Backend ' + entry.id + ' failed: ' + error.message);
        this.registry.markDegraded(entry.id, error.message);
      }
    }

    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: 'All backends failed. Last error: ' + (lastError ? lastError.message : 'unknown'),
        },
      }));
    }
  }

  getStatus() {
    var uptime = Date.now() - this.startTime;
    var hours = Math.floor(uptime / 3600000);
    var mins = Math.floor((uptime % 3600000) / 60000);

    return {
      backends: this.registry.getStatus(),
      uptime: hours + 'h ' + mins + 'm',
      uptimeMs: uptime,
    };
  }
}

module.exports = Router;
