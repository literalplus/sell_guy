import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from 'oidc-client-ts';
import { accessTokenFor, createUserManager, startOidcStateCleanup } from './auth';

afterEach(() => vi.useRealTimers());

describe('OIDC state cleanup', () => {
  it('cleans stale state immediately and periodically until stopped', () => {
    vi.useFakeTimers();
    const clearStaleState = vi.fn().mockResolvedValue(undefined);
    const manager = { clearStaleState } as never;

    const stop = startOidcStateCleanup(manager);
    expect(clearStaleState).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(clearStaleState).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(60_000);
    expect(clearStaleState).toHaveBeenCalledTimes(2);
  });

  it('does not leak cleanup failures as unhandled rejections', async () => {
    const clearStaleState = vi.fn().mockRejectedValue(new Error('storage unavailable'));
    const manager = { clearStaleState } as never;

    const stop = startOidcStateCleanup(manager);
    await Promise.resolve();
    stop();
    expect(clearStaleState).toHaveBeenCalledTimes(1);
  });
});

describe('access token refresh', () => {
  it('requests refresh-token scope and disables proactive silent renew', () => {
    const manager = createUserManager({
      issuer: 'https://issuer.example',
      client_id: 'client',
      audience: 'api',
      scope: 'openid profile email',
      redirect_uri: 'https://app.example/',
      post_logout_redirect_uri: 'https://app.example/',
    });

    expect(manager.settings.scope.split(/\s+/)).toContain('offline_access');
    expect(manager.settings.automaticSilentRenew).toBe(false);
  });

  it('reuses a valid token without requesting another token', async () => {
    const user = { access_token: 'still-valid', expires_at: Date.now() / 1000 + 60, refresh_token: 'refresh' };
    const signinSilent = vi.fn();
    const manager = { getUser: vi.fn().mockResolvedValue(user), signinSilent } as never;

    await expect(accessTokenFor(manager)).resolves.toBe('still-valid');
    expect(signinSilent).not.toHaveBeenCalled();
  });

  it('refreshes an expired token once and shares that refresh across concurrent requests', async () => {
    const refreshed = { access_token: 'fresh-token', expires_at: Date.now() / 1000 + 60 };
    const current = { access_token: 'expired-token', expires_at: Date.now() / 1000 - 1, refresh_token: 'refresh' };
    let finishRefresh!: (user: User) => void;
    const signinSilent = vi.fn(() => new Promise<User>(resolve => { finishRefresh = resolve; }));
    const manager = { getUser: vi.fn().mockResolvedValue(current), signinSilent } as never;

    const first = accessTokenFor(manager);
    const second = accessTokenFor(manager);
    await Promise.resolve();
    expect(signinSilent).toHaveBeenCalledTimes(1);

    finishRefresh(refreshed as User);
    await expect(Promise.all([first, second])).resolves.toEqual(['fresh-token', 'fresh-token']);
  });

  it('does not start an iframe signin when an expired session has no refresh token', async () => {
    const current = { access_token: 'expired-token', expires_at: Date.now() / 1000 - 1 };
    const signinSilent = vi.fn();
    const manager = { getUser: vi.fn().mockResolvedValue(current), signinSilent } as never;

    await expect(accessTokenFor(manager)).resolves.toBeNull();
    expect(signinSilent).not.toHaveBeenCalled();
  });
});
