# System Architecture

This document describes the production architecture of Attraction Football Commerce after the stock-aware variant checkout cutover. It is a technical companion to the project [README](../README.md) and the operational [variant checkout cutover runbook](variant-checkout-cutover.md).

## Architecture At A Glance

```text
Static HTML, CSS, and JavaScript on Netlify
                  |
                  v
          Supabase Auth session
                  |
        +---------+----------+
        |                    |
        v                    v
RLS-protected reads   Authenticated RPC calls
        |                    |
        +---------+----------+
                  |
                  v
 SECURITY DEFINER functions with empty search_path
                  |
                  v
       PostgreSQL atomic transactions
                  |
        +---------+----------+------------------+
        |                    |                  |
        v                    v                  v
 Orders and snapshots   Idempotency receipts   Inventory ledger
```

Netlify serves the static application. Supabase provides identity, PostgreSQL storage, RLS, and authenticated RPC execution. The frontend never receives elevated database credentials.

## Frontend Boundaries

The storefront is composed of individual HTML pages that share `styles.css` and `script.js`. `variant-checkout-production.js` sets the three coordinated production flags before `script.js` initializes:

```text
variantUi
variantCartV2
variantCheckoutV2
```

Together, these flags expose variant selection, variant-level cart behavior, and the V2 checkout caller. The admin dashboard is intentionally excluded from this storefront feature source.

The frontend is responsible for:

- Rendering product and variant choices
- Maintaining guest-only browser state where applicable
- Synchronizing authenticated cart and wishlist state through Supabase
- Collecting delivery information and COD confirmation
- Sending stable product and variant identifiers with quantities
- Displaying database-returned totals, order state, and inventory state
- Failing closed when immutable product or variant identity is unavailable

The frontend is not authoritative for prices, stock, ownership, order totals, or administrator authorization.

## Relational Model

### Catalogue And Inventory

`products` holds the 105 stable commerce products. Product IDs are immutable and are referenced explicitly by product cards through `data-product-id`.

`product_variants` holds 381 selectable options. Each variant has:

- UUID primary identity
- Immutable relationship to one product ID
- Human-readable variant label
- Unique SKU
- Non-negative stock quantity
- Low-stock threshold
- Active state
- Creation and update timestamps

Sized products have one row per size. Products without multiple sizes use a single option such as `One Size`, `Size 4`, or `Size 5`.

### Customer Collections

`variant_cart_items` stores authenticated V2 cart lines by user and variant. Product details and authoritative prices remain in catalogue tables rather than being duplicated as mutable cart metadata.

Authenticated wishlist records remain product-level. Guest cart and wishlist data remain browser-local and are migrated through controlled merge paths after authentication.

### Orders And Historical Snapshots

`orders` stores customer and delivery information, database-calculated total, order status, COD payment state, timestamps, cancellation audit fields, and inventory deduction/restoration timestamps.

`order_items` stores historical snapshots so prior purchases remain accurate after catalogue changes. Snapshot fields include:

- Product ID, name, category, image, and price
- Variant UUID, SKU, and label
- Quantity and line-level historical values

Historical display reads these stored snapshots instead of current catalogue prices.

### Idempotency And Audit Tables

`order_checkout_receipts_v2` is keyed by authenticated user and checkout UUID. It stores a normalized payload hash, linked order, completed result, and completion time. It allows an uncertain network retry to return the original committed result without creating another order or deducting stock again.

`inventory_movements` is the stock audit ledger. It records the variant, signed quantity delta, resulting quantity, movement type, associated order where applicable, administrator identity where applicable, reason, and timestamp.

`inventory_adjustment_receipts` protects administrator stock adjustments against duplicate retries and payload changes.

## Stock-Aware Checkout Transaction

Production checkout calls:

```text
public.place_order_v2(jsonb, jsonb, uuid)
```

The transaction proceeds as follows:

1. Require an authenticated Supabase user through `auth.uid()`.
2. Validate the shipping object and item array.
3. Normalize product ID, variant UUID, and quantity input.
4. Validate quantities and reject invalid or duplicate relationships.
5. Resolve an existing idempotency receipt or create the attempt receipt.
6. Lock required variant rows in deterministic product-and-variant order with `FOR UPDATE`.
7. Require active products and variants and validate every relationship.
8. Read authoritative product prices and verify sufficient variant stock.
9. Create the order with COD defaults and a database-calculated total.
10. Insert historical product and variant snapshots into `order_items`.
11. Deduct stock without allowing a negative result.
12. Insert one `Order Deduction` movement per ordered variant.
13. Set `orders.inventory_deducted_at`.
14. Mark the V2 receipt complete with the committed result.
15. Remove only accepted rows from the authenticated V2 cart.
16. Return the authoritative order ID, total, status, payment state, and inventory result.

Any validation, lock, insert, or deduction failure rolls back the whole transaction. A movement cannot commit without its order, and an order cannot commit with only part of its requested stock deducted.

## Concurrency And Idempotency

Two controls solve different failure modes:

**Row locking** serializes competing buyers for the same stock. If two customers request the final unit, the first transaction updates the locked row. The second transaction then sees the committed quantity and receives an insufficient-stock result rather than overselling.

**Idempotency receipts** identify one logical checkout attempt. The browser creates one UUID and reuses it after an unknown network outcome. A completed receipt returns its stored result. Reusing a UUID with a different normalized payload is rejected.

Administrator stock adjustments use a separate idempotency receipt. They also require the expected current quantity, so an administrator cannot silently overwrite stock changed by another checkout or adjustment after the modal was opened.

## Inventory States And Movements

The storefront receives only active products and active variants through the storefront variant RPC. An active zero-stock variant remains visible as `Out of Stock`; inactive records are hidden from customers but retained for administrators and audits.

Stock states are derived from quantity and threshold:

| Condition | State |
| --- | --- |
| Quantity equals zero | Out of Stock |
| Quantity is between one and the threshold | Low Stock |
| Quantity exceeds the threshold | In Stock |

The ledger movement types are:

- `Initial Stock`: prepared baseline seed
- `Admin Adjustment`: audited manual reconciliation
- `Order Deduction`: committed V2 purchase
- `Cancellation Restoration`: approved V2 cancellation

Database constraints prevent negative stock and invalid movement direction. Unique movement indexes prevent duplicate deduction or restoration records for the same order and variant.

## Cancellation And Restoration

Customers can submit one cancellation request per eligible order within the server-enforced 24-hour window. Administrators approve or reject the request through the review RPC.

For an approved V2 cancellation, PostgreSQL:

1. Locks the order and validates the pending request.
2. Confirms the order has V2 inventory deduction evidence.
3. Validates matching `Order Deduction` movements and order-item variant snapshots.
4. Locks the affected variants in deterministic order.
5. Restores each deducted quantity once.
6. Writes one `Cancellation Restoration` movement per variant.
7. Marks the order Cancelled and records `inventory_restored_at`.

`inventory_deducted_at` remains preserved as historical evidence. Pending and rejected requests do not restore stock. Unique indexes and order finality prevent duplicate approval from restoring inventory twice. Historical V1 orders without deduction evidence remain cancellable under their established workflow but do not receive inventory restoration.

## Administrator Inventory Management

Authorized administrators can inspect all 381 variants through paginated reads. The dashboard provides inventory totals, low/out-of-stock metrics, search, filters, sorting, desktop and mobile layouts, and recent movement history.

Stock mutation is restricted to:

```text
public.adjust_variant_stock(uuid, integer, integer, text, uuid)
```

The function requires:

- An authenticated administrator validated by `public.is_admin()`
- Variant UUID
- Signed integer adjustment
- Expected current stock quantity
- Meaningful reason
- Idempotency UUID

The function locks the variant, rejects stale expected stock, prevents negative results, writes the new quantity, creates one `Admin Adjustment` movement, and stores the replayable result. Direct table writes are not the supported administrator workflow.

## Security Model

### Identity And Authorization

Supabase Auth supplies the user UUID used by ownership checks. Customers do not send or choose their database owner ID. Administrator access is evaluated by `public.is_admin()` using the authenticated identity.

### RLS And RPC Boundaries

RLS protects customer and administrator reads. Browser roles do not receive direct order or inventory write privileges. Sensitive write workflows use reviewed PostgreSQL RPC functions that:

- Are `SECURITY DEFINER`
- Set `search_path = ''`
- Schema-qualify tables, functions, and operators
- Derive ownership from `auth.uid()`
- Validate administrator access inside the transaction
- Revoke execution from anon and PUBLIC
- Grant only the required authenticated entry points

Production authenticated checkout uses `place_order_v2`; legacy `place_order` execution is disabled. No service-role key, password, private key, or user session token is required in frontend source.

### Auditability

Orders preserve product and variant snapshots. Checkout and adjustment receipts preserve logical request identity. Inventory movements preserve each stock transition. Cancellation timestamps preserve deduction and restoration history rather than rewriting it.

## Production Cutover Record

The V2 rollout followed three controlled stages:

| Stage | Result |
| --- | --- |
| Stage 1 | Enabled authenticated V2 execution while keeping V1 available for rollback |
| Stage 2 | Activated all three frontend flags on all storefront pages |
| Controlled validation | Completed one quantity-one COD order and verified receipt, snapshots, deduction, customer view, and admin view |
| Cancellation validation | Approved the controlled request and verified one-time restoration |
| Stage 3 | Disabled authenticated V1 checkout and retained authenticated V2 checkout |

The controlled order reduced one selected variant from 10 to 9, created one completed V2 receipt and one `Order Deduction` movement with delta `-1`, then restored the variant from 9 to 10 with one `Cancellation Restoration` movement with delta `+1`. Total stock returned to 3810. Anonymous and PUBLIC checkout execution remained blocked.

No customer identity, delivery details, order UUID, user UUID, or authentication credential is recorded in this documentation.

## Failure And Rollback Principles

- A checkout validation failure leaves the order, stock, receipt completion, and cart unchanged.
- An unknown checkout response retries with the same idempotency UUID.
- An inventory adjustment conflict reloads authoritative stock before another attempt.
- A cancellation restoration failure rolls back cancellation approval and every stock change.
- Feature activation and database execution privileges are separate rollback controls.
- Operators must use the reviewed cutover runbook before changing production checkout privileges.
- Applied migrations are historical records and should not be edited in place.

## Verification Strategy

Automated Playwright coverage validates responsive and security-sensitive browser behavior with controlled Supabase stubs. Database migrations include static preconditions and postconditions for expected schemas, constraints, indexes, privileges, and data-neutral execution where required.

Production rollout verification separately checks deployed assets, feature flags, RPC selection, controlled order linkage, stock movement evidence, cancellation restoration, and legacy checkout shutdown.
