import "./assets/main.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";

import App from "./app";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, networkMode: "always", staleTime: 1000 },
    mutations: { networkMode: "always" },
  },
});

document.documentElement.dataset.platform = navigator.userAgent.includes("Mac")
  ? "mac"
  : "other";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
