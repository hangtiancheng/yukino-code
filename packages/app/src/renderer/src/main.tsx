import "./assets/main.css";

import App from "@renderer/app";
import { applyTheme } from "@renderer/lib/theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, networkMode: "always", staleTime: 1000 },
    mutations: { networkMode: "always" },
  },
});

document.documentElement.dataset.platform = navigator.userAgent.includes("Mac")
  ? "mac"
  : "other";

applyTheme(window.matchMedia("(prefers-color-scheme: dark)").matches);
void window.api
  .getTheme()
  .then((theme) => {
    document.documentElement.dataset.themeMode = theme.mode;
    applyTheme(theme.dark);
  })
  .catch(() => undefined)
  .finally(() => {
    createRoot(document.getElementById("root")!).render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );
  });
