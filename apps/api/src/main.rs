mod api;
mod auth;
mod config;
mod domain;
mod error;

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    Router,
    routing::{get, post, put},
};
use config::AppConfig;
use sqlx::postgres::PgPoolOptions;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing_subscriber::EnvFilter;

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::PgPool,
    pub config: Arc<AppConfig>,
    pub http: reqwest::Client,
    pub jwks: Arc<tokio::sync::RwLock<jsonwebtoken::jwk::JwkSet>>,
    pub jwks_uri: Arc<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let command = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "serve".to_owned());
    let database_url = std::env::var("DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("DATABASE_URL must be configured"))?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    if command == "migrate" {
        tracing::info!("database migrations applied");
        return Ok(());
    }
    if command != "serve" {
        anyhow::bail!("unknown command `{command}`; expected `serve` or `migrate`");
    }
    let config = AppConfig::from_env()?;

    let http = reqwest::Client::builder()
        .user_agent(concat!("sell-guy/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let discovery_url = format!(
        "{}/.well-known/openid-configuration",
        config.oidc_issuer.trim_end_matches('/')
    );
    let discovery: serde_json::Value = http
        .get(discovery_url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let jwks_uri = discovery
        .get("jwks_uri")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("OIDC discovery document has no jwks_uri"))?
        .to_owned();
    let jwks = http
        .get(&jwks_uri)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let state = AppState {
        pool,
        config: Arc::new(config.clone()),
        http,
        jwks: Arc::new(tokio::sync::RwLock::new(jwks)),
        jwks_uri: Arc::new(jwks_uri),
    };

    let protected = Router::new()
        .route(
            "/products",
            get(api::list_products).post(api::create_product),
        )
        .route("/products/{id}", put(api::update_product))
        .route("/invoices", post(api::submit_invoice))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::authenticate,
        ));
    let api = Router::new()
        .route("/health", get(api::health))
        .route("/runtime-config", get(api::runtime_config))
        .merge(protected);
    let static_dir = PathBuf::from(&config.static_dir);
    let app = Router::new()
        .nest("/api", api)
        .fallback_service(
            ServeDir::new(&static_dir)
                .not_found_service(ServeFile::new(static_dir.join("index.html"))),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let address = SocketAddr::new(config.api_host.parse()?, config.api_port);
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "Sell Guy API listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
