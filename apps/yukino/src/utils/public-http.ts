import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

import {
  BLOCKED_IPV4_SUBNETS,
  BLOCKED_IPV6_SUBNETS,
  MAX_REDIRECTS,
  NO_BODY_STATUSES,
  PUBLIC_HTTP_BODY_UNSUPPORTED_ERROR,
  REDIRECT_STATUSES,
  SKILL_URL_CREDENTIALS_ERROR,
  SKILL_URL_MISSING_LOCATION_ERROR,
  SKILL_URL_NON_PUBLIC_ERROR,
  SKILL_URL_PROTOCOL_ERROR,
  SKILL_URL_UNREACHABLE_ERROR,
} from "@/utils/constants.js";

export interface LookupAddress {
  address: string;
  family: number;
}

export type HostLookup = (
  hostname: string,
) => Promise<readonly LookupAddress[]>;

export interface PublicHttpDependencies {
  fetcher?: typeof fetch;
  lookup?: HostLookup;
}

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();

for (const [network, prefix] of BLOCKED_IPV4_SUBNETS) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of BLOCKED_IPV6_SUBNETS) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !blockedIpv4Addresses.check(address, "ipv4");
  }
  if (family === 6) {
    return !blockedIpv6Addresses.check(address, "ipv6");
  }
  return false;
}

const defaultLookup: HostLookup = async (hostname) =>
  await dnsLookup(hostname, { all: true, order: "verbatim" });

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

async function resolvePublicHttpUrl(
  input: string | URL,
  lookup: HostLookup,
): Promise<{ url: URL; addresses: LookupAddress[] }> {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(SKILL_URL_PROTOCOL_ERROR);
  }
  if (url.username || url.password) {
    throw new Error(SKILL_URL_CREDENTIALS_ERROR);
  }

  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname);
  const addresses = resolved.map((entry) => ({
    address: entry.address,
    family: isIP(entry.address),
  }));
  if (
    addresses.length === 0 ||
    addresses.some(
      (entry) =>
        (entry.family !== 4 && entry.family !== 6) ||
        !isPublicIpAddress(entry.address),
    )
  ) {
    throw new Error(SKILL_URL_NON_PUBLIC_ERROR);
  }
  return { url, addresses };
}

function responseHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(name, item);
      }
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

function fetchPinnedAddress(
  url: URL,
  init: RequestInit,
  address: LookupAddress,
): Promise<Response> {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        lookup,
        method: init.method ?? "GET",
        signal: init.signal ?? undefined,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 500;
        const noBody = NO_BODY_STATUSES.has(status);
        resolve(
          new Response(noBody ? null : Readable.toWeb(incoming), {
            headers: responseHeaders(incoming.headers),
            status,
            statusText: incoming.statusMessage,
          }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function fetchPinnedAddresses(
  url: URL,
  init: RequestInit,
  addresses: readonly LookupAddress[],
): Promise<Response> {
  let lastError: unknown;
  for (const address of addresses) {
    try {
      return await fetchPinnedAddress(url, init, address);
    } catch (error) {
      init.signal?.throwIfAborted();
      lastError = error;
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(SKILL_URL_UNREACHABLE_ERROR, {
    cause: lastError,
  });
}

// The pinned path re-issues the request over node:http(s) and streams no
// request body, so a body would be silently dropped. Narrow the contract to
// bodyless GET/HEAD up front so an injected fetcher and the pinned
// implementation behave identically instead of diverging on POST/body.
function assertBodylessGetOrHead(init: RequestInit): void {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new Error(
      `fetchPublicHttpUrl only supports GET or HEAD, received '${method}'`,
    );
  }
  if (init.body !== undefined && init.body !== null) {
    throw new Error(PUBLIC_HTTP_BODY_UNSUPPORTED_ERROR);
  }
}

export async function fetchPublicHttpUrl(
  input: string,
  init: RequestInit,
  dependencies: PublicHttpDependencies = {},
): Promise<Response> {
  assertBodylessGetOrHead(init);
  const fetcher = dependencies.fetcher ?? globalThis.fetch;
  const lookup = dependencies.lookup ?? defaultLookup;
  let url = new URL(input);

  for (let redirects = 0; ; redirects++) {
    const resolved = await resolvePublicHttpUrl(url, lookup);
    init.signal?.throwIfAborted();
    const response = dependencies.fetcher
      ? await fetcher(resolved.url, { ...init, redirect: "manual" })
      : await fetchPinnedAddresses(resolved.url, init, resolved.addresses);
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }
    await response.body?.cancel();
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(
        `Skill download exceeded ${String(MAX_REDIRECTS)} redirects`,
      );
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(SKILL_URL_MISSING_LOCATION_ERROR);
    }
    url = new URL(location, url);
  }
}
