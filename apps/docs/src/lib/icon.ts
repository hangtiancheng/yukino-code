export function icon(svg: string, className?: string, size?: number): string {
  let out = svg.replace(/<!--[^>]*-->\s*/g, "");
  if (size !== undefined) {
    out = out
      .replace(/width="24"/, `width="${size}"`)
      .replace(/height="24"/, `height="${size}"`);
  }
  if (className) {
    out = out.replace(/class="lucide[^"]*"/, `class="lucide ${className}"`);
  }
  return out;
}
