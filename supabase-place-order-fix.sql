begin;

create or replace function public.place_order(
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
  order_status text
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
  v_requested_count integer;
  v_found_count integer;
begin
  if v_user_id is null or v_email is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  if p_checkout_token is null then
    raise exception using errcode = '22023', message = 'Checkout token is required.';
  end if;

  select o.id, o.total_amount, o.status
  into v_order_id, v_total, v_status
  from public.orders o
  where o.checkout_token = p_checkout_token
    and o.user_id = v_user_id;

  if found then
    return query select v_order_id, v_total, v_status;
    return;
  end if;

  if length(btrim(coalesce(p_customer_name, ''))) not between 2 and 120
     or length(btrim(coalesce(p_customer_phone, ''))) not between 6 and 30
     or length(btrim(coalesce(p_address, ''))) not between 5 and 1000
     or length(btrim(coalesce(p_city, ''))) not between 2 and 100
     or length(btrim(coalesce(p_state, ''))) not between 2 and 100
     or coalesce(p_pin_code, '') !~ '^[0-9]{6}$'
     or length(coalesce(p_note, '')) > 1000 then
    raise exception using errcode = '22023', message = 'Invalid checkout details.';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'Your cart is invalid.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) e(item)
    where jsonb_typeof(item) <> 'object'
       or btrim(coalesce(item ->> 'product_id', '')) = ''
       or coalesce(item ->> 'quantity', '') !~ '^[1-9][0-9]*$'
  ) then
    raise exception using errcode = '22023', message = 'Your cart contains an invalid item.';
  end if;

  with requested as (
    select
      btrim(item ->> 'product_id') as product_id,
      sum((item ->> 'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) e(item)
    group by btrim(item ->> 'product_id')
  )
  select count(*) into v_requested_count
  from requested;

  if exists (
    with requested as (
      select
        btrim(item ->> 'product_id') as product_id,
        sum((item ->> 'quantity')::integer)::integer as quantity
      from jsonb_array_elements(p_items) e(item)
      group by btrim(item ->> 'product_id')
    )
    select 1 from requested where quantity > 20
  ) then
    raise exception using errcode = '22023', message = 'Maximum quantity is 20 per product.';
  end if;

  with requested as (
    select
      btrim(item ->> 'product_id') as product_id,
      sum((item ->> 'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) e(item)
    group by btrim(item ->> 'product_id')
  )
  select count(*), coalesce(sum(p.price * r.quantity), 0)
  into v_found_count, v_total
  from requested r
  join public.products p
    on p.id = r.product_id
   and p.is_active = true;

  if v_found_count <> v_requested_count then
    raise exception using errcode = '22023', message = 'One or more products are unavailable.';
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
    checkout_token
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
    p_checkout_token
  )
  on conflict (checkout_token) do nothing
  returning
    created_order.id,
    created_order.total_amount,
    created_order.status
  into v_order_id, v_total, v_status;

  if v_order_id is null then
    select o.id, o.total_amount, o.status
    into v_order_id, v_total, v_status
    from public.orders o
    where o.checkout_token = p_checkout_token
      and o.user_id = v_user_id;

    if v_order_id is null then
      raise exception using
        errcode = '23505',
        message = 'This checkout request has already been used.';
    end if;

    return query select v_order_id, v_total, v_status;
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

  return query select v_order_id, v_total, v_status;
end;
$$;

revoke execute on function public.place_order(
  text, text, text, text, text, text, text, jsonb, uuid
) from public, anon;

grant execute on function public.place_order(
  text, text, text, text, text, text, text, jsonb, uuid
) to authenticated;

commit;
