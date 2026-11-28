import { useCallback, useEffect, useRef, useState } from "react";

import type { InputEntry } from "@/history/index.js";

interface Options {
  mode?: "all" | "one-at-a-time";
  sendBatch?: (
    messages: { text: string; input?: InputEntry }[],
  ) => Promise<void>;
  blocked: boolean;
  send: (message: string, input?: InputEntry) => Promise<void>;
  onError: (error: unknown) => void;
}

export function useFollowUpQueue({
  blocked,
  send,
  onError,
  mode = "one-at-a-time",
  sendBatch,
}: Options) {
  const pending = useRef<{ text: string; input?: InputEntry }[]>([]);
  const active = useRef(false);
  // Synchronous pause gate: the paused STATE update is batched, and without
  // this ref the effect could re-fire on the requeue and retry a failing
  // message in a hot loop before `paused` propagates.
  const pausedRef = useRef(false);
  const mounted = useRef(true);
  // Bumped by reset() so an in-flight dispatch from a previous conversation
  // baseline cannot re-queue its failure into the new session.
  const generation = useRef(0);
  const callbacks = useRef({ send, onError, sendBatch });
  callbacks.current = { send, onError, sendBatch };
  const [messages, setMessages] = useState<string[]>([]);
  const [processing, setProcessing] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const enqueue = useCallback((message: string, input?: InputEntry) => {
    if (!message.trim()) {
      return;
    }
    pending.current = [...pending.current, { text: message, input }];
    setMessages(pending.current.map((entry) => entry.text));
    pausedRef.current = false;
    setPaused(false);
  }, []);

  const takeLast = useCallback((): string | undefined => {
    const message = pending.current.at(-1);
    if (message === undefined) {
      return undefined;
    }
    pending.current = pending.current.slice(0, -1);
    setMessages(pending.current.map((entry) => entry.text));
    return message.text;
  }, []);

  // Drop every queued/in-flight follow-up when the conversation baseline changes
  // (clear / resume / conversation rewind). A pure code rewind keeps the queue.
  const reset = useCallback(() => {
    generation.current += 1;
    pending.current = [];
    active.current = false;
    pausedRef.current = false;
    setMessages([]);
    setProcessing(false);
    setPaused(false);
  }, []);

  useEffect(() => {
    if (
      blocked ||
      pausedRef.current ||
      active.current ||
      pending.current.length === 0
    ) {
      return;
    }
    const next = pending.current[0];
    pending.current = pending.current.slice(1);
    const batch = [next];
    if (
      mode === "all" &&
      callbacks.current.sendBatch &&
      !/^[!/]/u.test(next.text.trim())
    ) {
      while (
        pending.current.length &&
        !/^[!/]/u.test(pending.current[0].text.trim())
      ) {
        const queued = pending.current.shift();
        if (queued) {
          batch.push(queued);
        }
      }
    }
    active.current = true;
    setMessages(pending.current.map((entry) => entry.text));
    setProcessing(true);
    const gen = generation.current;
    void (async () => {
      try {
        if (batch.length > 1 && callbacks.current.sendBatch) {
          await callbacks.current.sendBatch(batch);
        } else {
          await callbacks.current.send(next.text, next.input);
        }
      } catch (error) {
        if (mounted.current && gen === generation.current) {
          // Re-queue the failed message at the front instead of dropping it:
          // a transient submit error must not silently lose user input. The
          // queue stays paused until the next enqueue lifts the gate, so the
          // failure is surfaced once, not retried in a loop.
          pending.current = [...batch, ...pending.current];
          setMessages(pending.current.map((entry) => entry.text));
          pausedRef.current = true;
          setPaused(true);
          callbacks.current.onError(error);
        }
      } finally {
        if (gen === generation.current) {
          active.current = false;
          if (mounted.current) {
            setProcessing(false);
          }
        }
      }
    })();
  }, [blocked, messages, paused, processing, mode]);

  return {
    messages,
    enqueue,
    takeLast,
    processing,
    paused,
    reset,
    hasPending: () => pending.current.length > 0,
  };
}
