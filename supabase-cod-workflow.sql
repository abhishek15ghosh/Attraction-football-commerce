begin;

-- =========================================================
-- 1. ADD CASH ON DELIVERY FIELDS
-- =========================================================

alter table public.orders
  add column if not exists payment_method text,
  add column if not exists payment_status text,
  add column if not exists payment_collected_at timestamptz;

-- Existing orders are treated as COD orders that have not yet
-- had payment collection confirmed.
update public.orders
set
  payment_method = coalesce(payment_method, 'COD'),
  payment_status = coalesce(payment_status, 'Unpaid')
where payment_method is null
   or payment_status is null;

update public.orders
set payment_collected_at = null
where payment_status = 'Unpaid';

-- Defensive handling if this migration is resumed after a partial run.
update public.orders
set payment_collected_at = coalesce(payment_collected_at, now())
where payment_status = 'Paid';

alter table public.orders
  alter column payment_method set default 'COD',
  alter column payment_method set not null,
  alter column payment_status set default 'Unpaid',
  alter column payment_status set not null,
  alter column payment_collected_at drop default;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_payment_method_check'
  ) then
    alter table public.orders
      add constraint orders_payment_method_check
      check (payment_method = 'COD');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_payment_status_check'
  ) then
    alter table public.orders
      add constraint orders_payment_status_check
      check (payment_status in ('Unpaid', 'Paid'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_payment_collection_check'
  ) then
    alter table public.orders
      add constraint orders_payment_collection_check
      check (
        (
          payment_status = 'Unpaid'
          and payment_collected_at is null
        )
        or
        (
          payment_status = 'Paid'
          and payment_collected_at is not null
        )
      );
  end if;
end
$migration$;

-- Keep order writes RPC-only.
revoke insert, update, delete
on table public.orders
from anon, authenticated;

revoke insert, update, delete
on table public.order_items
from anon, authenticated;

-- =========================================================
-- 2. REPLACE SECURE PLACE_ORDER RPC
-- =========================================================
-- DROP is required because the return type now includes payment fields.
-- The input signature remains unchanged.

drop function if exists public.place_order(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  uuid
);

create function public.place_order(
  p_customer_name text,
  p_customer_phone text,
  p_address text,
  p_city text,
  p_state text,
  p_pin_code text,
  p_note text,
  p_items jsonb,
  p_checkout_token uuid
)
returns table (
  order_id uuid,
  total_amount numeric,
  order_status text,
  payment_method text,
  payment_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text := nullif(auth.jwt() ->> 'email', '');
  v_order_id uuid;
  v_total numeric(12,2);
  v_status text;
  v_payment_method text;
  v_payment_status text;
  v_requested_count integer;
  v_found_count integer;
begin
  if v_user_id is null or v_email is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication required.';
  end if;

  if p_checkout_token is null then
    raise exception using
      errcode = '22023',
      message = 'Checkout token is required.';
  end if;

  -- Return an existing order for an idempotent retry.
  select
    o.id,
    o.total_amount,
    o.status,
    o.payment_method,
    o.payment_status
  into
    v_order_id,
    v_total,
    v_status,
    v_payment_method,
    v_payment_status
  from public.orders o
  where o.checkout_token = p_checkout_token
    and o.user_id = v_user_id;

  if found then
    return query
    select
      v_order_id,
      v_total,
      v_status,
      v_payment_method,
      v_payment_status;
    return;
  end if;

  if length(btrim(coalesce(p_customer_name, ''))) not between 2 and 120
     or length(btrim(coalesce(p_customer_phone, ''))) not between 6 and 30
     or length(btrim(coalesce(p_address, ''))) not between 5 and 1000
     or length(btrim(coalesce(p_city, ''))) not between 2 and 100
     or length(btrim(coalesce(p_state, ''))) not between 2 and 100
     or coalesce(p_pin_code, '') !~ '^[0-9]{6}$'
     or length(coalesce(p_note, '')) > 1000 then
    raise exception using
      errcode = '22023',
      message = 'Invalid checkout details.';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 50 then
    raise exception using
      errcode = '22023',
      message = 'Your cart is invalid.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) e(item)
    where jsonb_typeof(item) <> 'object'
       or btrim(coalesce(item ->> 'product_id', '')) = ''
       or coalesce(item ->> 'quantity', '') !~ '^[1-9][0-9]*$'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Your cart contains an invalid item.';
  end if;

  with requested as (
    select
      btrim(item ->> 'product_id') as product_id,
      sum((item ->> 'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) e(item)
    group by btrim(item ->> 'product_id')
  )
  select count(*)
  into v_requested_count
  from requested;

  if exists (
    with requested as (
      select
        btrim(item ->> 'product_id') as product_id,
        sum((item ->> 'quantity')::integer)::integer as quantity
      from jsonb_array_elements(p_items) e(item)
      group by btrim(item ->> 'product_id')
    )
    select 1
    from requested
    where quantity > 20
  ) then
    raise exception using
      errcode = '22023',
      message = 'Maximum quantity is 20 per product.';
  end if;

  -- Prices and totals come only from the authoritative catalogue.
  with requested as (
    select
      btrim(item ->> 'product_id') as product_id,
      sum((item ->> 'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) e(item)
    group by btrim(item ->> 'product_id')
  )
  select
    count(*),
    coalesce(sum(p.price * r.quantity), 0)
  into
    v_found_count,
    v_total
  from requested r
  join public.products p
    on p.id = r.product_id
   and p.is_active = true;

  if v_found_count <> v_requested_count then
    raise exception using
      errcode = '22023',
      message = 'One or more products are unavailable.';
  end if;

  insert into public.orders as created_order (
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
    payment_collected_at
  )
  values (
    v_user_id,
    btrim(p_customer_name),
    v_email,
    btrim(p_customer_phone),
    btrim(p_address),
    btrim(p_city),
    btrim(p_state),
    btrim(p_pin_code),
    nullif(btrim(coalesce(p_note, '')), ''),
    v_total,
    'Pending',
    p_checkout_token,
    'COD',
    'Unpaid',
    null
  )
  on conflict (checkout_token) do nothing
  returning
    created_order.id,
    created_order.total_amount,
    created_order.status,
    created_order.payment_method,
    created_order.payment_status
  into
    v_order_id,
    v_total,
    v_status,
    v_payment_method,
    v_payment_status;

  if v_order_id is null then
    select
      o.id,
      o.total_amount,
      o.status,
      o.payment_method,
      o.payment_status
    into
      v_order_id,
      v_total,
      v_status,
      v_payment_method,
      v_payment_status
    from public.orders o
    where o.checkout_token = p_checkout_token
      and o.user_id = v_user_id;

    if v_order_id is null then
      raise exception using
        errcode = '23505',
        message = 'This checkout request has already been used.';
    end if;

    return query
    select
      v_order_id,
      v_total,
      v_status,
      v_payment_method,
      v_payment_status;
    return;
  end if;

  with requested as (
    select
      btrim(item ->> 'product_id') as product_id,
      sum((item ->> 'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) e(item)
    group by btrim(item ->> 'product_id')
  )
  insert into public.order_items (
    order_id,
    product_id,
    product_name,
    product_category,
    product_price,
    quantity,
    product_image
  )
  select
    v_order_id,
    p.id,
    p.name,
    p.category,
    p.price,
    r.quantity,
    p.image
  from requested r
  join public.products p
    on p.id = r.product_id
   and p.is_active = true;

  return query
  select
    v_order_id,
    v_total,
    v_status,
    v_payment_method,
    v_payment_status;
end;
$$;

revoke all on function public.place_order(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  uuid
) from public;

revoke execute on function public.place_order(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  uuid
) from anon;

grant execute on function public.place_order(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  uuid
) to authenticated;

-- =========================================================
-- 3. SECURE ADMIN PAYMENT-STATUS RPC
-- =========================================================

create or replace function public.update_order_payment_status(
  p_order_id uuid,
  p_payment_status text
)
returns table (
  order_id uuid,
  payment_method text,
  payment_status text,
  payment_collected_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_payment_method text;
  v_payment_status text;
  v_payment_collected_at timestamptz;
begin
  if auth.uid() is null
     or not coalesce(public.is_admin(), false) then
    raise exception using
      errcode = '42501',
      message = 'Admin access required.';
  end if;

  if p_order_id is null then
    raise exception using
      errcode = '22023',
      message = 'Order ID is required.';
  end if;

  if p_payment_status is null
     or p_payment_status not in ('Unpaid', 'Paid') then
    raise exception using
      errcode = '22023',
      message = 'Invalid payment status.';
  end if;

  update public.orders as updated_order
  set
    payment_status = p_payment_status,
    payment_collected_at = case
      when p_payment_status = 'Paid'
        then coalesce(updated_order.payment_collected_at, now())
      else null
    end
  where updated_order.id = p_order_id
  returning
    updated_order.id,
    updated_order.payment_method,
    updated_order.payment_status,
    updated_order.payment_collected_at
  into
    v_order_id,
    v_payment_method,
    v_payment_status,
    v_payment_collected_at;

  if v_order_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Order not found.';
  end if;

  return query
  select
    v_order_id,
    v_payment_method,
    v_payment_status,
    v_payment_collected_at;
end;
$$;

revoke all on function public.update_order_payment_status(uuid, text)
from public;

revoke execute on function public.update_order_payment_status(uuid, text)
from anon;

grant execute on function public.update_order_payment_status(uuid, text)
to authenticated;

commit;
