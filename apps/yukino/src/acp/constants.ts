export const SESSION_ID_PATTERN = /^[a-z0-9]+-[a-f0-9]{8}$/u;

export const ACP_PATH = "/acp";
export const ACP_WS_DEFAULT_PORT = 18889;
export const DEFAULT_ADDRESS = `127.0.0.1:${String(ACP_WS_DEFAULT_PORT)}`;
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
