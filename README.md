# Attraction Football Commerce

Attraction Football Commerce is a production-style football e-commerce platform built with plain HTML, CSS, and JavaScript. It combines a responsive storefront with Supabase authentication, cross-device customer data, transactional order processing, variant-level inventory, customer order history, and administrator tooling.

- Production: [attraction-football-commerce.netlify.app](https://attraction-football-commerce.netlify.app/)
- Repository: [github.com/abhishek15ghosh/Attraction-football-commerce](https://github.com/abhishek15ghosh/Attraction-football-commerce)
- Architecture: [docs/architecture.md](docs/architecture.md)
- Checkout cutover runbook: [docs/variant-checkout-cutover.md](docs/variant-checkout-cutover.md)

## Platform Overview

The current production system includes:

- Responsive desktop and mobile storefront pages
- Football shoes, jerseys, T-shirts, footballs, and accessories
- 105 products with immutable commerce IDs
- 381 product variants with unique SKUs
- Supabase Auth registration, login, logout, and persistent sessions
- Cross-device authenticated cart and wishlist synchronization
- Customer My Orders history with read-only order details
- Cash on Delivery checkout
- Stock-aware, variant-level order processing
- Customer cancellation requests with administrator approval
- One-time stock restoration for approved V2 cancellations
- Administrator order, payment, cancellation, and inventory management
- Audited inventory adjustments and movement history
- Playwright browser coverage across desktop and mobile behavior
- Static deployment through Netlify

## Technology Stack

| Layer | Technology |
| --- | --- |
| Frontend | HTML, CSS, JavaScript |
| Authentication | Supabase Auth |
| Database | PostgreSQL through Supabase |
| Data access | Supabase browser client, RLS-protected reads, versioned RPC functions |
| Authorization | Supabase Auth, Row Level Security, `public.is_admin()` |
| Hosting | Netlify |
| Testing | Playwright with Node.js tooling |

No frontend framework, custom password database, or server-side application framework is used.

## Production Architecture

```text
Browser storefront
  -> Supabase Auth session
  -> RLS-protected reads and authenticated RPC calls
  -> SECURITY DEFINER PostgreSQL functions
  -> atomic database transactions
  -> orders, idempotency receipts, variant stock, and inventory ledger
```

The browser handles presentation and submits identifiers and quantities. PostgreSQL remains authoritative for customer ownership, product prices, variant relationships, stock, order totals, order creation, and inventory movements.

See [System Architecture](docs/architecture.md) for the complete data model, checkout transaction, security controls, inventory lifecycle, and production cutover record.

## Core Data Model

| Relation | Responsibility |
| --- | --- |
| `products` | Immutable product identity, catalogue snapshots, price, category, image, and active state |
| `product_variants` | Variant UUID, product relationship, label, SKU, stock, threshold, and active state |
| `variant_cart_items` | Authenticated customer's variant-level cart lines |
| `orders` | Customer, delivery, COD, status, cancellation, and inventory audit fields |
| `order_items` | Historical product and variant snapshots for each order |
| `order_checkout_receipts_v2` | Idempotency key, normalized request, linked order, and completed result |
| `inventory_movements` | Append-only stock movement history |
| `inventory_adjustment_receipts` | Idempotent administrator adjustment receipts |

## Secure Variant Checkout

Production uses `public.place_order_v2(jsonb, jsonb, uuid)`. The legacy product-level `place_order` execution path is disabled for browser users.

1. The customer signs in and selects a product variant.
2. The V2 cart stores the product ID, variant UUID, and quantity.
3. Checkout reloads authoritative cart data from Supabase.
4. The browser submits product ID, variant ID, quantity, shipping details, and an idempotency UUID.
5. PostgreSQL validates ownership, active catalogue records, product-variant relationships, and quantities.
6. Variant stock rows are locked in deterministic order.
7. Prices and totals are derived from authoritative product records.
8. The order and historical order-item snapshots are created atomically.
9. Stock is deducted and one `Order Deduction` movement is written per ordered variant.
10. The completed idempotency result is stored and accepted V2 cart rows are removed server-side.
11. The database result supplies the final order total and payment information.

The browser does not directly insert orders, calculate authoritative prices, or update stock.

## Inventory Lifecycle

Inventory is held per product variant. Each variant has a stable UUID, unique SKU, non-negative stock quantity, low-stock threshold, and active state. Inactive records remain available to administrators for audit and reconciliation while the storefront excludes them from purchasable results.

The movement ledger recognizes four stock events:

| Movement | Purpose |
| --- | --- |
| `Initial Stock` | Records the prepared opening quantity for each variant |
| `Admin Adjustment` | Records a reasoned positive or negative administrator correction |
| `Order Deduction` | Records stock removed by a committed V2 order |
| `Cancellation Restoration` | Restores stock once after an eligible V2 cancellation is approved |

Browser roles cannot write inventory tables directly. Administrators adjust stock only through `adjust_variant_stock`, which validates authorization, expected stock, quantity bounds, the reason, and idempotency.

## Authentication And Security

- Supabase Auth manages user identities and sessions.
- Passwords and Supabase sessions are not manually stored by application code.
- RLS limits customer reads to owned records and administrator reads to authorized users.
- Browser checkout execution is restricted to authenticated `place_order_v2` calls.
- Anonymous and PUBLIC checkout execution is blocked.
- Legacy `place_order` execution is disabled for authenticated browser users.
- Administrator authorization is derived from `auth.uid()` through `public.is_admin()`.
- Sensitive RPC functions are `SECURITY DEFINER` functions with an empty `search_path`.
- Direct browser writes to orders and inventory tables are not permitted.
- No service-role key is exposed in frontend code.
- Historical order snapshots, checkout receipts, and inventory movements are preserved for auditability.

Only the Supabase project URL and public publishable/anon key belong in the static frontend. Never add a service-role key, database password, private key, or user token.

## Administrator Capabilities

The private `admin.html` dashboard provides:

- Orders and Inventory workspaces
- Order, payment, and cancellation review controls backed by RPC functions
- Inventory metrics and low/out-of-stock visibility
- Search by product name, product ID, SKU, or variant
- Category, stock-state, and active-state filters
- Desktop inventory table and responsive mobile cards
- Paginated loading for the full variant catalogue
- Recent movement history
- Positive and negative stock adjustments with a required reason
- Expected-stock conflict detection and idempotent retries

Administrators should use this dashboard instead of editing database rows manually.

## Production Cutover

The stock-aware checkout was introduced through a controlled three-stage rollout:

1. Stage 1 granted authenticated execution on V2 while retaining V1 temporarily.
2. Stage 2 activated `variantUi`, `variantCartV2`, and `variantCheckoutV2` together on all storefront pages.
3. A controlled quantity-one COD order verified the V2 receipt, order snapshots, and a stock change from 10 to 9.
4. Approved cancellation verified one restoration movement and returned the selected variant from 9 to 10.
5. Total inventory returned to the reconciled 3810-unit baseline.
6. Stage 3 disabled authenticated legacy V1 checkout while preserving authenticated V2 execution.

Anonymous and PUBLIC checkout access remained blocked throughout. The controlled validation did not add customer identity or delivery information to repository documentation.

## Testing

The complete Playwright suite passed **156/156** during the reviewed Stage 2 activation validation.

Coverage includes:

- Responsive header, navigation, drawers, modals, and overflow behavior
- Authentication UI and account switching isolation
- Cart and wishlist behavior
- V1/V2 feature and storage isolation
- Immutable product IDs and variant selectors
- Variant-aware checkout payload and result handling
- Duplicate submission and idempotency behavior
- Invalid and malformed quantities
- Unavailable and insufficient-stock handling
- My Orders and administrator order rendering
- Admin inventory loading, filtering, adjustment, and stale-stock protection
- Customer cancellation and one-time stock restoration behavior
- Safe rendering of hostile database text
- Production activation coverage

## Local Development

Requirements:

- Node.js with npm
- Python 3 for the local static server
- A Supabase project configured with the repository migrations

```bash
git clone https://github.com/abhishek15ghosh/Attraction-football-commerce.git
cd Attraction-football-commerce
npm install
```

This is a static browser application without a bundler-based environment injection step. Configure the Supabase browser client near the top of `script.js` according to the existing repository convention, using only the project URL and public publishable/anon key.

Start the site:

```bash
python3 -m http.server 4174 --bind 127.0.0.1
```

Open `http://127.0.0.1:4174/`.

Run the browser suite from the repository root:

```bash
npm run test:playwright
```

Playwright starts its own port-4174 static server when `PLAYWRIGHT_BASE_URL` is not set. To test another running deployment:

```bash
PLAYWRIGHT_BASE_URL=https://example.test npm run test:playwright
```

## Project Structure

```text
.
|-- index.html                         Storefront home
|-- products.html                     All products
|-- football-shoes.html               Category page
|-- jerseys.html                      Category page
|-- t-shirts.html                     Category page
|-- footballs.html                    Category page
|-- accessories.html                  Category page
|-- wishlist.html                     Customer wishlist
|-- my-orders.html                    Customer order history
|-- admin.html                        Private administrator dashboard
|-- script.js                         Storefront, auth, cart, checkout, and admin behavior
|-- styles.css                        Shared responsive design system
|-- variant-checkout-production.js    Production variant feature activation
|-- supabase/
|   |-- migrations/                   Reviewed database schema and RPC migrations
|   `-- seeds/                        Versioned inventory variant seed data
|-- tests/                            Playwright browser tests and fixtures
`-- docs/                             Architecture and controlled-cutover documentation
```

## Portfolio Value

This project demonstrates practical frontend development and production-oriented backend design without hiding core behavior behind a framework. Engineering areas include relational modelling, transactional checkout, deterministic concurrency control, idempotency, RLS authorization, immutable identifiers, audit logging, variant inventory, reconciliation, migration preconditions, automated browser testing, and controlled deployment with explicit rollback planning.

## Operational Notes

- Apply migrations in version order and review each migration before execution.
- Never rerun a production migration casually or edit an already applied migration.
- Reconcile stock before any inventory-policy change.
- Keep checkout, cancellation, and inventory writes on their approved RPC paths.
- Use [docs/variant-checkout-cutover.md](docs/variant-checkout-cutover.md) for the reviewed rollout and rollback gates.
