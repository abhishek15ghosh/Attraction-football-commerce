begin;

-- Purpose: secure 24-hour customer cancellation requests with admin approval.
-- Production application date: 2026-07-13.
-- This migration was originally applied manually through the Supabase SQL Editor.
-- It is stored here for database reproducibility and version control.
-- Requires existing orders, order_items, COD payment columns, and public.is_admin().

-- =========================================================
-- 1. CANCELLATION AUDIT FIELDS
-- =========================================================

alter table public.orders
  add column if not exists cancellation_request_status text,
  add column if not exists cancellation_reason text,
  add column if not exists cancellation_requested_at timestamptz,
  add column if not exists cancellation_reviewed_at timestamptz,
  add column if not exists cancellation_reviewed_by uuid,
  add column if not exists cancellation_admin_note text,
  add column if not exists cancelled_at timestamptz;

-- Existing orders remain unchanged and have no cancellation request.
update public.orders
set cancellation_request_status = 'None'
where cancellation_request_status is null;

alter table public.orders
  alter column cancellation_request_status set default 'None',
  alter column cancellation_request_status set not null;

alter table public.orders
  drop constraint if exists orders_cancellation_reviewed_by_fkey;

alter table public.orders
  add constraint orders_cancellation_reviewed_by_fkey
  foreign key (cancellation_reviewed_by)
  references auth.users(id);

alter table public.orders
  drop constraint if exists orders_cancellation_request_status_check,
  drop constraint if exists orders_cancellation_reason_length_check,
  drop constraint if exists orders_cancellation_admin_note_length_check,
  drop constraint if exists orders_cancellation_state_check;

alter table public.orders
  add constraint orders_cancellation_request_status_check
  check (
    cancellation_request_status in (
      'None',
      'Pending',
      'Approved',
      'Rejected'
    )
  );

alter table public.orders
  add constraint orders_cancellation_reason_length_check
  check (
    cancellation_reason is null
    or length(btrim(cancellation_reason)) between 5 and 300
  );

alter table public.orders
  add constraint orders_cancellation_admin_note_length_check
  check (
    cancellation_admin_note is null
    or length(btrim(cancellation_admin_note)) between 1 and 1000
  );

alter table public.orders
  add constraint orders_cancellation_state_check
  check (
    (
      cancellation_request_status = 'None'
      and cancellation_reason is null
      and cancellation_requested_at is null
      and cancellation_reviewed_at is null
      and cancellation_reviewed_by is null
      and cancellation_admin_note is null
      and cancelled_at is null
    )
    or
    (
      cancellation_request_status = 'Pending'
      and cancellation_reason is not null
      and cancellation_requested_at is not null
      and cancellation_reviewed_at is null
      and cancellation_reviewed_by is null
      and cancellation_admin_note is null
      and cancelled_at is null
      and status in ('Pending', 'Confirmed')
      and payment_method = 'COD'
      and payment_status = 'Unpaid'
    )
    or
    (
      cancellation_request_status = 'Approved'
      and cancellation_reason is not null
      and cancellation_requested_at is not null
      and cancellation_reviewed_at is not null
      and cancellation_reviewed_by is not null
      and cancelled_at is not null
      and status = 'Cancelled'
      and payment_method = 'COD'
      and payment_status = 'Unpaid'
    )
    or
    (
      cancellation_request_status = 'Rejected'
      and cancellation_reason is not null
      and cancellation_requested_at is not null
      and cancellation_reviewed_at is not null
      and cancellation_reviewed_by is not null
      and cancellation_admin_note is not null
      and length(btrim(cancellation_admin_note)) between 5 and 1000
      and cancelled_at is null
      and status <> 'Cancelled'
    )
  );

create index if not exists orders_cancellation_pending_idx
  on public.orders (cancellation_requested_at desc)
  where cancellation_request_status = 'Pending';

-- Keep all order writes RPC-only.
revoke insert, update, delete
on table public.orders
from anon, authenticated;

revoke insert, update, delete
on table public.order_items
from anon, authenticated;

-- =========================================================
-- 2. CUSTOMER CANCELLATION-REQUEST RPC
-- =========================================================

create or replace function public.request_order_cancellation(
  p_order_id uuid,
  p_reason text
)
returns table (
  order_id uuid,
  order_status text,
  cancellation_request_status text,
  cancellation_reason text,
  cancellation_requested_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_order_status text;
  v_created_at timestamptz;
  v_payment_method text;
  v_payment_status text;
  v_request_status text;
  v_requested_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication required.';
  end if;

  if p_order_id is null then
    raise exception using
      errcode = '22023',
      message = 'Order ID is required.';
  end if;

  if length(v_reason) not between 5 and 300 then
    raise exception using
      errcode = '22023',
      message = 'Please enter a cancellation reason.';
  end if;

  select
    o.status,
    o.created_at,
    o.payment_method,
    o.payment_status,
    o.cancellation_request_status
  into
    v_order_status,
    v_created_at,
    v_payment_method,
    v_payment_status,
    v_request_status
  from public.orders o
  where o.id = p_order_id
    and o.user_id = v_user_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Order not found.';
  end if;

  if v_request_status = 'Pending' then
    raise exception using
      errcode = 'P0001',
      message = 'Your cancellation request is already awaiting approval.';
  end if;

  -- One cancellation request per order for this version.
  if v_request_status <> 'None' then
    raise exception using
      errcode = 'P0001',
      message = 'This order can no longer be cancelled. Please contact support.';
  end if;

  if v_payment_status = 'Paid' then
    raise exception using
      errcode = 'P0001',
      message = 'Paid orders require support assistance.';
  end if;

  if v_payment_method <> 'COD'
     or v_payment_status <> 'Unpaid' then
    raise exception using
      errcode = 'P0001',
      message = 'This order can no longer be cancelled.';
  end if;

  if v_created_at is null
     or now() > v_created_at + interval '24 hours' then
    raise exception using
      errcode = 'P0001',
      message = 'The 24-hour cancellation window has closed.';
  end if;

  if v_order_status not in ('Pending', 'Confirmed') then
    raise exception using
      errcode = 'P0001',
      message = 'This order can no longer be cancelled.';
  end if;

  update public.orders o
  set
    cancellation_request_status = 'Pending',
    cancellation_reason = v_reason,
    cancellation_requested_at = v_requested_at,
    cancellation_reviewed_at = null,
    cancellation_reviewed_by = null,
    cancellation_admin_note = null,
    cancelled_at = null,
    updated_at = v_requested_at
  where o.id = p_order_id;

  return query
  select
    p_order_id,
    v_order_status,
    'Pending'::text,
    v_reason,
    v_requested_at;
end;
$$;

revoke all on function public.request_order_cancellation(uuid, text)
from public;

revoke execute on function public.request_order_cancellation(uuid, text)
from anon;

grant execute on function public.request_order_cancellation(uuid, text)
to authenticated;

-- =========================================================
-- 3. ADMIN CANCELLATION REVIEW RPC
-- =========================================================

create or replace function public.review_order_cancellation(
  p_order_id uuid,
  p_decision text,
  p_admin_note text
)
returns table (
  order_id uuid,
  order_status text,
  cancellation_request_status text,
  cancellation_reviewed_at timestamptz,
  cancellation_admin_note text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid := auth.uid();
  v_decision text := btrim(coalesce(p_decision, ''));
  v_admin_note text := nullif(btrim(coalesce(p_admin_note, '')), '');
  v_order_status text;
  v_request_status text;
  v_payment_method text;
  v_payment_status text;
  v_reviewed_at timestamptz := now();
begin
  if v_admin_id is null
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

  if v_decision not in ('Approved', 'Rejected') then
    raise exception using
      errcode = '22023',
      message = 'Invalid cancellation decision.';
  end if;

  if v_admin_note is not null
     and length(v_admin_note) > 1000 then
    raise exception using
      errcode = '22023',
      message = 'Admin note is too long.';
  end if;

  if v_decision = 'Rejected'
     and length(coalesce(v_admin_note, '')) < 5 then
    raise exception using
      errcode = '22023',
      message = 'A rejection explanation is required.';
  end if;

  select
    o.status,
    o.cancellation_request_status,
    o.payment_method,
    o.payment_status
  into
    v_order_status,
    v_request_status,
    v_payment_method,
    v_payment_status
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Order not found.';
  end if;

  if v_request_status <> 'Pending' then
    raise exception using
      errcode = 'P0001',
      message = 'This cancellation request has already been reviewed.';
  end if;

  -- Approval requires the order to remain eligible and unpaid.
  if v_decision = 'Approved'
     and (
       v_order_status not in ('Pending', 'Confirmed')
       or v_payment_method <> 'COD'
       or v_payment_status <> 'Unpaid'
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'This cancellation request can no longer be approved.';
  end if;

  -- Rejection deliberately has no payment-status eligibility check.
  -- Any still-Pending request can be rejected by an administrator.
  update public.orders o
  set
    cancellation_request_status = v_decision,
    cancellation_reviewed_at = v_reviewed_at,
    cancellation_reviewed_by = v_admin_id,
    cancellation_admin_note = v_admin_note,
    status = case
      when v_decision = 'Approved' then 'Cancelled'
      else o.status
    end,
    cancelled_at = case
      when v_decision = 'Approved' then v_reviewed_at
      else null
    end,
    updated_at = v_reviewed_at
  where o.id = p_order_id
  returning o.status
  into v_order_status;

  return query
  select
    p_order_id,
    v_order_status,
    v_decision,
    v_reviewed_at,
    v_admin_note;
end;
$$;

revoke all on function public.review_order_cancellation(uuid, text, text)
from public;

revoke execute on function public.review_order_cancellation(uuid, text, text)
from anon;

grant execute on function public.review_order_cancellation(uuid, text, text)
to authenticated;

-- =========================================================
-- 4. FINALITY-SAFE ORDER-STATUS RPC
-- =========================================================

create or replace function public.update_order_status(
  p_order_id uuid,
  p_new_status text
)
returns table (
  order_id uuid,
  order_status text,
  status_updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_status text;
  v_cancellation_status text;
  v_updated_at timestamptz := now();
begin
  if auth.uid() is null
     or not coalesce(public.is_admin(), false) then
    raise exception using
      errcode = '42501',
      message = 'Access denied.';
  end if;

  if p_order_id is null then
    raise exception using
      errcode = '22023',
      message = 'Order ID is required.';
  end if;

  -- New cancellations must go through review_order_cancellation.
  if p_new_status is null
     or p_new_status not in (
       'Pending',
       'Confirmed',
       'Shipped',
       'Delivered'
     ) then
    raise exception using
      errcode = '22023',
      message = 'Invalid order status.';
  end if;

  select
    o.status,
    o.cancellation_request_status
  into
    v_current_status,
    v_cancellation_status
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Order not found.';
  end if;

  if v_current_status = 'Cancelled'
     or v_cancellation_status = 'Approved' then
    raise exception using
      errcode = 'P0001',
      message = 'Cancelled orders cannot be reopened.';
  end if;

  if v_cancellation_status = 'Pending' then
    raise exception using
      errcode = 'P0001',
      message = 'Review the pending cancellation request first.';
  end if;

  update public.orders o
  set
    status = p_new_status,
    updated_at = v_updated_at
  where o.id = p_order_id;

  return query
  select
    p_order_id,
    p_new_status,
    v_updated_at;
end;
$$;

revoke all on function public.update_order_status(uuid, text)
from public;

revoke execute on function public.update_order_status(uuid, text)
from anon;

grant execute on function public.update_order_status(uuid, text)
to authenticated;

-- =========================================================
-- 5. CANCELLATION-SAFE PAYMENT-STATUS RPC
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
  v_order_status text;
  v_cancellation_status text;
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

  select
    o.status,
    o.cancellation_request_status
  into
    v_order_status,
    v_cancellation_status
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Order not found.';
  end if;

  if v_cancellation_status = 'Pending' then
    raise exception using
      errcode = 'P0001',
      message = 'Review the pending cancellation request first.';
  end if;

  if v_cancellation_status = 'Approved'
     or v_order_status = 'Cancelled' then
    raise exception using
      errcode = 'P0001',
      message = 'Payment status cannot be changed for a cancelled order.';
  end if;

  update public.orders as updated_order
  set
    payment_status = p_payment_status,
    payment_collected_at = case
      when p_payment_status = 'Paid'
        then coalesce(updated_order.payment_collected_at, now())
      else null
    end,
    updated_at = now()
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
