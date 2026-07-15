begin;

set transaction isolation level repeatable read;

-- Phase 2A2: additive, parallel variant-cart infrastructure.
-- The production v1 cart and checkout remain unchanged and operational.
-- This migration does not reserve, deduct, restore, or otherwise alter stock.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $pgcrypto$
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
    raise exception 'The pgcrypto extension could not be installed.';
  end if;

  if v_extension_schema <> 'extensions' then
    raise exception
      'The pgcrypto extension must be installed in the extensions schema; current schema: %.',
      v_extension_schema;
  end if;
end
$pgcrypto$;

create temporary table _variant_cart_v2_baseline (
  v1_cart_rows bigint not null,
  v1_cart_quantity bigint not null,
  inventory_variant_rows bigint not null,
  inventory_stock_total bigint not null,
  inventory_movement_rows bigint not null,
  inventory_movement_total bigint not null,
  v2_cart_preexisting boolean not null,
  v2_receipts_preexisting boolean not null
) on commit drop;

insert into pg_temp._variant_cart_v2_baseline (
  v1_cart_rows,
  v1_cart_quantity,
  inventory_variant_rows,
  inventory_stock_total,
  inventory_movement_rows,
  inventory_movement_total,
  v2_cart_preexisting,
  v2_receipts_preexisting
)
select
  (select count(*) from public.cart_items),
  (select coalesce(sum(quantity), 0) from public.cart_items),
  (select count(*) from public.product_variants),
  (select coalesce(sum(stock_quantity), 0) from public.product_variants),
  (select count(*) from public.inventory_movements),
  (select coalesce(sum(quantity_delta), 0) from public.inventory_movements),
  to_regclass('public.variant_cart_items') is not null,
  to_regclass('public.variant_cart_merge_receipts') is not null;

-- The redundant unique pair exists only so the variant-cart composite foreign
-- key can prove declaratively that a selected variant belongs to product_id.
do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.product_variants'::regclass
      and conname = 'product_variants_id_product_id_key'
  ) then
    alter table public.product_variants
      add constraint product_variants_id_product_id_key
      unique (id, product_id);
  end if;
end
$migration$;

create table if not exists public.variant_cart_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  product_id text not null,
  product_variant_id uuid not null,
  quantity integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint variant_cart_items_user_id_fkey
    foreign key (user_id)
    references auth.users(id)
    on update restrict
    on delete cascade,

  constraint variant_cart_items_product_id_fkey
    foreign key (product_id)
    references public.products(id)
    on update restrict
    on delete restrict,

  constraint variant_cart_items_variant_product_fkey
    foreign key (product_variant_id, product_id)
    references public.product_variants(id, product_id)
    on update restrict
    on delete restrict,

  constraint variant_cart_items_quantity_check
    check (quantity between 1 and 20),

  constraint variant_cart_items_user_variant_key
    unique (user_id, product_variant_id)
);

create index if not exists variant_cart_items_user_created_idx
  on public.variant_cart_items (user_id, created_at, id);

create index if not exists variant_cart_items_product_id_idx
  on public.variant_cart_items (product_id);

create index if not exists variant_cart_items_product_variant_id_idx
  on public.variant_cart_items (product_variant_id);

create or replace function public.touch_variant_cart_items_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all
on function public.touch_variant_cart_items_updated_at()
from public, anon, authenticated;

drop trigger if exists variant_cart_items_updated_at_trigger
on public.variant_cart_items;

create trigger variant_cart_items_updated_at_trigger
before update on public.variant_cart_items
for each row
execute function public.touch_variant_cart_items_updated_at();

create table if not exists public.variant_cart_merge_receipts (
  user_id uuid not null,
  merge_token uuid not null,
  payload_hash text not null,
  normalized_payload jsonb not null,
  result_payload jsonb not null,
  created_at timestamptz not null default now(),

  constraint variant_cart_merge_receipts_pkey
    primary key (user_id, merge_token),

  constraint variant_cart_merge_receipts_user_id_fkey
    foreign key (user_id)
    references auth.users(id)
    on update restrict
    on delete cascade,

  constraint variant_cart_merge_receipts_payload_hash_check
    check (payload_hash ~ '^[0-9a-f]{64}$'),

  constraint variant_cart_merge_receipts_normalized_payload_check
    check (jsonb_typeof(normalized_payload) = 'array'),

  constraint variant_cart_merge_receipts_result_payload_check
    check (jsonb_typeof(result_payload) = 'object')
);

alter table public.variant_cart_items enable row level security;
alter table public.variant_cart_merge_receipts enable row level security;

revoke all
on table public.variant_cart_items
from public, anon, authenticated;

revoke all
on table public.variant_cart_merge_receipts
from public, anon, authenticated;

-- Internal atomic additive merge helper. It is intentionally not executable by
-- browser roles and is called only by approved SECURITY DEFINER v2 RPCs.
create or replace function public._lock_active_product_variant_v2(
  p_product_id text,
  p_product_variant_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform product.id
  from public.products as product
  join public.product_variants as variant
    on variant.product_id = product.id
  where product.id = p_product_id
    and product.is_active = true
    and variant.id = p_product_variant_id
    and variant.is_active = true
  order by product.id, variant.id
  for share of product, variant;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Selected option is unavailable for this product.';
  end if;
end;
$$;

revoke all
on function public._lock_active_product_variant_v2(text, uuid)
from public, anon, authenticated;

create or replace function public._merge_variant_cart_quantity_v2(
  p_user_id uuid,
  p_product_id text,
  p_product_variant_id uuid,
  p_quantity_delta integer
)
returns table (
  previous_quantity integer,
  final_quantity integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_previous integer;
  v_final integer;
begin
  if p_user_id is null
     or p_product_id is null
     or p_product_variant_id is null
     or p_quantity_delta is null
     or p_quantity_delta not between 1 and 20 then
    raise exception using
      errcode = '22023',
      message = 'Invalid variant cart quantity.';
  end if;

  loop
    select cart.quantity
    into v_previous
    from public.variant_cart_items as cart
    where cart.user_id = p_user_id
      and cart.product_variant_id = p_product_variant_id
    for update;

    if found then
      v_final := least(20, v_previous + p_quantity_delta);

      update public.variant_cart_items as cart
      set quantity = v_final
      where cart.user_id = p_user_id
        and cart.product_variant_id = p_product_variant_id;

      return query select v_previous, v_final;
      return;
    end if;

    insert into public.variant_cart_items (
      user_id,
      product_id,
      product_variant_id,
      quantity
    )
    values (
      p_user_id,
      p_product_id,
      p_product_variant_id,
      p_quantity_delta
    )
    on conflict (user_id, product_variant_id) do nothing
    returning quantity into v_final;

    if found then
      return query select 0, v_final;
      return;
    end if;
  end loop;
end;
$$;

revoke all
on function public._merge_variant_cart_quantity_v2(uuid, text, uuid, integer)
from public, anon, authenticated;

create or replace function public.get_cart_v2()
returns table (
  cart_line_id uuid,
  product_id text,
  product_variant_id uuid,
  variant_sku text,
  variant_label text,
  product_name text,
  category text,
  unit_price numeric,
  image text,
  quantity integer,
  product_is_active boolean,
  variant_is_active boolean,
  purchasable_quantity integer,
  stock_state text,
  checkout_resolution_required boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication required.';
  end if;

  return query
  select
    cart.id,
    cart.product_id,
    cart.product_variant_id,
    variant.sku,
    variant.variant_label,
    product.name,
    product.category,
    product.price,
    product.image,
    cart.quantity,
    product.is_active,
    variant.is_active,
    case
      when not product.is_active or not variant.is_active then 0
      else least(20, greatest(variant.stock_quantity, 0))::integer
    end,
    case
      when not product.is_active or not variant.is_active then 'Unavailable'
      when variant.stock_quantity = 0 then 'Out of Stock'
      when variant.stock_quantity between 1 and variant.low_stock_threshold then 'Low Stock'
      else 'In Stock'
    end::text,
    false,
    cart.created_at,
    cart.updated_at
  from public.variant_cart_items as cart
  join public.products as product
    on product.id = cart.product_id
  join public.product_variants as variant
    on variant.id = cart.product_variant_id
   and variant.product_id = cart.product_id
  where cart.user_id = v_user_id
  order by cart.created_at, cart.id;
end;
$$;

create or replace function public.get_legacy_cart_items_v2()
returns table (
  product_id text,
  product_name text,
  category text,
  unit_price numeric,
  image text,
  quantity integer,
  product_is_active boolean,
  active_variant_count integer,
  automatic_variant_id uuid,
  automatic_variant_sku text,
  automatic_variant_label text,
  resolution_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication required.';
  end if;

  return query
  select
    cart.product_id,
    product.name,
    product.category,
    product.price,
    product.image,
    cart.quantity,
    product.is_active,
    coalesce(summary.active_variant_count, 0),
    case
      when coalesce(summary.active_variant_count, 0) = 1
        then summary.first_variant_id
      else null
    end,
    case
      when coalesce(summary.active_variant_count, 0) = 1
        then summary.first_variant_sku
      else null
    end,
    case
      when coalesce(summary.active_variant_count, 0) = 1
        then summary.first_variant_label
      else null
    end,
    case
      when coalesce(summary.active_variant_count, 0) = 1 then 'Automatic'
      when coalesce(summary.active_variant_count, 0) > 1 then 'Size selection required'
      else 'No active variants'
    end::text
  from public.cart_items as cart
  join public.products as product
    on product.id = cart.product_id
  left join lateral (
    select
      count(*)::integer as active_variant_count,
      (array_agg(
        variant.id
        order by variant.variant_label, variant.id
      ))[1] as first_variant_id,
      (array_agg(
        variant.sku
        order by variant.variant_label, variant.id
      ))[1] as first_variant_sku,
      (array_agg(
        variant.variant_label
        order by variant.variant_label, variant.id
      ))[1] as first_variant_label
    from public.product_variants as variant
    where product.is_active = true
      and variant.product_id = cart.product_id
      and variant.is_active = true
  ) as summary on true
  where cart.user_id = v_user_id
  order by cart.created_at, cart.product_id;
end;
$$;

create or replace function public.set_cart_item_v2(
  p_product_id text,
  p_product_variant_id uuid,
  p_quantity integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_product_id text := btrim(coalesce(p_product_id, ''));
  v_final_quantity integer;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication required.';
  end if;

  if v_product_id = ''
     or p_product_variant_id is null
     or p_quantity is null
     or p_quantity not between 1 and 20 then
    raise exception using
      errcode = '22023',
      message = 'Invalid variant cart item.';
  end if;

  perform public._lock_active_product_variant_v2(
    v_product_id,
    p_product_variant_id
  );

  insert into public.variant_cart_items as cart (
    user_id,
    product_id,
    product_variant_id,
    quantity
  )
  values (
    v_user_id,
    v_product_id,
    p_product_variant_id,
    p_quantity
  )
  on conflict (user_id, product_variant_id)
  do update set quantity = excluded.quantity
  returning cart.quantity into v_final_quantity;

  return v_final_quantity;
exception
  when foreign_key_violation then
    raise exception using
      errcode = '22023',
      message = 'Selected option is unavailable for this product.';
end;
$$;

create or replace function public.remove_cart_item_v2(
  p_product_variant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted integer;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication required.';
  end if;

  if p_product_variant_id is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid variant cart item.';
  end if;

  delete from public.variant_cart_items as cart
  where cart.user_id = v_user_id
    and cart.product_variant_id = p_product_variant_id;

  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

create or replace function public.clear_cart_v2()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted integer;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication required.';
  end if;

  delete from public.variant_cart_items as cart
  where cart.user_id = v_user_id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create or replace function public.resolve_legacy_cart_item_v2(
  p_product_id text,
  p_product_variant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_product_id text := btrim(coalesce(p_product_id, ''));
  v_legacy_quantity integer;
  v_previous_quantity integer;
  v_final_quantity integer;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication required.';
  end if;

  if v_product_id = '' or p_product_variant_id is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid legacy cart selection.';
  end if;

  select cart.quantity
  into v_legacy_quantity
  from public.cart_items as cart
  where cart.user_id = v_user_id
    and cart.product_id = v_product_id
  for update;

  if not found then
    return jsonb_build_object(
      'status', 'No legacy item',
      'product_id', v_product_id,
      'product_variant_id', p_product_variant_id,
      'moved_quantity', 0,
      'final_quantity', null,
      'quantity_capped', false
    );
  end if;

  perform public._lock_active_product_variant_v2(
    v_product_id,
    p_product_variant_id
  );

  select merged.previous_quantity, merged.final_quantity
  into v_previous_quantity, v_final_quantity
  from public._merge_variant_cart_quantity_v2(
    v_user_id,
    v_product_id,
    p_product_variant_id,
    v_legacy_quantity
  ) as merged;

  delete from public.cart_items as cart
  where cart.user_id = v_user_id
    and cart.product_id = v_product_id;

  return jsonb_build_object(
    'status', 'Resolved',
    'product_id', v_product_id,
    'product_variant_id', p_product_variant_id,
    'moved_quantity', v_legacy_quantity,
    'final_quantity', v_final_quantity,
    'quantity_capped', v_previous_quantity + v_legacy_quantity > v_final_quantity
  );
exception
  when foreign_key_violation then
    raise exception using
      errcode = '22023',
      message = 'Selected option is unavailable for this product.';
end;
$$;

create or replace function public.merge_guest_cart_v2(
  p_items jsonb,
  p_merge_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_submitted_count integer;
  v_normalized_count integer;
  v_normalized_payload jsonb;
  v_payload_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_claimed boolean;
  v_item jsonb;
  v_product_id text;
  v_product_variant_id uuid;
  v_requested_quantity integer;
  v_quantity integer;
  v_previous_quantity integer;
  v_final_quantity integer;
  v_inserted_count integer := 0;
  v_updated_count integer := 0;
  v_capped_count integer := 0;
  v_final_item_count integer;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication required.';
  end if;

  if p_merge_token is null then
    raise exception using
      errcode = '22023',
      message = 'Merge token is required.';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 50 then
    raise exception using
      errcode = '22023',
      message = 'Invalid guest variant cart.';
  end if;

  v_submitted_count := jsonb_array_length(p_items);

  if exists (
    select 1
    from jsonb_array_elements(p_items) as entry(item)
    where jsonb_typeof(item) <> 'object'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Guest variant cart contains an invalid item.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) as entry(item)
    where not (item ?& array['productId', 'productVariantId', 'quantity'])
       or (select count(*) from jsonb_object_keys(item)) <> 3
       or jsonb_typeof(item -> 'productId') <> 'string'
       or btrim(coalesce(item ->> 'productId', '')) = ''
       or jsonb_typeof(item -> 'productVariantId') <> 'string'
       or coalesce(item ->> 'productVariantId', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or jsonb_typeof(item -> 'quantity') <> 'number'
       or coalesce(item ->> 'quantity', '') !~ '^[0-9]{1,2}$'
       or (item ->> 'quantity')::integer not between 1 and 20
  ) then
    raise exception using
      errcode = '22023',
      message = 'Guest variant cart contains an invalid item.';
  end if;

  if exists (
    with parsed as (
      select
        btrim(item ->> 'productId') as product_id,
        (item ->> 'productVariantId')::uuid as product_variant_id
      from jsonb_array_elements(p_items) as entry(item)
    )
    select 1
    from parsed
    group by product_variant_id
    having count(distinct product_id) > 1
  ) then
    raise exception using
      errcode = '22023',
      message = 'Guest variant cart contains conflicting product selections.';
  end if;

  with parsed as (
    select
      btrim(item ->> 'productId') as product_id,
      (item ->> 'productVariantId')::uuid as product_variant_id,
      (item ->> 'quantity')::integer as quantity
    from jsonb_array_elements(p_items) as entry(item)
  ),
  normalized as (
    select
      product_id,
      product_variant_id,
      sum(quantity)::integer as requested_quantity,
      least(20, sum(quantity)::integer) as quantity
    from parsed
    group by product_id, product_variant_id
  )
  select jsonb_agg(
    jsonb_build_object(
      'productId', product_id,
      'productVariantId', product_variant_id,
      'requestedQuantity', requested_quantity,
      'quantity', quantity
    )
    order by product_id, product_variant_id::text
  )
  into v_normalized_payload
  from normalized;

  v_normalized_count := jsonb_array_length(v_normalized_payload);
  v_payload_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_normalized_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  select receipt.payload_hash, receipt.result_payload
  into v_existing_hash, v_existing_result
  from public.variant_cart_merge_receipts as receipt
  where receipt.user_id = v_user_id
    and receipt.merge_token = p_merge_token
  for update;

  if found then
    if v_existing_hash <> v_payload_hash then
      raise exception using
        errcode = '22023',
        message = 'This merge token was already used for different cart data.';
    end if;

    return v_existing_result || jsonb_build_object('idempotent_replay', true);
  end if;

  -- Lock every active product/variant pair in deterministic order before any
  -- receipt or cart write. The locks remain held through the mutation.
  for v_item in
    select entry.item
    from jsonb_array_elements(v_normalized_payload) as entry(item)
    order by
      entry.item ->> 'productId',
      entry.item ->> 'productVariantId'
  loop
    perform public._lock_active_product_variant_v2(
      v_item ->> 'productId',
      (v_item ->> 'productVariantId')::uuid
    );
  end loop;

  insert into public.variant_cart_merge_receipts (
    user_id,
    merge_token,
    payload_hash,
    normalized_payload,
    result_payload
  )
  values (
    v_user_id,
    p_merge_token,
    v_payload_hash,
    v_normalized_payload,
    '{}'::jsonb
  )
  on conflict (user_id, merge_token) do nothing
  returning true into v_claimed;

  if not coalesce(v_claimed, false) then
    select receipt.payload_hash, receipt.result_payload
    into v_existing_hash, v_existing_result
    from public.variant_cart_merge_receipts as receipt
    where receipt.user_id = v_user_id
      and receipt.merge_token = p_merge_token;

    if v_existing_hash is null or v_existing_hash <> v_payload_hash then
      raise exception using
        errcode = '22023',
        message = 'This merge token was already used for different cart data.';
    end if;

    return v_existing_result || jsonb_build_object('idempotent_replay', true);
  end if;

  for v_item in
    select entry.item
    from jsonb_array_elements(v_normalized_payload) as entry(item)
    order by entry.item ->> 'productVariantId'
  loop
    v_product_id := v_item ->> 'productId';
    v_product_variant_id := (v_item ->> 'productVariantId')::uuid;
    v_requested_quantity := (v_item ->> 'requestedQuantity')::integer;
    v_quantity := (v_item ->> 'quantity')::integer;

    select merged.previous_quantity, merged.final_quantity
    into v_previous_quantity, v_final_quantity
    from public._merge_variant_cart_quantity_v2(
      v_user_id,
      v_product_id,
      v_product_variant_id,
      v_quantity
    ) as merged;

    if v_previous_quantity = 0 then
      v_inserted_count := v_inserted_count + 1;
    else
      v_updated_count := v_updated_count + 1;
    end if;

    if v_requested_quantity > v_quantity
       or v_previous_quantity + v_quantity > v_final_quantity then
      v_capped_count := v_capped_count + 1;
    end if;
  end loop;

  select count(*)::integer
  into v_final_item_count
  from public.variant_cart_items as cart
  where cart.user_id = v_user_id;

  v_result := jsonb_build_object(
    'submitted_count', v_submitted_count,
    'normalized_count', v_normalized_count,
    'inserted_count', v_inserted_count,
    'updated_count', v_updated_count,
    'capped_count', v_capped_count,
    'final_item_count', v_final_item_count,
    'idempotent_replay', false
  );

  update public.variant_cart_merge_receipts as receipt
  set result_payload = v_result
  where receipt.user_id = v_user_id
    and receipt.merge_token = p_merge_token;

  return v_result;
exception
  when foreign_key_violation then
    raise exception using
      errcode = '22023',
      message = 'One or more selected product options are unavailable.';
end;
$$;

-- capped_count examples:
--   incoming 15 + 15, existing 0  -> requested 30, effective 20, capped 1
--   incoming 15, existing 10      -> requested 15, final 20, capped 1
--   incoming 5, existing 10       -> requested 5, final 15, capped 0
--   incoming 15 + 15, existing 10 -> both cap paths apply, capped 1 (not 2)

revoke all on function public.get_cart_v2()
from public, anon, authenticated;
revoke all on function public.get_legacy_cart_items_v2()
from public, anon, authenticated;
revoke all on function public.set_cart_item_v2(text, uuid, integer)
from public, anon, authenticated;
revoke all on function public.remove_cart_item_v2(uuid)
from public, anon, authenticated;
revoke all on function public.clear_cart_v2()
from public, anon, authenticated;
revoke all on function public.resolve_legacy_cart_item_v2(text, uuid)
from public, anon, authenticated;
revoke all on function public.merge_guest_cart_v2(jsonb, uuid)
from public, anon, authenticated;

grant execute on function public.get_cart_v2()
to authenticated;
grant execute on function public.get_legacy_cart_items_v2()
to authenticated;
grant execute on function public.set_cart_item_v2(text, uuid, integer)
to authenticated;
grant execute on function public.remove_cart_item_v2(uuid)
to authenticated;
grant execute on function public.clear_cart_v2()
to authenticated;
grant execute on function public.resolve_legacy_cart_item_v2(text, uuid)
to authenticated;
grant execute on function public.merge_guest_cart_v2(jsonb, uuid)
to authenticated;

-- Transactional assertions: v1 cart data and inventory remain unchanged, all
-- seven public v2 RPCs are secure definers with an explicit search_path, and
-- browser roles have no direct table access.
do $validation$
declare
  baseline pg_temp._variant_cart_v2_baseline%rowtype;
  signature text;
  function_oid regprocedure;
  is_security_definer boolean;
  function_config text[];
  v2_cart_rows bigint;
  v2_receipt_rows bigint;
begin
  select * into baseline
  from pg_temp._variant_cart_v2_baseline;

  if to_regclass('public.variant_cart_items') is null
     or to_regclass('public.variant_cart_merge_receipts') is null then
    raise exception 'Variant cart v2 tables were not created.';
  end if;

  if not (
    select class.relrowsecurity
    from pg_catalog.pg_class as class
    where class.oid = 'public.variant_cart_items'::regclass
  ) or not (
    select class.relrowsecurity
    from pg_catalog.pg_class as class
    where class.oid = 'public.variant_cart_merge_receipts'::regclass
  ) then
    raise exception 'RLS must be enabled on variant cart v2 tables.';
  end if;

  if has_table_privilege('anon', 'public.variant_cart_items', 'SELECT')
     or has_table_privilege('anon', 'public.variant_cart_items', 'INSERT')
     or has_table_privilege('anon', 'public.variant_cart_items', 'UPDATE')
     or has_table_privilege('anon', 'public.variant_cart_items', 'DELETE')
     or has_table_privilege('authenticated', 'public.variant_cart_items', 'SELECT')
     or has_table_privilege('authenticated', 'public.variant_cart_items', 'INSERT')
     or has_table_privilege('authenticated', 'public.variant_cart_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.variant_cart_items', 'DELETE')
     or has_table_privilege('anon', 'public.variant_cart_merge_receipts', 'SELECT')
     or has_table_privilege('authenticated', 'public.variant_cart_merge_receipts', 'SELECT') then
    raise exception 'Browser roles must not have direct v2 table privileges.';
  end if;

  foreach signature in array array[
    'public.get_cart_v2()',
    'public.get_legacy_cart_items_v2()',
    'public.set_cart_item_v2(text,uuid,integer)',
    'public.remove_cart_item_v2(uuid)',
    'public.clear_cart_v2()',
    'public.resolve_legacy_cart_item_v2(text,uuid)',
    'public.merge_guest_cart_v2(jsonb,uuid)'
  ]
  loop
    function_oid := to_regprocedure(signature);
    if function_oid is null then
      raise exception 'Missing v2 RPC: %', signature;
    end if;

    select procedure.prosecdef, procedure.proconfig
    into is_security_definer, function_config
    from pg_catalog.pg_proc as procedure
    where procedure.oid = function_oid;

    if not is_security_definer then
      raise exception 'V2 RPC is not SECURITY DEFINER: %', signature;
    end if;

    if not exists (
      select 1
      from unnest(coalesce(function_config, array[]::text[])) as setting(value)
      where setting.value in ('search_path=', 'search_path=""')
    ) then
      raise exception 'V2 RPC does not have an empty search_path: %', signature;
    end if;

    if not has_function_privilege('authenticated', signature, 'EXECUTE')
       or has_function_privilege('anon', signature, 'EXECUTE') then
      raise exception 'Unexpected v2 RPC execution privileges: %', signature;
    end if;
  end loop;

  if to_regprocedure('public.set_cart_item(text,integer)') is null
     or to_regprocedure('public.remove_cart_item(text)') is null
     or to_regprocedure('public.clear_cart()') is null
     or to_regprocedure('public.merge_guest_cart(jsonb,uuid)') is null
     or to_regprocedure('public.cart_product_is_active(text)') is null then
    raise exception 'An existing v1 cart RPC is missing.';
  end if;

  if baseline.v1_cart_rows <> (select count(*) from public.cart_items)
     or baseline.v1_cart_quantity <>
        (select coalesce(sum(quantity), 0) from public.cart_items) then
    raise exception 'The migration changed existing v1 cart data.';
  end if;

  if baseline.inventory_variant_rows <>
       (select count(*) from public.product_variants)
     or baseline.inventory_stock_total <>
       (select coalesce(sum(stock_quantity), 0) from public.product_variants)
     or baseline.inventory_movement_rows <>
       (select count(*) from public.inventory_movements)
     or baseline.inventory_movement_total <>
       (select coalesce(sum(quantity_delta), 0) from public.inventory_movements) then
    raise exception 'The migration changed inventory data.';
  end if;

  if not baseline.v2_cart_preexisting then
    select count(*) into v2_cart_rows
    from public.variant_cart_items;
    if v2_cart_rows <> 0 then
      raise exception 'A new v2 cart table must start empty.';
    end if;
  end if;

  if not baseline.v2_receipts_preexisting then
    select count(*) into v2_receipt_rows
    from public.variant_cart_merge_receipts;
    if v2_receipt_rows <> 0 then
      raise exception 'A new v2 receipt table must start empty.';
    end if;
  end if;
end
$validation$;

-- Rollback before frontend cutover:
--   1. Drop only the seven v2 RPCs and the private lock and merge helpers.
--   2. Drop variant_cart_merge_receipts, then variant_cart_items.
--   3. Drop product_variants_id_product_id_key only after its dependent
--      composite foreign key has been removed.
--   4. Leave every v1 cart object untouched.
-- After Phase 2A3 activation, preserve/export customer v2 rows before any
-- rollback. Disabling the feature flag is safer than dropping customer data.

commit;
