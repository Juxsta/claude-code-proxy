const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const Logger = require('./Logger');

const OAUTH_CONFIG = {
  client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorize_url: 'https://claude.ai/oauth/authorize',
  token_url: 'https://console.anthropic.com/v1/oauth/token',
  redirect_uri: 'https://console.anthropic.com/oauth/code/callback',
  scope: 'org:create_api_key user:profile user:inference'
};

const EXHAUSTION_COOLDOWN_MS = 300000; // 5 minutes

class OAuthManager {
  constructor() {
    this.tokenPath = path.join(
      process.env.HOME || process.env.USERPROFILE,
      '.claude-code-proxy',
      'tokens.json'
    );
    this.refreshPromises = new Map();
  }

  loadTokens() {
    try {
      if (!fs.existsSync(this.tokenPath)) return null;
      const raw = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
      if (!raw.accounts) {
        if (!raw.access_token) return null;
        const migrated = {
          accounts: [{
            id: 'account-1',
            access_token: raw.access_token,
            refresh_token: raw.refresh_token,
            expires_at: raw.expires_at,
            exhausted_until: null
          }],
          active_index: 0
        };
        this._writeTokens(migrated);
        Logger.info('Migrated tokens.json from old single-token format to multi-account format');
        return migrated;
      }
      return raw;
    } catch (error) {
      Logger.error('Failed to load tokens from file', error);
      return null;
    }
  }

  _writeTokens(data) {
    const dir = path.dirname(this.tokenPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.tokenPath, JSON.stringify(data, null, 2), 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(this.tokenPath, 0o600);
  }

  saveTokens(tokenData) {
    let store = this.loadTokens();
    if (!store) {
      store = { accounts: [], active_index: 0 };
    }
    if (tokenData.id) {
      const idx = store.accounts.findIndex(a => a.id === tokenData.id);
      if (idx >= 0) {
        store.accounts[idx] = { ...store.accounts[idx], ...tokenData };
      } else {
        store.accounts.push({ exhausted_until: null, ...tokenData });
      }
    } else {
      const nextNum = store.accounts.length + 1;
      tokenData.id = 'account-' + nextNum;
      tokenData.exhausted_until = null;
      store.accounts.push(tokenData);
    }
    this._writeTokens(store);
    Logger.info('Tokens saved for ' + (tokenData.id || 'new account') + ' (total accounts: ' + store.accounts.length + ')');
  }

  generatePKCE() {
    const code_verifier = crypto.randomBytes(32).toString('base64url');
    const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
    const state = crypto.randomBytes(32).toString('base64url');
    return { code_verifier, code_challenge, state };
  }

  buildAuthorizationURL(pkce) {
    const params = new URLSearchParams({
      code: 'true',
      client_id: OAUTH_CONFIG.client_id,
      response_type: 'code',
      redirect_uri: OAUTH_CONFIG.redirect_uri,
      scope: OAUTH_CONFIG.scope,
      code_challenge: pkce.code_challenge,
      code_challenge_method: 'S256',
      state: pkce.state
    });
    return OAUTH_CONFIG.authorize_url + '?' + params.toString();
  }

  async exchangeCodeForTokens(code, code_verifier, state) {
    const payload = JSON.stringify({
      grant_type: 'authorization_code',
      code: code,
      state: state,
      client_id: OAUTH_CONFIG.client_id,
      code_verifier: code_verifier,
      redirect_uri: OAUTH_CONFIG.redirect_uri
    });
    try {
      const response = await this._makeTokenRequest(payload);
      Logger.info('Successfully exchanged authorization code for tokens');
      return response;
    } catch (error) {
      Logger.error('Failed to exchange code for tokens', error);
      throw error;
    }
  }

  async refreshAccountToken(account) {
    const id = account.id;
    if (this.refreshPromises.has(id)) {
      return this.refreshPromises.get(id);
    }
    const promise = (async () => {
      try {
        const payload = JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: account.refresh_token,
          client_id: OAUTH_CONFIG.client_id
        });
        const response = await this._makeTokenRequest(payload);
        Logger.info('Refreshed token for ' + id);
        const store = this.loadTokens();
        const idx = store.accounts.findIndex(a => a.id === id);
        if (idx >= 0) {
          store.accounts[idx].access_token = response.access_token;
          store.accounts[idx].refresh_token = response.refresh_token || account.refresh_token;
          store.accounts[idx].expires_at = Date.now() + (response.expires_in * 1000);
          this._writeTokens(store);
        }
        return response.access_token;
      } finally {
        this.refreshPromises.delete(id);
      }
    })();
    this.refreshPromises.set(id, promise);
    return promise;
  }

  async refreshAccessToken() {
    const store = this.loadTokens();
    if (!store || !store.accounts.length) throw new Error('No accounts');
    const account = store.accounts[store.active_index || 0];
    return this.refreshAccountToken(account);
  }

  markExhausted(accountId) {
    const store = this.loadTokens();
    if (!store) return;
    const account = store.accounts.find(a => a.id === accountId);
    if (account) {
      account.exhausted_until = Date.now() + EXHAUSTION_COOLDOWN_MS;
      this._writeTokens(store);
      Logger.info('Marked ' + accountId + ' as exhausted until ' + new Date(account.exhausted_until).toISOString());
    }
  }

  async getValidAccessToken() {
    const store = this.loadTokens();
    if (!store || !store.accounts.length) {
      throw new Error('No authentication tokens found. Please authenticate first.');
    }
    const now = Date.now();
    const accounts = store.accounts;
    let chosen = null;
    for (let i = 0; i < accounts.length; i++) {
      const idx = ((store.active_index || 0) + i) % accounts.length;
      const a = accounts[idx];
      if (!a.exhausted_until || a.exhausted_until <= now) {
        chosen = { account: a, index: idx };
        break;
      }
    }
    if (!chosen) {
      const sorted = accounts.map((a, i) => ({ account: a, index: i }))
        .sort((x, y) => (x.account.exhausted_until || 0) - (y.account.exhausted_until || 0));
      chosen = sorted[0];
      Logger.warn('All accounts exhausted. Using ' + chosen.account.id + ' (cooldown expires soonest)');
    }
    const account = chosen.account;
    if (store.active_index !== chosen.index) {
      store.active_index = chosen.index;
      this._writeTokens(store);
    }
    if (account.expires_at <= now + 60000) {
      Logger.info('Token for ' + account.id + ' expired/expiring, refreshing...');
      const newToken = await this.refreshAccountToken(account);
      return { token: newToken, accountId: account.id };
    }
    return { token: account.access_token, accountId: account.id };
  }

  async getNextToken(skipAccountId) {
    const store = this.loadTokens();
    if (!store || !store.accounts.length) {
      throw new Error('No authentication tokens found.');
    }
    const now = Date.now();
    const accounts = store.accounts;
    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i];
      if (a.id === skipAccountId) continue;
      if (!a.exhausted_until || a.exhausted_until <= now) {
        if (a.expires_at <= now + 60000) {
          const newToken = await this.refreshAccountToken(a);
          return { token: newToken, accountId: a.id };
        }
        return { token: a.access_token, accountId: a.id };
      }
    }
    const others = accounts.filter(a => a.id !== skipAccountId);
    if (others.length > 0) {
      const best = others.sort((a, b) => (a.exhausted_until || 0) - (b.exhausted_until || 0))[0];
      if (best.expires_at <= now + 60000) {
        const newToken = await this.refreshAccountToken(best);
        return { token: newToken, accountId: best.id };
      }
      return { token: best.access_token, accountId: best.id };
    }
    throw new Error('No alternative accounts available.');
  }

  isAuthenticated() {
    const store = this.loadTokens();
    return !!(store && store.accounts && store.accounts.length > 0 &&
      store.accounts.some(a => a.access_token));
  }

  getTokenExpiration() {
    const store = this.loadTokens();
    if (!store || !store.accounts.length) return null;
    const account = store.accounts[store.active_index || 0];
    return account && account.expires_at ? new Date(account.expires_at) : null;
  }

  getAccountsStatus() {
    const store = this.loadTokens();
    if (!store || !store.accounts.length) return [];
    const now = Date.now();
    return store.accounts.map(function(a, i) {
      return {
        id: a.id,
        label: a.label || null,
        active: i === (store.active_index || 0),
        authenticated: !!a.access_token,
        expires_at: a.expires_at ? new Date(a.expires_at).toISOString() : null,
        expired: a.expires_at ? a.expires_at <= now : true,
        exhausted: !!(a.exhausted_until && a.exhausted_until > now),
        exhausted_until: a.exhausted_until && a.exhausted_until > now
          ? new Date(a.exhausted_until).toISOString() : null
      };
    });
  }

  updateAccount(accountId, updates) {
    const store = this.loadTokens();
    if (!store) return false;
    const account = store.accounts.find(a => a.id === accountId);
    if (!account) return false;
    // Only allow safe fields to be updated
    const safeFields = ['label'];
    for (const key of safeFields) {
      if (updates[key] !== undefined) account[key] = updates[key];
    }
    this._writeTokens(store);
    Logger.info('Updated account ' + accountId + ': ' + JSON.stringify(updates));
    return true;
  }

  removeAccount(accountId) {
    const store = this.loadTokens();
    if (!store) return false;
    const idx = store.accounts.findIndex(a => a.id === accountId);
    if (idx < 0) return false;
    store.accounts.splice(idx, 1);
    if (store.active_index >= store.accounts.length) store.active_index = 0;
    this._writeTokens(store);
    Logger.info('Removed account ' + accountId);
    return true;
  }

  logout() {
    try {
      if (fs.existsSync(this.tokenPath)) {
        fs.unlinkSync(this.tokenPath);
        Logger.info('Tokens deleted successfully');
      }
    } catch (error) {
      Logger.error('Failed to delete tokens', error);
      throw error;
    }
  }

  _makeTokenRequest(payload) {
    return new Promise((resolve, reject) => {
      const tokenUrl = new URL(OAUTH_CONFIG.token_url);
      const options = {
        hostname: tokenUrl.hostname,
        port: tokenUrl.port || 443,
        path: tokenUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch (error) { reject(new Error('Failed to parse token response: ' + error.message)); }
          } else {
            reject(new Error('Token request failed with status ' + res.statusCode + ': ' + data));
          }
        });
      });
      req.on('error', (error) => { reject(error); });
      req.write(payload);
      req.end();
    });
  }
}

module.exports = new OAuthManager();
