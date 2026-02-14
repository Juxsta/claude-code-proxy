const ClaudeRequest = require('../ClaudeRequest');
const OAuthManager = require('../OAuthManager');
const Logger = require('../Logger');

class AnthropicBackend {
  constructor(config) {
    this.type = 'anthropic';
    this.priority = config.priority || 1;
    this.models = config.models || [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-haiku-4-5-20250514',
    ];
    this.enabled = config.enabled !== false;
  }

  isHealthy() {
    return this.enabled && OAuthManager.isAuthenticated();
  }

  async sendRequest(req, res, body, presetName) {
    const claudeRequest = new ClaudeRequest(req);
    await claudeRequest.handleResponse(res, body, presetName);
  }
}

module.exports = AnthropicBackend;
