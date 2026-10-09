import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

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

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 3],
  ["4000::", 2],
  ["8000::", 1],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
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
  await dnsLookup(hostname, { all: true, verbatim: true });

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
    throw new Error("Skill URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Skill URL must not contain credentials");
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
    throw new Error("Skill URL resolves to a non-public network address");
  }
  return { url, addresses };
}

export async function assertPublicHttpUrl(
  input: string | URL,
  lookup: HostLookup = defaultLookup,
): Promise<URL> {
  return (await resolvePublicHttpUrl(input, lookup)).url;
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
        const noBody = [101, 204, 205, 304].includes(status);
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
  throw new Error("Skill URL has no reachable public address", {
    cause: lastError,
  });
}

export async function fetchPublicHttpUrl(
  input: string,
  init: RequestInit,
  dependencies: PublicHttpDependencies = {},
): Promise<Response> {
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
      throw new Error("Skill download redirect is missing a Location header");
    }
    url = new URL(location, url);
  }
}
