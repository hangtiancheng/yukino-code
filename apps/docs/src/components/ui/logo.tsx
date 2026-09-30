import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { cn } from "@/lib/cn";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import { heading } from "@/lib/styles";

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "from-brand-500 to-brand-700 shadow-glow dark:from-brand-400 dark:to-brand-600 grid h-8 w-8 place-items-center rounded-[11px] bg-linear-to-br select-none",
        className,
      )}
    >
      {unsafeHTML(icon(icons.squareTerminal, "h-[18px] w-[18px] text-white"))}
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark />
      <span className={cn("text-[17px] font-bold tracking-[-0.03em]", heading)}>
        Yukino
      </span>
    </span>
  );
}
