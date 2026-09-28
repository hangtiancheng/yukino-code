import { useEffect, useRef } from "react";

interface Options {
  blocked: boolean;
  hasPending: () => boolean;
  run: () => Promise<void>;
  onError: (error: unknown) => void;
  pollIntervalMs?: number;
}

export function useNotificationWakeup({
  blocked,
  hasPending,
  run,
  onError,
  pollIntervalMs = 250,
}: Options): void {
  const active = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef({ blocked, hasPending, run, onError });
  callbacks.current = { blocked, hasPending, run, onError };

  useEffect(() => {
    mounted.current = true;
    const check = (): void => {
      const current = callbacks.current;
      if (
        !mounted.current ||
        active.current ||
        current.blocked ||
        !current.hasPending()
      ) {
        return;
      }
      active.current = true;
      void current
        .run()
        .catch((error: unknown) => {
          if (mounted.current) {
            callbacks.current.onError(error);
          }
        })
        .finally(() => {
          active.current = false;
        });
    };

    check();
    const timer = setInterval(check, pollIntervalMs);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [pollIntervalMs]);
}
