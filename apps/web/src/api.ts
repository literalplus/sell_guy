import type { InvoiceSnapshot, Product, ProductInput, RuntimeConfig } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init?.headers },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { message = (await response.json() as { error?: string }).error ?? message; } catch { /* response may not be JSON */ }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  runtimeConfig: () => request<RuntimeConfig>('/runtime-config'),
  products: (token: string) => request<Product[]>('/products', token),
  createProduct: (token: string, product: ProductInput) => request<Product>('/products', token, { method: 'POST', body: JSON.stringify(product) }),
  updateProduct: (token: string, id: number, product: ProductInput) => request<Product>(`/products/${id}`, token, { method: 'PUT', body: JSON.stringify(product) }),
  submitInvoice: (token: string, snapshot: InvoiceSnapshot) => request<{ invoice_id: string; received_at: string; created: boolean }>('/invoices', token, { method: 'POST', body: JSON.stringify(snapshot) }),
};
