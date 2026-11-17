import {
  combineChunks,
  parseCookieHeader,
  serializeCookieHeader,
  stringFromBase64URL,
} from '@supabase/ssr';

/**
 * The browser session lives in the cookie `@supabase/ssr` already uses (`sb-<project>-auth-token`, chunked as `.0`,
 * `.1` when large, value `base64-<base64url(JSON session)>`), so the Next.js app keeps reading it unchanged. The only
 * differences from the library defaults are applied when this API writes it: `HttpOnly`, `SameSite=Lax` and `Secure`
 * outside local development, so page scripts can never read the tokens.
 */

/** Non-secret presence marker (no tokens): lets static public pages show "Dashboard" instead of "Sign in" without a lookup. */
export const SIGNED_IN_MARKER = 'sf_signed_in';

/** The cookie name supabase-js uses for a project: `sb-<first label of the host>-auth-token`. */
export function sessionCookieName(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
}

export interface CookieSession {
  accessToken: string;
  refreshToken: string | null;
  /** Unix seconds, as stored by supabase-js. */
  expiresAt: number | null;
}

export type CookiePair = { name: string; value: string };

export function parseCookies(header: string | undefined): CookiePair[] {
  return parseCookieHeader(header ?? '').map((c) => ({
    name: c.name,
    value: c.value ?? '',
  }));
}

/** Reads (without verifying) the session stored in the request's cookies, or null when there is none / it is unreadable. */
export async function readSessionCookie(
  header: string | undefined,
  cookieName: string,
): Promise<CookieSession | null> {
  const cookies = parseCookies(header);
  const raw = await combineChunks(
    cookieName,
    async (name) => cookies.find((c) => c.name === name)?.value ?? null,
  );
  if (!raw) return null;
  try {
    const json = raw.startsWith('base64-')
      ? stringFromBase64URL(raw.slice('base64-'.length))
      : raw;
    const session = JSON.parse(json) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_at?: unknown;
    };
    if (typeof session.access_token !== 'string' || !session.access_token)
      return null;
    return {
      accessToken: session.access_token,
      refreshToken:
        typeof session.refresh_token === 'string' && session.refresh_token
          ? session.refresh_token
          : null,
      expiresAt:
        typeof session.expires_at === 'number' ? session.expires_at : null,
    };
  } catch {
    return null;
  }
}

export interface WrittenCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

/** Collects the cookies one request wants to set, so nothing is sent when the request fails. */
export class CookieJar {
  private readonly pending: string[] = [];
  private readonly written: string[] = [];

  constructor(
    private readonly secure: boolean,
    private readonly sessionName: string,
  ) {}

  /** Applies the hardened attributes to a cookie written by supabase-js, and mirrors the presence marker. */
  setAll(cookies: WrittenCookie[]): void {
    for (const { name, value, options } of cookies) {
      const removing = value === '' || options['maxAge'] === 0;
      if (!removing) this.written.push(name);
      this.pending.push(
        serializeCookieHeader(name, value, {
          ...options,
          domain: undefined, // host-only: never widen a session cookie to sibling subdomains
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: this.secure,
        }),
      );
      if (
        name === this.sessionName ||
        name.startsWith(`${this.sessionName}.`)
      ) {
        if (removing) this.clearMarker();
        else this.setMarker(options['maxAge'] as number | undefined);
      }
    }
  }

  /** After a refresh: chunks of the previous (larger) session that the new session no longer uses must not linger. */
  clearStaleChunks(existing: CookiePair[], written: Set<string>): void {
    for (const c of existing) {
      if (c.name.startsWith(`${this.sessionName}.`) && !written.has(c.name))
        this.pending.push(
          serializeCookieHeader(c.name, '', {
            path: '/',
            maxAge: 0,
            httpOnly: true,
            sameSite: 'lax',
            secure: this.secure,
          }),
        );
    }
  }

  /** Names of the non-empty cookies written so far. */
  get writtenNames(): Set<string> {
    return new Set(this.written);
  }

  /** Removes the session (every chunk that exists in the request) and the marker. */
  clearSession(existing: CookiePair[]): void {
    for (const c of existing) {
      if (
        c.name === this.sessionName ||
        c.name.startsWith(`${this.sessionName}.`)
      )
        this.pending.push(
          serializeCookieHeader(c.name, '', {
            path: '/',
            maxAge: 0,
            httpOnly: true,
            sameSite: 'lax',
            secure: this.secure,
          }),
        );
    }
    this.clearMarker();
  }

  private setMarker(maxAge: number | undefined) {
    this.pending.push(
      serializeCookieHeader(SIGNED_IN_MARKER, '1', {
        path: '/',
        maxAge: maxAge ?? 60 * 60 * 24 * 400,
        httpOnly: false,
        sameSite: 'lax',
        secure: this.secure,
      }),
    );
  }

  private clearMarker() {
    this.pending.push(
      serializeCookieHeader(SIGNED_IN_MARKER, '', {
        path: '/',
        maxAge: 0,
        httpOnly: false,
        sameSite: 'lax',
        secure: this.secure,
      }),
    );
  }

  get headers(): string[] {
    // The last write for a cookie wins in the browser; keep order, drop exact duplicates.
    return [...new Set(this.pending)];
  }
}
