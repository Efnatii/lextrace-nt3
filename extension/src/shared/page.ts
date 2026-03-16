export function normalizePageKey(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    const normalizedPathname = normalizePathname(url.pathname);
    const normalizedPort = normalizePort(url.protocol, url.port);
    const normalizedHost = url.hostname.toLowerCase();

    return `${url.protocol}//${normalizedHost}${normalizedPort}${normalizedPathname}`;
  } catch {
    return null;
  }
}

export function shortenPageKey(pageKey: string | null | undefined, maxLength = 28): string {
  if (!pageKey) {
    return "-";
  }

  return pageKey.length > maxLength ? `${pageKey.slice(0, Math.max(1, maxLength - 3))}...` : pageKey;
}

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === "/") {
    return "/";
  }

  const collapsed = pathname.replace(/\/{2,}/g, "/");
  return collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

function normalizePort(protocol: string, port: string): string {
  if (!port) {
    return "";
  }

  if ((protocol === "http:" && port === "80") || (protocol === "https:" && port === "443")) {
    return "";
  }

  return `:${port}`;
}
