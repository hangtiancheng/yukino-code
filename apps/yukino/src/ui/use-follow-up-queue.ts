import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  blocked: boolean;
  send: (message: string) => Promise<void>;
  onError: (error: unknown) => void;
}

export function useFollowUpQueue({ blocked, send, onError }: Options) {
  const pending = useRef<string[]>([]);
  const active = useRef(false);
  // Synchronous pause gate: the paused STATE update is batched, and without
  // this ref the effect could re-fire on the requeue and retry a failing
  // message in a hot loop before `paused` propagates.
  const pausedRef = useRef(false);
  const mounted = useRef(true);
  // Bumped by reset() so an in-flight dispatch from a previous conversation
  // baseline cannot re-queue its failure into the new session.
  const generation = useRef(0);
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
    pausedRef.current = false;
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
    active.current = true;
    setMessages(pending.current);
    setProcessing(true);
    const gen = generation.current;
    void (async () => {
      try {
        await callbacks.current.send(next);
      } catch (error) {
        if (mounted.current && gen === generation.current) {
          // Re-queue the failed message at the front instead of dropping it:
          // a transient submit error must not silently lose user input. The
          // queue stays paused until the next enqueue lifts the gate, so the
          // failure is surfaced once, not retried in a loop.
          pending.current = [next, ...pending.current];
          setMessages(pending.current);
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
  }, [blocked, messages, paused, processing]);

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
