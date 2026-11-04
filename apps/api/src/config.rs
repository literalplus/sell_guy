use anyhow::{Context, Result};
use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct RuntimeConfig {
    pub issuer: String,
    pub client_id: String,
    pub audience: String,
    pub scope: String,
    pub redirect_uri: String,
    pub post_logout_redirect_uri: String,
}

#[derive(Clone)]
pub struct AppConfig {
    pub api_host: String,
    pub api_port: u16,
    pub static_dir: String,
    pub oidc_issuer: String,
    pub oidc_audience: String,
    pub runtime: RuntimeConfig,
}

impl AppConfig {
    pub fn from_env() -> Result<Self> {
        let issuer = required("OIDC_ISSUER")?;
        let client_id = required("OIDC_CLIENT_ID")?;
        let audience = required("OIDC_AUDIENCE")?;
        let app_base_url = value("APP_BASE_URL", "http://localhost:4200");
        let redirect_uri = value("OIDC_REDIRECT_URI", &app_base_url);
        let post_logout_redirect_uri = value("OIDC_POST_LOGOUT_REDIRECT_URI", &app_base_url);
        Ok(Self {
            api_host: value("API_HOST", "0.0.0.0"),
            api_port: value("API_PORT", "8080")
                .parse()
                .context("API_PORT must be a valid port")?,
            static_dir: value("STATIC_DIR", "/app/static"),
            oidc_issuer: issuer.clone(),
            oidc_audience: audience.clone(),
            runtime: RuntimeConfig {
                issuer,
                client_id,
                audience,
                scope: value("OIDC_SCOPE", "openid profile email"),
                redirect_uri,
                post_logout_redirect_uri,
            },
        })
    }
}

fn required(key: &str) -> Result<String> {
    std::env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .with_context(|| format!("{key} must be configured"))
}

fn value(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_owned())
}
