import { useCallback, useEffect, useRef, useState } from "react";

import { checkForUpdate } from "@/update/version-check.js";

export function useUpdateNotice() {
  const [latestVersion, setLatestVersion] = useState<string>();
  const latestVersionRef = useRef<string | undefined>(undefined);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void checkForUpdate(controller.signal).then((release) => {
      if (!controller.signal.aborted) {
        latestVersionRef.current = release;
        setLatestVersion(release);
      }
    });
    return () => {
      controller.abort();
    };
  }, []);

  const dismissNotice = useCallback(() => {
    setDismissed(true);
  }, []);

  return {
    latestVersionRef,
    noticeVersion: dismissed ? undefined : latestVersion,
    dismissNotice,
  };
}
