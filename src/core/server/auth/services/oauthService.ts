import { randomBytes } from 'crypto';
import { Application } from 'express';

import { config } from '@/config/manager';
import { loggingContext } from '@/core/server/http/context';

import { JWTService } from './jwtService';
import { Auth0Provider } from './providers/auth0';
import { StorageService } from './storageService';
import {
  OAuthServiceAuth0Session,
  OAuthServiceAuthorizationServer,
  OAuthServiceAuthorizationSession,
  OAuthServiceClient,
  OAuthServiceHandleAuthorizationRequest,
  OAuthServiceHandleAuthorizationRequestSchema,
  OAuthServiceHandleAuthorizationResponse,
  OAuthServiceHandleTokenRequest,
  OAuthServiceHandleTokenResponse,
  OAuthServiceProtectedResource,
  OAuthServiceRegisterClientRequest,
  OAuthServiceRegisterClientResponse,
  OAuthServiceStats,
  OAuthServiceTokenRecord,
  OAuthServiceValidateAccessToken,
} from './types';

export class OAuthService {
  private auth0Provider: Auth0Provider;
  private jwtService: JWTService;
  private storageService: StorageService;

  constructor() {
    this.jwtService = new JWTService();
    this.storageService = new StorageService();
    this.auth0Provider = new Auth0Provider(this.storageService);
  }

  public getOAuthAuthorizationServer(): OAuthServiceAuthorizationServer {
    const baseUrl = `http://${config.server.http.host}:${config.server.http.port}`;

    const issuer = `${config.server.auth.issuer}`;

    return {
      issuer,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      scopes_supported: ['openid', 'profile', 'email'],
      code_challenge_methods_supported: ['S256'],
    };
  }

  public getOAuthProtectedResource(): OAuthServiceProtectedResource {
    return {
      resource: config.server.auth.issuer,
      authorization_servers: [config.server.auth.issuer],
      scopes_supported: ['all'],
      bearer_methods_supported: ['header', 'query', 'body'],
      dpop_signing_alg_values_supported: ['RS256'],
      tls_client_certificate_bound_access_tokens: false,
      resource_name: config.server.name,
      resource_documentation: `${config.server.auth.issuer}/docs`,
    };
  }

  public async registerClient(
    args: OAuthServiceRegisterClientRequest
  ): Promise<OAuthServiceRegisterClientResponse> {
    const clientId = args.client_id ?? `mcp_${randomBytes(16).toString('hex')}`;
    const clientSecret = randomBytes(32).toString('hex');

    const now = Math.floor(Date.now() / 1000);

    const client: OAuthServiceClient = {
      clientId,
      clientIdIssuedAt: now,
      clientSecret,
      applicationType: 'web',
      redirectUris: args.redirect_uris,
      clientName: args.client_name ?? `MCP Client ${args.client_id}`,
      scope: args.scope ?? config.server.auth.auth0.scope,
      grantTypes: args.grant_types ?? ['authorization_code'],
      responseTypes: args.response_types ?? ['code'],
      tokenEndpointAuthMethod:
        args.token_endpoint_auth_method ?? 'client_secret_post',
    };

    await this.storageService.registerClient(client);

    const response: OAuthServiceRegisterClientResponse = {
      application_type: client.applicationType,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uris: client.redirectUris,
      client_name: client.clientName,
      scope: client.scope,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      client_id_issued_at: client.clientIdIssuedAt,
      client_secret_expires_at: client.clientSecretExpiresAt ?? 0,
    };

    return response;
  }

  private async getClientOrRegister(
    args: OAuthServiceHandleAuthorizationRequest
  ): Promise<OAuthServiceClient | null> {
    let client = await this.storageService.getClient(args.client_id);
    if (!client) {
      const registerClientResponse = await this.registerClient({
        client_id: args.client_id,
        client_secret: '',
        redirect_uris: [args.redirect_uri],
        response_types: ['code'],
        grant_types: ['authorization_code'],
        application_type: 'web',
        client_name: `MCP Client ${args.client_id}`,
        client_uri: '',
        scope: config.server.auth.auth0.scope,
        contacts: [],
        tos_uri: '',
        policy_uri: '',
        jwks_uri: '',
        token_endpoint_auth_method: 'client_secret_post',
      });

      client = await this.storageService.getClient(
        registerClientResponse.client_id
      );
    }

    return client;
  }

  private validateAuthorizationClient(
    args: OAuthServiceHandleAuthorizationRequest,
    client: OAuthServiceClient | null
  ): void {
    if (client && !client.redirectUris.includes(args.redirect_uri)) {
      throw new Error('Redirect URI not found');
    }

    if (client && !client.responseTypes.includes('code')) {
      throw new Error('Response type not supported');
    }
  }

  private validateAuthorization(
    args: OAuthServiceHandleAuthorizationRequest
  ): void {
    const validationResult =
      OAuthServiceHandleAuthorizationRequestSchema.safeParse(args);

    if (!validationResult.success) {
      loggingContext.log('error', 'Invalid authorization request', {
        data: {
          args,
        },
      });
      throw new Error('Invalid authorization request');
    }
  }

  public async handleAuthorization(
    args: OAuthServiceHandleAuthorizationRequest
  ): Promise<OAuthServiceHandleAuthorizationResponse> {
    loggingContext.log('debug', 'Handling authorization', {
      data: {
        args,
      },
    });

    this.validateAuthorization(args);

    const client = await this.getClientOrRegister(args);

    if (!client) {
      throw new Error('Client not found or registered');
    }

    this.validateAuthorizationClient(args, client);

    const sessionId = randomBytes(32).toString('hex');
    const codeVerifier = this.auth0Provider.generateCodeVerifier();
    const codeChallenge =
      this.auth0Provider.generateCodeChallenge(codeVerifier);
    const state = this.auth0Provider.generateState();

    const authSession: OAuthServiceAuthorizationSession = {
      sessionId,
      clientId: client.clientId,
      // Note: redirectUri must be request's redirect_uri.
      redirectUri: args.redirect_uri,
      // redirectUri: `http://${config.server.http.host}:${config.server.http.port}/oauth/auth0-callback`,
      scope: args.scope ?? 'openid profile email',
      state,
      codeChallenge,
      codeChallengeMethod: args.code_challenge_method ?? 'S256',
      expiresAt: Date.now() + config.server.auth.sessionTTL * 1000,
      responseType: args.response_type,
      createdAt: Math.floor(Date.now() / 1000),
    };

    const auth0Session: OAuthServiceAuth0Session = {
      sessionId,
      state,
      codeVerifier,
      originalSession: authSession,
      createdAt: Date.now(),
      expiresAt: Date.now() + config.server.auth.sessionTTL * 1000,
    };

    await this.storageService.createAuthSession(authSession);
    await this.storageService.createAuth0Session(auth0Session);

    // Note: Currently, only Auth0 is supported
    // if (config.server.auth.provider !== 'auth0') {
    //   throw new Error('Provider not supported');
    // }
    const redirectUrl = this.auth0Provider.generateAuthorizationUrl({
      redirectUri: `http://${config.server.http.host}:${config.server.http.port}/oauth/auth0-callback`,
      // redirectUri: args.redirect_uri,
      state,
      codeChallenge,
      codeChallengeMethod: authSession.codeChallengeMethod,
      scope: args.scope ?? 'openid profile email',
    });

    return { redirectUrl };
  }

  public async handleTokenRequest(
    args: OAuthServiceHandleTokenRequest
  ): Promise<OAuthServiceHandleTokenResponse> {
    loggingContext.log('debug', 'Handling token request', {
      data: {
        args,
      },
    });

    if (args.grant_type === 'authorization_code') {
      return this.handleAuthorizationCodeGrant(args);
    }

    if (args.grant_type === 'refresh_token') {
      return this.handleRefreshTokenGrant(args);
    }

    throw new Error('Invalid grant type');
  }

  private validateAuthorizationCodeClientSecret(
    args: OAuthServiceHandleTokenRequest,
    client: OAuthServiceClient | null
  ): void {
    // Note: For PKCE flows, client secret validation should be optional because `code_verifier` is used instead.
    if (client && client.clientSecret !== args.client_secret) {
      if (args.code_verifier !== undefined && args.code_verifier !== '') {
        loggingContext.log(
          'error',
          'Client secret validation failed, it is optional for PKCE flows',
          {
            data: {
              args,
              client,
            },
          }
        );
      } else {
        throw new Error('Invalid client secret for authorization code grant');
      }
    }
  }

  private validateAuthorizationCodeToken(
    tokenRecord: OAuthServiceTokenRecord | null,
    args: OAuthServiceHandleTokenRequest
  ): void {
    if (tokenRecord && tokenRecord.clientId !== args.client_id) {
      throw new Error('Client mismatch');
    }
  }

  private generateAccessAndRefreshTokens(
    tokenRecord: OAuthServiceTokenRecord,
    args: OAuthServiceHandleTokenRequest
  ): {
    accessToken: string;
    refreshToken: string;
  } {
    const accessToken = this.jwtService.generateAccessToken({
      clientId: args.client_id,
      userId: tokenRecord.userId,
      scope: tokenRecord.scope,
      audience: config.server.auth.auth0.audience,
      expiresIn: config.server.auth.tokenTTL.toString(),
    });

    const refreshToken = this.jwtService.generateRefreshToken({
      clientId: args.client_id,
      userId: tokenRecord.userId,
      scope: tokenRecord.scope,
      expiresIn: config.server.auth.refreshTokenTTL.toString(),
    });

    return { accessToken, refreshToken };
  }

  private async storeAuthorizationCodeGrantToken(
    accessToken: string,
    refreshToken: string,
    tokenRecord: OAuthServiceTokenRecord,
    args: OAuthServiceHandleTokenRequest
  ): Promise<OAuthServiceTokenRecord> {
    loggingContext.log('debug', 'Storing authorization code grant token', {
      data: {
        accessToken,
        refreshToken,
        tokenRecord,
        args,
      },
    });
    const newTokenRecord: OAuthServiceTokenRecord = {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresAt: Date.now() + config.server.auth.tokenTTL * 1000,
      scope: tokenRecord.scope,
      clientId: args.client_id,
      userId: tokenRecord.userId,
      auth0AccessToken: tokenRecord.auth0AccessToken,
      auth0RefreshToken: tokenRecord.auth0RefreshToken,
      auth0IdToken: tokenRecord.auth0IdToken,
      createdAt: Date.now(),
    };

    try {
      await this.storageService.storeToken(newTokenRecord);
    } catch (error: unknown) {
      loggingContext.log('error', 'Failed to store token', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }

    return newTokenRecord;
  }

  private async deleteAuthorizationCodeGrantToken(code: string): Promise<void> {
    try {
      await this.storageService.deleteToken(code);
    } catch (error: unknown) {
      loggingContext.log('error', 'Failed to delete token', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private async handleAuthorizationCodeGrant(
    args: OAuthServiceHandleTokenRequest
  ): Promise<OAuthServiceHandleTokenResponse> {
    const client = await this.storageService.getClient(args.client_id);

    if (!client) {
      throw new Error('Client not found for authorization code grant');
    }

    this.validateAuthorizationCodeClientSecret(args, client);

    if (args.code === undefined || args.code === '') {
      throw new Error('Code is required');
    }

    const tokenRecord = await this.storageService.getToken(args.code);

    if (!tokenRecord) {
      throw new Error('Token not found');
    }

    this.validateAuthorizationCodeToken(tokenRecord, args);

    const { accessToken, refreshToken } = this.generateAccessAndRefreshTokens(
      tokenRecord,
      args
    );

    const newTokenRecord = await this.storeAuthorizationCodeGrantToken(
      accessToken,
      refreshToken,
      tokenRecord,
      args
    );

    await this.deleteAuthorizationCodeGrantToken(args.code);

    return {
      access_token: newTokenRecord.accessToken,
      token_type: newTokenRecord.tokenType,
      expires_in: config.server.auth.tokenTTL,
      refresh_token: newTokenRecord.refreshToken,
      scope: newTokenRecord.scope,
    };
  }

  private async handleRefreshTokenGrant(
    args: OAuthServiceHandleTokenRequest
  ): Promise<OAuthServiceHandleTokenResponse> {
    const client = await this.storageService.getClient(args.client_id);

    if (!client) {
      throw new Error('Client not found for refresh token grant');
    }

    if (client.clientSecret !== args.client_secret) {
      throw new Error('Invalid client secret for refresh token grant');
    }

    if (args.refresh_token === undefined || args.refresh_token === '') {
      throw new Error('Refresh token is required');
    }

    const tokenRecord = await this.storageService.getTokenByRefreshToken(
      args.refresh_token
    );

    if (!tokenRecord) {
      throw new Error('Token not found');
    }

    if (tokenRecord.clientId !== args.client_id) {
      throw new Error('Client mismatch');
    }

    const accessToken = this.jwtService.generateAccessToken({
      clientId: args.client_id,
      userId: tokenRecord.userId,
      scope: tokenRecord.scope,
      audience: config.server.auth.auth0.audience,
      expiresIn: config.server.auth.tokenTTL.toString(),
    });

    const newTokenRecord: OAuthServiceTokenRecord = {
      ...tokenRecord,
      accessToken,
      refreshToken: tokenRecord.refreshToken,
      tokenType: 'Bearer',
      expiresAt: Date.now() + config.server.auth.tokenTTL * 1000,
    };

    try {
      await this.storageService.storeToken(newTokenRecord);
    } catch (error: unknown) {
      loggingContext.log('error', 'Failed to store token', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }

    const response: OAuthServiceHandleTokenResponse = {
      access_token: newTokenRecord.accessToken,
      token_type: newTokenRecord.tokenType,
      expires_in: config.server.auth.tokenTTL,
      refresh_token: newTokenRecord.refreshToken,
      scope: newTokenRecord.scope,
    };

    return response;
  }

  public async validateAccessToken(
    token: string
  ): Promise<OAuthServiceValidateAccessToken> {
    loggingContext.log('debug', 'Validating access token', {
      data: {
        token,
      },
    });

    try {
      const claims = this.jwtService.verifyAccessToken(token);

      if (!claims) {
        loggingContext.log('debug', 'Invalid access token', {
          data: {
            token,
            valid: false,
            claims,
            tokenRecord: null,
          },
        });
        return { valid: false, claims: null, tokenRecord: null };
      }

      const tokenRecord = await this.storageService.getToken(token);

      if (!tokenRecord) {
        loggingContext.log('debug', 'Token record not found', {
          data: {
            token,
            valid: false,
            claims,
            tokenRecord,
          },
        });
        return { valid: false, claims: null, tokenRecord: null };
      }

      const client = await this.storageService.getClient(claims.client_id);

      if (!client) {
        loggingContext.log('debug', 'Client not found', {
          data: {
            client,
            valid: false,
            claims,
            tokenRecord,
          },
        });
        return { valid: false, claims: null, tokenRecord: null };
      }

      loggingContext.log('debug', 'Access token is valid', {
        data: {
          valid: true,
          claims,
          tokenRecord,
        },
      });

      return { valid: true, claims, tokenRecord };
    } catch (error: unknown) {
      loggingContext.log('error', 'Failed to validate access token', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { valid: false, claims: null, tokenRecord: null };
    }
  }

  public async revokeToken(token: string): Promise<boolean> {
    try {
      if (await this.storageService.deleteToken(token)) {
        return true;
      }

      if (await this.storageService.deleteTokenByRefreshToken(token)) {
        return true;
      }

      return false;
    } catch (error: unknown) {
      loggingContext.log('error', 'Failed to revoke token', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      return false;
    }
  }

  public async getStats(): Promise<OAuthServiceStats> {
    return this.storageService.getStats();
  }

  public setupHandlers(app: Application): void {
    this.auth0Provider.setupHandlers(app);
  }
}
