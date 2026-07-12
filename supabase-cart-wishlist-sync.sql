begin;

create table if not exists public.cart_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null references public.products(id) on update cascade on delete restrict,
  quantity integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cart_items_pkey primary key (user_id, product_id),
  constraint cart_items_quantity_check check (quantity between 1 and 20)
);

create table if not exists public.wishlist_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null references public.products(id) on update cascade on delete restrict,
  created_at timestamptz not null default now(),
  constraint wishlist_items_pkey primary key (user_id, product_id)
);

create table if not exists public.cart_merge_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  merge_token uuid not null,
  created_at timestamptz not null default now(),
  constraint cart_merge_receipts_pkey primary key (user_id, merge_token)
);

create or replace function public.touch_cart_items_updated_at()
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

drop trigger if exists cart_items_updated_at_trigger on public.cart_items;

create trigger cart_items_updated_at_trigger
before update on public.cart_items
for each row
execute function public.touch_cart_items_updated_at();

revoke execute on function public.touch_cart_items_updated_at()
from public, anon, authenticated;

create or replace function public.cart_product_is_active(p_product_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.products as product
    where product.id = p_product_id
      and product.is_active = true
  );
$$;

revoke execute on function public.cart_product_is_active(text)
from public, anon;

grant execute on function public.cart_product_is_active(text)
to authenticated;

revoke all on table public.cart_items
from public, anon, authenticated;

revoke all on table public.wishlist_items
from public, anon, authenticated;

revoke all on table public.cart_merge_receipts
from public, anon, authenticated;

grant select, delete on table public.cart_items to authenticated;
grant insert (user_id, product_id, quantity) on table public.cart_items to authenticated;
grant update (quantity) on table public.cart_items to authenticated;

grant select, delete on table public.wishlist_items to authenticated;
grant insert (user_id, product_id) on table public.wishlist_items to authenticated;
grant update (product_id) on table public.wishlist_items to authenticated;

alter table public.cart_items enable row level security;
alter table public.wishlist_items enable row level security;
alter table public.cart_merge_receipts enable row level security;

drop policy if exists cart_items_select_own on public.cart_items;
create policy cart_items_select_own
on public.cart_items
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists cart_items_insert_own on public.cart_items;
create policy cart_items_insert_own
on public.cart_items
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and public.cart_product_is_active(product_id)
);

drop policy if exists cart_items_update_own on public.cart_items;
create policy cart_items_update_own
on public.cart_items
for update
to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and public.cart_product_is_active(product_id)
);

drop policy if exists cart_items_delete_own on public.cart_items;
create policy cart_items_delete_own
on public.cart_items
for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists wishlist_items_select_own on public.wishlist_items;
create policy wishlist_items_select_own
on public.wishlist_items
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists wishlist_items_insert_own on public.wishlist_items;
create policy wishlist_items_insert_own
on public.wishlist_items
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and public.cart_product_is_active(product_id)
);

drop policy if exists wishlist_items_update_own on public.wishlist_items;
create policy wishlist_items_update_own
on public.wishlist_items
for update
to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and public.cart_product_is_active(product_id)
);

drop policy if exists wishlist_items_delete_own on public.wishlist_items;
create policy wishlist_items_delete_own
on public.wishlist_items
for delete
to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.set_cart_item(
  p_product_id text,
  p_quantity integer
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_product_id text := btrim(coalesce(p_product_id, ''));
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  if v_product_id = ''
     or p_quantity is null
     or p_quantity < 1
     or p_quantity > 20 then
    raise exception using errcode = '22023', message = 'Invalid cart item.';
  end if;

  if not public.cart_product_is_active(v_product_id) then
    raise exception using errcode = '22023', message = 'Product is unavailable.';
  end if;

  insert into public.cart_items as cart (user_id, product_id, quantity)
  values (v_user_id, v_product_id, p_quantity)
  on conflict (user_id, product_id)
  do update set quantity = excluded.quantity;

  return p_quantity;
end;
$$;

create or replace function public.remove_cart_item(p_product_id text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_product_id text := btrim(coalesce(p_product_id, ''));
  v_deleted integer;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  if v_product_id = '' then
    raise exception using errcode = '22023', message = 'Invalid product.';
  end if;

  delete from public.cart_items
  where user_id = v_user_id
    and product_id = v_product_id;

  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

create or replace function public.clear_cart()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted integer;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  delete from public.cart_items where user_id = v_user_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create or replace function public.merge_guest_cart(
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
  v_requested_count integer;
  v_found_count integer;
  v_merged_count integer;
  v_claimed boolean;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  if p_merge_token is null then
    raise exception using errcode = '22023', message = 'Merge token is required.';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'Invalid guest cart.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) as entry(item)
    where jsonb_typeof(item) <> 'object'
       or btrim(coalesce(item ->> 'product_id', '')) = ''
       or case
            when coalesce(item ->> 'quantity', '') ~ '^[0-9]{1,2}$'
              then (item ->> 'quantity')::integer not between 1 and 20
            else true
          end
  ) then
    raise exception using errcode = '22023', message = 'Guest cart contains an invalid item.';
  end if;

  with requested as (
    select
      btrim(item ->> 'product_id') as product_id,
      least(20, sum((item ->> 'quantity')::integer)::integer) as quantity
    from jsonb_array_elements(p_items) as entry(item)
    group by btrim(item ->> 'product_id')
  )
  select count(*) into v_requested_count from requested;

  with requested as (
    select distinct btrim(item ->> 'product_id') as product_id
    from jsonb_array_elements(p_items) as entry(item)
  )
  select count(*) into v_found_count
  from requested
  join public.products as product
    on product.id = requested.product_id
   and product.is_active = true;

  if v_found_count <> v_requested_count then
    raise exception using errcode = '22023', message = 'One or more products are unavailable.';
  end if;

  insert into public.cart_merge_receipts (user_id, merge_token)
  values (v_user_id, p_merge_token)
  on conflict (user_id, merge_token) do nothing
  returning true into v_claimed;

  if not coalesce(v_claimed, false) then
    return jsonb_build_object(
      'merged', true,
      'already_processed', true,
      'item_count', 0
    );
  end if;

  with requested as (
    select
      btrim(item ->> 'product_id') as product_id,
      least(20, sum((item ->> 'quantity')::integer)::integer) as quantity
    from jsonb_array_elements(p_items) as entry(item)
    group by btrim(item ->> 'product_id')
  )
  insert into public.cart_items as cart (user_id, product_id, quantity)
  select v_user_id, requested.product_id, requested.quantity
  from requested
  join public.products as product
    on product.id = requested.product_id
   and product.is_active = true
  on conflict (user_id, product_id)
  do update set quantity = least(20, cart.quantity + excluded.quantity);

  get diagnostics v_merged_count = row_count;

  return jsonb_build_object(
    'merged', true,
    'already_processed', false,
    'item_count', v_merged_count
  );
end;
$$;

create or replace function public.set_wishlist_item(p_product_id text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_product_id text := btrim(coalesce(p_product_id, ''));
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  if v_product_id = ''
     or not public.cart_product_is_active(v_product_id) then
    raise exception using errcode = '22023', message = 'Product is unavailable.';
  end if;

  insert into public.wishlist_items (user_id, product_id)
  values (v_user_id, v_product_id)
  on conflict (user_id, product_id) do nothing;

  return true;
end;
$$;

create or replace function public.remove_wishlist_item(p_product_id text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_product_id text := btrim(coalesce(p_product_id, ''));
  v_deleted integer;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  if v_product_id = '' then
    raise exception using errcode = '22023', message = 'Invalid product.';
  end if;

  delete from public.wishlist_items
  where user_id = v_user_id
    and product_id = v_product_id;

  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

create or replace function public.merge_guest_wishlist(p_items jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_requested_count integer;
  v_found_count integer;
  v_merged_count integer;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 100 then
    raise exception using errcode = '22023', message = 'Invalid guest wishlist.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) as entry(item)
    where jsonb_typeof(item) <> 'object'
       or btrim(coalesce(item ->> 'product_id', '')) = ''
  ) then
    raise exception using errcode = '22023', message = 'Guest wishlist contains an invalid item.';
  end if;

  with requested as (
    select distinct btrim(item ->> 'product_id') as product_id
    from jsonb_array_elements(p_items) as entry(item)
  )
  select count(*) into v_requested_count from requested;

  with requested as (
    select distinct btrim(item ->> 'product_id') as product_id
    from jsonb_array_elements(p_items) as entry(item)
  )
  select count(*) into v_found_count
  from requested
  join public.products as product
    on product.id = requested.product_id
   and product.is_active = true;

  if v_found_count <> v_requested_count then
    raise exception using errcode = '22023', message = 'One or more products are unavailable.';
  end if;

  with requested as (
    select distinct btrim(item ->> 'product_id') as product_id
    from jsonb_array_elements(p_items) as entry(item)
  )
  insert into public.wishlist_items (user_id, product_id)
  select v_user_id, requested.product_id
  from requested
  join public.products as product
    on product.id = requested.product_id
   and product.is_active = true
  on conflict (user_id, product_id) do nothing;

  get diagnostics v_merged_count = row_count;
  return v_merged_count;
end;
$$;

revoke execute on function public.set_cart_item(text, integer) from public, anon;
revoke execute on function public.remove_cart_item(text) from public, anon;
revoke execute on function public.clear_cart() from public, anon;
revoke execute on function public.merge_guest_cart(jsonb, uuid) from public, anon;
revoke execute on function public.set_wishlist_item(text) from public, anon;
revoke execute on function public.remove_wishlist_item(text) from public, anon;
revoke execute on function public.merge_guest_wishlist(jsonb) from public, anon;

grant execute on function public.set_cart_item(text, integer) to authenticated;
grant execute on function public.remove_cart_item(text) to authenticated;
grant execute on function public.clear_cart() to authenticated;
grant execute on function public.merge_guest_cart(jsonb, uuid) to authenticated;
grant execute on function public.set_wishlist_item(text) to authenticated;
grant execute on function public.remove_wishlist_item(text) to authenticated;
grant execute on function public.merge_guest_wishlist(jsonb) to authenticated;

commit;
