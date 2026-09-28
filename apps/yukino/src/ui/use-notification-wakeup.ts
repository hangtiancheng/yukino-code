/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

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
