interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function isBingHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/u, "");
  return normalized === "bing.com" || normalized.endsWith(".bing.com");
}

function resolveResultUrl(href: string): string | undefined {
  try {
    let url = new URL(href, "https://www.bing.com");
    if (isBingHost(url.hostname)) {
      if (url.pathname !== "/ck/a") {
        return;
      }
      const encoded = url.searchParams.get("u") ?? "";
      if (!/^a[01][\w+/-]+={0,2}$/u.test(encoded)) {
        return;
      }
      url = new URL(
        Buffer.from(encoded.slice(2), "base64url").toString("utf8"),
      );
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      isBingHost(url.hostname)
    ) {
      return;
    }
    return url.href;
  } catch {
    return;
  }
}

function cleanText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export async function parseBingSearch(html: string): Promise<SearchResult[]> {
  const { load } = await import("cheerio/slim");
  const $ = load(html);
  $("script, style, noscript").remove();
  if ($("#b_captcha, #captcha, .g-recaptcha, #challenge-form").length) {
    throw new Error(
      "Bing search requires CAPTCHA verification; try again later",
    );
  }
  const blocks = $("#b_results li.b_algo");
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const node of blocks) {
    const block = $(node);
    const link = block.find("h2 a[href]").first();
    const url = resolveResultUrl(link.attr("href") ?? "");
    const title = cleanText(link.text());
    if (!url || !title || seen.has(url)) {
      continue;
    }
    const snippet =
      block.find('p[class*="b_lineclamp"]').first().text() ||
      block.find(".b_caption p").first().text() ||
      block.find(".b_caption").first().text();
    results.push({ title, url, snippet: cleanText(snippet) });
    seen.add(url);
  }
  if (
    !results.length &&
    !$("#b_results .b_no, #b_results .b_noresults").length
  ) {
    throw new Error(
      "Could not read Bing search results: the page may be blocked, require verification, or have changed its layout",
    );
  }
  return results;
}
