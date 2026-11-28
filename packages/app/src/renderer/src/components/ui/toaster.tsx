// App-wide toast host (sonner). Mount once; call `toast(...)` from anywhere.
// Styled with the app's CSS variables so toasts follow the active theme.

import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster(props: ToasterProps): React.JSX.Element {
  return (
    <Sonner
      position="top-right"
      toastOptions={{
        style: {
          background: "var(--background)",
          color: "var(--foreground)",
          border: "1px solid var(--border)",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
