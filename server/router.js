const Logger = require('./Logger');
const registry = require('./backends/registry');

const MODEL_ALIASES = {
  'auto': null, // resolved dynamically
  'sonnet': 'claude-sonnet-4-20250514',
  'opus': 'claude-opus-4-20250514',
  'haiku': 'claude-haiku-4-5-20250514',
  'gemini': 'gemini-2.5-pro',
  'flash': 'gemini-2.5-flash',
};

const RETRYABLE_STATUS = new Set([403, 429, 503, 529]);

function resolveModel(model) {
  if (!model) return { resolved: null, isAuto: true };
  const lower = model.toLowerCase();
  if (lower === 'auto') return { resolved: null, isAuto: true };
  if (MODEL_ALIASES[lower]) return { resolved: MODEL_ALIASES[lower], isAuto: false };
  return { resolved: model, isAuto: false };
}

function detectBackendForModel(model) {
  if (!model) return null;
  if (model.startsWith('claude-') || model.startsWith('anthropic/')) return 'anthropic';
  if (model.startsWith('gemini-') || model.startsWith('google/')) return 'gemini';
  return null;
}

async function routeRequest(req, res, body, presetName) {
  const originalModel = body.model;
  const { resolved, isAuto } = resolveModel(originalModel);

  let model = resolved;
  let backends = [];

  if (isAuto || !model) {
    // Use highest-priority healthy backend's default model
    const def = registry.getDefaultBackend();
    if (!def) {
      Logger.error('No healthy backends available');
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'service_unavailable', message: 'All backends are unavailable' } }));
      return;
    }
    backends = [def];
    // Keep original model for the backend to handle, or use first model from backend
    if (!model) model = def.backend.models[0];
    body.model = model;
    Logger.info('Auto-resolved to backend=' + def.name + ' model=' + model);
  } else {
    body.model = model;
    // Find backends that support this model
    backends = registry.getBackendsForModel(model);

    if (backends.length === 0) {
      // Try detecting backend by model name pattern
      const backendName = detectBackendForModel(model);
      if (backendName) {
        const backend = registry.getBackend(backendName);
        if (backend && backend.enabled) {
          backends = [{ name: backendName, backend }];
        }
      }
    }

    if (backends.length === 0) {
      Logger.error('No backend found for model: ' + model);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'No backend available for model: ' + model } }));
      return;
    }
  }

  // Try each backend in priority order
  for (let i = 0; i < backends.length; i++) {
    const { name, backend } = backends[i];

    if (!backend.isHealthy()) {
      Logger.info('Skipping unhealthy backend: ' + name);
      continue;
    }

    Logger.info('Routing to backend=' + name + ' model=' + model);
    registry.incrementCount(name);

    try {
      const result = await backend.sendRequest(req, res, body, presetName);

      // If backend returned an error status that's retryable, try next
      if (result && result.statusCode && RETRYABLE_STATUS.has(result.statusCode) && i < backends.length - 1) {
        Logger.warn('Backend ' + name + ' returned ' + result.statusCode + ', trying next backend');
        continue;
      }

      return; // Success or non-retryable error
    } catch (error) {
      Logger.error('Backend ' + name + ' failed: ' + error.message);
      if (i < backends.length - 1) {
        Logger.info('Retrying with next backend...');
        continue;
      }
      // Last backend failed
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Backend request failed: ' + error.message } }));
      }
      return;
    }
  }

  // All backends exhausted
  if (!res.headersSent) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'service_unavailable', message: 'All backends are unavailable or returned errors' } }));
  }
}

module.exports = { routeRequest, resolveModel, MODEL_ALIASES };
