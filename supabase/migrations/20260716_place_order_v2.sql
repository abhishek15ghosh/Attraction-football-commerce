begin;

set transaction isolation level repeatable read;

-- Phase 2B1: additive, stock-aware variant checkout infrastructure.
--
-- This migration deliberately leaves public.place_order, all v1 cart objects,
-- cancellation RPCs, payment/status RPCs, current data, and production feature
-- flags unchanged. public.place_order_v2 is created without browser execution
-- permission. A later cutover migration may grant authenticated execution only
-- after inventory reconciliation and cancellation stock restoration are ready.

-- =========================================================
-- 1. PRECONDITIONS AND STABLE BASELINE
-- =========================================================

do $preconditions$
declare
  v_extension_schema text;
begin
  select namespace.nspname
  into v_extension_schema
  from pg_catalog.pg_extension as extension
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = extension.extnamespace
  where extension.extname = 'pgcrypto';

  if v_extension_schema is null then
    raise exception 'The pgcrypto extension must exist before Phase 2B1.';
  end if;

  if v_extension_schema <> 'extensions' then
    raise exception
      'The pgcrypto extension must be installed in the extensions schema; current schema: %.',
      v_extension_schema;
  end if;

  if to_regclass('public.orders') is null
     or to_regclass('public.order_items') is null
     or to_regclass('public.products') is null
     or to_regclass('public.product_variants') is null
     or to_regclass('public.inventory_movements') is null
     or to_regclass('public.cart_items') is null
     or to_regclass('public.variant_cart_items') is null then
    raise exception 'A required Phase 2B1 table is missing.';
  end if;

  if to_regprocedure(
    'public.place_order(text,text,text,text,text,text,text,jsonb,uuid)'
  ) is null then
    raise exception 'The existing v1 public.place_order RPC is missing.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'public.orders'::regclass
      and attribute.attname = 'checkout_token'
      and attribute.atttypid = 'uuid'::regtype
      and not attribute.attisdropped
  ) then
    raise exception 'public.orders.checkout_token must exist as uuid.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index as index
    join pg_catalog.pg_attribute as attribute
      on attribute.attrelid = index.indrelid
     and attribute.attnum = any(index.indkey)
    where index.indrelid = 'public.orders'::regclass
      and index.indisunique
      and index.indisvalid
      and index.indnkeyatts = 1
      and index.indpred is null
      and index.indexprs is null
      and attribute.attname = 'checkout_token'
      and pg_catalog.pg_get_indexdef(index.indexrelid, 1, true) =
          'checkout_token'
  ) then
    raise exception 'public.orders.checkout_token must have a unique index.';
  end if;
end
$preconditions$;

create temporary table _place_order_v2_baseline (
  order_rows bigint not null,
  order_item_rows bigint not null,
  v1_cart_rows bigint not null,
  v1_cart_quantity bigint not null,
  v2_cart_rows bigint not null,
  v2_cart_quantity bigint not null,
  inventory_variant_rows bigint not null,
  inventory_stock_total bigint not null,
  inventory_movement_rows bigint not null,
  inventory_movement_total bigint not null,
  receipt_table_preexisting boolean not null,
  receipt_rows bigint not null,
  v1_function_oid oid not null,
  v1_function_owner oid not null,
  v1_function_definition text not null,
  v1_function_acl text,
  v1_anon_execute boolean not null,
  v1_authenticated_execute boolean not null
) on commit drop;

insert into pg_temp._place_order_v2_baseline (
  order_rows,
  order_item_rows,
  v1_cart_rows,
  v1_cart_quantity,
  v2_cart_rows,
  v2_cart_quantity,
  inventory_variant_rows,
  inventory_stock_total,
  inventory_movement_rows,
  inventory_movement_total,
  receipt_table_preexisting,
  receipt_rows,
  v1_function_oid,
  v1_function_owner,
  v1_function_definition,
  v1_function_acl,
  v1_anon_execute,
  v1_authenticated_execute
)
select
  (select count(*) from public.orders),
  (select count(*) from public.order_items),
  (select count(*) from public.cart_items),
  (select coalesce(sum(quantity), 0) from public.cart_items),
  (select count(*) from public.variant_cart_items),
  (select coalesce(sum(quantity), 0) from public.variant_cart_items),
  (select count(*) from public.product_variants),
  (select coalesce(sum(stock_quantity), 0) from public.product_variants),
  (select count(*) from public.inventory_movements),
  (select coalesce(sum(quantity_delta), 0) from public.inventory_movements),
  to_regclass('public.order_checkout_receipts_v2') is not null,
  0,
  procedure.oid,
  procedure.proowner,
  pg_catalog.pg_get_functiondef(procedure.oid),
  procedure.proacl::text,
  has_function_privilege(
    'anon',
    procedure.oid,
    'EXECUTE'
  ),
  has_function_privilege(
    'authenticated',
    procedure.oid,
    'EXECUTE'
  )
from pg_catalog.pg_proc as procedure
where procedure.oid = to_regprocedure(
  'public.place_order(text,text,text,text,text,text,text,jsonb,uuid)'
);

do $receipt_baseline$
begin
  if to_regclass('public.order_checkout_receipts_v2') is not null then
    update pg_temp._place_order_v2_baseline
    set receipt_rows = (
      select count(*)
      from public.order_checkout_receipts_v2
    );
  end if;
end
$receipt_baseline$;

-- =========================================================
-- 2. V2 CHECKOUT RECEIPTS
-- =========================================================

create table if not exists public.order_checkout_receipts_v2 (
  user_id uuid not null,
  idempotency_key uuid not null,
  payload_hash text not null,
  normalized_payload jsonb not null,
  order_id uuid,
  result_payload jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,

  constraint order_checkout_receipts_v2_pkey
    primary key (user_id, idempotency_key),

  constraint order_checkout_receipts_v2_user_id_fkey
    foreign key (user_id)
    references auth.users(id)
    on update restrict
    on delete cascade,

  constraint order_checkout_receipts_v2_order_id_fkey
    foreign key (order_id)
    references public.orders(id)
    on update restrict
    on delete restrict,

  constraint order_checkout_receipts_v2_payload_hash_check
    check (payload_hash ~ '^[0-9a-f]{64}$'),

  constraint order_checkout_receipts_v2_normalized_payload_check
    check (jsonb_typeof(normalized_payload) = 'object'),

  constraint order_checkout_receipts_v2_result_payload_check
    check (
      result_payload is null
      or jsonb_typeof(result_payload) = 'object'
    ),

  constraint order_checkout_receipts_v2_completion_check
    check (
      (
        order_id is null
        and result_payload is null
        and completed_at is null
      )
      or
      (
        order_id is not null
        and result_payload is not null
        and completed_at is not null
      )
    )
);

alter table public.order_checkout_receipts_v2 enable row level security;

revoke all
on table public.order_checkout_receipts_v2
from public, anon, authenticated;

-- =========================================================
-- 3. PRODUCT/VARIANT RELATIONSHIP PROTECTION
-- =========================================================

do $variant_relationship$
declare
  v_named_constraint_definition text;
begin
  select pg_catalog.pg_get_constraintdef(con.oid)
  into v_named_constraint_definition
  from pg_catalog.pg_constraint as con
  where con.conrelid = 'public.product_variants'::regclass
    and con.conname = 'product_variants_id_product_id_key';

  if v_named_constraint_definition is not null
     and v_named_constraint_definition <> 'UNIQUE (id, product_id)' then
    raise exception
      'product_variants_id_product_id_key has an unexpected definition: %',
      v_named_constraint_definition;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.product_variants'::regclass
      and con.contype in ('p', 'u')
      and (
        select array_agg(attribute.attname order by key_column.ordinality)
        from unnest(con.conkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = con.conrelid
         and attribute.attnum = key_column.attnum
      ) = array['id', 'product_id']::name[]
  ) then
    alter table public.product_variants
      add constraint product_variants_id_product_id_key
      unique (id, product_id);
  end if;

  if exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.order_items'::regclass
      and con.conname = 'order_items_variant_product_fkey'
      and (
        con.contype <> 'f'
        or con.confrelid <> 'public.product_variants'::regclass
        or con.confupdtype <> 'r'
        or con.confdeltype <> 'r'
      )
  ) then
    raise exception
      'order_items_variant_product_fkey exists with an unexpected definition.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.order_items'::regclass
      and con.conname = 'order_items_variant_product_fkey'
  ) then
    alter table public.order_items
      add constraint order_items_variant_product_fkey
      foreign key (product_variant_id, product_id)
      references public.product_variants(id, product_id)
      on update restrict
      on delete restrict
      not valid;

    alter table public.order_items
      validate constraint order_items_variant_product_fkey;
  end if;
end
$variant_relationship$;

-- =========================================================
-- 4. STOCK-AWARE VARIANT CHECKOUT RPC (NOT YET GRANTED)
-- =========================================================

create or replace function public.place_order_v2(
  p_items jsonb,
  p_shipping_details jsonb,
  p_idempotency_key uuid
)
returns table (
  order_id uuid,
  total_amount numeric,
  order_status text,
  payment_method text,
  payment_status text,
  inventory_deducted_at timestamptz,
  item_count integer,
  idempotent_replay boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_email text := nullif(btrim(auth.jwt() ->> 'email'), '');
  v_customer_name text;
  v_customer_phone text;
  v_address text;
  v_city text;
  v_state text;
  v_pin_code text;
  v_note text;
  v_normalized_items jsonb;
  v_normalized_shipping jsonb;
  v_normalized_payload jsonb;
  v_payload_hash text;
  v_existing_hash text;
  v_existing_order_id uuid;
  v_existing_result jsonb;
  v_existing_completed_at timestamptz;
  v_receipt_claimed boolean;
  v_item jsonb;
  v_product_id text;
  v_product_variant_id uuid;
  v_quantity integer;
  v_cart_product_id text;
  v_cart_quantity integer;
  v_product_name text;
  v_product_category text;
  v_product_price numeric;
  v_product_image text;
  v_product_is_active boolean;
  v_variant_product_id text;
  v_variant_sku text;
  v_variant_label text;
  v_variant_is_active boolean;
  v_stock_quantity integer;
  v_resulting_stock_quantity integer;
  v_total numeric := 0;
  v_item_count integer;
  v_order_id uuid;
  v_checkout_token uuid;
  v_inventory_timestamp timestamptz := pg_catalog.transaction_timestamp();
  v_result_payload jsonb;
  v_deleted_count integer;
  v_updated_count integer;
  v_internal_error text;
  v_internal_detail text;
  v_internal_hint text;
begin
  if v_user_id is null or v_email is null then
    raise exception using
      errcode = 'P0001',
      message = 'Please log in to continue.';
  end if;

  if p_idempotency_key is null then
    raise exception using
      errcode = 'P0001',
      message = 'A checkout identifier is required.';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 50 then
    raise exception using
      errcode = 'P0001',
      message = 'Your cart contains an invalid item.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) as entry(item)
    where jsonb_typeof(entry.item) <> 'object'
       or not (
         entry.item
         ?& array['product_id', 'product_variant_id', 'quantity']
       )
       or (
         select count(*)
         from jsonb_object_keys(entry.item)
       ) <> 3
       or jsonb_typeof(entry.item -> 'product_id') <> 'string'
       or length(btrim(coalesce(entry.item ->> 'product_id', '')))
            not between 1 and 200
       or jsonb_typeof(entry.item -> 'product_variant_id') <> 'string'
       or coalesce(entry.item ->> 'product_variant_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(entry.item -> 'quantity') <> 'number'
       or coalesce(entry.item ->> 'quantity', '') !~ '^[0-9]{1,2}$'
       or (entry.item ->> 'quantity')::integer not between 1 and 20
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'Your cart contains an invalid item.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) as entry(item)
    group by (entry.item ->> 'product_variant_id')::uuid
    having count(*) > 1
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'Your cart contains a duplicate selected option.';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'product_id', btrim(entry.item ->> 'product_id'),
      'product_variant_id',
        ((entry.item ->> 'product_variant_id')::uuid)::text,
      'quantity', (entry.item ->> 'quantity')::integer
    )
    order by ((entry.item ->> 'product_variant_id')::uuid)::text
  )
  into v_normalized_items
  from jsonb_array_elements(p_items) as entry(item);

  if p_shipping_details is null
     or jsonb_typeof(p_shipping_details) <> 'object'
     or not (
       p_shipping_details
       ?& array[
         'customer_name',
         'customer_phone',
         'address',
         'city',
         'state',
         'pin_code'
       ]
     )
     or exists (
       select 1
       from jsonb_object_keys(p_shipping_details) as key(name)
       where key.name not in (
         'customer_name',
         'customer_phone',
         'address',
         'city',
         'state',
         'pin_code',
         'note'
       )
     )
     or jsonb_typeof(p_shipping_details -> 'customer_name') <> 'string'
     or jsonb_typeof(p_shipping_details -> 'customer_phone') <> 'string'
     or jsonb_typeof(p_shipping_details -> 'address') <> 'string'
     or jsonb_typeof(p_shipping_details -> 'city') <> 'string'
     or jsonb_typeof(p_shipping_details -> 'state') <> 'string'
     or jsonb_typeof(p_shipping_details -> 'pin_code') <> 'string'
     or (
       p_shipping_details ? 'note'
       and jsonb_typeof(p_shipping_details -> 'note') not in ('string', 'null')
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'Please check your delivery details.';
  end if;

  v_customer_name := btrim(p_shipping_details ->> 'customer_name');
  v_customer_phone := btrim(p_shipping_details ->> 'customer_phone');
  v_address := btrim(p_shipping_details ->> 'address');
  v_city := btrim(p_shipping_details ->> 'city');
  v_state := btrim(p_shipping_details ->> 'state');
  v_pin_code := btrim(p_shipping_details ->> 'pin_code');
  v_note := nullif(btrim(coalesce(p_shipping_details ->> 'note', '')), '');

  if length(v_customer_name) not between 2 and 120
     or length(v_customer_phone) not between 6 and 30
     or length(v_address) not between 5 and 1000
     or length(v_city) not between 2 and 100
     or length(v_state) not between 2 and 100
     or v_pin_code !~ '^[0-9]{6}$'
     or length(coalesce(v_note, '')) > 1000 then
    raise exception using
      errcode = 'P0001',
      message = 'Please check your delivery details.';
  end if;

  v_normalized_shipping := jsonb_build_object(
    'customer_name', v_customer_name,
    'customer_phone', v_customer_phone,
    'address', v_address,
    'city', v_city,
    'state', v_state,
    'pin_code', v_pin_code,
    'note', v_note
  );

  v_normalized_payload := jsonb_build_object(
    'authenticated_user', jsonb_build_object(
      'user_id', v_user_id::text,
      'email', v_email
    ),
    'items', v_normalized_items,
    'shipping_details', v_normalized_shipping
  );

  v_payload_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_normalized_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  -- A completed receipt is returned before cart or inventory validation. This
  -- makes a retry safe after the original transaction deleted accepted lines.
  select
    receipt.payload_hash,
    receipt.order_id,
    receipt.result_payload,
    receipt.completed_at
  into
    v_existing_hash,
    v_existing_order_id,
    v_existing_result,
    v_existing_completed_at
  from public.order_checkout_receipts_v2 as receipt
  where receipt.user_id = v_user_id
    and receipt.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing_hash <> v_payload_hash then
      raise exception using
        errcode = 'P0001',
        message = 'This checkout identifier was already used for different order details.';
    end if;

    if v_existing_order_id is null
       or v_existing_result is null
       or v_existing_completed_at is null then
      raise exception using
        errcode = 'P0001',
        message = 'This checkout is still processing. Please try again.';
    end if;

    return query
    select
      (v_existing_result ->> 'order_id')::uuid,
      (v_existing_result ->> 'total_amount')::numeric,
      v_existing_result ->> 'order_status',
      v_existing_result ->> 'payment_method',
      v_existing_result ->> 'payment_status',
      (v_existing_result ->> 'inventory_deducted_at')::timestamptz,
      (v_existing_result ->> 'item_count')::integer,
      true;
    return;
  end if;

  insert into public.order_checkout_receipts_v2 (
    user_id,
    idempotency_key,
    payload_hash,
    normalized_payload
  )
  values (
    v_user_id,
    p_idempotency_key,
    v_payload_hash,
    v_normalized_payload
  )
  on conflict (user_id, idempotency_key) do nothing
  returning true into v_receipt_claimed;

  if not coalesce(v_receipt_claimed, false) then
    -- A concurrent insert on the primary key waits for the claiming transaction.
    -- This subsequent row lock observes its committed completed receipt.
    select
      receipt.payload_hash,
      receipt.order_id,
      receipt.result_payload,
      receipt.completed_at
    into
      v_existing_hash,
      v_existing_order_id,
      v_existing_result,
      v_existing_completed_at
    from public.order_checkout_receipts_v2 as receipt
    where receipt.user_id = v_user_id
      and receipt.idempotency_key = p_idempotency_key
    for update;

    if not found
       or v_existing_hash <> v_payload_hash then
      raise exception using
        errcode = 'P0001',
        message = 'This checkout identifier was already used for different order details.';
    end if;

    if v_existing_order_id is null
       or v_existing_result is null
       or v_existing_completed_at is null then
      raise exception using
        errcode = 'P0001',
        message = 'This checkout is still processing. Please try again.';
    end if;

    return query
    select
      (v_existing_result ->> 'order_id')::uuid,
      (v_existing_result ->> 'total_amount')::numeric,
      v_existing_result ->> 'order_status',
      v_existing_result ->> 'payment_method',
      v_existing_result ->> 'payment_status',
      (v_existing_result ->> 'inventory_deducted_at')::timestamptz,
      (v_existing_result ->> 'item_count')::integer,
      true;
    return;
  end if;

  -- Match the established v2 mutation order: product identity first, then each
  -- variant in product/variant order, then cart rows in variant UUID order.
  for v_product_id in
    select distinct entry.item ->> 'product_id'
    from jsonb_array_elements(v_normalized_items) as entry(item)
    order by entry.item ->> 'product_id'
  loop
    select product.is_active
    into v_product_is_active
    from public.products as product
    where product.id = v_product_id
    for share;

    if not found or not v_product_is_active then
      raise exception using
        errcode = 'P0001',
        message = 'One or more products are unavailable.';
    end if;
  end loop;

  for v_item in
    select entry.item
    from jsonb_array_elements(v_normalized_items) as entry(item)
    order by
      entry.item ->> 'product_id',
      entry.item ->> 'product_variant_id'
  loop
    v_product_id := v_item ->> 'product_id';
    v_product_variant_id := (v_item ->> 'product_variant_id')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;

    select
      variant.product_id,
      variant.sku,
      variant.variant_label,
      variant.is_active,
      variant.stock_quantity
    into
      v_variant_product_id,
      v_variant_sku,
      v_variant_label,
      v_variant_is_active,
      v_stock_quantity
    from public.product_variants as variant
    where variant.id = v_product_variant_id
    for update;

    if not found
       or v_variant_product_id <> v_product_id
       or not v_variant_is_active then
      raise exception using
        errcode = 'P0001',
        message = 'One or more selected options are unavailable.';
    end if;

    if v_stock_quantity < v_quantity then
      select product.name
      into v_product_name
      from public.products as product
      where product.id = v_product_id;

      raise exception using
        errcode = 'P0001',
        message = format(
          'Insufficient stock for %s (%s).',
          v_product_name,
          v_variant_label
        );
    end if;
  end loop;

  for v_item in
    select entry.item
    from jsonb_array_elements(v_normalized_items) as entry(item)
    order by entry.item ->> 'product_variant_id'
  loop
    v_product_id := v_item ->> 'product_id';
    v_product_variant_id := (v_item ->> 'product_variant_id')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;

    select cart.product_id, cart.quantity
    into v_cart_product_id, v_cart_quantity
    from public.variant_cart_items as cart
    where cart.user_id = v_user_id
      and cart.product_variant_id = v_product_variant_id
    for update;

    if not found
       or v_cart_product_id <> v_product_id
       or v_cart_quantity <> v_quantity then
      raise exception using
        errcode = 'P0001',
        message = 'Cart changed. Please review your cart and try again.';
    end if;
  end loop;

  v_item_count := jsonb_array_length(v_normalized_items);

  for v_item in
    select entry.item
    from jsonb_array_elements(v_normalized_items) as entry(item)
    order by entry.item ->> 'product_variant_id'
  loop
    v_product_id := v_item ->> 'product_id';
    v_product_variant_id := (v_item ->> 'product_variant_id')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;

    select
      product.name,
      product.category,
      product.price,
      product.image,
      product.is_active,
      variant.product_id,
      variant.sku,
      variant.variant_label,
      variant.is_active,
      variant.stock_quantity
    into
      v_product_name,
      v_product_category,
      v_product_price,
      v_product_image,
      v_product_is_active,
      v_variant_product_id,
      v_variant_sku,
      v_variant_label,
      v_variant_is_active,
      v_stock_quantity
    from public.products as product
    join public.product_variants as variant
      on variant.id = v_product_variant_id
     and variant.product_id = product.id
    where product.id = v_product_id;

    if not found
       or not v_product_is_active
       or not v_variant_is_active
       or v_variant_product_id <> v_product_id then
      raise exception using
        errcode = 'P0001',
        message = 'One or more products or selected options are unavailable.';
    end if;

    if v_stock_quantity < v_quantity then
      raise exception using
        errcode = 'P0001',
        message = format(
          'Insufficient stock for %s (%s).',
          v_product_name,
          v_variant_label
        );
    end if;

    if v_product_price is null or v_product_price < 0 then
      raise exception using
        errcode = 'P0001',
        message = 'One or more products are unavailable.';
    end if;

    v_total := v_total + (v_product_price * v_quantity);
  end loop;

  v_total := round(v_total, 2);

  if v_total <= 0 or v_total > 9999999999.99 then
    raise exception using
      errcode = 'P0001',
      message = 'The order total is invalid.';
  end if;

  v_checkout_token := pg_catalog.gen_random_uuid();

  insert into public.orders (
    user_id,
    customer_name,
    customer_email,
    customer_phone,
    address,
    city,
    state,
    pin_code,
    note,
    total_amount,
    status,
    checkout_token,
    payment_method,
    payment_status,
    payment_collected_at,
    inventory_deducted_at,
    inventory_restored_at
  )
  values (
    v_user_id,
    v_customer_name,
    v_email,
    v_customer_phone,
    v_address,
    v_city,
    v_state,
    v_pin_code,
    v_note,
    v_total,
    'Pending',
    v_checkout_token,
    'COD',
    'Unpaid',
    null,
    null,
    null
  )
  returning id into v_order_id;

  for v_item in
    select entry.item
    from jsonb_array_elements(v_normalized_items) as entry(item)
    order by entry.item ->> 'product_variant_id'
  loop
    v_product_id := v_item ->> 'product_id';
    v_product_variant_id := (v_item ->> 'product_variant_id')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;

    select
      product.name,
      product.category,
      product.price,
      product.image,
      variant.sku,
      variant.variant_label
    into
      v_product_name,
      v_product_category,
      v_product_price,
      v_product_image,
      v_variant_sku,
      v_variant_label
    from public.products as product
    join public.product_variants as variant
      on variant.id = v_product_variant_id
     and variant.product_id = product.id
    where product.id = v_product_id;

    insert into public.order_items (
      order_id,
      product_id,
      product_name,
      product_category,
      product_price,
      quantity,
      product_image,
      product_variant_id,
      variant_sku,
      variant_label
    )
    values (
      v_order_id,
      v_product_id,
      v_product_name,
      v_product_category,
      v_product_price,
      v_quantity,
      v_product_image,
      v_product_variant_id,
      v_variant_sku,
      v_variant_label
    );

    update public.product_variants as variant
    set stock_quantity = variant.stock_quantity - v_quantity
    where variant.id = v_product_variant_id
      and variant.product_id = v_product_id
      and variant.stock_quantity >= v_quantity
    returning variant.stock_quantity
    into v_resulting_stock_quantity;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = format(
          'Insufficient stock for %s (%s).',
          v_product_name,
          v_variant_label
        );
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
      v_product_variant_id,
      v_order_id,
      'Order Deduction',
      -v_quantity,
      v_resulting_stock_quantity,
      v_user_id,
      'Stock deducted by place_order_v2 checkout.',
      v_inventory_timestamp
    );
  end loop;

  update public.orders as created_order
  set
    inventory_deducted_at = v_inventory_timestamp,
    inventory_restored_at = null,
    updated_at = v_inventory_timestamp
  where created_order.id = v_order_id;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = 'We could not place your order. Please try again.';
  end if;

  with accepted as (
    select
      entry.item ->> 'product_id' as product_id,
      (entry.item ->> 'product_variant_id')::uuid as product_variant_id,
      (entry.item ->> 'quantity')::integer as quantity
    from jsonb_array_elements(v_normalized_items) as entry(item)
  )
  delete from public.variant_cart_items as cart
  using accepted
  where cart.user_id = v_user_id
    and cart.product_id = accepted.product_id
    and cart.product_variant_id = accepted.product_variant_id
    and cart.quantity = accepted.quantity;

  get diagnostics v_deleted_count = row_count;
  if v_deleted_count <> v_item_count then
    raise exception using
      errcode = 'P0001',
      message = 'Cart changed. Please review your cart and try again.';
  end if;

  v_result_payload := jsonb_build_object(
    'order_id', v_order_id,
    'total_amount', v_total,
    'order_status', 'Pending',
    'payment_method', 'COD',
    'payment_status', 'Unpaid',
    'inventory_deducted_at', v_inventory_timestamp,
    'item_count', v_item_count
  );

  update public.order_checkout_receipts_v2 as receipt
  set
    order_id = v_order_id,
    result_payload = v_result_payload,
    completed_at = v_inventory_timestamp
  where receipt.user_id = v_user_id
    and receipt.idempotency_key = p_idempotency_key
    and receipt.order_id is null
    and receipt.result_payload is null
    and receipt.completed_at is null;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = 'We could not place your order. Please try again.';
  end if;

  return query
  select
    v_order_id,
    v_total,
    'Pending'::text,
    'COD'::text,
    'Unpaid'::text,
    v_inventory_timestamp,
    v_item_count,
    false;
exception
  when raise_exception then
    raise;
  when others then
    get stacked diagnostics
      v_internal_error = message_text,
      v_internal_detail = pg_exception_detail,
      v_internal_hint = pg_exception_hint;

    raise log
      'place_order_v2 failed: %, detail: %, hint: %',
      v_internal_error,
      coalesce(v_internal_detail, ''),
      coalesce(v_internal_hint, '');

    raise exception using
      errcode = 'P0001',
      message = 'We could not place your order. Please try again.';
end;
$function$;

revoke all on function public.place_order_v2(jsonb, jsonb, uuid)
from public, anon, authenticated;

-- Deliberately no GRANT EXECUTE to authenticated in Phase 2B1.

-- =========================================================
-- 5. TRANSACTIONAL MIGRATION VALIDATION
-- =========================================================

do $validation$
declare
  baseline pg_temp._place_order_v2_baseline%rowtype;
  v_function_oid regprocedure;
  v_is_security_definer boolean;
  v_function_config text[];
  v_current_v1_owner oid;
  v_current_v1_definition text;
  v_current_v1_acl text;
  v_receipt_rows bigint;
  v_fk_columns name[];
  v_fk_reference_columns name[];
  v_fk_update_action "char";
  v_fk_delete_action "char";
begin
  select *
  into baseline
  from pg_temp._place_order_v2_baseline;

  if to_regclass('public.order_checkout_receipts_v2') is null then
    raise exception 'public.order_checkout_receipts_v2 was not created.';
  end if;

  if not (
    select class.relrowsecurity
    from pg_catalog.pg_class as class
    where class.oid = 'public.order_checkout_receipts_v2'::regclass
  ) then
    raise exception 'RLS must be enabled on order_checkout_receipts_v2.';
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
       where class.oid = 'public.order_checkout_receipts_v2'::regclass
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
     or has_table_privilege('anon', 'public.order_checkout_receipts_v2', 'SELECT')
     or has_table_privilege('anon', 'public.order_checkout_receipts_v2', 'INSERT')
     or has_table_privilege('anon', 'public.order_checkout_receipts_v2', 'UPDATE')
     or has_table_privilege('anon', 'public.order_checkout_receipts_v2', 'DELETE')
     or has_table_privilege('anon', 'public.order_checkout_receipts_v2', 'TRUNCATE')
     or has_table_privilege('anon', 'public.order_checkout_receipts_v2', 'REFERENCES')
     or has_table_privilege('anon', 'public.order_checkout_receipts_v2', 'TRIGGER')
     or has_table_privilege('authenticated', 'public.order_checkout_receipts_v2', 'SELECT')
     or has_table_privilege('authenticated', 'public.order_checkout_receipts_v2', 'INSERT')
     or has_table_privilege('authenticated', 'public.order_checkout_receipts_v2', 'UPDATE')
     or has_table_privilege('authenticated', 'public.order_checkout_receipts_v2', 'DELETE')
     or has_table_privilege('authenticated', 'public.order_checkout_receipts_v2', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.order_checkout_receipts_v2', 'REFERENCES')
     or has_table_privilege('authenticated', 'public.order_checkout_receipts_v2', 'TRIGGER') then
    raise exception 'Browser roles must have no direct receipt-table privileges.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.order_checkout_receipts_v2'::regclass
      and con.conname = 'order_checkout_receipts_v2_pkey'
      and con.contype = 'p'
  )
  or not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.order_checkout_receipts_v2'::regclass
      and con.conname = 'order_checkout_receipts_v2_payload_hash_check'
      and con.contype = 'c'
  )
  or not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.order_checkout_receipts_v2'::regclass
      and con.conname = 'order_checkout_receipts_v2_completion_check'
      and con.contype = 'c'
  ) then
    raise exception 'A required receipt-table constraint is missing.';
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
  where con.conrelid = 'public.order_items'::regclass
    and con.conname = 'order_items_variant_product_fkey'
    and con.contype = 'f'
    and con.confrelid = 'public.product_variants'::regclass;

  if not found
     or v_fk_columns <> array['product_variant_id', 'product_id']::name[]
     or v_fk_reference_columns <> array['id', 'product_id']::name[]
     or v_fk_update_action <> 'r'
     or v_fk_delete_action <> 'r' then
    raise exception 'The order-item variant/product foreign key is invalid.';
  end if;

  v_function_oid := to_regprocedure(
    'public.place_order_v2(jsonb,jsonb,uuid)'
  );

  if v_function_oid is null then
    raise exception 'public.place_order_v2(jsonb,jsonb,uuid) is missing.';
  end if;

  select procedure.prosecdef, procedure.proconfig
  into v_is_security_definer, v_function_config
  from pg_catalog.pg_proc as procedure
  where procedure.oid = v_function_oid;

  if not v_is_security_definer then
    raise exception 'place_order_v2 must be SECURITY DEFINER.';
  end if;

  if not exists (
    select 1
    from unnest(coalesce(v_function_config, array[]::text[])) as setting(value)
    where setting.value in ('search_path=', 'search_path=""')
  ) then
    raise exception 'place_order_v2 must have an empty search_path.';
  end if;

  if exists (
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
     or has_function_privilege(
       'anon',
       'public.place_order_v2(jsonb,jsonb,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.place_order_v2(jsonb,jsonb,uuid)',
       'EXECUTE'
     ) then
    raise exception 'place_order_v2 must not be executable by browser roles.';
  end if;

  if to_regprocedure(
       'public.place_order(text,text,text,text,text,text,text,jsonb,uuid)'
     ) is distinct from baseline.v1_function_oid then
    raise exception 'The existing v1 place_order identity changed.';
  end if;

  select
    procedure.proowner,
    pg_catalog.pg_get_functiondef(procedure.oid),
    procedure.proacl::text
  into
    v_current_v1_owner,
    v_current_v1_definition,
    v_current_v1_acl
  from pg_catalog.pg_proc as procedure
  where procedure.oid = baseline.v1_function_oid;

  if v_current_v1_owner is distinct from baseline.v1_function_owner
     or v_current_v1_definition is distinct from baseline.v1_function_definition
     or v_current_v1_acl is distinct from baseline.v1_function_acl
     or has_function_privilege(
          'anon',
          baseline.v1_function_oid,
          'EXECUTE'
        ) <> baseline.v1_anon_execute
     or has_function_privilege(
          'authenticated',
          baseline.v1_function_oid,
          'EXECUTE'
        ) <> baseline.v1_authenticated_execute then
    raise exception 'The migration changed the existing v1 place_order RPC.';
  end if;

  if baseline.order_rows <> (select count(*) from public.orders)
     or baseline.order_item_rows <> (select count(*) from public.order_items)
     or baseline.v1_cart_rows <> (select count(*) from public.cart_items)
     or baseline.v1_cart_quantity <>
          (select coalesce(sum(quantity), 0) from public.cart_items)
     or baseline.v2_cart_rows <>
          (select count(*) from public.variant_cart_items)
     or baseline.v2_cart_quantity <>
          (select coalesce(sum(quantity), 0) from public.variant_cart_items)
     or baseline.inventory_variant_rows <>
          (select count(*) from public.product_variants)
     or baseline.inventory_stock_total <>
          (select coalesce(sum(stock_quantity), 0) from public.product_variants)
     or baseline.inventory_movement_rows <>
          (select count(*) from public.inventory_movements)
     or baseline.inventory_movement_total <>
          (select coalesce(sum(quantity_delta), 0) from public.inventory_movements) then
    raise exception 'The migration changed existing commerce or inventory data.';
  end if;

  select count(*)
  into v_receipt_rows
  from public.order_checkout_receipts_v2;

  if (
    not baseline.receipt_table_preexisting
    and v_receipt_rows <> 0
  ) or (
    baseline.receipt_table_preexisting
    and v_receipt_rows <> baseline.receipt_rows
  ) then
    raise exception 'The migration changed existing V2 checkout receipt data.';
  end if;
end
$validation$;

-- Rollback before V2 execution is granted:
--   1. Drop public.place_order_v2(jsonb, jsonb, uuid).
--   2. Drop order_items_variant_product_fkey if no dependent V2 rows exist.
--   3. Drop public.order_checkout_receipts_v2.
-- Leave public.place_order and all V1 cart/order behavior unchanged.
--
-- After V2 orders exist, receipt rows, variant snapshots, stock deductions, and
-- inventory movements are audit records and must not be dropped casually.

commit;
