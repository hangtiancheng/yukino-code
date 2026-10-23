import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps/app-bridge";

function domains(values: string[] | undefined): string {
  return (values ?? [])
    .filter((value) => {
      if (!/^https?:\/\/(?:\*\.)?[a-z\d.-]+(?::\d+)?\/?$/iu.test(value)) {
        return false;
      }
      return true;
    })
    .join(" ");
}

export function buildAppCsp(csp?: McpUiResourceCsp): string {
  const resources = domains(csp?.resourceDomains);
  const connections = domains(csp?.connectDomains);
  const frames = domains(csp?.frameDomains);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`,
    `style-src 'unsafe-inline' ${resources}`,
    `img-src data: blob: ${resources}`,
    `font-src data: ${resources}`,
    `media-src data: blob: ${resources}`,
    `connect-src ${connections || "'none'"}`,
    `frame-src about: ${frames}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
