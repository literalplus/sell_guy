import { UserManager, type User } from 'oidc-client-ts';
import type { RuntimeConfig } from './types';

export function createUserManager(config: RuntimeConfig) {
  return new UserManager({
    authority: config.issuer,
    client_id: config.client_id,
    redirect_uri: config.redirect_uri,
    post_logout_redirect_uri: config.post_logout_redirect_uri,
    response_type: 'code',
    scope: [...new Set([...config.scope.split(/\s+/).filter(Boolean), 'offline_access'])].join(' '),
    extraQueryParams: { audience: config.audience },
    automaticSilentRenew: false,
    monitorSession: false,
    loadUserInfo: false,
  });
}

const refreshes = new WeakMap<UserManager, Promise<User | null>>();

function accessTokenExpired(user: User): boolean {
  return user.expires_at !== undefined && user.expires_at <= Date.now() / 1000;
}

export function startOidcStateCleanup(manager: UserManager): () => void {
  const cleanup = () => { void manager.clearStaleState().catch(() => undefined); };
  cleanup();
  const timer = window.setInterval(cleanup, 60_000);
  return () => window.clearInterval(timer);
}

export function isAuthenticated(user: User | null): user is User {
  return user !== null && !accessTokenExpired(user) && Boolean(user.access_token);
}

async function userWithValidAccessToken(manager: UserManager, current: User | null): Promise<User | null> {
  if (!current?.access_token) return null;
  if (!accessTokenExpired(current)) return current;

  // Without a refresh token signinSilent falls back to an iframe authorization
  // request, creating OIDC state. Expired sessions without refresh tokens must
  // sign in again instead.
  if (!current.refresh_token) return null;

  let refresh = refreshes.get(manager);
  if (!refresh) {
    refresh = manager.signinSilent().catch(() => null);
    refreshes.set(manager, refresh);
  }
  try {
    const refreshed = await refresh;
    return isAuthenticated(refreshed) ? refreshed : null;
  } finally {
    if (refreshes.get(manager) === refresh) refreshes.delete(manager);
  }
}

export async function callbackOrStoredUser(manager: UserManager): Promise<User | null> {
  if (location.search.includes('code=') && location.search.includes('state=')) {
    const callbackUser = await manager.signinCallback();
    history.replaceState({}, document.title, location.pathname);
    const authenticatedUser = callbackUser ?? null;
    return isAuthenticated(authenticatedUser) ? authenticatedUser : null;
  }
  const storedUser = await manager.getUser();
  return userWithValidAccessToken(manager, storedUser);
}

export async function accessTokenFor(manager: UserManager): Promise<string | null> {
  try {
    const current = await manager.getUser();
    const user = await userWithValidAccessToken(manager, current);
    return user?.access_token ?? null;
  } catch {
    return null;
  }
}
