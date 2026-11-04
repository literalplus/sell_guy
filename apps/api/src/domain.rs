use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    Product,
    Custom,
    Donation,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct InvoiceLine {
    pub kind: LineKind,
    pub product_id: Option<i32>,
    pub description: String,
    pub unit_amount_cents: i64,
    pub quantity: i64,
    pub line_total_cents: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct InvoiceSnapshot {
    pub schema_version: u32,
    pub cart_uuid: Uuid,
    pub saved_at: DateTime<Utc>,
    pub currency: String,
    pub lines: Vec<InvoiceLine>,
    pub chargeable_total_cents: i64,
    pub donation_total_cents: i64,
    pub cash_amount_due_cents: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Product {
    pub id: i32,
    pub name: String,
    pub display_name: Option<String>,
    pub price_cents: i64,
    pub position: i32,
    pub enabled: bool,
}

#[derive(Deserialize)]
pub struct ProductInput {
    pub name: String,
    pub display_name: Option<String>,
    pub price_cents: i64,
    pub position: i32,
    pub enabled: bool,
}

#[derive(Serialize)]
pub struct InvoiceResponse {
    pub invoice_id: Uuid,
    pub received_at: DateTime<Utc>,
    pub created: bool,
}

pub fn idempotency_payload_matches(
    existing: &serde_json::Value,
    submitted: &serde_json::Value,
) -> bool {
    existing == submitted
}

pub fn validate_snapshot(snapshot: &InvoiceSnapshot) -> Result<(), String> {
    if snapshot.schema_version != 1 {
        return Err("unsupported invoice schema version".into());
    }
    if snapshot.currency != "EUR" {
        return Err("currency must be EUR".into());
    }
    if snapshot.lines.is_empty() {
        return Err("empty carts cannot be saved".into());
    }

    let mut chargeable = 0_i64;
    let mut donations = 0_i64;
    for line in &snapshot.lines {
        if line.unit_amount_cents <= 0 {
            return Err("line amounts must be positive".into());
        }
        if line.quantity <= 0 {
            return Err("line quantities must be positive whole numbers".into());
        }
        if line.description.trim().is_empty() {
            return Err("line description is required".into());
        }
        let expected = line
            .unit_amount_cents
            .checked_mul(line.quantity)
            .ok_or("line total is out of range")?;
        if expected != line.line_total_cents {
            return Err("line total does not match amount and quantity".into());
        }
        match line.kind {
            LineKind::Product => {
                if !matches!(line.product_id, Some(id) if id > 0) {
                    return Err("product lines require a positive product id".into());
                }
                chargeable = chargeable
                    .checked_add(expected)
                    .ok_or("chargeable total is out of range")?;
            }
            LineKind::Custom => {
                if line.product_id.is_some() || line.description != "Sonstiger Artikel" {
                    return Err("invalid custom line".into());
                }
                chargeable = chargeable
                    .checked_add(expected)
                    .ok_or("chargeable total is out of range")?;
            }
            LineKind::Donation => {
                if line.product_id.is_some() || line.description != "Spende" || line.quantity != 1 {
                    return Err("invalid donation line".into());
                }
                donations = donations
                    .checked_add(expected)
                    .ok_or("donation total is out of range")?;
            }
        }
    }
    let due = chargeable
        .checked_add(donations)
        .ok_or("cash amount due is out of range")?;
    if chargeable != snapshot.chargeable_total_cents
        || donations != snapshot.donation_total_cents
        || due != snapshot.cash_amount_due_cents
    {
        return Err("invoice totals do not match the submitted lines".into());
    }
    Ok(())
}

pub fn validate_product(input: &ProductInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("product name is required".into());
    }
    if input.price_cents <= 0 {
        return Err("product price must be positive integer cents".into());
    }
    if input.position < 0 {
        return Err("product position cannot be negative".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(lines: Vec<InvoiceLine>, chargeable: i64, donations: i64) -> InvoiceSnapshot {
        InvoiceSnapshot {
            schema_version: 1,
            cart_uuid: Uuid::new_v4(),
            saved_at: Utc::now(),
            currency: "EUR".into(),
            lines,
            chargeable_total_cents: chargeable,
            donation_total_cents: donations,
            cash_amount_due_cents: chargeable + donations,
        }
    }

    #[test]
    fn donation_only_invoice_is_valid_and_empty_invoice_is_not() {
        let donation = InvoiceLine {
            kind: LineKind::Donation,
            product_id: None,
            description: "Spende".into(),
            unit_amount_cents: 200,
            quantity: 1,
            line_total_cents: 200,
        };
        assert!(validate_snapshot(&snapshot(vec![donation], 0, 200)).is_ok());
        assert!(validate_snapshot(&snapshot(vec![], 0, 0)).is_err());
    }

    #[test]
    fn rejects_invalid_quantities_and_inconsistent_totals() {
        let custom = InvoiceLine {
            kind: LineKind::Custom,
            product_id: None,
            description: "Sonstiger Artikel".into(),
            unit_amount_cents: 250,
            quantity: 0,
            line_total_cents: 0,
        };
        assert!(validate_snapshot(&snapshot(vec![custom], 0, 0)).is_err());
        let custom = InvoiceLine {
            kind: LineKind::Custom,
            product_id: None,
            description: "Sonstiger Artikel".into(),
            unit_amount_cents: 250,
            quantity: 1,
            line_total_cents: 250,
        };
        assert!(validate_snapshot(&snapshot(vec![custom], 249, 0)).is_err());
    }

    #[test]
    fn idempotency_accepts_identical_retries_and_rejects_changed_payloads() {
        let original = serde_json::json!({"cart_uuid": "one", "total": 500});
        let identical_retry = serde_json::json!({"cart_uuid": "one", "total": 500});
        let changed_retry = serde_json::json!({"cart_uuid": "one", "total": 600});
        assert!(idempotency_payload_matches(&original, &identical_retry));
        assert!(!idempotency_payload_matches(&original, &changed_retry));
    }
}
