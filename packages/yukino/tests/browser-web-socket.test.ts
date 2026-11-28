import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientMessage } from "#/types.js";

const harness = vi.hoisted(() => {
  const effects: (() => undefined | (() => void))[] = [];
  const sockets: {
    onclose: (() => void) | null;
    onopen: (() => void) | null;
    readyState: number;
    url: string;
    close: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  }[] = [];
  return { effects, sockets };
});
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => undefined | (() => void)) =>
    harness.effects.push(effect),
}));
vi.mock("partysocket", () => ({
  WebSocket: class {
    onclose = null;
    onopen = null;
    readyState = 3;
    close = vi.fn();
    send = vi.fn();
    constructor(readonly url: string) {
      harness.sockets.push(this);
    }
  },
}));
const { useWebSocket } = await import("#/hooks/use-web-socket.js");
const cleanups: (() => void)[] = [];
const message: ClientMessage = {
  type: "user_message",
  data: { content: "queued prompt" },
};

function Mount(hash: string) {
  const listeners = new Map<string, () => void>();
  const location = {
    hash,
    href: "http://localhost:3000/",
    pathname: "/",
    search: "",
  };
  vi.stubGlobal("window", {
    location,
    sessionStorage: { getItem: () => null, setItem: vi.fn() },
    history: { replaceState: vi.fn() },
    addEventListener: (name: string, callback: () => void) =>
      listeners.set(name, callback),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  const callbacks = {
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onMessage: vi.fn(),
    onAuthRequired: vi.fn(),
  };
  const { send } = useWebSocket(callbacks);
  for (const effect of harness.effects) {
    const cleanup = effect();
    if (cleanup) {
      cleanups.push(cleanup);
    }
  }
  return { callbacks, location, listeners, send };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  harness.effects.length = 0;
  harness.sockets.length = 0;
  vi.unstubAllGlobals();
});

describe("remote connection authentication", () => {
  it("reports a missing token and connects when an invite arrives", () => {
    const { callbacks, location, listeners, send } = Mount("");
    expect(callbacks.onAuthRequired).toHaveBeenCalledOnce();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(harness.sockets).toHaveLength(0);
    expect(send(message)).toBe("dropped");
    location.hash = "#token=fresh";
    listeners.get("hashchange")?.();
    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0].url).toBe("ws://localhost:3000/ws?token=fresh");
  });

  it("stops retrying a rejected token and resumes with a fresh invite", async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 401 });
    vi.stubGlobal("fetch", fetch);
    const { callbacks, location, listeners, send } = Mount("#token=expired");
    const socket = harness.sockets[0];
    socket.onclose?.();
    await vi.waitFor(() => {
      expect(callbacks.onAuthRequired).toHaveBeenCalledOnce();
    });
    expect(socket.close).toHaveBeenCalledOnce();
    expect(send(message)).toBe("dropped");
    location.hash = "#token=fresh";
    listeners.get("hashchange")?.();
    expect(harness.sockets[1].url).toBe("ws://localhost:3000/ws?token=fresh");
  });

  it("replays queued messages on reconnecting with the same invite", () => {
    const { send } = Mount("#token=original");
    const socket = harness.sockets[0];
    expect(send(message)).toBe("queued");
    socket.readyState = 1;
    socket.onopen?.();
    expect(socket.send).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(message),
    );
  });

  it("drops the old invite's queue and ignores its authentication probe after switching invites", async () => {
    const probe = Promise.withResolvers<{ status: number }>();
    const fetch = vi.fn(() => probe.promise);
    vi.stubGlobal("fetch", fetch);
    const { callbacks, location, listeners, send } = Mount("#token=original");
    const original = harness.sockets[0];
    original.onclose?.();
    expect(send(message)).toBe("queued");
    location.hash = "#token=fresh";
    listeners.get("hashchange")?.();
    const replacement = harness.sockets[1];
    expect(original.close).toHaveBeenCalledOnce();
    expect(replacement.url).toBe("ws://localhost:3000/ws?token=fresh");
    probe.resolve({ status: 401 });
    await probe.promise;
    expect(callbacks.onAuthRequired).not.toHaveBeenCalled();
    replacement.readyState = 1;
    replacement.onopen?.();
    expect(replacement.send).not.toHaveBeenCalled();
  });
});
