use axum::{
    extract::{Request, State},
    http::header::AUTHORIZATION,
    middleware::Next,
    response::{IntoResponse, Response},
};
use jsonwebtoken::{Algorithm, DecodingKey, TokenData, Validation, decode};
use serde::Deserialize;
use serde_json::Value;

use crate::{AppState, error::ApiError};

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
            tracing::debug!(%error, "bearer token rejected");
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
    let mut key = {
        let keys = state.jwks.read().await;
        keys.find(kid)
            .map(|jwk| DecodingKey::from_jwk(jwk))
            .transpose()?
    };
    if key.is_none() {
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
        *state.jwks.write().await = refreshed;
        let keys = state.jwks.read().await;
        key = keys
            .find(kid)
            .map(|jwk| DecodingKey::from_jwk(jwk))
            .transpose()?;
    }
    let key = key.ok_or_else(|| {
        jsonwebtoken::errors::Error::from(jsonwebtoken::errors::ErrorKind::InvalidToken)
    })?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.algorithms = vec![
        Algorithm::RS256,
        Algorithm::RS384,
        Algorithm::RS512,
        Algorithm::PS256,
        Algorithm::PS384,
        Algorithm::PS512,
        Algorithm::ES256,
        Algorithm::ES384,
        Algorithm::EdDSA,
    ];
    validation.set_issuer(&[state.config.oidc_issuer.as_str()]);
    validation.set_audience(&[state.config.oidc_audience.as_str()]);
    decode::<Claims>(token, &key, &validation)
}
