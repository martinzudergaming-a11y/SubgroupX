import { INTERNAL_BLOG_ENABLED } from "./internal-features";

export function parseBlogRoute(pathname: string): { slug?: string } | null {
  if (!INTERNAL_BLOG_ENABLED) return null;
  if (pathname === "/blog") return {};
  if (!pathname.startsWith("/blog/")) return null;
  const rest = pathname.slice("/blog/".length);
  if (!rest || rest.includes("/")) return null;
  try {
    return { slug: decodeURIComponent(rest) };
  } catch {
    return null;
  }
}

export const BLOG_PATH = "/blog";
