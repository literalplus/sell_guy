import { UserManager, type User } from 'oidc-client-ts';
import type { RuntimeConfig } from './types';

export function createUserManager(config: RuntimeConfig) {
  return new UserManager({
    authority: config.issuer,
    client_id: config.client_id,
    redirect_uri: config.redirect_uri,
    post_logout_redirect_uri: config.post_logout_redirect_uri,
    response_type: 'code',
    scope: config.scope,
    extraQueryParams: { audience: config.audience },
    automaticSilentRenew: true,
    monitorSession: false,
    loadUserInfo: false,
  });
}

export async function callbackOrStoredUser(manager: UserManager): Promise<User | null> {
  if (location.search.includes('code=') && location.search.includes('state=')) {
    const callbackUser = await manager.signinCallback();
    history.replaceState({}, document.title, location.pathname);
    return callbackUser ?? null;
  }
  return manager.getUser();
}

export async function tokenForUpload(manager: UserManager, current: User | null): Promise<string | null> {
  let user = current;
  if (!user || user.expired || !user.access_token) {
    try { user = await manager.signinSilent(); } catch { return null; }
  }
  return user && !user.expired ? user.access_token : null;
}
