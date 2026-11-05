use axum::{
    extract::{Request, State},
    http::header::AUTHORIZATION,
    middleware::Next,
    response::{IntoResponse, Response},
};
use jsonwebtoken::{Algorithm, DecodingKey, TokenData, Validation, decode};
use serde::Deserialize;
use serde_json::Value;
use std::time::{Duration, Instant};

use crate::{AppState, JwksCache, error::ApiError};

const JWKS_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const JWKS_CACHE_LIFETIME: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug)]
pub struct AuthenticatedUser {
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Claims {
    #[serde(rename = "iss")]
    _iss: String,
    #[serde(rename = "aud")]
    _aud: Value,
    #[serde(rename = "exp")]
    _exp: usize,
    email: Option<String>,
}

pub async fn authenticate(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(raw) = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
    else {
        return ApiError::Unauthorized.into_response();
    };
    let Some(token) = raw.strip_prefix("Bearer ") else {
        return ApiError::Unauthorized.into_response();
    };
    match validate_token(&state, token).await {
        Ok(claims) => {
            request.extensions_mut().insert(AuthenticatedUser {
                email: claims.claims.email.filter(|email| !email.trim().is_empty()),
            });
            next.run(request).await
        }
        Err(error) => {
            tracing::warn!(%error, "bearer token rejected");
            ApiError::Unauthorized.into_response()
        }
    }
}

async fn validate_token(
    state: &AppState,
    token: &str,
) -> Result<TokenData<Claims>, jsonwebtoken::errors::Error> {
    let header = jsonwebtoken::decode_header(token)?;
    let kid = header.kid.as_deref().ok_or_else(|| {
        jsonwebtoken::errors::Error::from(jsonwebtoken::errors::ErrorKind::InvalidToken)
    })?;
    let key = resolve_key(state, kid).await?;
    let key = key.ok_or_else(|| {
        jsonwebtoken::errors::Error::from(jsonwebtoken::errors::ErrorKind::InvalidToken)
    })?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[state.config.oidc_issuer.as_str()]);
    validation.set_audience(&[state.config.oidc_audience.as_str()]);
    decode::<Claims>(token, &key, &validation)
}

async fn resolve_key(
    state: &AppState,
    kid: &str,
) -> Result<Option<DecodingKey>, jsonwebtoken::errors::Error> {
    let (fresh, key) = {
        let cache = state.jwks.read().await;
        (
            cache_is_fresh(cache.fetched_at, Instant::now()),
            find_key(&cache.keys, kid)?,
        )
    };
    if fresh && key.is_some() {
        return Ok(key);
    }

    // Serialize refreshes, then recheck in case a concurrent request already
    // refreshed the set while this request waited for the lock.
    let mut last_refresh = state.jwks_refresh.lock().await;
    let (fresh, key) = {
        let cache = state.jwks.read().await;
        (
            cache_is_fresh(cache.fetched_at, Instant::now()),
            find_key(&cache.keys, kid)?,
        )
    };
    if fresh && key.is_some() {
        return Ok(key);
    }

    if refresh_allowed(*last_refresh, Instant::now()) {
        // Record attempts (including failures) so an unavailable identity
        // provider cannot be hammered by arbitrary unknown key IDs.
        *last_refresh = Some(Instant::now());
        fetch_jwks(state).await?;
    }

    let cache = state.jwks.read().await;
    if cache_is_fresh(cache.fetched_at, Instant::now()) {
        find_key(&cache.keys, kid)
    } else {
        // Never accept a key from an expired JWKS, even if refresh was
        // rate-limited or the identity provider is unavailable.
        Ok(None)
    }
}

pub fn refresh_jwks_periodically(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(JWKS_CACHE_LIFETIME);
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Err(error) = refresh_jwks(&state).await {
                tracing::warn!(%error, "periodic JWKS refresh failed");
            }
        }
    });
}

async fn refresh_jwks(state: &AppState) -> Result<(), jsonwebtoken::errors::Error> {
    let mut last_refresh = state.jwks_refresh.lock().await;
    if !refresh_allowed(*last_refresh, Instant::now()) {
        return Ok(());
    }
    *last_refresh = Some(Instant::now());
    fetch_jwks(state).await
}

async fn fetch_jwks(state: &AppState) -> Result<(), jsonwebtoken::errors::Error> {
    let refreshed: jsonwebtoken::jwk::JwkSet = state
        .http
        .get(state.jwks_uri.as_str())
        .send()
        .await
        .map_err(|_| {
            jsonwebtoken::errors::Error::from(jsonwebtoken::errors::ErrorKind::InvalidToken)
        })?
        .error_for_status()
        .map_err(|_| {
            jsonwebtoken::errors::Error::from(jsonwebtoken::errors::ErrorKind::InvalidToken)
        })?
        .json()
        .await
        .map_err(|_| {
            jsonwebtoken::errors::Error::from(jsonwebtoken::errors::ErrorKind::InvalidToken)
        })?;
    *state.jwks.write().await = JwksCache {
        keys: refreshed,
        fetched_at: Instant::now(),
    };
    Ok(())
}

fn find_key(
    keys: &jsonwebtoken::jwk::JwkSet,
    kid: &str,
) -> Result<Option<DecodingKey>, jsonwebtoken::errors::Error> {
    keys.find(kid).map(DecodingKey::from_jwk).transpose()
}

fn cache_is_fresh(fetched_at: Instant, now: Instant) -> bool {
    now.duration_since(fetched_at) < JWKS_CACHE_LIFETIME
}

fn refresh_allowed(last_refresh: Option<Instant>, now: Instant) -> bool {
    last_refresh
        .is_none_or(|last_refresh| now.duration_since(last_refresh) >= JWKS_REFRESH_INTERVAL)
}

#[cfg(test)]
mod tests {
    use super::{JWKS_CACHE_LIFETIME, JWKS_REFRESH_INTERVAL, cache_is_fresh, refresh_allowed};
    use std::time::Instant;

    #[test]
    fn unknown_kid_refresh_is_limited_to_one_per_interval() {
        let last_refresh = Instant::now();

        assert!(!refresh_allowed(Some(last_refresh), last_refresh));
        assert!(!refresh_allowed(
            Some(last_refresh),
            last_refresh + JWKS_REFRESH_INTERVAL - std::time::Duration::from_millis(1)
        ));
        assert!(refresh_allowed(
            Some(last_refresh),
            last_refresh + JWKS_REFRESH_INTERVAL
        ));
        assert!(refresh_allowed(None, last_refresh));
    }

    #[test]
    fn jwks_cache_expires_after_its_lifetime() {
        let fetched_at = Instant::now();

        assert!(cache_is_fresh(fetched_at, fetched_at));
        assert!(cache_is_fresh(
            fetched_at,
            fetched_at + JWKS_CACHE_LIFETIME - std::time::Duration::from_millis(1)
        ));
        assert!(!cache_is_fresh(
            fetched_at,
            fetched_at + JWKS_CACHE_LIFETIME
        ));
    }
}
