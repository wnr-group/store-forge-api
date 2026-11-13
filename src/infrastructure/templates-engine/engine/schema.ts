// GENERATED from wnr-group/store-forge lib/templates/engine/schema.ts. DO NOT EDIT.

import { z } from "zod";
import { DOCUMENT_SCHEMA_VERSION, LAYOUTS, type ComponentNode } from "../document.js";
import { LIMITS } from "../limits.js";

export const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{6})$/;

export const hexColorSchema = z
  .string()
  .regex(HEX_COLOR_REGEX, "Must be a 6-digit hex color (#rrggbb)");

/** URL protocol allowlist (D5/D21): the only absolute schemes a template may link to. */
const ALLOWED_URL_PROTOCOLS: readonly string[] = ["http:", "https:", "mailto:"];

const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/;

/** `http(s)://` followed by the authority (everything up to the first `/`, `\`, `?` or `#`), exactly two slashes. */
const HTTP_AUTHORITY_REGEX = /^https?:\/\/([^/\\?#]*)/i;

/**
 * The single URL predicate. Returns the trimmed URL when it is relative (a path "/x" or a fragment "#x")
 * or an absolute http/https/mailto URL, otherwise null. Rules (D9, D5):
 * - longer than LIMITS.maxTextLength (measured before trimming, like the schema) is rejected;
 * - any control character rejects the value outright (browsers silently drop tab/newline inside URLs,
 *   which hides schemes);
 * - "/" followed by "/" or "\" is an authority in browsers (protocol-relative), so it is not relative;
 * - http/https must be written `scheme://host...` with a non-empty host and no userinfo: `user@host`
 *   enables spoofs such as `https://good.example@evil.example`, so credentials are rejected outright.
 */
export function safeUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  if (rawUrl.length > LIMITS.maxTextLength) return null;

  const trimmed = rawUrl.trim();
  if (!trimmed || CONTROL_CHARS_REGEX.test(trimmed)) return null;

  if (trimmed.startsWith("#")) return trimmed;
  if (trimmed.startsWith("/")) return trimmed[1] === "/" || trimmed[1] === "\\" ? null : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (!ALLOWED_URL_PROTOCOLS.includes(protocol)) return null;
  if (protocol === "mailto:") return parsed.pathname ? trimmed : null;

  const authority = HTTP_AUTHORITY_REGEX.exec(trimmed)?.[1];
  if (!authority || authority.includes("@") || !isPlainHostname(parsed.hostname)) return null;
  return trimmed;
}

const IPV6_HOST_REGEX = /^\[[0-9a-f:.]+\]$/i;
const HOST_LABEL_REGEX = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/i;

/**
 * The parser lowercases and punycodes the host but still lets quotes, backticks, braces and similar
 * through; a real host is dot-separated labels of letters, digits, `_` and inner `-` (one trailing dot
 * allowed), or a bracketed IPv6 address.
 */
function isPlainHostname(hostname: string): boolean {
  if (IPV6_HOST_REGEX.test(hostname)) return true;
  const labels = (hostname.endsWith(".") ? hostname.slice(0, -1) : hostname).split(".");
  return labels.every((label) => HOST_LABEL_REGEX.test(label));
}

/** Descriptor `url` values: blank means "no link"; anything else must pass `safeUrl`. */
export const safeUrlSchema = z
  .string()
  .max(LIMITS.maxTextLength)
  .refine((val) => !val.trim() || safeUrl(val) !== null, {
    message: "Must be a valid HTTP, HTTPS, mailto, or relative URL",
  });

/** Closed enum built from the one LAYOUTS list (D3, R3); anything else, including "default", is rejected. */
export const layoutKeySchema = z.enum(LAYOUTS, {
  error: `Layout must be one of: ${LAYOUTS.join(", ")}`,
});

/** Issue codes raised by the image rules; `validateDocument` surfaces them as-is (D11, AC-ENG-016). */
export const IMAGE_ISSUE_CODES = {
  /** The path leaves the tenant's `store/` folder, or tries to (traversal, encoding tricks, other schemes). */
  crossTenantPath: "CROSS_TENANT_PATH",
  /** No safe tenant id was supplied, so no image path can be proven to belong to anyone. */
  tenantRequired: "TENANT_REQUIRED",
  /** An object that looks like an image (it has a `path` key) but whose `path` is not a string. */
  invalidImage: "INVALID_IMAGE",
} as const;
export type ImageIssueCode = (typeof IMAGE_ISSUE_CODES)[keyof typeof IMAGE_ISSUE_CODES];

const IMAGE_ISSUE_MESSAGES: Record<ImageIssueCode, string> = {
  CROSS_TENANT_PATH: "Image must be a file in this store's own image folder",
  TENANT_REQUIRED: "Images cannot be validated without a valid tenant id",
  INVALID_IMAGE: "Image path must be a text value",
};

const SAFE_TENANT_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

/** A tenant id may be embedded in a storage path only when it is plain letters, digits, `-` or `_`. */
export function isSafeTenantId(id: unknown): id is string {
  return typeof id === "string" && SAFE_TENANT_ID_REGEX.test(id);
}

/**
 * Characters that never belong in an image path: control characters (Cc, which includes the C1 range),
 * format characters (Cf: zero-width, bidi and invisible operators, soft hyphen, BOM, tag characters) and
 * the line and paragraph separators (Zl, Zp). A Unicode property rule, so new code points are covered.
 */
const IMAGE_PATH_FORBIDDEN_CHARS_REGEX = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Percent-encoded separators (`%2e`, `%2f`, `%5c`), NUL/control bytes (`%00`-`%1f`, `%7f`) and the
 * overlong UTF-8 lead bytes `%c0`/`%c1` (as in `%c0%ae`), in any case and also behind extra `%25`
 * layers (double encoding).
 */
const ENCODED_PATH_CHAR_REGEX = /%(?:25)*(?:2e|2f|5c|[01][0-9a-f]|7f|c0|c1)/i;

function hasUnsafePathParts(path: string): boolean {
  if (IMAGE_PATH_FORBIDDEN_CHARS_REGEX.test(path) || path.includes("\\") || path.includes("..") || ENCODED_PATH_CHAR_REGEX.test(path)) {
    return true;
  }
  // Rejects empty segments ("//", leading or trailing "/") and "." segments.
  return path.split("/").some((segment) => segment === "" || segment === ".");
}

/**
 * Percent-encoding allowlist: a `%` is accepted only when the whole path decodes (decodeURIComponent
 * throws on a lone `%`, non-hex digits, `%u002e`, invalid UTF-8, overlong forms such as `%c0%ae`,
 * `%e0%80%ae` or `%f0%80%80%ae`, and encoded surrogates) and the decoded text, and a second decode of it,
 * still passes every rule above (no `..`, dot or empty segments, separators, control or format characters).
 * Anything still carrying a `%` after two decodes is rejected as over-encoded.
 */
function hasUnsafePercentEncoding(path: string): boolean {
  let current = path;
  for (let pass = 0; pass < 2 && current.includes("%"); pass++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return true;
    }
    if (hasUnsafePathParts(decoded) || hasUnsafePathParts(decoded.normalize("NFKC"))) return true;
    current = decoded;
  }
  return current.includes("%");
}

/**
 * The single image-path rule (D11). A path is valid only as `<tenantId>/store/<file...>`: exact,
 * case-sensitive prefix, at least one file segment, no traversal, no empty/dot segments, no backslash,
 * control characters or percent-encoded separators. The checks run again on the NFKC form so that
 * look-alike characters (fullwidth dots and slashes) cannot hide a traversal.
 * Returns the violated rule's code, or null when the path is acceptable.
 */
export function imagePathViolation(path: string, tenantId: string | undefined): ImageIssueCode | null {
  if (!isSafeTenantId(tenantId)) return IMAGE_ISSUE_CODES.tenantRequired;
  const prefix = `${tenantId}/store/`;
  if (!path.startsWith(prefix) || path.length === prefix.length) return IMAGE_ISSUE_CODES.crossTenantPath;
  const folded = path.normalize("NFKC");
  for (const form of path === folded ? [path] : [path, folded]) {
    if (hasUnsafePathParts(form) || hasUnsafePercentEncoding(form)) return IMAGE_ISSUE_CODES.crossTenantPath;
  }
  return null;
}

/** Reads the image rule code off a Zod issue produced by `imageValueSchema`, if it is one. */
export function imageIssueCode(issue: { code: string; params?: Record<string, unknown> }): ImageIssueCode | null {
  const code = issue.code === "custom" ? issue.params?.imageIssue : undefined;
  return code === IMAGE_ISSUE_CODES.crossTenantPath || code === IMAGE_ISSUE_CODES.tenantRequired ? code : null;
}

export function imageValueMessage(code: ImageIssueCode): string {
  return IMAGE_ISSUE_MESSAGES[code];
}

/**
 * The single image value schema. With a safe `tenantId` the path must live under `<tenantId>/store/`;
 * without one (missing or unsafe) every image is rejected with TENANT_REQUIRED. The issue sits on the
 * image value itself so the error path is the setting, not its `path` field.
 */
export function imageValueSchema(tenantId?: string) {
  return z
    .object({
      path: z.string().min(1, "Image path is required").max(LIMITS.maxTextLength),
      alt: z.string().max(LIMITS.maxAltLength, `Alt text must be at most ${LIMITS.maxAltLength} characters`).optional(),
      focal: z
        .object({
          x: z.number().min(0).max(100),
          y: z.number().min(0).max(100),
        })
        .optional(),
    })
    .superRefine((image, ctx) => {
      const violation = imagePathViolation(image.path, tenantId);
      if (violation) {
        ctx.addIssue({ code: "custom", message: IMAGE_ISSUE_MESSAGES[violation], params: { imageIssue: violation } });
      }
    });
}

export const ALLOWED_SOCIAL_NETWORKS = {
  facebook: ["facebook.com", "www.facebook.com"],
  instagram: ["instagram.com", "www.instagram.com"],
  x: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
  twitter: ["twitter.com", "www.twitter.com", "x.com", "www.x.com"],
  pinterest: ["pinterest.com", "www.pinterest.com"],
  tiktok: ["tiktok.com", "www.tiktok.com"],
  youtube: ["youtube.com", "www.youtube.com"],
  linkedin: ["linkedin.com", "www.linkedin.com"],
} as const;

type SocialNetwork = keyof typeof ALLOWED_SOCIAL_NETWORKS;

/** Own keys only: `in` would let `constructor`, `toString` or `__proto__` pass as networks. */
function isSocialNetwork(key: string): key is SocialNetwork {
  return Object.prototype.hasOwnProperty.call(ALLOWED_SOCIAL_NETWORKS, key);
}

/** Whitespace and invisible characters (control, format, line/paragraph separators) never belong in a stored link. */
const SOCIAL_URL_FORBIDDEN_CHARS_REGEX = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * One social link must be a single, exactly written https URL on its network's host: the parsed `hostname` equals an allowed
 * host or ends with `.<allowed host>` (the dot is required, so `notfacebook.com` and `facebook.com.evil.example`
 * fail). Userinfo (`facebook.com@evil.example`) and non-default ports are rejected, as is any whitespace, which
 * would allow several URLs in one value. The parser lowercases the host, so `FACEBOOK.COM` is accepted.
 */
function isSocialLinkOnNetwork(network: SocialNetwork, url: string): boolean {
  if (url.length > LIMITS.maxTextLength || SOCIAL_URL_FORBIDDEN_CHARS_REGEX.test(url)) return false;
  // Exact `https://host...` form only: the URL parser repairs `https:host`, `https:/host`, `https:\\host` and
  // `https:///host` into a valid URL, and safeUrl (the single URL predicate, which also applies the
  // plain-hostname rule) refuses them, so the value must pass unchanged.
  if (safeUrl(url) !== url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
  if (HTTP_AUTHORITY_REGEX.exec(url)?.[1]?.includes("@")) return false;
  const host = parsed.hostname;
  return ALLOWED_SOCIAL_NETWORKS[network].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Checks the raw input, not a parsed copy: `z.record` silently drops an own `__proto__` key, which would let
 * that key stay in the stored document while the validator saw an empty record.
 */
export const socialLinksSchema = z.custom<Record<string, string>>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([net, url]) => isSocialNetwork(net) && typeof url === "string" && isSocialLinkOnNetwork(net, url),
    ),
  "Social links must be HTTPS URLs matching their respective network host",
);

export const componentNodeSchema: z.ZodType<ComponentNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1, "Component type is required"),
    settings: z.record(z.string(), z.unknown()),
    blocks: z.record(z.string(), componentNodeSchema),
    block_order: z.array(z.string()),
    disabled: z.boolean().optional(),
  }),
);

export const pageTemplateSchema = z.object({
  schemaVersion: z.literal(DOCUMENT_SCHEMA_VERSION),
  layout: layoutKeySchema,
  sections: z.record(z.string(), componentNodeSchema),
  order: z.array(z.string()),
});

export const groupTemplateSchema = z.object({
  schemaVersion: z.literal(DOCUMENT_SCHEMA_VERSION),
  layout: layoutKeySchema.optional(),
  sections: z.record(z.string(), componentNodeSchema),
  order: z.array(z.string()),
});
