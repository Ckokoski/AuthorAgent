/**
 * Tiny, dependency-free leveled logger for AuthorClaw.
 *
 * Why this exists: the codebase used raw console.* everywhere with no way to
 * quiet verbose/diagnostic output in production, and no consistent way to
 * surface swallowed errors from best-effort (non-throwing) code paths.
 *
 * Design goals:
 *  - Zero dependencies, zero behavior change to the existing boot experience.
 *    The emoji-prefixed startup lines (e.g. "  ✓ ...", "  ⚠ ...") are printed
 *    verbatim via logger.info/logger.warn at the default level.
 *  - Level threshold controlled by AUTHORCLAW_LOG_LEVEL env var.
 *    One of: 'debug' | 'info' | 'warn' | 'error'. Defaults to 'info'.
 *  - debug() is silent unless AUTHORCLAW_LOG_LEVEL=debug — use it for
 *    previously-silent catch blocks so failures are visible without
 *    changing the default console output.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function isLogLevel(value: string | undefined): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function resolveThreshold(): LogLevel {
  const envLevel = process.env.AUTHORCLAW_LOG_LEVEL?.toLowerCase();
  return isLogLevel(envLevel) ? envLevel : 'info';
}

export class Logger {
  /** Optional prefix (e.g. "[router]") prepended to every message. */
  private prefix: string;

  constructor(prefix = '') {
    this.prefix = prefix;
  }

  /** Current minimum level that will be printed. Re-read on every call so
   *  tests / runtime tweaks to AUTHORCLAW_LOG_LEVEL take effect immediately. */
  private get threshold(): LogLevel {
    return resolveThreshold();
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.threshold];
  }

  private format(message: string): string {
    return this.prefix ? `${this.prefix} ${message}` : message;
  }

  debug(message: string, ...args: unknown[]): void {
    if (!this.enabled('debug')) return;
    // eslint-disable-next-line no-console
    console.debug(this.format(message), ...args);
  }

  info(message: string, ...args: unknown[]): void {
    if (!this.enabled('info')) return;
    // eslint-disable-next-line no-console
    console.log(this.format(message), ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    if (!this.enabled('warn')) return;
    // eslint-disable-next-line no-console
    console.warn(this.format(message), ...args);
  }

  error(message: string, ...args: unknown[]): void {
    if (!this.enabled('error')) return;
    // eslint-disable-next-line no-console
    console.error(this.format(message), ...args);
  }

  /** Returns a child logger that prepends `tag` (e.g. "[skills]") to every
   *  message. Useful for tagging output from a specific component without
   *  repeating the tag at every call site. */
  child(tag: string): Logger {
    const combinedPrefix = this.prefix ? `${this.prefix} ${tag}` : tag;
    return new Logger(combinedPrefix);
  }
}

/** Singleton logger for app-wide use. Import `{ logger }` and call directly,
 *  or `logger.child('[component]')` for a tagged sub-logger. */
export const logger = new Logger();
