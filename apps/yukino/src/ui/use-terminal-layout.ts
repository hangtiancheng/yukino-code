import { useStdout } from "ink";
import { createContext, useContext, useSyncExternalStore } from "react";

export const AvailableRows = createContext<number | null>(null);

interface TerminalDimensions {
  columns: number;
  rows: number;
}

const terminalStores = new WeakMap<
  NodeJS.WriteStream,
  ReturnType<typeof createTerminalStore>
>();

function createTerminalStore(stdout: NodeJS.WriteStream) {
  const listeners = new Set<() => void>();
  let snapshot: TerminalDimensions = {
    columns: 80,
    rows: 24,
  };
  const getSnapshot = () => {
    const columns = Math.max(1, stdout.columns || 80);
    const rows = Math.max(1, stdout.rows || 24);
    if (columns !== snapshot.columns || rows !== snapshot.rows) {
      snapshot = {
        columns,
        rows,
      };
    }
    return snapshot;
  };
  const onResize = () => {
    getSnapshot();
    for (const listener of listeners) {
      listener();
    }
  };
  const subscribe = (listener: () => void) => {
    if (listeners.size === 0) {
      stdout.on?.("resize", onResize);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        stdout.off?.("resize", onResize);
      }
    };
  };
  return { getSnapshot, subscribe };
}

export function useTerminalDimensions(): TerminalDimensions {
  const { stdout } = useStdout();
  let store = terminalStores.get(stdout);
  if (!store) {
    store = createTerminalStore(stdout);
    terminalStores.set(stdout, store);
  }
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

export function useAvailableRows(reservedRows = 0, top = 0): number {
  const budget = useContext(AvailableRows);
  const { rows } = useTerminalDimensions();
  // Ink restores the caret from the line after its output frame.
  const frameRows = Math.max(1, rows - 1);
  return Math.max(0, budget ?? frameRows - reservedRows - top);
}
