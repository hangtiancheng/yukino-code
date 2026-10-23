import type { TeamManager } from "@yukino.js/teams";
import type { TeammateUIState } from "@yukino.js/teams/progress.js";
import { useEffect, useState } from "react";

export function useTeammateStates(manager: TeamManager) {
  const [states, setStates] = useState<TeammateUIState[]>([]);

  useEffect(() => {
    let signature = "";
    const timer = setInterval(() => {
      const next = manager.getAllTeammateStates();
      const nextSignature = JSON.stringify(next);
      if (nextSignature !== signature) {
        signature = nextSignature;
        setStates(next);
      }
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [manager]);

  return states;
}
