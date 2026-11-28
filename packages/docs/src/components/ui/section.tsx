import { cn } from "@/lib/cn";
import {
  container,
  eyebrow as eyebrowClass,
  heading,
  muted,
} from "@/lib/styles";
import "./reveal";

export function Section({
  id,
  children,
  className,
}: {
  id?: string;
  children?: unknown;
  className?: string;
}) {
  return (
    <section id={id} className={cn("relative py-16 sm:py-24", className)}>
      {children}
    </section>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  align = "center",
}: {
  eyebrow?: string;
  title?: unknown;
  description?: unknown;
  align?: "center" | "left";
}) {
  return (
    <div
      className={cn(
        container,
        align === "center" ? "text-center" : "text-left",
      )}
    >
      <div className={cn("max-w-3xl", align === "center" && "mx-auto")}>
        {eyebrow ? (
          <docs-reveal>
            <span className={eyebrowClass}>{eyebrow}</span>
          </docs-reveal>
        ) : null}
        <docs-reveal delay={0.05}>
          <h2
            className={cn(
              "mt-5 text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl md:text-[2.6rem] md:leading-[1.1]",
              heading,
            )}
          >
            {title}
          </h2>
        </docs-reveal>
        {description ? (
          <docs-reveal delay={0.1}>
            <p
              className={cn(
                "mt-5 text-base leading-relaxed text-pretty sm:text-lg",
                muted,
              )}
            >
              {description}
            </p>
          </docs-reveal>
        ) : null}
      </div>
    </div>
  );
}
