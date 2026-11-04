use axum::{
    Extension, Json,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedUser,
    domain::{
        InvoiceResponse, InvoiceSnapshot, Product, ProductInput, idempotency_payload_matches,
        validate_product, validate_snapshot,
    },
    error::ApiError,
};

pub async fn health() -> &'static str {
    "ok"
}

pub async fn runtime_config(State(state): State<AppState>) -> Json<crate::config::RuntimeConfig> {
    Json(state.config.runtime.clone())
}

pub async fn list_products(State(state): State<AppState>) -> Result<Json<Vec<Product>>, ApiError> {
    let products = sqlx::query_as::<_, Product>(
        "SELECT id, name, display_name, price_cents, position, enabled FROM products ORDER BY position, id"
    ).fetch_all(&state.pool).await?;
    Ok(Json(products))
}

pub async fn create_product(
    State(state): State<AppState>,
    Json(input): Json<ProductInput>,
) -> Result<impl IntoResponse, ApiError> {
    validate_product(&input).map_err(ApiError::BadRequest)?;
    let product = sqlx::query_as::<_, Product>(
        "INSERT INTO products (name, display_name, price_cents, position, enabled) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, display_name, price_cents, position, enabled"
    ).bind(input.name.trim()).bind(input.display_name).bind(input.price_cents).bind(input.position).bind(input.enabled)
        .fetch_one(&state.pool).await?;
    Ok((StatusCode::CREATED, Json(product)))
}

pub async fn update_product(
    State(state): State<AppState>,
    Path(id): Path<i32>,
    Json(input): Json<ProductInput>,
) -> Result<Json<Product>, ApiError> {
    validate_product(&input).map_err(ApiError::BadRequest)?;
    let product = sqlx::query_as::<_, Product>(
        "UPDATE products SET name = $2, display_name = $3, price_cents = $4, position = $5, enabled = $6 WHERE id = $1 RETURNING id, name, display_name, price_cents, position, enabled"
    ).bind(id).bind(input.name.trim()).bind(input.display_name).bind(input.price_cents).bind(input.position).bind(input.enabled)
        .fetch_optional(&state.pool).await?.ok_or(ApiError::NotFound)?;
    Ok(Json(product))
}

#[derive(FromRow)]
struct InvoiceRow {
    invoice_id: Uuid,
    received_at: DateTime<Utc>,
    payload: Value,
}

pub async fn submit_invoice(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(snapshot): Json<InvoiceSnapshot>,
) -> Result<impl IntoResponse, ApiError> {
    let email = user
        .email
        .filter(|email| !email.trim().is_empty())
        .ok_or_else(|| {
            ApiError::BadRequest(
                "token must contain a usable email claim to upload invoices".into(),
            )
        })?;
    validate_snapshot(&snapshot).map_err(ApiError::BadRequest)?;
    let payload = serde_json::to_value(&snapshot).map_err(|e| ApiError::Unexpected(e.into()))?;
    let mut data = payload.clone();
    data.as_object_mut()
        .ok_or_else(|| ApiError::BadRequest("invoice payload must be an object".into()))?
        .insert("uploaded_by_email".into(), Value::String(email));

    let inserted = sqlx::query_as::<_, (Uuid, DateTime<Utc>)>(
        "INSERT INTO invoices (cart_uuid, total_cents, data, client_payload) VALUES ($1, $2, $3, $4) ON CONFLICT (cart_uuid) DO NOTHING RETURNING invoice_id, received_at"
    ).bind(snapshot.cart_uuid).bind(snapshot.chargeable_total_cents).bind(data).bind(&payload)
        .fetch_optional(&state.pool).await?;
    if let Some((invoice_id, received_at)) = inserted {
        return Ok((
            StatusCode::CREATED,
            Json(InvoiceResponse {
                invoice_id,
                received_at,
                created: true,
            }),
        ));
    }

    let existing = sqlx::query_as::<_, InvoiceRow>(
        "SELECT invoice_id, received_at, client_payload AS payload FROM invoices WHERE cart_uuid = $1"
    ).bind(snapshot.cart_uuid).fetch_optional(&state.pool).await?.ok_or_else(|| ApiError::Conflict("invoice was concurrently changed; retry with the same snapshot".into()))?;
    if !idempotency_payload_matches(&existing.payload, &payload) {
        return Err(ApiError::Conflict(
            "cart UUID has already been used with a different invoice snapshot".into(),
        ));
    }
    Ok((
        StatusCode::OK,
        Json(InvoiceResponse {
            invoice_id: existing.invoice_id,
            received_at: existing.received_at,
            created: false,
        }),
    ))
}
