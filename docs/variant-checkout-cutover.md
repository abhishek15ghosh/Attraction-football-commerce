# Variant Checkout Controlled Cutover

This runbook controls the Phase 2C transition from the stock-neutral V1
checkout to the stock-aware variant V2 checkout. It does not authorize an
operator to skip a stage. Record every verification result in the deployment
ticket before proceeding.

## Immutable Contracts

### Checkout RPCs

V1 legacy checkout:

```text
public.place_order(text,text,text,text,text,text,text,jsonb,uuid)
```

Parameters, in order: customer name, phone, address, city, state, PIN code,
note, product-level items, and checkout token. It returns order ID, database
total, order status, payment method, and payment status. The frontend caller is
`handleCheckoutSubmit()` in `script.js`.

V2 stock-aware checkout:

```text
public.place_order_v2(jsonb,jsonb,uuid)
```

Parameters: variant items, shipping details, and idempotency key. It returns
order ID, database total, order status, payment method, payment status,
inventory deduction time, item count, and idempotent replay state. The frontend
caller is `handleVariantCheckoutSubmit()` in `script.js`.

Both repository definitions are PL/pgSQL `SECURITY DEFINER` functions with an
empty `search_path`. They were created through the Supabase SQL Editor without
an explicit `ALTER OWNER`; the cutover migrations therefore fail unless both
remain owned by `postgres`. Confirm the live owner with the preflight query.

Current repository ACL intent:

- V1: authenticated `EXECUTE`; anon and PUBLIC denied.
- V2 before Stage 1: authenticated, anon, and PUBLIC denied.
- V2 after Stage 1: authenticated `EXECUTE`; anon and PUBLIC denied.
- V1 after Stage 3: authenticated, anon, and PUBLIC denied; owner access remains.

No other `public.place_order` overload exists in repository SQL. Cancellation,
order-status, payment-status, and audited inventory RPCs are not modified by
either cutover migration.

### Frontend Feature Source

`variant-checkout-production.js` is the single staged production source of
truth. It enables these three flags atomically:

```js
{
  variantUi: true,
  variantCartV2: true,
  variantCheckoutV2: true
}
```

The file preserves a pre-existing `window.__ATTRACTION_FEATURES__` object so
Playwright and emergency rollback tests can force all flags off with
`page.addInitScript`.

The repository is a static site with no `netlify.toml`, build pipeline, or
environment-value injection. During preparation, no HTML loads the file, so
production remains off. During Stage 2, add the following tag immediately
before each existing `script.js` tag:

```html
<script src="variant-checkout-production.js"></script>
```

Apply that same ordering to these 18 storefront pages:

```text
about.html
accessories.html
careers.html
contact.html
cookies.html
faqs.html
football-shoes.html
footballs.html
index.html
jerseys.html
my-orders.html
privacy-policy.html
products.html
returns-exchanges.html
shipping-delivery.html
t-shirts.html
terms-conditions.html
wishlist.html
```

Do not add the source to `admin.html`. Do not activate through a URL, query
parameter, local storage, a cookie, or a Supabase secret. Review all 18 changes
as one atomic frontend deployment; never deploy a mixed three-flag state.

## Stage 0: Preflight

1. Complete the static review of the dormant package and record its result.
2. Run every read-only Supabase preflight query in this runbook.
3. Confirm the release worktree contains only the reviewed dormant-package files.
4. Confirm `http://127.0.0.1:4174/` serves this repository, not another copy.
5. Confirm no Netlify deployment is pending.
6. Record the current variant count, stock total, order count, receipt count,
   cart counts, and movement counts/fingerprints.
7. Expected prepared baseline is 381 variants and 3810 units. A different stock
   total is permitted only when reconciled, explained, and approved because
   real admin adjustments may have changed the opening demo total.
8. Confirm authenticated V2 execution is false, authenticated V1 execution is
   true, and anon/PUBLIC execution is false for both.
9. Confirm no production HTML references `variant-checkout-production.js` and
   all three runtime flags are false/absent.
10. Pause checkout briefly before final inventory reconciliation. Reconcile
   physical/test stock and any orders placed since the Phase 1 baseline.

**STOP — DO NOT APPLY STAGE 1** when any owner, function definition, privilege,
constraint, index, RLS setting, count, or data fingerprint differs from the
reviewed contract. Resolve and review the difference before continuing.

## Dormant Package Commit

After static review and read-only preflight pass, commit and push the complete
reviewed dormant Phase 2C package before applying either database migration:

- `variant-checkout-production.js`
- `supabase/migrations/20260719_enable_variant_checkout_v2.sql`
- `supabase/migrations/20260719_disable_legacy_checkout.sql`
- `docs/variant-checkout-cutover.md`
- `tests/mobile-header.spec.js`
- `playwright.config.js`

Confirm Git is clean and synchronized with the remote repository. This dormant
package commit does not activate frontend flags because no HTML page loads the
feature source. Do not apply Stage 1 from an uncommitted or modified migration.

## Stage 1: Enable V2 Permission

Run only:

```text
supabase/migrations/20260719_enable_variant_checkout_v2.sql
```

The migration grants authenticated V2 execution and leaves V1 available. It
does not call checkout or change data. After it commits, verify:

- authenticated V2: true
- anon and PUBLIC V2: false
- authenticated V1: true
- variant count and stock unchanged
- orders and order items unchanged
- V1 and V2 carts unchanged
- receipts and movement ledger unchanged
- stored fingerprints unchanged

If any check fails, stop. Do not deploy the frontend and do not run Stage 3.

## Stage 2: Deploy the Frontend

1. Add `variant-checkout-production.js` before `script.js` on all 18 listed
   storefront pages in one reviewed change. Leave `admin.html` unchanged.
2. Test the Stage 2 activation locally at port 4174 and run the complete
   Playwright suite with the Supabase stub.
3. Commit and push a separate Stage 2 change containing only the reviewed 18
   storefront script-tag insertions and directly related activation tests.
4. Wait for Netlify to finish. Do not run Stage 3 while deployment is pending.
5. In the deployed browser, confirm all three flags are true and the checkout
   request uses `place_order_v2`, never `place_order`.
6. Confirm variant selection, V2 cart, checkout, My Orders, and admin views have
   no console errors or horizontal overflow.

The V1 database grant remains available during this window, but the frontend
must expose only V2. Do not leave both frontend modes active.

## Stage 2 Verification: Controlled Real Order

Use one approved test customer and one chosen active variant. Do not use a
customer's production order. Record these values in the deployment ticket
without recording a password, access token, refresh token, or service-role key:

- test customer account identifier
- authenticated test user UUID
- selected `product_id`
- selected `product_variant_id`
- selected `sku`
- selected `variant_label`
- current `stock_quantity`
- current total order count
- current completed V2 receipt count
- current Order Deduction movement count
- current Cancellation Restoration movement count
- matching V2 cart row count
- current order-item count
- the V2 idempotency key used for this single logical attempt

Place one COD V2 order with quantity 1. Every item below is a mandatory Stage 3
gate:

- exactly one new order exists
- exactly one completed V2 receipt was created for the recorded test user and
  idempotency key
- that receipt's `order_id` is the exact new order ID
- no second order is linked to the same logical attempt
- the new order-item count equals the submitted item count
- selected variant stock decreased by exactly 1
- exactly one new Order Deduction movement exists
- the deduction references the exact new `order_id` and `product_variant_id`
- deduction `quantity_delta` is exactly -1
- deduction `resulting_stock_quantity` equals
  `product_variants.stock_quantity`
- `orders.inventory_deducted_at` is populated
- `orders.inventory_restored_at` remains NULL before cancellation
- each `order_items` snapshot is correct for `product_id`,
  `product_variant_id`, `product_name`, `product_category`, `product_image`,
  `product_price`, `quantity`, `variant_sku`, and `variant_label`
- the derived line subtotal, `product_price * quantity`, is correct; the schema
  has no separate stored line-subtotal column
- the server total displayed by checkout equals `orders.total_amount`
- only the test customer's submitted `variant_cart_items` rows were removed by
  the database function
- all V1 `cart_items` rows remain unchanged
- confirmation displays the server total and variant label
- My Orders displays the variant label
- admin order details display the variant SKU and label

Replay the exact idempotency key and normalized payload. Confirm the original
order result is returned/displayed, total order count does not increase, no
second completed receipt points to a different order, stock does not decrease,
and the Order Deduction movement count does not increase.

Request cancellation from the test customer and approve it once as admin. Every
item below is also a mandatory Stage 3 gate:

- `cancellation_request_status` is Approved and order `status` is Cancelled
- `inventory_deducted_at` remains populated and unchanged
- `inventory_restored_at` becomes populated exactly once
- selected variant stock increases exactly by 1 from its post-order value
- final stock equals the recorded pre-order quantity when no unrelated audited
  adjustment occurred
- exactly one new Cancellation Restoration movement exists
- the restoration references the exact `order_id` and `product_variant_id`
- restoration `quantity_delta` is exactly +1
- restoration `resulting_stock_quantity` equals
  `product_variants.stock_quantity`
- the original Order Deduction movement remains present
- repeated approval/review creates no additional restoration, does not change
  `inventory_restored_at`, and does not increase stock again

Run the historical V1 integrity query in section D and inspect the deployed
`review_order_cancellation(uuid,text,text)` definition. Confirm restoration
requires V2 deduction evidence. Do not mutate or re-approve a historical V1
order for testing.

Do not continue to Stage 3 if any order, receipt, idempotency, snapshot,
deduction, cancellation, restoration, or historical V1 integrity gate fails.

## Stage 3: Disable Legacy Checkout

Run only:

```text
supabase/migrations/20260719_disable_legacy_checkout.sql
```

Apply only after Stage 2 deployment and controlled verification succeed. After
commit, verify:

- authenticated V2: true
- authenticated V1: false
- anon and PUBLIC V1/V2: false
- protected cancellation, status, payment, and inventory RPC ACLs unchanged
- stock, variants, orders, order items, carts, receipts, and movements unchanged
- stored fingerprints unchanged

## Final Smoke Test

Check both `http://127.0.0.1:4174/` and the deployed Netlify URL:

- homepage and product pages
- variant selection and availability
- V2 cart mutations and cross-session loading
- V2 COD checkout
- My Orders variant and payment details
- cancellation request and admin approval
- admin Inventory and Orders tabs
- desktop and mobile navigation
- no horizontal overflow
- no console errors
- no V1 checkout request

## Failure and Rollback

### A. Failure Before Stage 1

Make no database privilege change. Keep the V1 frontend and database path
active, fix or discard the dormant package, and leave production unchanged.
Do not apply Stage 1, Stage 2, or Stage 3.

Never reset stock to 3810, delete a valid V2 order, delete a V2 receipt, delete
an inventory movement, or directly repair `product_variants`. Every stock
correction must call the audited `public.adjust_variant_stock(...)` RPC with a
documented reason.

### B. Failure After Stage 1 but Before Stage 2 Frontend Deployment

V1 remains active and the dormant frontend source remains unloaded. Do not
apply Stage 3. Authenticated V2 execution may be revoked with this reviewed
transaction after confirming no V2 request is in flight:

```sql
begin;
revoke all on function public.place_order_v2(jsonb, jsonb, uuid)
from public, anon, authenticated;
commit;
```

Never reset stock to 3810, delete a valid V2 order, delete a V2 receipt, delete
an inventory movement, or directly repair `product_variants`. Every stock
correction must call the audited `public.adjust_variant_stock(...)` RPC with a
documented reason.

### C. Stage 2 Deployment Failure

Roll Netlify back to the previous HTML deployment. V1 remains available because
Stage 3 was not applied. Do not apply Stage 3. V2 permission may remain
temporarily or be revoked with the transaction in scenario B after confirming
no V2 request is in flight.

Never reset stock to 3810, delete a valid V2 order, delete a V2 receipt, delete
an inventory movement, or directly repair `product_variants`. Every stock
correction must call the audited `public.adjust_variant_stock(...)` RPC with a
documented reason.

### D. V2 Functional Failure After Stage 2 but Before Stage 3

Deploy a reviewed rollback that removes the production feature-source tags so
all three flags are off and frontend behavior returns to V1. Preserve all V2
orders, receipts, movements, and stock history. Never directly update
`product_variants` or directly insert/delete `inventory_movements`. Reconcile a
stock discrepancy only through `public.adjust_variant_stock(...)` with the
current expected stock, a UUID idempotency key, and a documented reason. Do not
apply Stage 3.

Never reset stock to 3810, delete a valid V2 order, delete a V2 receipt, delete
an inventory movement, or directly repair `product_variants`. Every stock
correction must call the audited `public.adjust_variant_stock(...)` RPC with a
documented reason.

### E. Failure After Stage 3

1. Deploy a reviewed frontend rollback so all three V2 flags are off.
2. Confirm no V2 checkout request is in flight.
3. Restore authenticated V1 only:

```sql
begin;
revoke all on function public.place_order(
  text, text, text, text, text, text, text, jsonb, uuid
) from public, anon;
grant execute on function public.place_order(
  text, text, text, text, text, text, text, jsonb, uuid
) to authenticated;
commit;
```

Never expose V1 to anon/PUBLIC or enable V1 and V2 frontend checkout modes
simultaneously. Preserve all orders, receipts, and movements, investigate the
failure, and repeat the complete controlled cutover before disabling V1 again.

Never reset stock to 3810, delete a valid V2 order, delete a V2 receipt, delete
an inventory movement, or directly repair `product_variants`. Every stock
correction must call the audited `public.adjust_variant_stock(...)` RPC with a
documented reason.

## Read-Only Verification Queries

All blocks below are read-only. They use no service-role secret.

### A. Preflight

```sql
with target(signature) as (
  values
    ('public.place_order(text,text,text,text,text,text,text,jsonb,uuid)'),
    ('public.place_order_v2(jsonb,jsonb,uuid)'),
    ('public.request_order_cancellation(uuid,text)'),
    ('public.review_order_cancellation(uuid,text,text)'),
    ('public.update_order_status(uuid,text)'),
    ('public.update_order_payment_status(uuid,text)'),
    ('public.adjust_variant_stock(uuid,integer,integer,text,uuid)')
)
select
  target.signature,
  proc.oid::regprocedure as resolved_signature,
  owner_role.rolname as owner,
  language.lanname as language,
  proc.prosecdef as security_definer,
  proc.proconfig as function_config,
  pg_catalog.has_function_privilege(
    'authenticated', proc.oid, 'EXECUTE'
  ) as authenticated_execute,
  pg_catalog.has_function_privilege(
    'anon', proc.oid, 'EXECUTE'
  ) as anon_execute,
  exists (
    select 1
    from pg_catalog.aclexplode(
      coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
    ) as acl
    where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  ) as public_execute
from target
left join pg_catalog.pg_proc as proc
  on proc.oid = pg_catalog.to_regprocedure(target.signature)
left join pg_catalog.pg_roles as owner_role on owner_role.oid = proc.proowner
left join pg_catalog.pg_language as language on language.oid = proc.prolang
order by target.signature;

select
  (select count(*) from public.product_variants) as variant_count,
  (select coalesce(sum(stock_quantity), 0) from public.product_variants) as total_stock,
  (select count(*) from public.orders) as order_count,
  (select count(*) from public.order_items) as order_item_count,
  (select count(*) from public.cart_items) as v1_cart_count,
  (select count(*) from public.variant_cart_items) as v2_cart_count,
  (select count(*) from public.order_checkout_receipts_v2) as v2_receipt_count;

select movement_type, count(*) as movement_count,
       coalesce(sum(quantity_delta), 0) as quantity_delta_total
from public.inventory_movements
group by movement_type
order by movement_type;

select cls.relrowsecurity as receipt_rls
from pg_catalog.pg_class as cls
where cls.oid = 'public.order_checkout_receipts_v2'::regclass;

select
  con.conrelid::regclass as table_name,
  con.conname,
  con.contype,
  con.convalidated,
  (
    select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
    from pg_catalog.unnest(con.conkey)
      with ordinality as key_column(attnum, ordinality)
    join pg_catalog.pg_attribute as attribute
      on attribute.attrelid = con.conrelid
     and attribute.attnum = key_column.attnum
  ) as local_columns,
  case when con.contype = 'f' then con.confrelid::regclass end as referenced_table,
  case when con.contype = 'f' then (
    select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
    from pg_catalog.unnest(con.confkey)
      with ordinality as key_column(attnum, ordinality)
    join pg_catalog.pg_attribute as attribute
      on attribute.attrelid = con.confrelid
     and attribute.attnum = key_column.attnum
  ) end as referenced_columns,
  case when con.contype = 'f' then con.confupdtype end as update_action,
  case when con.contype = 'f' then con.confdeltype end as delete_action,
  pg_catalog.pg_get_constraintdef(con.oid) as definition
from pg_catalog.pg_constraint as con
where con.conrelid in (
  'public.order_checkout_receipts_v2'::regclass,
  'public.order_items'::regclass,
  'public.product_variants'::regclass
)
and (
  con.conrelid = 'public.order_checkout_receipts_v2'::regclass
  or con.conname = 'order_items_variant_product_fkey'
  or con.conname = 'product_variants_stock_quantity_check'
)
order by con.conrelid::regclass::text, con.conname;

select
  index_definition.indexrelid::regclass as index_name,
  index_definition.indisunique,
  index_definition.indisvalid,
  index_definition.indisready,
  index_definition.indnkeyatts,
  index_definition.indnatts,
  (
    select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
    from pg_catalog.unnest(index_definition.indkey)
      with ordinality as key_column(attnum, ordinality)
    join pg_catalog.pg_attribute as attribute
      on attribute.attrelid = index_definition.indrelid
     and attribute.attnum = key_column.attnum
    where key_column.ordinality <= index_definition.indnkeyatts
  ) as indexed_columns,
  pg_catalog.pg_get_expr(
    index_definition.indpred,
    index_definition.indrelid
  ) as predicate
from pg_catalog.pg_index as index_definition
where index_definition.indrelid = 'public.inventory_movements'::regclass
  and index_definition.indpred is not null
  and pg_catalog.pg_get_expr(
    index_definition.indpred,
    index_definition.indrelid
  ) ilike any (array[
    '%Order Deduction%',
    '%Cancellation Restoration%'
  ])
order by index_definition.indexrelid::regclass::text;
```

The receipt output must show the exact composite identity, ownership/order
foreign keys, SHA-256, JSON-object, and completion constraints documented in the
applied V2 migration. The order-item composite foreign key, exact nonnegative
stock CHECK, and both unique/valid/ready movement indexes must match Stage 1's
structural checks. **STOP — DO NOT APPLY STAGE 1** if any row, owner,
definition, privilege, validation state, column order, foreign-key action, index
predicate, or index state differs from the reviewed contract.

Record a deterministic application fingerprint before each privilege migration:

```sql
select pg_catalog.encode(
  extensions.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'variants', coalesce(
          (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v) order by v.id)
           from public.product_variants as v), '[]'::jsonb
        ),
        'movements', coalesce(
          (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) order by m.id)
           from public.inventory_movements as m), '[]'::jsonb
        ),
        'orders', coalesce(
          (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.id)
           from public.orders as o), '[]'::jsonb
        ),
        'order_items', coalesce(
          (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) order by i.id)
           from public.order_items as i), '[]'::jsonb
        ),
        'v1_cart', coalesce(
          (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c)
                   order by c.user_id, c.product_id)
           from public.cart_items as c), '[]'::jsonb
        ),
        'v2_cart', coalesce(
          (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(vc) order by vc.id)
           from public.variant_cart_items as vc), '[]'::jsonb
        ),
        'receipts', coalesce(
          (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)
                   order by r.user_id, r.idempotency_key)
           from public.order_checkout_receipts_v2 as r), '[]'::jsonb
        )
      )::text,
      'UTF8'
    ),
    'sha256'
  ),
  'hex'
) as commerce_fingerprint;
```

### B. After Stage 1

```sql
select
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.place_order_v2(jsonb,jsonb,uuid)',
    'EXECUTE'
  ) as authenticated_v2,
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.place_order(text,text,text,text,text,text,text,jsonb,uuid)',
    'EXECUTE'
  ) as authenticated_v1,
  pg_catalog.has_function_privilege(
    'anon', 'public.place_order_v2(jsonb,jsonb,uuid)', 'EXECUTE'
  ) as anon_v2;
```

Re-run the counts, movement summary, and commerce fingerprint from section A;
compare them exactly with the recorded pre-Stage-1 values.

### C. Controlled V2 Order

Record the non-secret test account identifier separately. Replace the four UUID
placeholders below with the authenticated test user, selected variant, V2
idempotency key, and resulting order. Run the baseline queries before checkout,
then repeat them after checkout and after the exact idempotent replay.

```sql
with params as (
  select
    'PASTE_VARIANT_UUID'::uuid as variant_id,
    'PASTE_CUSTOMER_UUID'::uuid as customer_id,
    'PASTE_IDEMPOTENCY_UUID'::uuid as idempotency_key,
    'PASTE_ORDER_UUID'::uuid as order_id
)
select
  params.customer_id as authenticated_test_user_id,
  variant.product_id,
  variant.id as product_variant_id,
  variant.sku,
  variant.variant_label,
  variant.stock_quantity,
  variant.is_active,
  (select count(*) from public.orders) as order_count,
  (select count(*) from public.order_items) as order_item_count,
  (select count(*) from public.order_checkout_receipts_v2
   where completed_at is not null) as completed_receipt_count,
  (select count(*) from public.inventory_movements
   where movement_type = 'Order Deduction') as deduction_count,
  (select count(*) from public.inventory_movements
   where movement_type = 'Cancellation Restoration') as restoration_count,
  (select count(*) from public.variant_cart_items as cart_line
   where cart_line.user_id = params.customer_id
     and cart_line.product_variant_id = params.variant_id) as matching_v2_cart_rows
from public.product_variants as variant
cross join params
where variant.id = params.variant_id;

with params as (
  select
    'PASTE_CUSTOMER_UUID'::uuid as customer_id,
    'PASTE_IDEMPOTENCY_UUID'::uuid as idempotency_key,
    'PASTE_ORDER_UUID'::uuid as order_id
)
select
  receipt.user_id,
  receipt.idempotency_key,
  receipt.order_id,
  receipt.completed_at,
  receipt.payload_hash,
  receipt.normalized_payload,
  receipt.result_payload,
  (receipt.order_id = params.order_id) as linked_to_expected_order
from public.order_checkout_receipts_v2 as receipt
cross join params
where receipt.user_id = params.customer_id
  and receipt.idempotency_key = params.idempotency_key
  and receipt.completed_at is not null;

with params as (select 'PASTE_ORDER_UUID'::uuid as order_id)
select
  customer_order.id,
  customer_order.status,
  customer_order.total_amount,
  customer_order.inventory_deducted_at,
  customer_order.inventory_restored_at,
  item.product_id,
  item.product_variant_id,
  item.product_name,
  item.product_category,
  item.product_image,
  item.product_price,
  item.quantity,
  item.product_price * item.quantity as derived_line_subtotal,
  item.variant_sku,
  item.variant_label
from public.orders as customer_order
join public.order_items as item on item.order_id = customer_order.id
join params on params.order_id = customer_order.id
order by item.id;

with params as (select 'PASTE_ORDER_UUID'::uuid as order_id)
select movement.product_variant_id, movement.quantity_delta,
       movement.resulting_stock_quantity, movement.created_at
from public.inventory_movements as movement, params
where movement.order_id = params.order_id
  and movement.movement_type = 'Order Deduction'
order by movement.product_variant_id;

with params as (
  select
    'PASTE_CUSTOMER_UUID'::uuid as customer_id,
    'PASTE_VARIANT_UUID'::uuid as variant_id
)
select
  (select count(*) from public.variant_cart_items as cart_line
   where cart_line.user_id = params.customer_id
     and cart_line.product_variant_id = params.variant_id) as matching_v2_cart_rows,
  (select count(*) from public.cart_items as legacy_cart
   where legacy_cart.user_id = params.customer_id) as unchanged_v1_cart_rows
from params;
```

The completed receipt query must return exactly one row linked to the new order.
After the exact replay, order, receipt, stock, order-item, and movement values
must remain unchanged and the original result must be returned.

### D. After Cancellation Approval

```sql
with params as (select 'PASTE_ORDER_UUID'::uuid as order_id)
select customer_order.id, customer_order.status,
       customer_order.cancellation_request_status,
       customer_order.inventory_deducted_at,
       customer_order.inventory_restored_at
from public.orders as customer_order, params
where customer_order.id = params.order_id;

with params as (select 'PASTE_ORDER_UUID'::uuid as order_id)
select movement.product_variant_id, movement.quantity_delta,
       movement.resulting_stock_quantity, movement.created_at
from public.inventory_movements as movement, params
where movement.order_id = params.order_id
  and movement.movement_type = 'Cancellation Restoration'
order by movement.product_variant_id;

with params as (select 'PASTE_ORDER_UUID'::uuid as order_id)
select movement.product_variant_id, movement.quantity_delta,
       movement.resulting_stock_quantity, movement.created_at
from public.inventory_movements as movement, params
where movement.order_id = params.order_id
  and movement.movement_type = 'Order Deduction'
order by movement.product_variant_id;

with params as (select 'PASTE_ORDER_UUID'::uuid as order_id)
select variant.id, variant.stock_quantity
from public.product_variants as variant
join public.order_items as item on item.product_variant_id = variant.id
join params on params.order_id = item.order_id
order by variant.id;

-- Mandatory historical V1 integrity check: both counts must be zero.
select
  (select count(*)
   from public.orders as customer_order
   where customer_order.inventory_deducted_at is null
     and customer_order.inventory_restored_at is not null)
    as v1_orders_with_invalid_restoration_timestamp,
  (select count(*)
   from public.inventory_movements as movement
   join public.orders as customer_order on customer_order.id = movement.order_id
   where movement.movement_type = 'Cancellation Restoration'
     and customer_order.inventory_deducted_at is null)
    as restoration_movements_without_v2_deduction;

-- Read-only contract inspection: confirm restoration requires V2 deduction
-- evidence before approving the controlled cancellation.
select pg_catalog.pg_get_functiondef(
  pg_catalog.to_regprocedure(
    'public.review_order_cancellation(uuid,text,text)'
  )
) as cancellation_review_definition;
```

Both historical integrity counts must be zero. Confirm the controlled order's
`inventory_deducted_at` is unchanged, `inventory_restored_at` is written once,
the original deduction remains, and one +1 restoration returns the variant to
its recorded pre-order stock. **STOP — DO NOT APPLY STAGE 3** if any condition
differs or the cancellation function does not require V2 deduction evidence.

### E. After Stage 3

```sql
select
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.place_order_v2(jsonb,jsonb,uuid)',
    'EXECUTE'
  ) as authenticated_v2,
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.place_order(text,text,text,text,text,text,text,jsonb,uuid)',
    'EXECUTE'
  ) as authenticated_v1,
  pg_catalog.has_function_privilege(
    'anon', 'public.place_order_v2(jsonb,jsonb,uuid)', 'EXECUTE'
  ) as anon_v2,
  pg_catalog.has_function_privilege(
    'anon',
    'public.place_order(text,text,text,text,text,text,text,jsonb,uuid)',
    'EXECUTE'
  ) as anon_v1;
```

Expected: authenticated V2 true; all other values false. Re-run the section A
counts, movement summary, and fingerprint and compare with the values recorded
immediately before Stage 3.

## Final Authorization Gate

Stage 3 is authorized only when all Stage 2 evidence is recorded, idempotency
and cancellation restoration both pass, Netlify is stable, and no V1 browser
request is observed. Otherwise stop with V1 temporarily available.
