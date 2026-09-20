/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

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
