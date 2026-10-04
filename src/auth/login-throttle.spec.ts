import { LoginThrottle } from './login-throttle';

describe('LoginThrottle', () => {
  it('blocks after repeated failures and recovers after the window', () => {
    const throttle = new LoginThrottle();
    const now = 1_000_000;
    for (let i = 0; i < 8; i++) throttle.fail('ip|a@x.com', now + i);
    expect(() => throttle.assertAllowed('ip|a@x.com', now + 10)).toThrow(
      /Too many/,
    );
    expect(() => throttle.assertAllowed('ip|b@x.com', now + 10)).not.toThrow();
    expect(() =>
      throttle.assertAllowed('ip|a@x.com', now + 16 * 60_000),
    ).not.toThrow();
  });

  it('clears failures after a successful sign-in', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 7; i++) throttle.fail('k', 1000 + i);
    throttle.succeed('k');
    throttle.fail('k', 2000);
    expect(() => throttle.assertAllowed('k', 2001)).not.toThrow();
  });
});
