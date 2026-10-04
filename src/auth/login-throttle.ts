import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;

/**
 * In-memory brute-force guard keyed by client + account. It resets on restart
 * and is per-instance; use a shared store if the API is scaled horizontally.
 */
@Injectable()
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

  private recent(key: string, now: number) {
    const hits = (this.failures.get(key) ?? []).filter(
      (time) => now - time < WINDOW_MS,
    );
    if (hits.length) this.failures.set(key, hits);
    else this.failures.delete(key);
    return hits;
  }

  assertAllowed(key: string, now = Date.now()) {
    const hits = this.recent(key, now);
    if (hits.length >= MAX_FAILURES) {
      const retryAfter = Math.ceil((WINDOW_MS - (now - hits[0])) / 1000);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many failed sign-in attempts. Try again later.',
          retryAfterSeconds: retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  fail(key: string, now = Date.now()) {
    this.failures.set(key, [...this.recent(key, now), now]);
  }

  succeed(key: string) {
    this.failures.delete(key);
  }
}
