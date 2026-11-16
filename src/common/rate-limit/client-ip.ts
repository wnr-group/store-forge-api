import type { Request } from 'express';

/**
 * Resolves the client IP address from the incoming request.
 *
 * Adheres to:
 * - Express `req.ip`, which respects the `trust proxy` setting configured on the Express instance.
 * - When `trust proxy` is disabled (default / 0), `req.ip` is the remote address of the direct socket.
 * - When `trust proxy` is set to N > 0, Express determines the client IP from the Nth trusted hop from the right.
 * - Client-supplied leftmost `X-Forwarded-For` entries cannot bypass the limit (AC-B-69).
 * - IPv6-mapped IPv4 addresses (e.g. `::ffff:127.0.0.1`) are normalized to standard IPv4.
 */
export function getClientIp(req: Request): string {
  const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }
  return ip;
}
