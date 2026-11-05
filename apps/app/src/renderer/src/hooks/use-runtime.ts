import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export function useRuntime(sessionId: string | null, streaming: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.api.onEvent((event) => {
      if (
        [
          "tool_result",
          "run_state",
          "session_changed",
          "init_state",
          "subagent",
        ].includes(event.type)
      ) {
        clearTimeout(timer);
        timer = setTimeout(() => {
          void client.invalidateQueries({ queryKey: ["runtime"] });
        }, 150);
      }
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [client]);
  return useQuery({
    queryKey: ["runtime", sessionId],
    queryFn: () => window.api.getRuntime(),
    enabled: sessionId !== null,
    refetchInterval: streaming ? 2000 : 5000,
  });
}
