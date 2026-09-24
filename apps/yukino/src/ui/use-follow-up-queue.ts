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

import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  blocked: boolean;
  send: (message: string) => Promise<void>;
  onError: (error: unknown) => void;
}

export function useFollowUpQueue({ blocked, send, onError }: Options) {
  const pending = useRef<string[]>([]);
  const active = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef({ send, onError });
  callbacks.current = { send, onError };
  const [messages, setMessages] = useState<string[]>([]);
  const [processing, setProcessing] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const enqueue = useCallback((message: string) => {
    if (!message.trim()) {
      return;
    }
    pending.current = [...pending.current, message];
    setMessages(pending.current);
    setPaused(false);
  }, []);

  const takeLast = useCallback((): string | undefined => {
    const message = pending.current.at(-1);
    if (message === undefined) {
      return undefined;
    }
    pending.current = pending.current.slice(0, -1);
    setMessages(pending.current);
    return message;
  }, []);

  useEffect(() => {
    if (blocked || paused || active.current || pending.current.length === 0) {
      return;
    }
    const next = pending.current[0];
    pending.current = pending.current.slice(1);
    active.current = true;
    setMessages(pending.current);
    setProcessing(true);
    void (async () => {
      try {
        await callbacks.current.send(next);
      } catch (error) {
        if (mounted.current) {
          setPaused(true);
          callbacks.current.onError(error);
        }
      } finally {
        active.current = false;
        if (mounted.current) {
          setProcessing(false);
        }
      }
    })();
  }, [blocked, messages, paused, processing]);

  return { messages, enqueue, takeLast, processing, paused };
}
