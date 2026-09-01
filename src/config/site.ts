export const SITE_ORIGIN = "https://giselalentz.com.ar" as const;

export function getCanonicalUrl(pathname = "/"): string {
  const url = new URL(SITE_ORIGIN);
  url.pathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  url.search = "";
  url.hash = "";
  return url.href;
}
