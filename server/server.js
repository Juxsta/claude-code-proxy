const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const ClaudeRequest = require('./ClaudeRequest');
const Logger = require('./Logger');
const OAuthManager = require('./OAuthManager');
const { exec } = require('child_process');

let config = {};

const pkceStates = new Map();
const PKCE_EXPIRY_MS = 10 * 60 * 1000;

function cleanupExpiredPKCE() {
  const now = Date.now();
  for (const [state, data] of pkceStates.entries()) {
    if (now - data.created_at > PKCE_EXPIRY_MS) pkceStates.delete(state);
  }
}
setInterval(cleanupExpiredPKCE, 60000);

function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config.txt');
    const configFile = fs.readFileSync(configPath, 'utf8');
    configFile.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split('=');
        const key = parts[0];
        const value = parts.slice(1).join('=').trim();
        const commentIndex = value.indexOf('#');
        config[key.trim()] = commentIndex >= 0 ? value.substring(0, commentIndex).trim() : value;
      }
    });
    Logger.init(config);
    Logger.info('Config loaded from config.txt');
  } catch (error) {
    Logger.error('Failed to load config:', error.message);
    process.exit(1);
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(new Error('Invalid JSON: ' + error.message)); }
    });
    req.on('error', reject);
  });
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.connection.remoteAddress || '127.0.0.1';
}

function serveStaticFile(res, filePath, contentType) {
  const staticPath = path.join(__dirname, 'static', filePath);
  fs.readFile(staticPath, 'utf8', (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function openBrowser(targetUrl) {
  let command;
  if (process.platform === 'darwin') command = 'open "' + targetUrl + '"';
  else if (process.platform === 'win32') command = 'cmd /c start "" "' + targetUrl + '"';
  else command = 'xdg-open "' + targetUrl + '"';
  exec(command, (error) => { if (error) Logger.debug('Failed to open browser: ' + error.message); });
}

function isRunningInDocker() {
  if (fs.existsSync('/.dockerenv')) return true;
  try { return fs.readFileSync('/proc/self/cgroup', 'utf8').includes('docker'); } catch (err) { return false; }
}

async function handleRequest(req, res) {
  const clientIP = getClientIP(req);
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  Logger.info(req.method + ' ' + pathname + ' from ' + clientIP);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (pathname === '/auth/login' && req.method === 'GET') {
    serveStaticFile(res, 'login.html', 'text/html');
    return;
  }

  if (pathname === '/auth/get-url' && req.method === 'GET') {
    try {
      const pkce = OAuthManager.generatePKCE();
      pkceStates.set(pkce.state, { code_verifier: pkce.code_verifier, created_at: Date.now() });
      const authUrl = OAuthManager.buildAuthorizationURL(pkce);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: authUrl, state: pkce.state }));
      Logger.info('Generated OAuth authorization URL');
    } catch (error) {
      Logger.error('OAuth get-url error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to generate OAuth URL' }));
    }
    return;
  }

  if (pathname === '/auth/callback' && req.method === 'GET') {
    try {
      const query = parsedUrl.query;
      let code = query.code;
      let state = query.state;
      if (query.manual_code) {
        const parts = query.manual_code.split('#');
        if (parts.length !== 2) throw new Error('Invalid code format. Expected: code#state');
        code = parts[0];
        state = parts[1];
      }
      if (!code || !state) throw new Error('Missing authorization code or state');
      const pkceData = pkceStates.get(state);
      if (!pkceData) throw new Error('Invalid or expired state parameter. Please start the authorization process again.');
      pkceStates.delete(state);
      const tokens = await OAuthManager.exchangeCodeForTokens(code, pkceData.code_verifier, state);
      // Append as new account (does NOT overwrite existing accounts)
      const tokenData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in * 1000)
      };
      OAuthManager.saveTokens(tokenData);
      serveStaticFile(res, 'callback.html', 'text/html');
      Logger.info('OAuth authentication successful (account added)');
    } catch (error) {
      Logger.error('OAuth callback error:', error.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Authentication Failed</h1><p>' + error.message + '</p><p><a href="/auth/login">Try again</a></p></body></html>');
    }
    return;
  }

  if (pathname === '/auth/status' && req.method === 'GET') {
    try {
      const isAuthenticated = OAuthManager.isAuthenticated();
      const accounts = OAuthManager.getAccountsStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: isAuthenticated, total_accounts: accounts.length, accounts: accounts }));
    } catch (error) {
      Logger.error('Auth status error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to check authentication status' }));
    }
    return;
  }

  if (pathname === '/auth/accounts' && req.method === 'GET') {
    try {
      const accounts = OAuthManager.getAccountsStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accounts: accounts }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list accounts' }));
    }
    return;
  }

  if (pathname === '/auth/accounts' && req.method === 'DELETE') {
    try {
      const accountId = parsedUrl.query.id;
      if (!accountId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing id parameter' })); return; }
      const removed = OAuthManager.removeAccount(accountId);
      if (removed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, message: 'Removed ' + accountId })); }
      else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Account ' + accountId + ' not found' })); }
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname === '/auth/logout' && req.method === 'GET') {
    try {
      OAuthManager.logout();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Logged out successfully (all accounts removed)' }));
      Logger.info('User logged out');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to logout' }));
    }
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'claude-code-proxy', timestamp: Date.now() }));
    return;
  }

  if (req.method === 'POST' && (pathname === '/v1/messages' || pathname.match(/^\/v1\/\w+\/messages$/))) {
    try {
      Logger.debug('Incoming request headers:', JSON.stringify(req.headers, null, 2));
      const body = await parseBody(req);
      Logger.debug('Claude request body (' + JSON.stringify(body).length + ' bytes):', JSON.stringify(body, null, 2));
      let presetName = null;
      const presetMatch = pathname.match(/^\/v1\/(\w+)\/messages$/);
      if (presetMatch) { presetName = presetMatch[1]; Logger.debug('Detected preset: ' + presetName); }
      await new ClaudeRequest(req).handleResponse(res, body, presetName);
    } catch (error) {
      Logger.error('Request error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function startServer() {
  loadConfig();
  const server = http.createServer(handleRequest);
  const port = parseInt(config.port) || 3000;
  const host = config.host || (isRunningInDocker() ? '0.0.0.0' : '127.0.0.1');

  server.listen(port, host, () => {
    Logger.info('claude-code-proxy server listening on ' + host + ':' + port);
    const isAuthenticated = OAuthManager.isAuthenticated();
    const accounts = OAuthManager.getAccountsStatus();
    Logger.info('');
    Logger.info('Authentication Status:');
    if (isAuthenticated && accounts.length > 0) {
      Logger.info('  ' + accounts.length + ' account(s) authenticated');
      accounts.forEach(function(a) {
        const status = a.exhausted ? 'exhausted' : a.expired ? 'expired' : 'active';
        Logger.info('    ' + a.id + ': ' + status + (a.active ? ' (current)' : ''));
      });
    } else {
      Logger.info('  Not authenticated');
      const authUrl = 'http://localhost:' + port + '/auth/login';
      Logger.info('  Visit ' + authUrl + ' to authenticate');
      const autoOpenBrowser = config.auto_open_browser !== 'false';
      if (!isAuthenticated && autoOpenBrowser && !isRunningInDocker()) {
        Logger.info('  Opening browser for authentication...');
        setTimeout(function() { openBrowser(authUrl); }, 1000);
      }
    }
    Logger.info('');
  });

  process.on('SIGTERM', () => { Logger.info('Shutting down...'); server.close(() => process.exit(0)); });
  process.on('SIGINT', () => { Logger.info('Shutting down...'); server.close(() => process.exit(0)); });
}

if (require.main === module) { startServer(); }
module.exports = { startServer, ClaudeRequest };
