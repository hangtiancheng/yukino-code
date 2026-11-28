export function icon(svg: string, className?: string): string {
  let out = svg.replace(/<!--[^>]*-->\s*/g, "");
  if (className) {
    out = out.replace(/class="lucide[^"]*"/, `class="lucide ${className}"`);
  }
  return out;
}
