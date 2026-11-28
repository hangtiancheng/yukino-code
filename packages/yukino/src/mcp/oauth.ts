import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";

import {
  auth,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import type { MCPOAuthConfig } from "@/mcp/config.js";
import {
  MCP_OAUTH_CALLBACK_PATH,
  MCP_OAUTH_CALLBACK_TTL_MS,
  MCP_OAUTH_REFRESH_SKEW_MS,
  MCP_OAUTH_REQUIRED,
  MCP_OAUTH_STORE_VERSION,
  MCP_REQUEST_TIMEOUT_MS,
} from "@/mcp/constants.js";
import { writePrivateFileAtomically } from "@/storage/private.js";

function secureURL(value: string | URL): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      ))
  ) {
    throw new Error("Unsafe MCP OAuth URL");
  }
  return url;
}
function equalURL(a: string | URL, b: string | URL): boolean {
  return new URL(a).href === new URL(b).href;
}

const StoredCredentialsSchema = z.strictObject({
  version: z.literal(MCP_OAUTH_STORE_VERSION),
  binding: z.string(),
  redirect: z.string().optional(),
  client: z
    .union([OAuthClientInformationFullSchema, OAuthClientInformationSchema])
    .optional(),
  tokens: OAuthTokensSchema.optional(),
  expiresAt: z.number().optional(),
});
type StoredCredentials = z.infer<typeof StoredCredentialsSchema>;

export class MCPTokenStore {
  readonly filePath: string;
  constructor(
    private directory: string,
    private binding: string,
  ) {
    if (!path.isAbsolute(directory)) {
      throw new Error(
        "OAuth token directory must be host-selected and absolute",
      );
    }
    this.filePath = path.join(
      directory,
      `${createHash("sha256").update(binding).digest("hex")}.json`,
    );
  }
  private async checkDirectory(create: boolean): Promise<void> {
    if (create) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
    }
    const stat = await lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error("OAuth token directory is not private");
    }
  }
  async read(): Promise<StoredCredentials | undefined> {
    try {
      await this.checkDirectory(false);
      const stat = await lstat(this.filePath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 64 * 1024
      ) {
        throw new Error("Unsafe OAuth token file");
      }
      const value = StoredCredentialsSchema.parse(
        JSON.parse(await readFile(this.filePath, "utf8")),
      );
      if (value.binding !== this.binding) {
        throw new Error("OAuth credential target mismatch");
      }
      return value;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw new Error("Cannot read private MCP OAuth credentials");
    }
  }
  async write(value: StoredCredentials): Promise<void> {
    await this.checkDirectory(true);
    await writePrivateFileAtomically(
      this.filePath,
      JSON.stringify(StoredCredentialsSchema.parse(value)),
    );
  }
  async clear(): Promise<void> {
    await this.checkDirectory(false).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    });
    await unlink(this.filePath).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    });
  }
}

export class MCPOAuthCallback {
  readonly state = randomBytes(32).toString("base64url");
  readonly code: Promise<string>;
  private resolve!: (code: string) => void;
  private reject!: (error: Error) => void;
  private used = false;
  private timer: ReturnType<typeof setTimeout>;
  constructor(
    readonly redirectUrl: URL,
    readonly issuer: URL,
    signal?: AbortSignal,
    ttl = MCP_OAUTH_CALLBACK_TTL_MS,
  ) {
    this.code = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    void this.code.catch(() => undefined);
    this.timer = setTimeout(() => {
      this.cancel();
    }, ttl);
    this.timer.unref();
    if (signal) {
      const abort = () => {
        this.cancel();
      };
      signal.addEventListener("abort", abort, { once: true });
      void this.code
        .finally(() => {
          signal.removeEventListener("abort", abort);
        })
        .catch(() => undefined);
      if (signal.aborted) {
        this.cancel();
      }
    }
  }
  accept(callbackUrl: string): void {
    if (this.used) {
      throw new Error("OAuth callback expired or already consumed");
    }
    const url = new URL(callbackUrl);
    if (
      url.origin !== this.redirectUrl.origin ||
      url.pathname !== this.redirectUrl.pathname ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error("OAuth callback redirect mismatch");
    }
    const state = url.searchParams.getAll("state");
    const actual = Buffer.from(state[0] ?? "");
    const expected = Buffer.from(this.state);
    if (
      state.length !== 1 ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error("OAuth callback state mismatch");
    }
    const issuers = url.searchParams.getAll("iss");
    if (
      issuers.length > 1 ||
      (issuers.length === 1 && !equalURL(issuers[0], this.issuer))
    ) {
      throw new Error("OAuth callback issuer mismatch");
    }
    const codes = url.searchParams.getAll("code");
    if (
      !url.searchParams.has("error") &&
      (codes.length !== 1 || !codes[0] || codes[0].length > 8192)
    ) {
      throw new Error("Invalid OAuth callback code");
    }
    this.used = true;
    clearTimeout(this.timer);
    if (url.searchParams.has("error")) {
      this.reject(new Error("MCP OAuth authorization denied"));
    } else {
      this.resolve(codes[0]);
    }
  }
  cancel(): void {
    if (this.used) {
      return;
    }
    this.used = true;
    clearTimeout(this.timer);
    this.reject(new Error("MCP OAuth callback cancelled or expired"));
  }
}

export interface MCPOAuthOptions {
  tokenDirectory: string;
  fetch?: FetchLike;
  now?: () => number;
}
export interface MCPLoginOptions {
  signal?: AbortSignal;
  onAuthorization: (
    url: URL,
    submitCallback: (url: string) => void,
  ) => void | Promise<void>;
}

export class MCPOAuthProvider implements OAuthClientProvider {
  private issuer: URL;
  private resource: URL;
  private serverUrl: URL;
  private store: MCPTokenStore;
  private credentials?: StoredCredentials;
  private discovery?: OAuthDiscoveryState;
  private callback?: MCPOAuthCallback;
  private verifier?: string;
  private redirect?: URL;
  private interactive?: MCPLoginOptions;
  private loginController?: AbortController;
  private loginSignal?: AbortSignal;
  private refreshFlight?: Promise<OAuthTokens>;
  private serial = Promise.resolve();
  private epoch = 0;
  private now: () => number;
  private rawFetch: FetchLike;

  constructor(
    serverUrl: string,
    private config: MCPOAuthConfig,
    options: MCPOAuthOptions,
  ) {
    this.serverUrl = secureURL(serverUrl);
    this.issuer = secureURL(config.issuer);
    this.resource = secureURL(config.resource ?? serverUrl);
    if (
      this.resource.origin !== this.serverUrl.origin ||
      !(
        this.serverUrl.pathname === this.resource.pathname ||
        this.serverUrl.pathname.startsWith(
          this.resource.pathname.endsWith("/")
            ? this.resource.pathname
            : `${this.resource.pathname}/`,
        )
      )
    ) {
      throw new Error("OAuth resource audience does not contain MCP endpoint");
    }
    this.now = options.now ?? Date.now;
    this.rawFetch = options.fetch ?? fetch;
    this.store = new MCPTokenStore(
      options.tokenDirectory,
      JSON.stringify({
        endpoint: this.serverUrl.href,
        issuer: this.issuer.href,
        resource: this.resource.href,
        client: config.client_id,
        scope: config.scope,
        callback: config.callback ?? { mode: "loopback" },
      }),
    );
  }
  get redirectUrl(): URL | undefined {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Yukino MCP",
      redirect_uris: this.redirect ? [this.redirect.href] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.client_secret
        ? "client_secret_basic"
        : "none",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }
  state(): string {
    if (!this.callback) {
      throw new Error(MCP_OAUTH_REQUIRED);
    }
    return this.callback.state;
  }
  private async load(): Promise<StoredCredentials> {
    this.credentials ??= (await this.store.read()) ?? {
      version: MCP_OAUTH_STORE_VERSION,
      binding: JSON.stringify({
        endpoint: this.serverUrl.href,
        issuer: this.issuer.href,
        resource: this.resource.href,
        client: this.config.client_id,
        scope: this.config.scope,
        callback: this.config.callback ?? { mode: "loopback" },
      }),
    };
    return this.credentials;
  }
  private persist(
    update: (value: StoredCredentials) => StoredCredentials,
  ): Promise<void> {
    const epoch = this.epoch;
    const result = this.serial.then(async () => {
      if (epoch !== this.epoch) {
        throw new Error("OAuth operation revoked");
      }
      const value = update(await this.load());
      await this.store.write(value);
      this.credentials = value;
    });
    this.serial = result.catch(() => undefined);
    return result;
  }
  private assertIssuer(value?: string): void {
    if (!value || !equalURL(value, this.issuer)) {
      throw new Error("MCP OAuth issuer mismatch");
    }
  }
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.client_id) {
      return {
        client_id: this.config.client_id,
        ...(this.config.client_secret
          ? { client_secret: this.config.client_secret }
          : {}),
        issuer: this.issuer.href,
      };
    }
    const value = (await this.load()).client;
    if (value) {
      this.assertIssuer(value.issuer);
    }
    return value;
  }
  async saveClientInformation(
    client: OAuthClientInformationMixed,
  ): Promise<void> {
    this.assertIssuer(client.issuer);
    if (!this.config.client_id && this.config.registration !== "dynamic") {
      throw new Error("Dynamic OAuth registration is disabled");
    }
    await this.persist((value) => ({ ...value, client }));
  }
  async tokens(): Promise<OAuthTokens | undefined> {
    const tokens = (await this.load()).tokens;
    if (tokens) {
      this.assertIssuer(tokens.issuer);
    }
    return tokens;
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.assertIssuer(tokens.issuer);
    if (tokens.token_type.toLowerCase() !== "bearer") {
      throw new Error("Unsupported MCP OAuth token type");
    }
    if (this.loginSignal?.aborted) {
      throw new Error("OAuth operation revoked");
    }
    await this.persist((value) => ({
      ...value,
      tokens,
      redirect: this.redirect?.href ?? value.redirect,
      expiresAt:
        tokens.expires_in === undefined
          ? undefined
          : this.now() + tokens.expires_in * 1000,
    }));
  }
  validateResourceURL(
    serverUrl: string | URL,
    resource?: string,
  ): Promise<URL> {
    if (
      !equalURL(serverUrl, this.serverUrl) ||
      (resource && !equalURL(resource, this.resource))
    ) {
      return Promise.reject(new Error("MCP OAuth resource mismatch"));
    }
    return Promise.resolve(this.resource);
  }
  saveCodeVerifier(verifier: string): void {
    if (!this.callback) {
      throw new Error(MCP_OAUTH_REQUIRED);
    }
    this.verifier = verifier;
  }
  codeVerifier(): string {
    if (!this.verifier) {
      throw new Error("OAuth PKCE verifier unavailable");
    }
    return this.verifier;
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive || !this.callback || !this.redirect) {
      throw new Error(MCP_OAUTH_REQUIRED);
    }
    if (
      url.origin !== this.issuer.origin ||
      url.searchParams.get("state") !== this.callback.state ||
      url.searchParams.get("redirect_uri") !== this.redirect.href ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      !url.searchParams.get("code_challenge") ||
      !equalURL(url.searchParams.get("resource") ?? "", this.resource)
    ) {
      throw new Error("Unsafe MCP OAuth authorization redirect");
    }
    const callback = this.callback;
    await this.interactive.onAuthorization(url, (value) => {
      callback.accept(value);
    });
  }
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.assertIssuer(state.authorizationServerUrl);
    const metadata = state.authorizationServerMetadata;
    if (!metadata) {
      throw new Error("MCP OAuth requires authorization server metadata");
    }
    this.assertIssuer(metadata.issuer);
    for (const endpoint of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.registration_endpoint,
    ]) {
      if (endpoint && secureURL(endpoint).origin !== this.issuer.origin) {
        throw new Error("OAuth endpoint is outside the pinned issuer");
      }
    }
    if (
      !this.config.client_id &&
      this.config.registration === "dynamic" &&
      !metadata.registration_endpoint
    ) {
      throw new Error("OAuth server does not support dynamic registration");
    }
    await this.validateResourceURL(
      this.serverUrl,
      state.resourceMetadata?.resource,
    );
    this.discovery = state;
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "discovery") {
      this.discovery = undefined;
    }
    if (scope === "all" || scope === "verifier") {
      this.verifier = undefined;
    }
    if (scope === "all" || scope === "client" || scope === "tokens") {
      await this.persist((value) => ({
        ...value,
        ...(scope !== "tokens" ? { client: undefined } : {}),
        ...(scope !== "client"
          ? { tokens: undefined, expiresAt: undefined }
          : {}),
      }));
    }
  }
  private authFetch: FetchLike = async (input, init) => {
    const url = secureURL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== this.issuer.origin &&
      url.origin !== this.serverUrl.origin
    ) {
      throw new Error("OAuth discovery target is outside the pinned endpoints");
    }
    if (
      init?.method &&
      init.method !== "GET" &&
      url.origin !== this.issuer.origin
    ) {
      throw new Error("OAuth credentials cannot be sent to resource discovery");
    }
    const headers = new Headers(init?.headers);
    headers.delete("cookie");
    const signals = [
      AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
      init?.signal,
      this.loginSignal,
    ].filter((signal): signal is AbortSignal => Boolean(signal));
    return this.rawFetch(url, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.any(signals),
    });
  };
  async getAccessToken(): Promise<string> {
    const stored = await this.load();
    if (!stored.tokens) {
      throw new Error(MCP_OAUTH_REQUIRED);
    }
    this.assertIssuer(stored.tokens.issuer);
    if (
      stored.expiresAt === undefined ||
      stored.expiresAt > this.now() + MCP_OAUTH_REFRESH_SKEW_MS
    ) {
      return stored.tokens.access_token;
    }
    if (!stored.tokens.refresh_token) {
      throw new Error(MCP_OAUTH_REQUIRED);
    }
    this.refreshFlight ??= this.refresh().finally(() => {
      this.refreshFlight = undefined;
    });
    return (await this.refreshFlight).access_token;
  }
  private async refresh(): Promise<OAuthTokens> {
    const epoch = this.epoch;
    const tokens = await this.tokens();
    const client = await this.clientInformation();
    if (!tokens?.refresh_token || !client) {
      throw new Error(MCP_OAUTH_REQUIRED);
    }
    // SDK discovery validates/stamps credentials; refresh itself has no interactive fallback.
    if (!this.discovery) {
      const { discoverOAuthServerInfo } =
        await import("@modelcontextprotocol/sdk/client/auth.js");
      await this.saveDiscoveryState(
        await discoverOAuthServerInfo(this.serverUrl, {
          fetchFn: this.authFetch,
        }),
      );
    }
    const metadata = this.discovery?.authorizationServerMetadata;
    if (!metadata) {
      throw new Error("MCP OAuth discovery unavailable");
    }
    const updated = await refreshAuthorization(this.issuer, {
      metadata,
      clientInformation: client,
      refreshToken: tokens.refresh_token,
      resource: this.resource,
      fetchFn: this.authFetch,
    });
    if (epoch !== this.epoch) {
      throw new Error("OAuth operation revoked");
    }
    const bound = { ...updated, issuer: this.issuer.href };
    await this.saveTokens(bound);
    return bound;
  }
  readonly transportFetch: FetchLike = async (input, init) => {
    const url = secureURL(input instanceof Request ? input.url : String(input));
    if (!equalURL(url, this.serverUrl)) {
      throw new Error("MCP credential endpoint mismatch");
    }
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${await this.getAccessToken()}`);
    headers.delete("cookie");
    return this.rawFetch(url, { ...init, headers, redirect: "error" });
  };
  async login(options: MCPLoginOptions): Promise<void> {
    if (this.interactive) {
      throw new Error("MCP OAuth login already pending");
    }
    options.signal?.throwIfAborted();
    this.interactive = options;
    this.loginController = new AbortController();
    const signal = AbortSignal.any([
      this.loginController.signal,
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(MCP_OAUTH_CALLBACK_TTL_MS),
    ]);
    this.loginSignal = signal;
    let server: Server | undefined;
    try {
      if (this.config.callback?.mode === "headless") {
        this.redirect = secureURL(this.config.callback.redirect_uri);
        if (this.redirect.search) {
          throw new Error(
            "OAuth headless redirect cannot contain query parameters",
          );
        }
      } else {
        server = createServer((request, response) => {
          response.setHeader("cache-control", "no-store");
          try {
            if (
              request.method !== "GET" ||
              request.headers.host !== this.redirect?.host ||
              !request.url ||
              request.url.length > 16_384
            ) {
              throw new Error("Invalid callback");
            }
            const callback = this.callback;
            if (!callback) {
              throw new Error("Expired OAuth callback");
            }
            callback.accept(new URL(request.url, this.redirect).href);
            response.end(
              "MCP authorization received. You may close this window.",
            );
          } catch {
            response.statusCode = 400;
            response.end("Invalid or expired MCP authorization callback.");
          }
        });
        const listener = server;
        await new Promise<void>((resolve, reject) => {
          listener.once("error", reject);
          listener.listen(
            this.config.callback?.mode === "loopback"
              ? (this.config.callback.port ?? 0)
              : 0,
            "127.0.0.1",
            resolve,
          );
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("OAuth loopback unavailable");
        }
        this.redirect = new URL(
          `http://127.0.0.1:${address.port}${MCP_OAUTH_CALLBACK_PATH}`,
        );
      }
      signal.throwIfAborted();
      this.callback = new MCPOAuthCallback(this.redirect, this.issuer, signal);
      await this.invalidateCredentials("tokens");
      const stored = await this.load();
      if (stored.client && stored.redirect !== this.redirect.href) {
        await this.invalidateCredentials("client");
      }
      if (
        (await auth(this, {
          serverUrl: this.serverUrl,
          scope: this.config.scope,
          fetchFn: this.authFetch,
        })) !== "REDIRECT"
      ) {
        throw new Error("Expected interactive MCP OAuth flow");
      }
      const code = await this.callback.code;
      signal.throwIfAborted();
      await auth(this, {
        serverUrl: this.serverUrl,
        authorizationCode: code,
        scope: this.config.scope,
        fetchFn: this.authFetch,
      });
      signal.throwIfAborted();
    } catch {
      throw new Error("MCP OAuth login failed, denied, cancelled, or expired");
    } finally {
      this.callback?.cancel();
      this.callback = undefined;
      this.verifier = undefined;
      this.interactive = undefined;
      this.loginController = undefined;
      this.loginSignal = undefined;
      const listener = server;
      if (listener) {
        await new Promise<void>((resolve) => {
          listener.close(() => {
            resolve();
          });
          listener.closeAllConnections();
        });
      }
    }
  }
  async logout(): Promise<void> {
    this.epoch++;
    this.loginController?.abort();
    this.callback?.cancel();
    await this.serial;
    await this.refreshFlight?.catch(() => undefined);
    await this.store.clear();
    this.credentials = undefined;
    this.discovery = undefined;
    this.verifier = undefined;
  }
  async status(): Promise<{
    authenticated: boolean;
    expiresAt?: number;
    issuer: string;
    resource: string;
    loginPending: boolean;
  }> {
    const stored = await this.load();
    return {
      authenticated: Boolean(stored.tokens),
      expiresAt: stored.expiresAt,
      issuer: this.issuer.href,
      resource: this.resource.href,
      loginPending: Boolean(this.interactive),
    };
  }
}
