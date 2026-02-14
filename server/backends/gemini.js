const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Logger = require('../Logger');
const { translateRequest, translateResponse, StreamTranslator, mapModelToGemini } = require('../gemini/translator');

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION = 'v1internal';
const OAUTH_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

const RATE_LIMIT_CODES = [429, 503];
const AUTO_SWITCH_MAP = { 'gemini-2.5-pro': 'gemini-2.5-flash', 'gemini-2.5-flash': 'gemini-2.5-flash-lite' };
const COOLDOWN_MS = 10 * 60 * 1000;

class GeminiBackend {
  constructor(config) {
    this.type = 'gemini';
    this.priority = config.priority || 2;
    this.models = config.models || ['gemini-2.5-pro', 'gemini-2.5-flash'];
    this.enabled = config.enabled !== false;
    this.disableSearch = config.disableSearch || false;

    this.accessToken = null;
    this.tokenExpiry = 0;
    this.projectId = null;
    this.credentials = null;
    this.requestCount = 0;
    this.modelCooldowns = {};

    this._loadCredentials();
  }

  _loadCredentials() {
    var credPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.gemini', 'oauth_creds.json');
    try {
      if (fs.existsSync(credPath)) {
        this.credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        Logger.info('Gemini credentials loaded from ' + credPath);
      } else {
        Logger.warn('Gemini credentials not found at ' + credPath);
      }
    } catch (e) {
      Logger.error('Failed to load Gemini credentials: ' + e.message);
    }
  }

  isHealthy() {
    return this.enabled && !!this.credentials;
  }

  async _getAccessToken(forceRefresh) {
    if (!forceRefresh && this.accessToken && Date.now() < this.tokenExpiry - 60000) {
      return this.accessToken;
    }

    if (!this.credentials) throw new Error('No Gemini credentials');

    var refreshToken = this.credentials.refresh_token;
    if (!refreshToken) throw new Error('No refresh_token in Gemini credentials');

    var formPayload = 'client_id=' + encodeURIComponent(OAUTH_CLIENT_ID) +
      '&client_secret=' + encodeURIComponent(OAUTH_CLIENT_SECRET) +
      '&refresh_token=' + encodeURIComponent(refreshToken) +
      '&grant_type=refresh_token';

    var tokenResponse = await this._httpsPostRaw('oauth2.googleapis.com', '/token', formPayload, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    if (tokenResponse.statusCode !== 200) {
      throw new Error('Token refresh failed: ' + tokenResponse.body);
    }

    var parsed = JSON.parse(tokenResponse.body);
    this.accessToken = parsed.access_token;
    this.tokenExpiry = Date.now() + (parsed.expires_in * 1000);
    Logger.info('Gemini access token refreshed');
    return this.accessToken;
  }

  async _discoverProjectId() {
    if (this.projectId) return this.projectId;

    var token = await this._getAccessToken();

    try {
      // Send empty body to let the API return the user's assigned project
      var loadResp = await this._callEndpoint(token, 'loadCodeAssist', {});
      var loadParsed = JSON.parse(loadResp.body);

      if (loadParsed.cloudaicompanionProject) {
        this.projectId = loadParsed.cloudaicompanionProject;
        Logger.info('Gemini project discovered: ' + this.projectId);
        return this.projectId;
      }

      // No project assigned - try onboarding with default tier
      var defaultTier = (loadParsed.allowedTiers || []).find(function(t) { return t.isDefault; });
      var tierId = (defaultTier && defaultTier.id) || 'free-tier';

      var lroResp = await this._callEndpoint(token, 'onboardUser', {
        tierId: tierId,
      });
      var lro = JSON.parse(lroResp.body);

      // Poll for completion
      var retries = 0;
      while (!lro.done && retries < 30) {
        await new Promise(function(r) { setTimeout(r, 5000); });
        var opResp = await this._callEndpoint(token, 'operations/' + lro.name, {});
        lro = JSON.parse(opResp.body);
        retries++;
      }

      if (lro.done && lro.response && lro.response.cloudaicompanionProject) {
        this.projectId = lro.response.cloudaicompanionProject.id || lro.response.cloudaicompanionProject;
        Logger.info('Gemini project onboarded: ' + this.projectId);
        return this.projectId;
      }

      throw new Error('Could not discover project ID');
    } catch (e) {
      Logger.error('Project discovery failed: ' + e.message);
      throw e;
    }
  }

  async _callEndpoint(token, method, body) {
    var endpointUrl = CODE_ASSIST_ENDPOINT + '/' + CODE_ASSIST_API_VERSION + ':' + method;
    var urlObj = new URL(endpointUrl);
    return this._httpsPostRaw(urlObj.hostname, urlObj.pathname, JSON.stringify(body), {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    });
  }

  _getBestModel(requestedModel) {
    var model = mapModelToGemini(requestedModel);
    var now = Date.now();
    while (this.modelCooldowns[model] && this.modelCooldowns[model] > now) {
      var fallback = AUTO_SWITCH_MAP[model];
      if (!fallback) break;
      Logger.info('Gemini model ' + model + ' in cooldown, falling back to ' + fallback);
      model = fallback;
    }
    return model;
  }

  _markModelRateLimited(model) {
    this.modelCooldowns[model] = Date.now() + COOLDOWN_MS;
    Logger.warn('Gemini model ' + model + ' rate limited, cooldown for ' + (COOLDOWN_MS / 1000) + 's');
  }

  async sendRequest(req, res, body) {
    try {
      var token = await this._getAccessToken();
      var projectId = await this._discoverProjectId();
      var model = this._getBestModel(body.model);
      var isStream = body.stream !== false;

      var cleanBody = Object.assign({}, body);
      delete cleanBody.stream;

      var geminiPayload = translateRequest(cleanBody, projectId);
      geminiPayload.model = model;

      if (isStream) {
        await this._handleStreaming(res, token, geminiPayload, model);
      } else {
        await this._handleNonStreaming(res, token, geminiPayload, model);
      }

      this.requestCount++;
    } catch (error) {
      Logger.error('Gemini request error: ' + error.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      if (!res.destroyed) {
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Gemini backend error: ' + error.message } }));
      }
    }
  }

  async _handleNonStreaming(res, token, geminiPayload, model) {
    var endpointUrl = CODE_ASSIST_ENDPOINT + '/' + CODE_ASSIST_API_VERSION + ':generateContent';
    var urlObj = new URL(endpointUrl);
    var requestBody = JSON.stringify({ model: geminiPayload.model, project: this.projectId, request: geminiPayload.request });

    var response = await this._httpsPostRaw(urlObj.hostname, urlObj.pathname, requestBody, {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    });

    if (response.statusCode === 401) {
      var newToken = await this._getAccessToken(true);
      response = await this._httpsPostRaw(urlObj.hostname, urlObj.pathname, requestBody, {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + newToken,
      });
    }

    if (RATE_LIMIT_CODES.includes(response.statusCode)) {
      this._markModelRateLimited(model);
      var fallback = AUTO_SWITCH_MAP[model];
      if (fallback) {
        Logger.info('Rate limited on ' + model + ', retrying with ' + fallback);
        geminiPayload.model = fallback;
        return this._handleNonStreaming(res, token, geminiPayload, fallback);
      }
    }

    if (response.statusCode !== 200) {
      res.writeHead(response.statusCode >= 500 ? 502 : response.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'Gemini API error: ' + response.statusCode + ' ' + response.body },
      }));
      return;
    }

    var rawResponse = JSON.parse(response.body);
    // Cloud Code Assist wraps response in { response: { candidates: [...] } }
    var geminiResponse = rawResponse.response || rawResponse;
    var anthropicResponse = translateResponse(geminiResponse, model);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(anthropicResponse));
  }

  async _handleStreaming(res, token, geminiPayload, model) {
    var endpointUrl = CODE_ASSIST_ENDPOINT + '/' + CODE_ASSIST_API_VERSION + ':streamGenerateContent?alt=sse';
    var urlObj = new URL(endpointUrl);
    var requestBody = JSON.stringify({ model: geminiPayload.model, project: this.projectId, request: geminiPayload.request });

    var headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    };

    var geminiRes = await this._httpsRequest(urlObj.hostname, urlObj.pathname + urlObj.search, requestBody, headers);

    if (geminiRes.statusCode === 401) {
      geminiRes.destroy();
      var newToken = await this._getAccessToken(true);
      headers['Authorization'] = 'Bearer ' + newToken;
      var retryRes = await this._httpsRequest(urlObj.hostname, urlObj.pathname + urlObj.search, requestBody, headers);
      return this._streamGeminiToAnthropic(res, retryRes, model);
    }

    if (RATE_LIMIT_CODES.includes(geminiRes.statusCode)) {
      this._markModelRateLimited(model);
      var fallback = AUTO_SWITCH_MAP[model];
      if (fallback) {
        geminiRes.destroy();
        Logger.info('Rate limited streaming on ' + model + ', retrying with ' + fallback);
        geminiPayload.model = fallback;
        return this._handleStreaming(res, token, geminiPayload, fallback);
      }
    }

    if (geminiRes.statusCode !== 200) {
      var errorBody = '';
      geminiRes.on('data', function(c) { errorBody += c; });
      geminiRes.on('end', function() {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'Gemini streaming error: ' + geminiRes.statusCode + ' ' + errorBody },
        }));
      });
      return;
    }

    await this._streamGeminiToAnthropic(res, geminiRes, model);
  }

  _streamGeminiToAnthropic(res, geminiRes, model) {
    return new Promise(function(resolve, reject) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      var translator = new StreamTranslator(model);
      var buffer = '';

      var writeEvents = function(events) {
        for (var evt of events) {
          res.write('event: ' + evt.event + '\ndata: ' + JSON.stringify(evt.data) + '\n\n');
        }
      };

      geminiRes.on('data', function(chunk) {
        buffer += chunk.toString();
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (var line of lines) {
          if (line.startsWith('data: ')) {
            try {
              var jsonStr = line.substring(6);
              if (!jsonStr.trim()) continue;
              var parsed = JSON.parse(jsonStr);
              var data = parsed.response || parsed;
              var events = translator.translateChunk(data);
              writeEvents(events);
            } catch (e) {
              Logger.debug('Failed to parse Gemini SSE chunk: ' + e.message);
            }
          }
        }
      });

      geminiRes.on('end', function() {
        if (buffer.trim()) {
          var lines = buffer.split('\n');
          for (var line of lines) {
            if (line.startsWith('data: ')) {
              try {
                var parsed = JSON.parse(line.substring(6));
                var data = parsed.response || parsed;
                writeEvents(translator.translateChunk(data));
              } catch (e) { /* ignore */ }
            }
          }
        }
        writeEvents(translator.finalize());
        res.end();
        resolve();
      });

      geminiRes.on('error', function(err) {
        Logger.error('Gemini stream error: ' + err.message);
        if (!res.destroyed) res.end();
        reject(err);
      });

      res.on('close', function() {
        if (!geminiRes.destroyed) geminiRes.destroy();
      });
    });
  }

  // --- HTTP Helpers ---

  _httpsPostRaw(hostname, pathname, body, headers) {
    return new Promise(function(resolve, reject) {
      var options = {
        hostname: hostname, port: 443, path: pathname, method: 'POST',
        headers: Object.assign({}, headers, { 'Content-Length': Buffer.byteLength(body) }),
      };
      var req = https.request(options, function(res) {
        var data = '';
        res.on('data', function(c) { data += c; });
        res.on('end', function() { resolve({ statusCode: res.statusCode, headers: res.headers, body: data }); });
      });
      req.on('error', reject);
      req.setTimeout(30000, function() { req.destroy(); reject(new Error('Request timeout')); });
      req.write(body);
      req.end();
    });
  }

  _httpsRequest(hostname, pathname, body, headers) {
    return new Promise(function(resolve, reject) {
      var options = {
        hostname: hostname, port: 443, path: pathname, method: 'POST',
        headers: Object.assign({}, headers, { 'Content-Length': Buffer.byteLength(body) }),
      };
      var req = https.request(options, resolve);
      req.on('error', reject);
      req.setTimeout(60000, function() { req.destroy(); reject(new Error('Request timeout')); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = GeminiBackend;
