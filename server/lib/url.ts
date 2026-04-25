/**
 * Compose the upstream base URL for a given endpoint host:port.
 *
 * - Local services (e.g. exo on a Mac mini) speak plain http with their custom port.
 * - Well-known cloud hosts (OpenRouter, Anthropic, OpenAI) speak https on 443
 *   and have a published path prefix; OpenRouter notably routes its OpenAI-
 *   compatible API under `/api` (i.e. `/api/v1/chat/completions`).
 */
export function buildBase(ip: string, port: number): string {
  const cloud = isCloudHost(ip);
  const isHttps = port === 443 || cloud;
  const scheme = isHttps ? "https" : "http";
  const portPart =
    (isHttps && port === 443) || (!isHttps && port === 80) ? "" : `:${port}`;
  if (ip.includes("openrouter.ai")) return `${scheme}://${ip}${portPart}/api`;
  return `${scheme}://${ip}${portPart}`;
}

export function isCloudHost(ip: string): boolean {
  return (
    ip.includes("openrouter.ai") ||
    ip.includes("anthropic.com") ||
    ip.includes("openai.com")
  );
}
