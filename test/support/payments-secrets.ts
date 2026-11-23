import { randomBytes } from 'node:crypto';
import type { LoggerService } from '@nestjs/common';

/**
 * Per-run synthetic credentials and a log recorder, shared by the payments specs. Nothing here touches the application or a
 * database, so unit specs can import it cheaply. The synthetic secret and encryption key exist only in memory (or in the
 * evidence run's environment) and are the leak sentinels.
 */

export const KEY_B64 =
  process.env.QA_SYNTH_KEY_B64 ?? randomBytes(32).toString('base64');
export const SECRET =
  process.env.QA_SYNTH_SECRET ?? `SYNTH${randomBytes(10).toString('hex')}`;

export const keyId = (mode: 'test' | 'live' = 'test') =>
  `rzp_${mode}_${randomBytes(6).toString('hex')}`;
export const secretOf = (n = 0) =>
  `SYNTH${randomBytes(10).toString('hex')}${String(n).padStart(2, '0')}`;

/** Everything the application logger wrote, as plain text, for leak scans and event assertions. */
export class LogRecorder implements LoggerService {
  readonly entries: { level: string; message: unknown; rest: unknown[] }[] = [];
  // Nest forwards optional arguments (context, stack, extra values); record them so a leak scan sees every one.
  private push(level: string, message: unknown, rest: unknown[] = []) {
    this.entries.push({ level, message, rest });
  }
  log = (m: unknown, ...rest: unknown[]) => this.push('log', m, rest);
  error = (m: unknown, ...rest: unknown[]) => this.push('error', m, rest);
  warn = (m: unknown, ...rest: unknown[]) => this.push('warn', m, rest);
  debug = (m: unknown, ...rest: unknown[]) => this.push('debug', m, rest);
  verbose = (m: unknown, ...rest: unknown[]) => this.push('verbose', m, rest);
  fatal = (m: unknown, ...rest: unknown[]) => this.push('fatal', m, rest);
  clear() {
    this.entries.length = 0;
  }
  text(): string {
    return this.entries
      .map((e) =>
        [e.message, ...e.rest]
          .map((part) =>
            typeof part === 'string' ? part : JSON.stringify(part),
          )
          .join(' '),
      )
      .join('\n');
  }
}
