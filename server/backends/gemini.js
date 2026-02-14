const https = require('https');
const fs = require('fs');
const path = require('path');
const Logger = require('../Logger');
const { anthropicToGemini, geminiToAnthropic, geminiStreamToAnthropicSSE } = require('../gemini/translator');

const GEMINI_CREDS_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.gemini',
  'oauth_creds.json'
);

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
// Gemini CLI client_id (public)
const GEMINI_CLIENT_ID = '012559816023-eilk1a70rlaqufkfgkhiaag2vi1svore.apps.googleusercontent.com';
const GEMINI_CLIENT_SECRET = '';

class GeminiBackend {
  constructor(config) {
    this.type = 'gemini';
    this.priority = config.priority || 2;
    this.models = config.models || [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ];
    this.enabled = config.enabled !== false;
    this.disableSearch = config.disableSearch || false;
    this._cachedToken = null;
    this._tokenExpiry = 0;
  }

  isHealthy() {
    if (!this.enabled) return false;
    try {
      return fs.existsSync(GEMINI_CREDS_PATH);
    } catch {
      return false;
    }
  }

  async _getAccessToken() {
    if (this._cachedToken && Date.now() < this._tokenExpiry - 30000) {
      return this._cachedToken;
    }

    const creds = JSON.parse(fs.readFileSync(GEMINI_CREDS_PATH, 'utf8'));

    // If token is still valid, use it
    if (creds.access_token && creds.expires_at && Date.now() < creds.expires_at - 30000) {
      this._cachedToken = creds.access_token;
      this._tokenExpiry = creds.expires_at;
      return creds.access_token;
    }

    // Refresh
    if (!creds.refresh_token) throw new Error('No Gemini refresh token available');

    Logger.info('Refreshing Gemini OAuth token...');
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refresh_token,
      client_id: GEMINI_CLIENT_ID,
    });
    if (GEMINI_CLIENT_SECRET) params.append('client_secret', GEMINI_CLIENT_SECRET);

    const response = await this._httpPost(TOKEN_ENDPOINT, params.toString(), 'application/x-www-form-urlencoded');
    const tokens = JSON.parse(response);

    if (tokens.error) throw new Error('Gemini token refresh failed: ' + tokens.error);

    this._cachedToken = tokens.access_token;
    this._tokenExpiry = Date.now() + (tokens.expires_in * 1000);

    // Save updated tokens
    creds.access_token = tokens.access_token;
    creds.expires_at = this._tokenExpiry;
    if (tokens.refresh_token) creds.refresh_token = tokens.refresh_token;
    fs.writeFileSync(GEMINI_CREDS_PATH, JSON.stringify(creds, null, 2));

    Logger.info('Gemini token refreshed successfully');
    return this._cachedToken;
  }

  _httpPost(url, body, contentType) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': contentType }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(body);
      req.end();
    });
  }

  async sendRequest(req, res, body, presetName) {
    const isStreaming = body.stream !== false;
    const model = body.model || 'gemini-2.5-flash';

    const accessToken = await this._getAccessToken();
    const geminiBody = anthropicToGemini(body, { disableSearch: this.disableSearch });

    const endpoint = isStreaming ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}`;

    Logger.debug('Gemini request to: ' + apiUrl);
    Logger.debug('Gemini body: ' + JSON.stringify(geminiBody).substring(0, 500));

    const parsed = new URL(apiUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + accessToken,
      }
    };

    return new Promise((resolve, reject) => {
      const apiReq = https.request(options, (apiRes) => {
        if (apiRes.statusCode >= 400) {
          let errData = '';
          apiRes.on('data', c => errData += c);
          apiRes.on('end', () => {
            Logger.error('Gemini API error ' + apiRes.statusCode + ': ' + errData.substring(0, 500));
            // Return status to caller for retry logic
            resolve({ statusCode: apiRes.statusCode, error: errData });
          });
          return;
        }

        if (isStreaming) {
          this._handleStreamResponse(res, apiRes, model);
        } else {
          this._handleNonStreamResponse(res, apiRes, model);
        }
        resolve({ statusCode: apiRes.statusCode });
      });

      apiReq.on('error', (err) => {
        Logger.error('Gemini request error: ' + err.message);
        reject(err);
      });
      apiReq.setTimeout(120000, () => { apiReq.destroy(); reject(new Error('Gemini request timeout')); });
      apiReq.write(JSON.stringify(geminiBody));
      apiReq.end();
    });
  }

  _handleStreamResponse(res, apiRes, model) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const state = { started: false, model, contentIndex: 0, inText: false, inThinking: false };
    let buffer = '';

    apiRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const geminiChunk = JSON.parse(line.substring(6));
            const sseOutput = geminiStreamToAnthropicSSE(geminiChunk, state);
            if (sseOutput) res.write(sseOutput);
          } catch (e) {
            Logger.debug('Failed to parse Gemini SSE chunk: ' + e.message);
          }
        }
      }
    });

    apiRes.on('end', () => {
      // Process remaining buffer
      if (buffer.startsWith('data: ')) {
        try {
          const geminiChunk = JSON.parse(buffer.substring(6));
          const sseOutput = geminiStreamToAnthropicSSE(geminiChunk, state);
          if (sseOutput) res.write(sseOutput);
        } catch (e) { /* ignore */ }
      }
      res.end();
    });

    apiRes.on('error', (err) => {
      Logger.error('Gemini stream error: ' + err.message);
      if (!res.destroyed) res.end();
    });

    res.on('close', () => {
      if (!apiRes.destroyed) apiRes.destroy();
    });
  }

  _handleNonStreamResponse(res, apiRes, model) {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      try {
        const geminiResponse = JSON.parse(data);
        const anthropicResponse = geminiToAnthropic(geminiResponse, model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(anthropicResponse));
      } catch (e) {
        Logger.error('Failed to translate Gemini response: ' + e.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to process Gemini response' }));
      }
    });
  }
}

module.exports = GeminiBackend;
