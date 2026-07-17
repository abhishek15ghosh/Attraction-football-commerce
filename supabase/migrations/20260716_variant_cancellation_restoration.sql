begin;

set transaction isolation level repeatable read;

-- Phase 2B2: one-time, admin-approved cancellation stock restoration.
--
-- This additive migration replaces only the existing
-- public.review_order_cancellation(uuid, text, text) implementation. It keeps
-- the established request, order-status, payment-status, V1 checkout, and V2
-- checkout contracts unchanged.
--
-- Legacy V1 orders have inventory_deducted_at IS NULL and remain on the
-- existing cancellation path: approval changes cancellation/order audit fields
-- but never changes inventory or creates an inventory movement.
--
-- Stock-aware V2 orders have inventory_deducted_at IS NOT NULL. Their stock is
-- restored only by the first valid Approved decision, in the same transaction
-- as the cancellation decision. Rejected and Pending requests never restore.

-- =========================================================
-- 1. PRECONDITIONS AND MUTABLE-DATA BASELINE
-- =========================================================

do $preconditions$
declare
  v_extension_schema text;
  v_deduction_index_matches integer;
  v_restoration_index_matches integer;
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

  if to_regclass('public.orders') is null
     or to_regclass('public.order_items') is null
     or to_regclass('public.product_variants') is null
     or to_regclass('public.inventory_movements') is null then
    raise exception 'A required Phase 2B2 table is missing.';
  end if;

  if to_regprocedure(
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
     ) is null
     or to_regprocedure(
       'public.place_order_v2(jsonb,jsonb,uuid)'
     ) is null
     or to_regprocedure('public.is_admin()') is null then
    raise exception 'A required Phase 2B2 function is missing.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'public.orders'::regclass
      and attribute.attname = 'inventory_deducted_at'
      and attribute.atttypid = 'timestamptz'::regtype
      and not attribute.attisdropped
  )
  or not exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'public.orders'::regclass
      and attribute.attname = 'inventory_restored_at'
      and attribute.atttypid = 'timestamptz'::regtype
      and not attribute.attisdropped
  )
  or not exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'public.order_items'::regclass
      and attribute.attname = 'product_variant_id'
      and attribute.atttypid = 'uuid'::regtype
      and not attribute.attisdropped
  ) then
    raise exception 'Required inventory compatibility columns are missing.';
  end if;

  select count(*)::integer
  into v_deduction_index_matches
  from pg_catalog.pg_index as index_definition
  where index_definition.indrelid = 'public.inventory_movements'::regclass
    and index_definition.indisunique
    and index_definition.indisvalid
    and index_definition.indpred is not null
    and (
      select array_agg(attribute.attname order by key_column.ordinality)
      from unnest(index_definition.indkey)
        with ordinality as key_column(attnum, ordinality)
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = index_definition.indrelid
       and attribute.attnum = key_column.attnum
      where key_column.ordinality <= index_definition.indnkeyatts
    ) = array['order_id', 'product_variant_id']::name[]
    and regexp_replace(
      lower(pg_catalog.pg_get_expr(
        index_definition.indpred,
        index_definition.indrelid
      )),
      '[[:space:]()]',
      '',
      'g'
    ) in (
      'movement_type=''orderdeduction''::textandorder_idisnotnull',
      'movement_type=''orderdeduction''andorder_idisnotnull'
    );

  if v_deduction_index_matches < 1 then
    raise exception
      'The Order Deduction unique index protection is missing or invalid.';
  end if;

  select count(*)::integer
  into v_restoration_index_matches
  from pg_catalog.pg_index as index_definition
  where index_definition.indrelid = 'public.inventory_movements'::regclass
    and index_definition.indisunique
    and index_definition.indisvalid
    and index_definition.indpred is not null
    and (
      select array_agg(attribute.attname order by key_column.ordinality)
      from unnest(index_definition.indkey)
        with ordinality as key_column(attnum, ordinality)
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = index_definition.indrelid
       and attribute.attnum = key_column.attnum
      where key_column.ordinality <= index_definition.indnkeyatts
    ) = array['order_id', 'product_variant_id']::name[]
    and regexp_replace(
      lower(pg_catalog.pg_get_expr(
        index_definition.indpred,
        index_definition.indrelid
      )),
      '[[:space:]()]',
      '',
      'g'
    ) in (
      'movement_type=''cancellationrestoration''::textandorder_idisnotnull',
      'movement_type=''cancellationrestoration''andorder_idisnotnull'
    );

  if v_restoration_index_matches < 1 then
    raise exception
      'The cancellation-restoration unique index is missing or invalid.';
  end if;

  if has_function_privilege(
       'anon',
       'public.review_order_cancellation(uuid,text,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated',
       'public.review_order_cancellation(uuid,text,text)',
       'EXECUTE'
     ) then
    raise exception
      'The existing cancellation-review execution contract is invalid.';
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

create temporary table _cancellation_restoration_data_baseline (
  order_rows bigint not null,
  order_item_rows bigint not null,
  variant_rows bigint not null,
  variant_stock_total bigint not null,
  movement_rows bigint not null,
  movement_quantity_total bigint not null,
  variant_fingerprint text not null,
  movement_fingerprint text not null,
  cancellation_fingerprint text not null
) on commit drop;

insert into pg_temp._cancellation_restoration_data_baseline (
  order_rows,
  order_item_rows,
  variant_rows,
  variant_stock_total,
  movement_rows,
  movement_quantity_total,
  variant_fingerprint,
  movement_fingerprint,
  cancellation_fingerprint
)
select
  (select count(*) from public.orders),
  (select count(*) from public.order_items),
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
                variant.stock_quantity,
                variant.low_stock_threshold,
                variant.is_active,
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
  pg_catalog.md5(
    coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_array(
            order_row.id,
            order_row.status,
            order_row.payment_method,
            order_row.payment_status,
            order_row.cancellation_request_status,
            order_row.cancellation_reason,
            order_row.cancellation_requested_at,
            order_row.cancellation_reviewed_at,
            order_row.cancellation_reviewed_by,
            order_row.cancellation_admin_note,
            order_row.cancelled_at,
            order_row.inventory_deducted_at,
            order_row.inventory_restored_at,
            order_row.updated_at
          )
          order by order_row.id
        )::text
        from public.orders as order_row
      ),
      '[]'
    )
  );

create temporary table _cancellation_restoration_function_baseline (
  function_signature text primary key,
  function_oid oid not null,
  function_owner oid not null,
  function_definition text not null,
  function_acl text,
  anon_execute boolean not null,
  authenticated_execute boolean not null
) on commit drop;

insert into pg_temp._cancellation_restoration_function_baseline (
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
    ('public.request_order_cancellation(uuid,text)'),
    ('public.update_order_status(uuid,text)'),
    ('public.update_order_payment_status(uuid,text)'),
    ('public.place_order_v2(jsonb,jsonb,uuid)')
) as expected(function_signature)
join pg_catalog.pg_proc as procedure
  on procedure.oid = to_regprocedure(expected.function_signature);

create temporary table _cancellation_review_function_baseline (
  function_oid oid primary key,
  function_owner oid not null,
  function_result text not null,
  function_acl text,
  anon_execute boolean not null,
  authenticated_execute boolean not null,
  public_execute boolean not null
) on commit drop;

insert into pg_temp._cancellation_review_function_baseline (
  function_oid,
  function_owner,
  function_result,
  function_acl,
  anon_execute,
  authenticated_execute,
  public_execute
)
select
  procedure.oid,
  procedure.proowner,
  pg_catalog.pg_get_function_result(procedure.oid),
  procedure.proacl::text,
  has_function_privilege('anon', procedure.oid, 'EXECUTE'),
  has_function_privilege('authenticated', procedure.oid, 'EXECUTE'),
  exists (
    select 1
    from pg_catalog.aclexplode(
      coalesce(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) as privilege
    where privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  )
from pg_catalog.pg_proc as procedure
where procedure.oid = to_regprocedure(
  'public.review_order_cancellation(uuid,text,text)'
);

-- =========================================================
-- 2. STOCK-AWARE ADMIN CANCELLATION REVIEW RPC
-- =========================================================
-- Existing signature and return contract:
--   public.review_order_cancellation(uuid, text, text)
--   TABLE(order_id uuid, order_status text,
--         cancellation_request_status text,
--         cancellation_reviewed_at timestamptz,
--         cancellation_admin_note text)

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
as $function$
declare
  v_admin_id uuid := auth.uid();
  v_decision text := btrim(coalesce(p_decision, ''));
  v_admin_note text := nullif(btrim(coalesce(p_admin_note, '')), '');
  v_order_status text;
  v_request_status text;
  v_payment_method text;
  v_payment_status text;
  v_inventory_deducted_at timestamptz;
  v_inventory_restored_at timestamptz;
  v_reviewed_at timestamptz := transaction_timestamp();
  v_order_item_rows bigint;
  v_invalid_item_rows bigint;
  v_expected_variant_rows bigint;
  v_invalid_relationship_rows bigint;
  v_deduction_movement_rows bigint;
  v_deduction_mismatch_rows bigint;
  v_restoration_movement_rows bigint;
  v_restoration_mismatch_rows bigint;
  v_current_stock integer;
  v_resulting_stock integer;
  v_restoration record;
  v_internal_error text;
  v_internal_detail text;
  v_internal_hint text;
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

  -- Lock the order before evaluating the decision. The existing status and
  -- payment RPCs use the same order-row lock, so approval/rejection cannot race
  -- with another review or a restricted status/payment mutation.
  select
    order_row.status,
    order_row.cancellation_request_status,
    order_row.payment_method,
    order_row.payment_status,
    order_row.inventory_deducted_at,
    order_row.inventory_restored_at
  into
    v_order_status,
    v_request_status,
    v_payment_method,
    v_payment_status,
    v_inventory_deducted_at,
    v_inventory_restored_at
  from public.orders as order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Order not found.';
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

  -- A V2 restoration marker and its movements are an inseparable audit unit.
  -- Audit them before returning the existing already-reviewed finality error so
  -- a corrupted completed state cannot be silently treated as healthy.
  select count(*)
  into v_restoration_movement_rows
  from public.inventory_movements as movement
  where movement.order_id = p_order_id
    and movement.movement_type = 'Cancellation Restoration';

  if v_inventory_deducted_at is null
     and (
       v_inventory_restored_at is not null
       or v_restoration_movement_rows > 0
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'Inventory audit data is inconsistent. Cancellation cannot be approved safely.';
  end if;

  if v_inventory_deducted_at is not null then
    if v_inventory_restored_at is null
       and v_restoration_movement_rows > 0 then
      raise exception using
        errcode = 'P0001',
        message = 'Inventory audit data is inconsistent. Cancellation cannot be approved safely.';
    end if;

    -- Approval requires a complete historical variant snapshot. A completed
    -- restoration marker also requires that snapshot for audit reconciliation.
    -- A normal rejection with no restoration marker/movement does not depend on
    -- item suitability, preserving the established always-rejectable workflow.
    if v_decision = 'Approved'
       or v_inventory_restored_at is not null then
      select
        count(*),
        count(*) filter (
          where order_item.product_variant_id is null
             or order_item.product_id is null
             or order_item.quantity is null
             or order_item.quantity <= 0
        )
      into
        v_order_item_rows,
        v_invalid_item_rows
      from public.order_items as order_item
      where order_item.order_id = p_order_id;

      if v_order_item_rows = 0 or v_invalid_item_rows > 0 then
        raise exception using
          errcode = 'P0001',
          message = 'Inventory audit data is inconsistent. Cancellation cannot be approved safely.';
      end if;

      if exists (
        select 1
        from public.order_items as order_item
        where order_item.order_id = p_order_id
        group by order_item.product_variant_id
        having count(distinct order_item.product_id) <> 1
      ) then
        raise exception using
          errcode = 'P0001',
          message = 'Inventory audit data is inconsistent. Cancellation cannot be approved safely.';
      end if;

      with expected as (
        select
          order_item.product_variant_id,
          order_item.product_id,
          sum(order_item.quantity)::bigint as restore_quantity
        from public.order_items as order_item
        where order_item.order_id = p_order_id
        group by
          order_item.product_variant_id,
          order_item.product_id
      )
      select
        count(*),
        count(*) filter (where variant.id is null)
      into
        v_expected_variant_rows,
        v_invalid_relationship_rows
      from expected
      left join public.product_variants as variant
        on variant.id = expected.product_variant_id
       and variant.product_id = expected.product_id;

      if v_expected_variant_rows = 0
         or v_invalid_relationship_rows > 0 then
        raise exception using
          errcode = 'P0001',
          message = 'Inventory audit data is inconsistent. Cancellation cannot be approved safely.';
      end if;
    end if;

    if v_decision = 'Approved' then
      select count(*)
      into v_deduction_movement_rows
      from public.inventory_movements as movement
      where movement.order_id = p_order_id
        and movement.movement_type = 'Order Deduction';

      -- place_order_v2 writes every Order Deduction movement and
      -- orders.inventory_deducted_at from the same v_inventory_timestamp value,
      -- initialized with transaction_timestamp(). Exact timestamp equality is
      -- therefore the deployed contract, not an arbitrary tolerance window.
      with expected as (
        select
          order_item.product_variant_id,
          order_item.product_id,
          sum(order_item.quantity)::bigint as ordered_quantity
        from public.order_items as order_item
        where order_item.order_id = p_order_id
        group by
          order_item.product_variant_id,
          order_item.product_id
      ),
      actual as (
        select
          movement.product_variant_id,
          count(*)::bigint as movement_count,
          sum(movement.quantity_delta)::bigint as quantity_delta,
          min(movement.resulting_stock_quantity) as minimum_resulting_stock,
          min(movement.created_at) as first_movement_at,
          max(movement.created_at) as last_movement_at
        from public.inventory_movements as movement
        where movement.order_id = p_order_id
          and movement.movement_type = 'Order Deduction'
        group by movement.product_variant_id
      )
      select count(*)
      into v_deduction_mismatch_rows
      from expected
      full join actual
        on actual.product_variant_id = expected.product_variant_id
      where expected.product_variant_id is null
         or actual.product_variant_id is null
         or actual.movement_count <> 1
         or actual.quantity_delta <> -expected.ordered_quantity
         or actual.minimum_resulting_stock < 0
         or actual.first_movement_at <> v_inventory_deducted_at
         or actual.last_movement_at <> v_inventory_deducted_at;

      if v_deduction_mismatch_rows > 0
         or v_deduction_movement_rows <> v_expected_variant_rows then
        raise exception using
          errcode = 'P0001',
          message = 'Inventory audit data is inconsistent. Cancellation cannot be approved safely.';
      end if;
    end if;

    if v_inventory_restored_at is not null then
      with expected as (
        select
          order_item.product_variant_id,
          sum(order_item.quantity)::bigint as restore_quantity
        from public.order_items as order_item
        where order_item.order_id = p_order_id
        group by order_item.product_variant_id
      ),
      actual as (
        select
          movement.product_variant_id,
          count(*)::bigint as movement_count,
          sum(movement.quantity_delta)::bigint as restored_quantity,
          min(movement.created_at) as first_movement_at,
          max(movement.created_at) as last_movement_at
        from public.inventory_movements as movement
        where movement.order_id = p_order_id
          and movement.movement_type = 'Cancellation Restoration'
        group by movement.product_variant_id
      )
      select count(*)
      into v_restoration_mismatch_rows
      from expected
      full join actual
        on actual.product_variant_id = expected.product_variant_id
      where expected.product_variant_id is null
         or actual.product_variant_id is null
         or actual.movement_count <> 1
         or actual.restored_quantity <> expected.restore_quantity
         or actual.first_movement_at <> v_inventory_restored_at
         or actual.last_movement_at <> v_inventory_restored_at;

      if v_restoration_mismatch_rows > 0
         or v_restoration_movement_rows <> v_expected_variant_rows
         or v_inventory_restored_at < v_inventory_deducted_at
         or v_request_status <> 'Approved'
         or v_order_status <> 'Cancelled' then
        raise exception using
          errcode = 'P0001',
          message = 'Inventory audit data is inconsistent. Cancellation cannot be approved safely.';
      end if;
    end if;
  end if;

  if v_request_status <> 'Pending' then
    raise exception using
      errcode = 'P0001',
      message = 'This cancellation request has already been reviewed.';
  end if;

  -- Approval keeps the established COD/unpaid/status eligibility contract.
  -- Rejection deliberately remains possible for every Pending request.
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

  if v_decision = 'Approved'
     and v_inventory_deducted_at is not null then
    if v_inventory_restored_at is not null then
      raise exception using
        errcode = 'P0001',
        message = 'Inventory audit data is inconsistent. Cancellation cannot be approved safely.';
    end if;

    if v_reviewed_at < v_inventory_deducted_at then
      raise exception using
        errcode = 'P0001',
        message = 'Inventory audit data is inconsistent. Cancellation cannot be approved safely.';
    end if;

    -- Lock every expected variant before changing any stock. The ordering is
    -- identical to place_order_v2: product identity, then variant UUID.
    for v_restoration in
      select
        order_item.product_id,
        order_item.product_variant_id,
        sum(order_item.quantity)::bigint as restore_quantity
      from public.order_items as order_item
      where order_item.order_id = p_order_id
      group by
        order_item.product_id,
        order_item.product_variant_id
      order by
        order_item.product_id,
        order_item.product_variant_id
    loop
      select variant.stock_quantity
      into v_current_stock
      from public.product_variants as variant
      where variant.id = v_restoration.product_variant_id
        and variant.product_id = v_restoration.product_id
      for update;

      if not found
         or v_restoration.restore_quantity <= 0
         or v_restoration.restore_quantity > 2147483647::bigint
         or v_current_stock::bigint
              + v_restoration.restore_quantity > 2147483647::bigint then
        raise exception using
          errcode = 'P0001',
          message = 'Inventory audit data is inconsistent. Cancellation cannot be approved safely.';
      end if;
    end loop;

    -- All variant locks are now held. Each stock update and matching movement
    -- shares this function transaction with the final cancellation decision.
    for v_restoration in
      select
        order_item.product_id,
        order_item.product_variant_id,
        sum(order_item.quantity)::bigint as restore_quantity
      from public.order_items as order_item
      where order_item.order_id = p_order_id
      group by
        order_item.product_id,
        order_item.product_variant_id
      order by
        order_item.product_id,
        order_item.product_variant_id
    loop
      update public.product_variants as variant
      set stock_quantity =
        variant.stock_quantity + v_restoration.restore_quantity::integer
      where variant.id = v_restoration.product_variant_id
        and variant.product_id = v_restoration.product_id
      returning variant.stock_quantity
      into v_resulting_stock;

      if not found then
        raise exception using
          errcode = 'P0001',
          message = 'Inventory audit data is inconsistent. Cancellation cannot be approved safely.';
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
        v_restoration.product_variant_id,
        p_order_id,
        'Cancellation Restoration',
        v_restoration.restore_quantity::integer,
        v_resulting_stock,
        v_admin_id,
        'Stock restored after approved order cancellation.',
        v_reviewed_at
      );
    end loop;
  end if;

  update public.orders as order_row
  set
    cancellation_request_status = v_decision,
    cancellation_reviewed_at = v_reviewed_at,
    cancellation_reviewed_by = v_admin_id,
    cancellation_admin_note = v_admin_note,
    status = case
      when v_decision = 'Approved' then 'Cancelled'
      else order_row.status
    end,
    cancelled_at = case
      when v_decision = 'Approved' then v_reviewed_at
      else null
    end,
    inventory_restored_at = case
      when v_decision = 'Approved'
       and v_inventory_deducted_at is not null
        then v_reviewed_at
      else order_row.inventory_restored_at
    end,
    updated_at = v_reviewed_at
  where order_row.id = p_order_id
  returning order_row.status
  into v_order_status;

  return query
  select
    p_order_id,
    v_order_status,
    v_decision,
    v_reviewed_at,
    v_admin_note;
exception
  when raise_exception
    or insufficient_privilege
    or invalid_parameter_value
    or no_data_found then
    raise;
  when others then
    get stacked diagnostics
      v_internal_error = message_text,
      v_internal_detail = pg_exception_detail,
      v_internal_hint = pg_exception_hint;

    raise log
      'review_order_cancellation restoration failed: %, detail: %, hint: %',
      v_internal_error,
      coalesce(v_internal_detail, ''),
      coalesce(v_internal_hint, '');

    raise exception using
      errcode = 'P0001',
      message = 'We could not review this cancellation request. Please try again.';
end;
$function$;

-- CREATE OR REPLACE preserves the existing function ACL. No privilege statement
-- is issued here; the validation below requires authenticated execution and no
-- anon/PUBLIC execution, exactly matching the approved administration contract.

-- =========================================================
-- 3. TRANSACTIONAL MIGRATION VALIDATION
-- =========================================================

do $validation$
declare
  baseline pg_temp._cancellation_restoration_data_baseline%rowtype;
  review_baseline pg_temp._cancellation_review_function_baseline%rowtype;
  v_current_variant_fingerprint text;
  v_current_movement_fingerprint text;
  v_current_cancellation_fingerprint text;
  v_review_oid regprocedure;
  v_review_owner oid;
  v_review_result text;
  v_review_acl text;
  v_review_security_definer boolean;
  v_review_config text[];
  v_review_definition text;
  v_public_execute boolean;
begin
  select *
  into baseline
  from pg_temp._cancellation_restoration_data_baseline;

  select *
  into review_baseline
  from pg_temp._cancellation_review_function_baseline;

  v_current_variant_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_array(
                variant.id,
                variant.product_id,
                variant.stock_quantity,
                variant.low_stock_threshold,
                variant.is_active,
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

  v_current_cancellation_fingerprint := pg_catalog.md5(
    coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_array(
            order_row.id,
            order_row.status,
            order_row.payment_method,
            order_row.payment_status,
            order_row.cancellation_request_status,
            order_row.cancellation_reason,
            order_row.cancellation_requested_at,
            order_row.cancellation_reviewed_at,
            order_row.cancellation_reviewed_by,
            order_row.cancellation_admin_note,
            order_row.cancelled_at,
            order_row.inventory_deducted_at,
            order_row.inventory_restored_at,
            order_row.updated_at
          )
          order by order_row.id
        )::text
        from public.orders as order_row
      ),
      '[]'
    )
  );

  if baseline.order_rows <> (select count(*) from public.orders)
     or baseline.order_item_rows <>
          (select count(*) from public.order_items)
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
          v_current_movement_fingerprint
     or baseline.cancellation_fingerprint is distinct from
          v_current_cancellation_fingerprint then
    raise exception
      'Phase 2B2 migration execution changed mutable production data.';
  end if;

  if exists (
    select 1
    from pg_temp._cancellation_restoration_function_baseline as protected
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
    raise exception
      'A protected request/status/payment/checkout function changed.';
  end if;

  v_review_oid := to_regprocedure(
    'public.review_order_cancellation(uuid,text,text)'
  );

  if v_review_oid is null
     or v_review_oid::oid <> review_baseline.function_oid then
    raise exception
      'The cancellation-review function identity changed.';
  end if;

  select
    procedure.proowner,
    pg_catalog.pg_get_function_result(procedure.oid),
    procedure.proacl::text,
    procedure.prosecdef,
    procedure.proconfig,
    pg_catalog.pg_get_functiondef(procedure.oid)
  into
    v_review_owner,
    v_review_result,
    v_review_acl,
    v_review_security_definer,
    v_review_config,
    v_review_definition
  from pg_catalog.pg_proc as procedure
  where procedure.oid = v_review_oid;

  if v_review_owner <> review_baseline.function_owner
     or v_review_result is distinct from review_baseline.function_result
     or v_review_acl is distinct from review_baseline.function_acl then
    raise exception
      'The cancellation-review owner, return contract, or ACL changed.';
  end if;

  if not v_review_security_definer then
    raise exception
      'review_order_cancellation must remain SECURITY DEFINER.';
  end if;

  if not exists (
    select 1
    from unnest(coalesce(v_review_config, array[]::text[])) as setting(value)
    where setting.value in ('search_path=', 'search_path=""')
  ) then
    raise exception
      'review_order_cancellation must retain an empty search_path.';
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
    where procedure.oid = v_review_oid
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  )
  into v_public_execute;

  if v_public_execute
     or has_function_privilege(
       'anon',
       v_review_oid,
       'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated',
       v_review_oid,
       'EXECUTE'
     ) then
    raise exception
      'The cancellation-review execution privileges are invalid.';
  end if;

  if position(
       'Cancellation Restoration' in v_review_definition
     ) = 0
     or position(
       'Order Deduction' in v_review_definition
     ) = 0
     or position(
       'for update' in lower(v_review_definition)
     ) = 0
     or position(
       'inventory_restored_at' in v_review_definition
     ) = 0 then
    raise exception
      'The stock-restoration implementation is incomplete.';
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
$validation$;

-- =========================================================
-- 4. READ-ONLY POST-MIGRATION VERIFICATION QUERIES
-- =========================================================
-- Run these separately after deployment. They are intentionally comments and
-- are not executed by this migration.
--
-- Signature and return contract:
-- select to_regprocedure(
--   'public.review_order_cancellation(uuid,text,text)'
-- ) as review_signature;
-- select pg_catalog.pg_get_function_result(
--   to_regprocedure('public.review_order_cancellation(uuid,text,text)')
-- ) as review_result;
--
-- SECURITY DEFINER and empty search_path:
-- select procedure.prosecdef, procedure.proconfig
-- from pg_catalog.pg_proc as procedure
-- where procedure.oid = to_regprocedure(
--   'public.review_order_cancellation(uuid,text,text)'
-- );
--
-- Browser execution privileges:
-- select
--   has_function_privilege(
--     'anon',
--     'public.review_order_cancellation(uuid,text,text)',
--     'EXECUTE'
--   ) as anon_review_execute,
--   has_function_privilege(
--     'authenticated',
--     'public.review_order_cancellation(uuid,text,text)',
--     'EXECUTE'
--   ) as authenticated_review_execute,
--   has_function_privilege(
--     'authenticated',
--     'public.place_order_v2(jsonb,jsonb,uuid)',
--     'EXECUTE'
--   ) as authenticated_place_order_v2_execute;
--
-- Current V2 deduction/restoration markers:
-- select
--   count(*) filter (where inventory_deducted_at is not null)
--     as deducted_orders,
--   count(*) filter (where inventory_restored_at is not null)
--     as restored_orders
-- from public.orders;
--
-- Restoration movement count and total units:
-- select
--   count(*) as restoration_movements,
--   coalesce(sum(quantity_delta), 0) as restored_units
-- from public.inventory_movements
-- where movement_type = 'Cancellation Restoration';
--
-- Deduction evidence reconciliation (expected: no rows):
-- with expected as (
--   select
--     item.order_id,
--     item.product_variant_id,
--     sum(item.quantity)::bigint as ordered_quantity
--   from public.order_items as item
--   join public.orders as order_row on order_row.id = item.order_id
--   where order_row.inventory_deducted_at is not null
--   group by item.order_id, item.product_variant_id
-- ), actual as (
--   select
--     movement.order_id,
--     movement.product_variant_id,
--     count(*)::bigint as movement_count,
--     sum(movement.quantity_delta)::bigint as quantity_delta,
--     min(movement.created_at) as first_movement_at,
--     max(movement.created_at) as last_movement_at
--   from public.inventory_movements as movement
--   where movement.movement_type = 'Order Deduction'
--   group by movement.order_id, movement.product_variant_id
-- )
-- select
--   coalesce(expected.order_id, actual.order_id) as order_id,
--   coalesce(expected.product_variant_id, actual.product_variant_id)
--     as product_variant_id
-- from expected
-- full join actual using (order_id, product_variant_id)
-- join public.orders as order_row
--   on order_row.id = coalesce(expected.order_id, actual.order_id)
-- where expected.product_variant_id is null
--    or actual.product_variant_id is null
--    or actual.movement_count <> 1
--    or actual.quantity_delta <> -expected.ordered_quantity
--    or actual.first_movement_at <> order_row.inventory_deducted_at
--    or actual.last_movement_at <> order_row.inventory_deducted_at;
--
-- Orders marked restored but missing one or more expected movements:
-- with expected as (
--   select
--     item.order_id,
--     item.product_variant_id,
--     sum(item.quantity)::bigint as expected_quantity
--   from public.order_items as item
--   join public.orders as order_row on order_row.id = item.order_id
--   where order_row.inventory_restored_at is not null
--   group by item.order_id, item.product_variant_id
-- ), actual as (
--   select
--     movement.order_id,
--     movement.product_variant_id,
--     sum(movement.quantity_delta)::bigint as restored_quantity
--   from public.inventory_movements as movement
--   where movement.movement_type = 'Cancellation Restoration'
--   group by movement.order_id, movement.product_variant_id
-- )
-- select expected.*
-- from expected
-- left join actual using (order_id, product_variant_id)
-- where actual.product_variant_id is null
--    or actual.restored_quantity <> expected.expected_quantity;
--
-- Restoration movements whose order has no restoration marker:
-- select movement.*
-- from public.inventory_movements as movement
-- join public.orders as order_row on order_row.id = movement.order_id
-- where movement.movement_type = 'Cancellation Restoration'
--   and order_row.inventory_restored_at is null;
--
-- Restored-quantity reconciliation by order and variant:
-- with expected as (
--   select
--     item.order_id,
--     item.product_variant_id,
--     sum(item.quantity)::bigint as expected_quantity
--   from public.order_items as item
--   where item.product_variant_id is not null
--   group by item.order_id, item.product_variant_id
-- ), actual as (
--   select
--     movement.order_id,
--     movement.product_variant_id,
--     sum(movement.quantity_delta)::bigint as restored_quantity
--   from public.inventory_movements as movement
--   where movement.movement_type = 'Cancellation Restoration'
--   group by movement.order_id, movement.product_variant_id
-- )
-- select
--   expected.order_id,
--   expected.product_variant_id,
--   expected.expected_quantity,
--   actual.restored_quantity
-- from expected
-- join public.orders as order_row on order_row.id = expected.order_id
-- left join actual using (order_id, product_variant_id)
-- where order_row.inventory_restored_at is not null
-- order by expected.order_id, expected.product_variant_id;
--
-- Duplicate restoration movement check (expected: no rows):
-- select order_id, product_variant_id, count(*)
-- from public.inventory_movements
-- where movement_type = 'Cancellation Restoration'
-- group by order_id, product_variant_id
-- having count(*) > 1;
--
-- V1 cancelled orders remain unrestored and have no restoration movement:
-- select order_row.id
-- from public.orders as order_row
-- where order_row.status = 'Cancelled'
--   and order_row.inventory_deducted_at is null
--   and (
--     order_row.inventory_restored_at is not null
--     or exists (
--       select 1
--       from public.inventory_movements as movement
--       where movement.order_id = order_row.id
--         and movement.movement_type = 'Cancellation Restoration'
--     )
--   );
--
-- Inventory snapshot (capture immediately before and after migration; values
-- must be identical because migration execution performs no restoration):
-- select
--   count(*) as variant_rows,
--   coalesce(sum(stock_quantity), 0) as total_stock
-- from public.product_variants;
-- select
--   count(*) as movement_rows,
--   coalesce(sum(quantity_delta), 0) as movement_quantity_total
-- from public.inventory_movements;

-- =========================================================
-- 5. CONTROLLED TEST PLAN (DO NOT RUN IN PRODUCTION CASUALLY)
-- =========================================================
-- 1. Approve a pending V1 order and confirm no stock/movement/restore marker.
-- 2. Approve a V2 one-variant order and reconcile quantity, movement, and marker.
-- 3. Approve a V2 two-variant order and reconcile both locked variants.
-- 4. Retry the same approval and confirm the existing reviewed finality error.
-- 5. Race two admin approvals and confirm only one commits restoration.
-- 6. Reject a V2 request and confirm no restoration or marker is created.
-- 7. Deactivate a variant, approve its cancellation, and confirm restoration.
-- 8. Force a second-item failure in a disposable transaction and confirm the
--    first update/movement and the cancellation decision all roll back.
-- 9. Construct each inconsistent marker/movement state in a disposable
--    transaction and confirm approval fails without changing stock.
-- 10. Remove, duplicate, add, retimestamp, or alter a deduction movement in a
--     disposable transaction and confirm approval fails before variant locks.

-- =========================================================
-- 6. ROLLBACK NOTES
-- =========================================================
-- Before any V2 cancellations exist, rollback may restore the previous
-- review_order_cancellation definition and its unchanged ACL.
--
-- After a V2 cancellation is approved, its restoration movements,
-- inventory_restored_at, cancellation decision, and restored stock are
-- production audit records. They must not be deleted or reversed casually.
-- A frontend feature-flag rollback must preserve every V2 order and movement.

commit;
