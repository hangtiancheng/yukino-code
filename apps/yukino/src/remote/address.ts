export function parseRemoteAddress(address: string): {
  host: string;
  port: number;
} {
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
  const port = Number(portText ?? "18888");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Remote port must be an integer between 1 and 65535");
  }
  return { host: host || "127.0.0.1", port };
}
