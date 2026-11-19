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
  readonly entries: { level: string; message: unknown }[] = [];
  private push(level: string, message: unknown) {
    this.entries.push({ level, message });
  }
  log = (m: unknown) => this.push('log', m);
  error = (m: unknown) => this.push('error', m);
  warn = (m: unknown) => this.push('warn', m);
  debug = (m: unknown) => this.push('debug', m);
  verbose = (m: unknown) => this.push('verbose', m);
  fatal = (m: unknown) => this.push('fatal', m);
  clear() {
    this.entries.length = 0;
  }
  text(): string {
    return this.entries
      .map((e) =>
        typeof e.message === 'string' ? e.message : JSON.stringify(e.message),
      )
      .join('\n');
  }
}
