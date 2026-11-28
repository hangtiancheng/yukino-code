export function resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  const fingerprint =
    context.parentURL &&
    new URL(context.parentURL).searchParams.get("yukinoReload");
  if (
    fingerprint &&
    result.url.startsWith("file:") &&
    (specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      specifier.startsWith("file:"))
  ) {
    const url = new URL(result.url);
    url.searchParams.set("yukinoReload", fingerprint);
    return { ...result, url: url.href };
  }
  return result;
}
