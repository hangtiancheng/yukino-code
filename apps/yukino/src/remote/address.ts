export interface ParseRemoteAddressOptions {
  /**
   * Port used when the address omits one (a bare host like "localhost" or an
   * empty host like ":"). Each server mode passes its own default so a
   * bare-host address does not silently fall back to the remote-mode port.
   */
  defaultPort?: number;
  /**
   * Allow port 0, which binds an ephemeral port chosen by the OS. Only modes
   * that advertise their actual bound address after listening should enable
   * this; otherwise the caller would bind an unreachable, unreported port.
   */
  allowEphemeral?: boolean;
}

export function parseRemoteAddress(
  address: string,
  options: ParseRemoteAddressOptions = {},
): {
  host: string;
  port: number;
} {
  const { defaultPort = 18888, allowEphemeral = false } = options;
  const value = address.trim();
  let host: string;
  let portText: string | undefined;
  if (/^\d+$/.test(value)) {
    // A bare number is a port, never a hostname: "9000" behaves like ":9000".
    host = "";
    portText = value;
  } else {
    const match = /^(?:\[([^\]]+)\]|([^:]*))(?::(\d+))?$/.exec(value);
    if (!match) {
      throw new Error(
        "Invalid remote address; use port, host:port or [IPv6]:port",
      );
    }
    host = match[1] ?? match[2] ?? "";
    portText = match[3];
  }
  const port = Number(portText ?? String(defaultPort));
  const minPort = allowEphemeral ? 0 : 1;
  if (!Number.isInteger(port) || port < minPort || port > 65535) {
    throw new Error(
      `Remote port must be an integer between ${String(minPort)} and 65535`,
    );
  }
  return { host: host || "127.0.0.1", port };
}
