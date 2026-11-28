import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";

import {
  Agent,
  Headers as UndiciHeaders,
  fetch as undiciFetch,
  type Response as UndiciResponse,
} from "undici";

import {
  BLOCKED_IPV4_SUBNETS,
  BLOCKED_IPV6_SUBNETS,
  MAX_REDIRECTS,
  PUBLIC_HTTP_BODY_UNSUPPORTED_ERROR,
  REDIRECT_STATUSES,
  SKILL_URL_CREDENTIALS_ERROR,
  SKILL_URL_MISSING_LOCATION_ERROR,
  SKILL_URL_NON_PUBLIC_ERROR,
  SKILL_URL_PROTOCOL_ERROR,
  SKILL_URL_UNREACHABLE_ERROR,
} from "@/utils/constants.js";

export type PublicHttpResponse = Response | UndiciResponse;

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

async function fetchPinnedAddress(
  url: URL,
  init: RequestInit,
  address: LookupAddress,
): Promise<PublicHttpResponse> {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [address]);
    } else {
      callback(null, address.address, address.family);
    }
  };
  const dispatcher = new Agent({ connect: { lookup } });
  try {
    const headers = new UndiciHeaders();
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    const response = await undiciFetch(url, {
      dispatcher,
      headers,
      method: init.method ?? "GET",
      signal: init.signal,
      redirect: "manual",
    });
    // Closing drains active response bodies without allowing another DNS resolution.
    void dispatcher.close().catch(() => dispatcher.destroy());
    return response;
  } catch (error) {
    await dispatcher.destroy();
    throw error;
  }
}

async function fetchPinnedAddresses(
  url: URL,
  init: RequestInit,
  addresses: readonly LookupAddress[],
): Promise<PublicHttpResponse> {
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
): Promise<PublicHttpResponse> {
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
