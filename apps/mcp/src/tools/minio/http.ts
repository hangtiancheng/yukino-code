import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** S3 keys may contain dot segments, which fetch's URL parser removes. */
export async function fetchS3(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const parts = /^(https?:\/\/[^/]+)(\/[^?]*)(\?.*)?$/.exec(url);
  if (
    !parts ||
    !parts[2]!.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return fetch(url, init);
  }

  const origin = new URL(parts[1]!);
  const request = origin.protocol === "https:" ? httpsRequest : httpRequest;
  // Pass path separately so Node sends the exact path that was signed.
  return new Promise((resolve, reject) => {
    const req = request(
      origin,
      {
        path: parts[2]! + (parts[3] ?? ""),
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        signal: init.signal ?? undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined)
              headers.set(
                name,
                Array.isArray(value) ? value.join(", ") : value,
              );
          }
          const status = res.statusCode ?? 500;
          const body =
            init.method === "HEAD" || [204, 205, 304].includes(status)
              ? null
              : new Uint8Array(Buffer.concat(chunks));
          resolve(new Response(body, { status, headers }));
        });
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}
