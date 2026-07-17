begin;

set transaction isolation level repeatable read;

-- Phase 2B3: additive, audited administrator inventory reconciliation.
--
-- This migration creates an admin-only adjustment receipt and RPC. Migration
-- execution never calls the RPC and therefore never changes stock or writes an
-- inventory movement. Existing products, variants, orders, carts, checkout,
-- cancellation, payment, and production feature-flag behavior remain unchanged.
--
-- A no-change request is rejected. Its receipt insert is rolled back with the
-- function transaction, preserving the existing nonzero movement constraint.

-- =========================================================
-- 1. PRECONDITIONS AND IMMUTABLE DATA BASELINE
-- =========================================================

do $preconditions$
declare
  v_extension_schema text;
  v_is_admin_oid regprocedure;
begin
  select namespace.nspname
  into v_extension_schema
  from pg_catalog.pg_extension as extension
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = extension.extnamespace
  where extension.extname = 'pgcrypto';

  if v_extension_schema is distinct from 'extensions' then
    raise exception
      'The pgcrypto extension must exist in the extensions schema.';
  end if;

  if to_regclass('public.products') is null
     or to_regclass('public.product_variants') is null
     or to_regclass('public.inventory_movements') is null
     or to_regclass('public.orders') is null
     or to_regclass('public.order_items') is null
     or to_regclass('public.cart_items') is null
     or to_regclass('public.variant_cart_items') is null then
    raise exception 'A required Phase 2B3 table is missing.';
  end if;

  v_is_admin_oid := to_regprocedure('public.is_admin()');

  if v_is_admin_oid is null
     or to_regprocedure(
       'public.place_order(text,text,text,text,text,text,text,jsonb,uuid)'
     ) is null
     or to_regprocedure(
       'public.place_order_v2(jsonb,jsonb,uuid)'
     ) is null
     or to_regprocedure(
       'public.request_order_cancellation(uuid,text)'
     ) is null
     or to_regprocedure(
       'public.review_order_cancellation(uuid,text,text)'
     ) is null
     or to_regprocedure(
       'public.update_order_status(uuid,text)'
     ) is null
     or to_regprocedure(
       'public.update_order_payment_status(uuid,text)'
     ) is null then
    raise exception 'A required Phase 2B3 function is missing.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'public.product_variants'::regclass
      and attribute.attname = 'stock_quantity'
      and attribute.atttypid = 'integer'::regtype
      and attribute.attnotnull
      and not attribute.attisdropped
  )
  or not exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'public.product_variants'::regclass
      and attribute.attname = 'low_stock_threshold'
      and attribute.atttypid = 'integer'::regtype
      and attribute.attnotnull
      and not attribute.attisdropped
  ) then
    raise exception 'The product-variant stock contract is invalid.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.product_variants'::regclass
      and con.conname = 'product_variants_stock_quantity_check'
      and con.contype = 'c'
      and position(
        'stock_quantity >= 0' in pg_catalog.pg_get_constraintdef(con.oid)
      ) > 0
  ) then
    raise exception 'The non-negative stock constraint is missing or invalid.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.inventory_movements'::regclass
      and con.conname = 'inventory_movements_type_check'
      and con.contype = 'c'
      and position(
        '''Admin Adjustment''' in pg_catalog.pg_get_constraintdef(con.oid)
      ) > 0
  )
  or not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.inventory_movements'::regclass
      and con.conname = 'inventory_movements_quantity_delta_check'
      and con.contype = 'c'
      and position(
        'quantity_delta <> 0' in pg_catalog.pg_get_constraintdef(con.oid)
      ) > 0
  )
  or not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.inventory_movements'::regclass
      and con.conname = 'inventory_movements_quantity_direction_check'
      and con.contype = 'c'
      and position(
        '''Admin Adjustment''' in pg_catalog.pg_get_constraintdef(con.oid)
      ) > 0
      and position(
        'quantity_delta <> 0' in pg_catalog.pg_get_constraintdef(con.oid)
      ) > 0
  )
  or not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.inventory_movements'::regclass
      and con.conname = 'inventory_movements_resulting_stock_check'
      and con.contype = 'c'
      and position(
        'resulting_stock_quantity >= 0'
        in pg_catalog.pg_get_constraintdef(con.oid)
      ) > 0
  )
  or not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.inventory_movements'::regclass
      and con.conname = 'inventory_movements_order_requirement_check'
      and con.contype = 'c'
      and position(
        '''Admin Adjustment''' in pg_catalog.pg_get_constraintdef(con.oid)
      ) > 0
  ) then
    raise exception 'The Admin Adjustment movement contract is invalid.';
  end if;

  if not (
    select class.relrowsecurity
    from pg_catalog.pg_class as class
    where class.oid = 'public.product_variants'::regclass
  )
  or not (
    select class.relrowsecurity
    from pg_catalog.pg_class as class
    where class.oid = 'public.inventory_movements'::regclass
  ) then
    raise exception 'Inventory RLS must be enabled before Phase 2B3.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_policy as policy
    where policy.polrelid = 'public.product_variants'::regclass
      and policy.polname = 'product_variants_admin_select'
  )
  or not exists (
    select 1
    from pg_catalog.pg_policy as policy
    where policy.polrelid = 'public.inventory_movements'::regclass
      and policy.polname = 'inventory_movements_admin_select'
  ) then
    raise exception 'The inventory administrator read policies are missing.';
  end if;

  if has_table_privilege('anon', 'public.product_variants', 'INSERT')
     or has_table_privilege('anon', 'public.product_variants', 'UPDATE')
     or has_table_privilege('anon', 'public.product_variants', 'DELETE')
     or has_table_privilege('anon', 'public.product_variants', 'TRUNCATE')
     or has_table_privilege(
       'authenticated', 'public.product_variants', 'INSERT'
     )
     or has_table_privilege(
       'authenticated', 'public.product_variants', 'UPDATE'
     )
     or has_table_privilege(
       'authenticated', 'public.product_variants', 'DELETE'
     )
     or has_table_privilege(
       'authenticated', 'public.product_variants', 'TRUNCATE'
     )
     or has_table_privilege('anon', 'public.inventory_movements', 'INSERT')
     or has_table_privilege('anon', 'public.inventory_movements', 'UPDATE')
     or has_table_privilege('anon', 'public.inventory_movements', 'DELETE')
     or has_table_privilege('anon', 'public.inventory_movements', 'TRUNCATE')
     or has_table_privilege(
       'authenticated', 'public.inventory_movements', 'INSERT'
     )
     or has_table_privilege(
       'authenticated', 'public.inventory_movements', 'UPDATE'
     )
     or has_table_privilege(
       'authenticated', 'public.inventory_movements', 'DELETE'
     )
     or has_table_privilege(
       'authenticated', 'public.inventory_movements', 'TRUNCATE'
     ) then
    raise exception 'Browser roles must not have direct inventory writes.';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.place_order_v2(jsonb,jsonb,uuid)',
    'EXECUTE'
  ) then
    raise exception
      'place_order_v2 must remain unavailable to authenticated users.';
  end if;
end
$preconditions$;

create temporary table _admin_inventory_adjustment_baseline (
  product_rows bigint not null,
  order_rows bigint not null,
  order_item_rows bigint not null,
  v1_cart_rows bigint not null,
  v1_cart_quantity bigint not null,
  v2_cart_rows bigint not null,
  v2_cart_quantity bigint not null,
  variant_rows bigint not null,
  variant_stock_total bigint not null,
  movement_rows bigint not null,
  movement_quantity_total bigint not null,
  variant_fingerprint text not null,
  movement_fingerprint text not null,
  receipt_table_preexisting boolean not null,
  receipt_rows bigint not null
) on commit drop;

insert into pg_temp._admin_inventory_adjustment_baseline (
  product_rows,
  order_rows,
  order_item_rows,
  v1_cart_rows,
  v1_cart_quantity,
  v2_cart_rows,
  v2_cart_quantity,
  variant_rows,
  variant_stock_total,
  movement_rows,
  movement_quantity_total,
  variant_fingerprint,
  movement_fingerprint,
  receipt_table_preexisting,
  receipt_rows
)
select
  (select count(*) from public.products),
  (select count(*) from public.orders),
  (select count(*) from public.order_items),
  (select count(*) from public.cart_items),
  (select coalesce(sum(cart.quantity), 0) from public.cart_items as cart),
  (select count(*) from public.variant_cart_items),
  (
    select coalesce(sum(cart.quantity), 0)
    from public.variant_cart_items as cart
  ),
  (select count(*) from public.product_variants),
  (
    select coalesce(sum(variant.stock_quantity), 0)
    from public.product_variants as variant
  ),
  (select count(*) from public.inventory_movements),
  (
    select coalesce(sum(movement.quantity_delta), 0)
    from public.inventory_movements as movement
  ),
  pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_array(
                variant.id,
                variant.product_id,
                variant.sku,
                variant.variant_label,
                variant.stock_quantity,
                variant.low_stock_threshold,
                variant.is_active,
                variant.created_at,
                variant.updated_at
              )
              order by variant.id
            )::text
            from public.product_variants as variant
          ),
          '[]'
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ),
  pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_array(
                movement.id,
                movement.product_variant_id,
                movement.order_id,
                movement.movement_type,
                movement.quantity_delta,
                movement.resulting_stock_quantity,
                movement.actor_user_id,
                movement.reason,
                movement.created_at
              )
              order by movement.id
            )::text
            from public.inventory_movements as movement
          ),
          '[]'
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ),
  to_regclass('public.inventory_adjustment_receipts') is not null,
  0;

do $receipt_baseline$
begin
  if to_regclass('public.inventory_adjustment_receipts') is not null then
    update pg_temp._admin_inventory_adjustment_baseline
    set receipt_rows = (
      select count(*)
      from public.inventory_adjustment_receipts
    );
  end if;
end
$receipt_baseline$;

create temporary table _admin_inventory_protected_functions (
  function_signature text primary key,
  function_oid oid not null,
  function_owner oid not null,
  function_definition text not null,
  function_acl text,
  anon_execute boolean not null,
  authenticated_execute boolean not null
) on commit drop;

insert into pg_temp._admin_inventory_protected_functions (
  function_signature,
  function_oid,
  function_owner,
  function_definition,
  function_acl,
  anon_execute,
  authenticated_execute
)
select
  expected.function_signature,
  procedure.oid,
  procedure.proowner,
  pg_catalog.pg_get_functiondef(procedure.oid),
  procedure.proacl::text,
  has_function_privilege('anon', procedure.oid, 'EXECUTE'),
  has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
from (
  values
    ('public.place_order(text,text,text,text,text,text,text,jsonb,uuid)'),
    ('public.place_order_v2(jsonb,jsonb,uuid)'),
    ('public.request_order_cancellation(uuid,text)'),
    ('public.review_order_cancellation(uuid,text,text)'),
    ('public.update_order_status(uuid,text)'),
    ('public.update_order_payment_status(uuid,text)')
) as expected(function_signature)
join pg_catalog.pg_proc as procedure
  on procedure.oid = to_regprocedure(expected.function_signature);

do $protected_baseline$
begin
  if (
    select count(*)
    from pg_temp._admin_inventory_protected_functions
  ) <> 6 then
    raise exception 'A protected commerce function baseline is incomplete.';
  end if;
end
$protected_baseline$;

-- =========================================================
-- 2. ADMIN INVENTORY ADJUSTMENT RECEIPTS
-- =========================================================

create table if not exists public.inventory_adjustment_receipts (
  admin_user_id uuid not null,
  idempotency_key uuid not null,
  payload_hash text not null,
  normalized_payload jsonb not null,
  movement_id uuid,
  result_payload jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,

  constraint inventory_adjustment_receipts_pkey
    primary key (admin_user_id, idempotency_key),

  constraint inventory_adjustment_receipts_admin_user_id_fkey
    foreign key (admin_user_id)
    references auth.users(id)
    on update restrict
    on delete restrict,

  constraint inventory_adjustment_receipts_movement_id_fkey
    foreign key (movement_id)
    references public.inventory_movements(id)
    on update restrict
    on delete restrict,

  constraint inventory_adjustment_receipts_payload_hash_check
    check (payload_hash ~ '^[0-9a-f]{64}$'),

  constraint inventory_adjustment_receipts_normalized_payload_check
    check (jsonb_typeof(normalized_payload) = 'object'),

  constraint inventory_adjustment_receipts_result_payload_check
    check (
      result_payload is null
      or jsonb_typeof(result_payload) = 'object'
    ),

  constraint inventory_adjustment_receipts_completion_check
    check (
      (
        movement_id is null
        and result_payload is null
        and completed_at is null
      )
      or
      (
        movement_id is not null
        and result_payload is not null
        and completed_at is not null
      )
    )
);

alter table public.inventory_adjustment_receipts enable row level security;

revoke all
on table public.inventory_adjustment_receipts
from public, anon, authenticated;

-- No browser-facing policy is created. The SECURITY DEFINER RPC is the only
-- supported browser path to receipt creation and replay.

-- =========================================================
-- 3. AUDITED ADMIN STOCK ADJUSTMENT RPC
-- =========================================================

create or replace function public.adjust_variant_stock(
  p_product_variant_id uuid,
  p_expected_stock_quantity integer,
  p_new_stock_quantity integer,
  p_reason text,
  p_idempotency_key uuid
)
returns table (
  product_variant_id uuid,
  product_id text,
  sku text,
  variant_label text,
  previous_stock_quantity integer,
  new_stock_quantity integer,
  quantity_delta integer,
  low_stock_threshold integer,
  stock_state text,
  movement_id uuid,
  adjusted_at timestamptz,
  idempotent_replay boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_admin_id uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_normalized_payload jsonb;
  v_payload_hash text;
  v_existing_hash text;
  v_existing_normalized_payload jsonb;
  v_existing_movement_id uuid;
  v_existing_result jsonb;
  v_existing_completed_at timestamptz;
  v_receipt_claimed boolean;
  v_product_id text;
  v_sku text;
  v_variant_label text;
  v_current_stock_quantity integer;
  v_updated_stock_quantity integer;
  v_low_stock_threshold integer;
  v_quantity_delta integer;
  v_stock_state text;
  v_movement_id uuid;
  v_adjusted_at timestamptz := pg_catalog.transaction_timestamp();
  v_result_payload jsonb;
  v_updated_rows integer;
  v_internal_sqlstate text;
  v_internal_error text;
  v_internal_detail text;
  v_internal_hint text;
begin
  if v_admin_id is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication required.';
  end if;

  if not coalesce(public.is_admin(), false) then
    raise exception using
      errcode = '42501',
      message = 'Admin access required.';
  end if;

  if p_product_variant_id is null then
    raise exception using
      errcode = '22023',
      message = 'Product variant is required.';
  end if;

  if p_idempotency_key is null then
    raise exception using
      errcode = '22023',
      message = 'Adjustment identifier is required.';
  end if;

  if p_expected_stock_quantity is null
     or p_expected_stock_quantity < 0
     or p_new_stock_quantity is null
     or p_new_stock_quantity < 0 then
    raise exception using
      errcode = '22023',
      message = 'Stock quantities must be non-negative integers.';
  end if;

  if length(v_reason) not between 3 and 500 then
    raise exception using
      errcode = '22023',
      message = 'Adjustment reason must be between 3 and 500 characters.';
  end if;

  v_normalized_payload := pg_catalog.jsonb_build_object(
    'admin_user_id', v_admin_id::text,
    'product_variant_id', p_product_variant_id::text,
    'expected_stock_quantity', p_expected_stock_quantity,
    'new_stock_quantity', p_new_stock_quantity,
    'reason', v_reason
  );

  v_payload_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_normalized_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  select
    receipt.payload_hash,
    receipt.normalized_payload,
    receipt.movement_id,
    receipt.result_payload,
    receipt.completed_at
  into
    v_existing_hash,
    v_existing_normalized_payload,
    v_existing_movement_id,
    v_existing_result,
    v_existing_completed_at
  from public.inventory_adjustment_receipts as receipt
  where receipt.admin_user_id = v_admin_id
    and receipt.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing_hash <> v_payload_hash
       or v_existing_normalized_payload is distinct from
            v_normalized_payload then
      raise exception using
        errcode = '22023',
        message = 'This adjustment identifier was already used for different inventory details.';
    end if;

    if v_existing_movement_id is null
       or v_existing_result is null
       or v_existing_completed_at is null then
      raise exception using
        errcode = 'P0001',
        message = 'This inventory adjustment is still processing. Please try again.';
    end if;

    return query
    select
      (v_existing_result ->> 'product_variant_id')::uuid,
      v_existing_result ->> 'product_id',
      v_existing_result ->> 'sku',
      v_existing_result ->> 'variant_label',
      (v_existing_result ->> 'previous_stock_quantity')::integer,
      (v_existing_result ->> 'new_stock_quantity')::integer,
      (v_existing_result ->> 'quantity_delta')::integer,
      (v_existing_result ->> 'low_stock_threshold')::integer,
      v_existing_result ->> 'stock_state',
      (v_existing_result ->> 'movement_id')::uuid,
      (v_existing_result ->> 'adjusted_at')::timestamptz,
      true;
    return;
  end if;

  insert into public.inventory_adjustment_receipts (
    admin_user_id,
    idempotency_key,
    payload_hash,
    normalized_payload
  )
  values (
    v_admin_id,
    p_idempotency_key,
    v_payload_hash,
    v_normalized_payload
  )
  on conflict (admin_user_id, idempotency_key) do nothing
  returning true into v_receipt_claimed;

  if not coalesce(v_receipt_claimed, false) then
    -- The primary-key conflict waits for a concurrent claimant. Its completed
    -- receipt is then locked and returned without repeating the adjustment.
    select
      receipt.payload_hash,
      receipt.normalized_payload,
      receipt.movement_id,
      receipt.result_payload,
      receipt.completed_at
    into
      v_existing_hash,
      v_existing_normalized_payload,
      v_existing_movement_id,
      v_existing_result,
      v_existing_completed_at
    from public.inventory_adjustment_receipts as receipt
    where receipt.admin_user_id = v_admin_id
      and receipt.idempotency_key = p_idempotency_key
    for update;

    if not found
       or v_existing_hash <> v_payload_hash
       or v_existing_normalized_payload is distinct from
            v_normalized_payload then
      raise exception using
        errcode = '22023',
        message = 'This adjustment identifier was already used for different inventory details.';
    end if;

    if v_existing_movement_id is null
       or v_existing_result is null
       or v_existing_completed_at is null then
      raise exception using
        errcode = 'P0001',
        message = 'This inventory adjustment is still processing. Please try again.';
    end if;

    return query
    select
      (v_existing_result ->> 'product_variant_id')::uuid,
      v_existing_result ->> 'product_id',
      v_existing_result ->> 'sku',
      v_existing_result ->> 'variant_label',
      (v_existing_result ->> 'previous_stock_quantity')::integer,
      (v_existing_result ->> 'new_stock_quantity')::integer,
      (v_existing_result ->> 'quantity_delta')::integer,
      (v_existing_result ->> 'low_stock_threshold')::integer,
      v_existing_result ->> 'stock_state',
      (v_existing_result ->> 'movement_id')::uuid,
      (v_existing_result ->> 'adjusted_at')::timestamptz,
      true;
    return;
  end if;

  select
    variant.product_id,
    variant.sku,
    variant.variant_label,
    variant.stock_quantity,
    variant.low_stock_threshold
  into
    v_product_id,
    v_sku,
    v_variant_label,
    v_current_stock_quantity,
    v_low_stock_threshold
  from public.product_variants as variant
  where variant.id = p_product_variant_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Product variant not found.';
  end if;

  if v_current_stock_quantity <> p_expected_stock_quantity then
    raise exception using
      errcode = 'P0001',
      message = 'Inventory changed. Refresh the variant and try again.';
  end if;

  if p_new_stock_quantity = v_current_stock_quantity then
    raise exception using
      errcode = 'P0001',
      message = 'Stock quantity is already set to this value.';
  end if;

  v_quantity_delta := p_new_stock_quantity - v_current_stock_quantity;

  update public.product_variants as variant
  set stock_quantity = p_new_stock_quantity
  where variant.id = p_product_variant_id
    and variant.stock_quantity = v_current_stock_quantity
  returning variant.stock_quantity
  into v_updated_stock_quantity;

  if not found
     or v_updated_stock_quantity <> p_new_stock_quantity then
    raise exception using
      errcode = 'P0001',
      message = 'Inventory changed. Refresh the variant and try again.';
  end if;

  insert into public.inventory_movements (
    product_variant_id,
    order_id,
    movement_type,
    quantity_delta,
    resulting_stock_quantity,
    actor_user_id,
    reason,
    created_at
  )
  values (
    p_product_variant_id,
    null,
    'Admin Adjustment',
    v_quantity_delta,
    p_new_stock_quantity,
    v_admin_id,
    v_reason,
    v_adjusted_at
  )
  returning id into v_movement_id;

  v_stock_state := case
    when p_new_stock_quantity = 0 then 'Out of Stock'
    when p_new_stock_quantity <= v_low_stock_threshold then 'Low Stock'
    else 'In Stock'
  end;

  v_result_payload := pg_catalog.jsonb_build_object(
    'product_variant_id', p_product_variant_id::text,
    'product_id', v_product_id,
    'sku', v_sku,
    'variant_label', v_variant_label,
    'previous_stock_quantity', v_current_stock_quantity,
    'new_stock_quantity', p_new_stock_quantity,
    'quantity_delta', v_quantity_delta,
    'low_stock_threshold', v_low_stock_threshold,
    'stock_state', v_stock_state,
    'movement_id', v_movement_id::text,
    'adjusted_at', v_adjusted_at
  );

  update public.inventory_adjustment_receipts as receipt
  set
    movement_id = v_movement_id,
    result_payload = v_result_payload,
    completed_at = v_adjusted_at
  where receipt.admin_user_id = v_admin_id
    and receipt.idempotency_key = p_idempotency_key
    and receipt.payload_hash = v_payload_hash
    and receipt.movement_id is null
    and receipt.result_payload is null
    and receipt.completed_at is null;

  get diagnostics v_updated_rows = row_count;

  if v_updated_rows <> 1 then
    raise exception using
      errcode = 'P0001',
      message = 'We could not complete the inventory adjustment. Please try again.';
  end if;

  return query
  select
    p_product_variant_id,
    v_product_id,
    v_sku,
    v_variant_label,
    v_current_stock_quantity,
    p_new_stock_quantity,
    v_quantity_delta,
    v_low_stock_threshold,
    v_stock_state,
    v_movement_id,
    v_adjusted_at,
    false;
exception
  when others then
    get stacked diagnostics
      v_internal_sqlstate = returned_sqlstate,
      v_internal_error = message_text,
      v_internal_detail = pg_exception_detail,
      v_internal_hint = pg_exception_hint;

    if (
      v_internal_sqlstate = '42501'
      and v_internal_error in (
        'Authentication required.',
        'Admin access required.'
      )
    )
    or (
      v_internal_sqlstate = '22023'
      and v_internal_error in (
        'Product variant is required.',
        'Adjustment identifier is required.',
        'Stock quantities must be non-negative integers.',
        'Adjustment reason must be between 3 and 500 characters.',
        'This adjustment identifier was already used for different inventory details.'
      )
    )
    or (
      v_internal_sqlstate = 'P0002'
      and v_internal_error = 'Product variant not found.'
    )
    or (
      v_internal_sqlstate = 'P0001'
      and v_internal_error in (
        'This inventory adjustment is still processing. Please try again.',
        'Inventory changed. Refresh the variant and try again.',
        'Stock quantity is already set to this value.',
        'We could not complete the inventory adjustment. Please try again.'
      )
    ) then
      raise exception using
        errcode = v_internal_sqlstate,
        message = v_internal_error;
    end if;

    raise log
      'adjust_variant_stock failed: %, detail: %, hint: %',
      v_internal_error,
      coalesce(v_internal_detail, ''),
      coalesce(v_internal_hint, '');

    raise exception using
      errcode = 'P0001',
      message = 'We could not adjust inventory. Please try again.';
end;
$function$;

revoke all on function public.adjust_variant_stock(
  uuid,
  integer,
  integer,
  text,
  uuid
)
from public, anon, authenticated;

grant execute on function public.adjust_variant_stock(
  uuid,
  integer,
  integer,
  text,
  uuid
)
to authenticated;

-- =========================================================
-- 4. TRANSACTIONAL MIGRATION VALIDATION
-- =========================================================

do $validation$
declare
  baseline pg_temp._admin_inventory_adjustment_baseline%rowtype;
  v_current_variant_fingerprint text;
  v_current_movement_fingerprint text;
  v_receipt_rows bigint;
  v_receipt_oid regclass;
  v_function_oid regprocedure;
  v_function_security_definer boolean;
  v_function_config text[];
  v_function_definition text;
  v_public_execute boolean;
  v_primary_key_columns name[];
  v_fk_columns name[];
  v_fk_reference_columns name[];
  v_fk_update_action "char";
  v_fk_delete_action "char";
begin
  select *
  into baseline
  from pg_temp._admin_inventory_adjustment_baseline;

  v_receipt_oid := to_regclass('public.inventory_adjustment_receipts');

  if v_receipt_oid is null then
    raise exception 'public.inventory_adjustment_receipts was not created.';
  end if;

  if exists (
    with expected(attname, atttypid, attnotnull) as (
      values
        ('admin_user_id'::name, 'uuid'::regtype::oid, true),
        ('idempotency_key'::name, 'uuid'::regtype::oid, true),
        ('payload_hash'::name, 'text'::regtype::oid, true),
        ('normalized_payload'::name, 'jsonb'::regtype::oid, true),
        ('movement_id'::name, 'uuid'::regtype::oid, false),
        ('result_payload'::name, 'jsonb'::regtype::oid, false),
        ('created_at'::name, 'timestamptz'::regtype::oid, true),
        ('completed_at'::name, 'timestamptz'::regtype::oid, false)
    ),
    actual as (
      select
        attribute.attname,
        attribute.atttypid,
        attribute.attnotnull
      from pg_catalog.pg_attribute as attribute
      where attribute.attrelid = v_receipt_oid
        and attribute.attnum > 0
        and not attribute.attisdropped
    )
    select 1
    from expected
    full join actual using (attname)
    where expected.attname is null
       or actual.attname is null
       or expected.atttypid <> actual.atttypid
       or expected.attnotnull <> actual.attnotnull
  ) then
    raise exception 'The adjustment receipt columns are invalid.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    join pg_catalog.pg_attrdef as default_definition
      on default_definition.adrelid = attribute.attrelid
     and default_definition.adnum = attribute.attnum
    where attribute.attrelid = v_receipt_oid
      and attribute.attname = 'created_at'
      and position(
        'now()' in pg_catalog.pg_get_expr(
          default_definition.adbin,
          default_definition.adrelid
        )
      ) > 0
  ) then
    raise exception 'The adjustment receipt created_at default is invalid.';
  end if;

  select array_agg(attribute.attname order by key_column.ordinality)
  into v_primary_key_columns
  from pg_catalog.pg_constraint as con
  cross join unnest(con.conkey)
    with ordinality as key_column(attnum, ordinality)
  join pg_catalog.pg_attribute as attribute
    on attribute.attrelid = con.conrelid
   and attribute.attnum = key_column.attnum
  where con.conrelid = v_receipt_oid
    and con.conname = 'inventory_adjustment_receipts_pkey'
    and con.contype = 'p';

  if v_primary_key_columns is distinct from
       array['admin_user_id', 'idempotency_key']::name[] then
    raise exception 'The adjustment receipt primary key is invalid.';
  end if;

  select
    (
      select array_agg(attribute.attname order by key_column.ordinality)
      from unnest(con.conkey)
        with ordinality as key_column(attnum, ordinality)
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = con.conrelid
       and attribute.attnum = key_column.attnum
    ),
    (
      select array_agg(attribute.attname order by key_column.ordinality)
      from unnest(con.confkey)
        with ordinality as key_column(attnum, ordinality)
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = con.confrelid
       and attribute.attnum = key_column.attnum
    ),
    con.confupdtype,
    con.confdeltype
  into
    v_fk_columns,
    v_fk_reference_columns,
    v_fk_update_action,
    v_fk_delete_action
  from pg_catalog.pg_constraint as con
  where con.conrelid = v_receipt_oid
    and con.conname = 'inventory_adjustment_receipts_admin_user_id_fkey'
    and con.contype = 'f'
    and con.confrelid = 'auth.users'::regclass;

  if not found
     or v_fk_columns <> array['admin_user_id']::name[]
     or v_fk_reference_columns <> array['id']::name[]
     or v_fk_update_action <> 'r'
     or v_fk_delete_action <> 'r' then
    raise exception 'The adjustment receipt administrator foreign key is invalid.';
  end if;

  select
    (
      select array_agg(attribute.attname order by key_column.ordinality)
      from unnest(con.conkey)
        with ordinality as key_column(attnum, ordinality)
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = con.conrelid
       and attribute.attnum = key_column.attnum
    ),
    (
      select array_agg(attribute.attname order by key_column.ordinality)
      from unnest(con.confkey)
        with ordinality as key_column(attnum, ordinality)
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = con.confrelid
       and attribute.attnum = key_column.attnum
    ),
    con.confupdtype,
    con.confdeltype
  into
    v_fk_columns,
    v_fk_reference_columns,
    v_fk_update_action,
    v_fk_delete_action
  from pg_catalog.pg_constraint as con
  where con.conrelid = v_receipt_oid
    and con.conname = 'inventory_adjustment_receipts_movement_id_fkey'
    and con.contype = 'f'
    and con.confrelid = 'public.inventory_movements'::regclass;

  if not found
     or v_fk_columns <> array['movement_id']::name[]
     or v_fk_reference_columns <> array['id']::name[]
     or v_fk_update_action <> 'r'
     or v_fk_delete_action <> 'r' then
    raise exception 'The adjustment receipt movement foreign key is invalid.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = v_receipt_oid
      and con.conname = 'inventory_adjustment_receipts_payload_hash_check'
      and con.contype = 'c'
      and position(
        '^[0-9a-f]{64}$' in pg_catalog.pg_get_constraintdef(con.oid)
      ) > 0
  )
  or not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = v_receipt_oid
      and con.conname = 'inventory_adjustment_receipts_normalized_payload_check'
      and con.contype = 'c'
      and position(
        'jsonb_typeof(normalized_payload)' in
          pg_catalog.pg_get_constraintdef(con.oid)
      ) > 0
  )
  or not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = v_receipt_oid
      and con.conname = 'inventory_adjustment_receipts_result_payload_check'
      and con.contype = 'c'
      and position(
        'jsonb_typeof(result_payload)' in
          pg_catalog.pg_get_constraintdef(con.oid)
      ) > 0
  )
  or not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = v_receipt_oid
      and con.conname = 'inventory_adjustment_receipts_completion_check'
      and con.contype = 'c'
      and position(
        'movement_id IS NOT NULL' in
          pg_catalog.pg_get_constraintdef(con.oid)
      ) > 0
      and position(
        'completed_at IS NOT NULL' in
          pg_catalog.pg_get_constraintdef(con.oid)
      ) > 0
  ) then
    raise exception 'A required adjustment receipt constraint is invalid.';
  end if;

  if not (
    select class.relrowsecurity
    from pg_catalog.pg_class as class
    where class.oid = v_receipt_oid
  ) then
    raise exception 'RLS must be enabled on inventory_adjustment_receipts.';
  end if;

  if exists (
       select 1
       from pg_catalog.pg_class as class
       cross join lateral pg_catalog.aclexplode(
         coalesce(
           class.relacl,
           pg_catalog.acldefault('r', class.relowner)
         )
       ) as privilege
       where class.oid = v_receipt_oid
         and privilege.grantee = 0
         and privilege.privilege_type in (
           'SELECT',
           'INSERT',
           'UPDATE',
           'DELETE',
           'TRUNCATE',
           'REFERENCES',
           'TRIGGER'
         )
     )
     or has_table_privilege(
       'anon', 'public.inventory_adjustment_receipts', 'SELECT'
     )
     or has_table_privilege(
       'anon', 'public.inventory_adjustment_receipts', 'INSERT'
     )
     or has_table_privilege(
       'anon', 'public.inventory_adjustment_receipts', 'UPDATE'
     )
     or has_table_privilege(
       'anon', 'public.inventory_adjustment_receipts', 'DELETE'
     )
     or has_table_privilege(
       'anon', 'public.inventory_adjustment_receipts', 'TRUNCATE'
     )
     or has_table_privilege(
       'anon', 'public.inventory_adjustment_receipts', 'REFERENCES'
     )
     or has_table_privilege(
       'anon', 'public.inventory_adjustment_receipts', 'TRIGGER'
     )
     or has_table_privilege(
       'authenticated', 'public.inventory_adjustment_receipts', 'SELECT'
     )
     or has_table_privilege(
       'authenticated', 'public.inventory_adjustment_receipts', 'INSERT'
     )
     or has_table_privilege(
       'authenticated', 'public.inventory_adjustment_receipts', 'UPDATE'
     )
     or has_table_privilege(
       'authenticated', 'public.inventory_adjustment_receipts', 'DELETE'
     )
     or has_table_privilege(
       'authenticated', 'public.inventory_adjustment_receipts', 'TRUNCATE'
     )
     or has_table_privilege(
       'authenticated', 'public.inventory_adjustment_receipts', 'REFERENCES'
     )
     or has_table_privilege(
       'authenticated', 'public.inventory_adjustment_receipts', 'TRIGGER'
     ) then
    raise exception 'Browser roles must have no direct adjustment receipt access.';
  end if;

  v_function_oid := to_regprocedure(
    'public.adjust_variant_stock(uuid,integer,integer,text,uuid)'
  );

  if v_function_oid is null then
    raise exception 'The admin inventory adjustment function is missing.';
  end if;

  select
    procedure.prosecdef,
    procedure.proconfig,
    pg_catalog.pg_get_functiondef(procedure.oid)
  into
    v_function_security_definer,
    v_function_config,
    v_function_definition
  from pg_catalog.pg_proc as procedure
  where procedure.oid = v_function_oid;

  if not v_function_security_definer then
    raise exception 'adjust_variant_stock must be SECURITY DEFINER.';
  end if;

  if not exists (
    select 1
    from unnest(coalesce(v_function_config, array[]::text[])) as setting(value)
    where setting.value in ('search_path=', 'search_path=""')
  ) then
    raise exception 'adjust_variant_stock must have an empty search_path.';
  end if;

  select exists (
    select 1
    from pg_catalog.pg_proc as procedure
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) as privilege
    where procedure.oid = v_function_oid
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  )
  into v_public_execute;

  if v_public_execute
     or has_function_privilege(
       'anon',
       v_function_oid,
       'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated',
       v_function_oid,
       'EXECUTE'
     ) then
    raise exception 'The adjustment function execution privileges are invalid.';
  end if;

  if position('for update' in lower(v_function_definition)) = 0
     or position('Admin Adjustment' in v_function_definition) = 0
     or position('public.is_admin()' in v_function_definition) = 0 then
    raise exception 'The adjustment function implementation is incomplete.';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.place_order_v2(jsonb,jsonb,uuid)',
    'EXECUTE'
  ) then
    raise exception
      'place_order_v2 must remain unavailable to authenticated users.';
  end if;

  if exists (
    select 1
    from pg_temp._admin_inventory_protected_functions as protected
    left join pg_catalog.pg_proc as procedure
      on procedure.oid = to_regprocedure(protected.function_signature)
    where procedure.oid is null
       or procedure.oid <> protected.function_oid
       or procedure.proowner <> protected.function_owner
       or pg_catalog.pg_get_functiondef(procedure.oid)
            is distinct from protected.function_definition
       or procedure.proacl::text is distinct from protected.function_acl
       or has_function_privilege('anon', procedure.oid, 'EXECUTE')
            is distinct from protected.anon_execute
       or has_function_privilege(
            'authenticated',
            procedure.oid,
            'EXECUTE'
          ) is distinct from protected.authenticated_execute
  ) then
    raise exception 'A protected commerce function changed.';
  end if;

  v_current_variant_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_array(
                variant.id,
                variant.product_id,
                variant.sku,
                variant.variant_label,
                variant.stock_quantity,
                variant.low_stock_threshold,
                variant.is_active,
                variant.created_at,
                variant.updated_at
              )
              order by variant.id
            )::text
            from public.product_variants as variant
          ),
          '[]'
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  v_current_movement_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_array(
                movement.id,
                movement.product_variant_id,
                movement.order_id,
                movement.movement_type,
                movement.quantity_delta,
                movement.resulting_stock_quantity,
                movement.actor_user_id,
                movement.reason,
                movement.created_at
              )
              order by movement.id
            )::text
            from public.inventory_movements as movement
          ),
          '[]'
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  if baseline.product_rows <> (select count(*) from public.products)
     or baseline.order_rows <> (select count(*) from public.orders)
     or baseline.order_item_rows <> (select count(*) from public.order_items)
     or baseline.v1_cart_rows <> (select count(*) from public.cart_items)
     or baseline.v1_cart_quantity <>
          (select coalesce(sum(cart.quantity), 0) from public.cart_items as cart)
     or baseline.v2_cart_rows <>
          (select count(*) from public.variant_cart_items)
     or baseline.v2_cart_quantity <>
          (
            select coalesce(sum(cart.quantity), 0)
            from public.variant_cart_items as cart
          )
     or baseline.variant_rows <>
          (select count(*) from public.product_variants)
     or baseline.variant_stock_total <>
          (
            select coalesce(sum(variant.stock_quantity), 0)
            from public.product_variants as variant
          )
     or baseline.movement_rows <>
          (select count(*) from public.inventory_movements)
     or baseline.movement_quantity_total <>
          (
            select coalesce(sum(movement.quantity_delta), 0)
            from public.inventory_movements as movement
          )
     or baseline.variant_fingerprint is distinct from
          v_current_variant_fingerprint
     or baseline.movement_fingerprint is distinct from
          v_current_movement_fingerprint then
    raise exception 'Phase 2B3 migration execution changed production data.';
  end if;

  select count(*)
  into v_receipt_rows
  from public.inventory_adjustment_receipts;

  if (
    not baseline.receipt_table_preexisting
    and v_receipt_rows <> 0
  ) or (
    baseline.receipt_table_preexisting
    and v_receipt_rows <> baseline.receipt_rows
  ) then
    raise exception 'The migration changed adjustment receipt data.';
  end if;
end
$validation$;

-- =========================================================
-- 5. READ-ONLY POST-MIGRATION VERIFICATION QUERIES
-- =========================================================
-- Run these separately after deployment. They are comments and are not
-- executed by this migration.
--
-- Receipt columns and constraints:
-- select
--   attribute.attname,
--   pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) as type,
--   attribute.attnotnull
-- from pg_catalog.pg_attribute as attribute
-- where attribute.attrelid = 'public.inventory_adjustment_receipts'::regclass
--   and attribute.attnum > 0
--   and not attribute.attisdropped
-- order by attribute.attnum;
-- select con.conname, pg_catalog.pg_get_constraintdef(con.oid)
-- from pg_catalog.pg_constraint as con
-- where con.conrelid = 'public.inventory_adjustment_receipts'::regclass
-- order by con.conname;
--
-- RLS and direct table privileges:
-- select class.relrowsecurity
-- from pg_catalog.pg_class as class
-- where class.oid = 'public.inventory_adjustment_receipts'::regclass;
-- select privilege.grantee, privilege.privilege_type
-- from pg_catalog.pg_class as class
-- cross join lateral pg_catalog.aclexplode(
--   coalesce(
--     class.relacl,
--     pg_catalog.acldefault('r', class.relowner)
--   )
-- ) as privilege
-- where class.oid = 'public.inventory_adjustment_receipts'::regclass
-- order by privilege.grantee, privilege.privilege_type;
-- select
--   has_table_privilege(
--     'anon',
--     'public.inventory_adjustment_receipts',
--     'SELECT'
--   ) as anon_select,
--   has_table_privilege(
--     'anon',
--     'public.inventory_adjustment_receipts',
--     'INSERT'
--   ) as anon_insert,
--   has_table_privilege(
--     'anon',
--     'public.inventory_adjustment_receipts',
--     'UPDATE'
--   ) as anon_update,
--   has_table_privilege(
--     'anon',
--     'public.inventory_adjustment_receipts',
--     'DELETE'
--   ) as anon_delete,
--   has_table_privilege(
--     'authenticated',
--     'public.inventory_adjustment_receipts',
--     'SELECT'
--   ) as authenticated_select,
--   has_table_privilege(
--     'authenticated',
--     'public.inventory_adjustment_receipts',
--     'INSERT'
--   ) as authenticated_insert,
--   has_table_privilege(
--     'authenticated',
--     'public.inventory_adjustment_receipts',
--     'UPDATE'
--   ) as authenticated_update,
--   has_table_privilege(
--     'authenticated',
--     'public.inventory_adjustment_receipts',
--     'DELETE'
--   ) as authenticated_delete;
--
-- Function signature, SECURITY DEFINER, and empty search_path:
-- select
--   procedure.oid::regprocedure as signature,
--   procedure.prosecdef,
--   procedure.proconfig
-- from pg_catalog.pg_proc as procedure
-- where procedure.oid = to_regprocedure(
--   'public.adjust_variant_stock(uuid,integer,integer,text,uuid)'
-- );
--
-- Function execution privileges and place_order_v2 protection:
-- select
--   exists (
--     select 1
--     from pg_catalog.pg_proc as procedure
--     cross join lateral pg_catalog.aclexplode(
--       coalesce(
--         procedure.proacl,
--         pg_catalog.acldefault('f', procedure.proowner)
--       )
--     ) as privilege
--     where procedure.oid = to_regprocedure(
--       'public.adjust_variant_stock(uuid,integer,integer,text,uuid)'
--     )
--       and privilege.grantee = 0
--       and privilege.privilege_type = 'EXECUTE'
--   ) as public_adjust_execute,
--   has_function_privilege(
--     'anon',
--     'public.adjust_variant_stock(uuid,integer,integer,text,uuid)',
--     'EXECUTE'
--   ) as anon_adjust_execute,
--   has_function_privilege(
--     'authenticated',
--     'public.adjust_variant_stock(uuid,integer,integer,text,uuid)',
--     'EXECUTE'
--   ) as authenticated_adjust_execute,
--   has_function_privilege(
--     'authenticated',
--     'public.place_order_v2(jsonb,jsonb,uuid)',
--     'EXECUTE'
--   ) as authenticated_place_order_v2_execute;
--
-- Current variant count, stock total, adjustment movements, and receipts:
-- select count(*) as variant_count, coalesce(sum(stock_quantity), 0) as stock
-- from public.product_variants;
-- select count(*) as admin_adjustment_movements
-- from public.inventory_movements
-- where movement_type = 'Admin Adjustment';
-- select count(*) as adjustment_receipts
-- from public.inventory_adjustment_receipts;
--
-- Variant stock compared with the complete movement ledger (expected no rows):
-- with ledger as (
--   select
--     movement.product_variant_id,
--     sum(movement.quantity_delta)::bigint as ledger_stock
--   from public.inventory_movements as movement
--   group by movement.product_variant_id
-- )
-- select
--   variant.id,
--   variant.sku,
--   variant.stock_quantity,
--   coalesce(ledger.ledger_stock, 0) as ledger_stock
-- from public.product_variants as variant
-- left join ledger on ledger.product_variant_id = variant.id
-- where variant.stock_quantity::bigint <>
--       coalesce(ledger.ledger_stock, 0)
-- order by variant.sku;

-- =========================================================
-- 6. CONTROLLED TEST PLAN (DO NOT RUN CASUALLY IN PRODUCTION)
-- =========================================================
-- 1. Increase an active variant and reconcile stock, delta, movement, receipt.
-- 2. Decrease a variant and confirm a signed negative Admin Adjustment delta.
-- 3. Set stock to zero and confirm Out of Stock with exact quantity zero.
-- 4. Set stock between one and threshold and confirm Low Stock.
-- 5. Submit a stale expected quantity and confirm no receipt or data mutation.
-- 6. Call as a non-admin authenticated user and confirm access is denied.
-- 7. Adjust an inactive variant and confirm the reconciliation succeeds.
-- 8. Replay the same token and payload; confirm one movement and replay=true.
-- 9. Reuse the token with different data and confirm a safe conflict.
-- 10. Race two adjustments for one variant; only the current expectation wins.
-- 11. Race adjustment with checkout deduction; the variant lock serializes both.
-- 12. Force movement insertion failure in a disposable transaction and confirm
--     receipt and stock update both roll back.
-- 13. Submit current stock as new stock; confirm the no-change rejection leaves
--     no receipt and creates no zero-delta movement.

-- =========================================================
-- 7. ROLLBACK NOTES
-- =========================================================
-- Before any adjustment is used:
--   1. Drop public.adjust_variant_stock(uuid, integer, integer, text, uuid).
--   2. Drop public.inventory_adjustment_receipts.
--
-- After real adjustments exist, their stock quantities, movement rows,
-- administrator identities, and receipts are audit records. Do not remove them
-- casually. A rollback must preserve reconciled stock and movement history.

commit;
