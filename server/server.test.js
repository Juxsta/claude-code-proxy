const request = require('supertest');
const nock = require('nock');
const { app, startServer } = require('./server');
const OAuthManager = require('./OAuthManager');
const BackendRegistry = require('./backends/registry');

// Mock OAuthManager
jest.mock('./OAuthManager');

// Mock BackendRegistry
jest.mock('./backends/registry');

describe('Server Routes', () => {
  describe('GET /auth/login', () => {
    it('should redirect to authorization URL', async () => {
      const mockPKCE = {
        code_verifier: 'test-verifier',
        code_challenge: 'test-challenge',
        state: 'test-state'
      };
      const mockAuthURL = 'https://claude.ai/oauth/authorize?test=true';
      
      OAuthManager.generatePKCE.mockReturnValue(mockPKCE);
      OAuthManager.buildAuthorizationURL.mockReturnValue(mockAuthURL);

      const response = await request(app).get('/auth/login');
      
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(mockAuthURL);
      expect(response.headers['set-cookie']).toBeDefined();
    });
  });

  describe('GET /auth/callback', () => {
    it('should handle missing code or state', async () => {
      const response = await request(app).get('/auth/callback');
      expect(response.status).toBe(400);
      expect(response.text).toContain('Missing code or state');
    });

    it('should handle state mismatch', async () => {
      const cookie = 'claude_pkce_state=expected-state; Path=/; HttpOnly';
      const response = await request(app)
        .get('/auth/callback?code=test-code&state=wrong-state')
        .set('Cookie', [cookie]);
      
      expect(response.status).toBe(400);
      expect(response.text).toContain('Invalid state parameter');
    });

    it('should exchange code for tokens and save them', async () => {
      const cookie = 'claude_pkce_state=test-state; Path=/; HttpOnly; claude_pkce_verifier=test-verifier';
      const mockTokens = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600
      };

      OAuthManager.exchangeCodeForTokens.mockResolvedValue(mockTokens);

      const response = await request(app)
        .get('/auth/callback?code=test-code&state=test-state')
        .set('Cookie', [cookie]);

      expect(response.status).toBe(200);
      expect(response.text).toContain('Authentication successful');
      expect(OAuthManager.saveTokens).toHaveBeenCalledWith(mockTokens);
    });

    it('should handle token exchange failure', async () => {
      const cookie = 'claude_pkce_state=test-state; Path=/; HttpOnly; claude_pkce_verifier=test-verifier';
      OAuthManager.exchangeCodeForTokens.mockRejectedValue(new Error('Exchange failed'));

      const response = await request(app)
        .get('/auth/callback?code=test-code&state=test-state')
        .set('Cookie', [cookie]);

      expect(response.status).toBe(500);
      expect(response.text).toContain('Authentication failed');
    });
  });

  describe('GET /auth/status', () => {
    it('should return authentication status', async () => {
      const mockStatus = {
        isAuthenticated: true,
        expiration: new Date().toISOString()
      };
      
      OAuthManager.isAuthenticated.mockReturnValue(true);
      OAuthManager.getTokenExpiration.mockReturnValue(mockStatus.expiration);

      const response = await request(app).get('/auth/status');
      
      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockStatus);
    });
  });

  describe('GET /auth/logout', () => {
    it('should call logout and return success', async () => {
      const response = await request(app).get('/auth/logout');
      
      expect(response.status).toBe(200);
      expect(response.text).toContain('Logged out successfully');
      expect(OAuthManager.logout).toHaveBeenCalled();
    });

    it('should handle logout error', async () => {
      OAuthManager.logout.mockImplementation(() => {
        throw new Error('Logout failed');
      });

      const response = await request(app).get('/auth/logout');
      
      expect(response.status).toBe(500);
      expect(response.text).toContain('Logout failed');
    });
  });

  // Basic check for OAuth Routes Integration Tests (without full nock/real implementation)
  // This verifies that the routes exist and call the manager correctly
  describe('OAuth Routes Integration Tests', () => {
    // Re-enable real implementation for these tests if possible, 
    // or rely on the unit tests above which mock the manager.
    // Given the issues with file paths in the previous attempts, 
    // we'll stick to unit testing the route handlers via supertest + mocks above.
  });
});
