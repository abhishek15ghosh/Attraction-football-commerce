begin;
set transaction isolation level repeatable read;

-- Phase 2C Stage 1: permit authenticated callers to use the already-deployed
-- stock-aware checkout while preserving the stock-neutral V1 checkout during
-- the controlled frontend deployment window.
--
-- This migration changes function privileges only. It does not call checkout,
-- mutate application data, change stock, or replace any function body.

-- =========================================================
-- 1. PRECONDITIONS
-- =========================================================

do $preconditions$
declare
  v_v1_oid regprocedure := pg_catalog.to_regprocedure(
    'public.place_order(text,text,text,text,text,text,text,jsonb,uuid)'
  );
  v_v2_oid regprocedure := pg_catalog.to_regprocedure(
    'public.place_order_v2(jsonb,jsonb,uuid)'
  );
  v_v1_owner name;
  v_v2_owner name;
  v_extension_schema name;
  v_proc record;
begin
  if v_v1_oid is null or v_v2_oid is null then
    raise exception 'The exact V1 or V2 checkout function is missing.';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_proc as proc
    join pg_catalog.pg_namespace as ns on ns.oid = proc.pronamespace
    where ns.nspname = 'public'
      and proc.proname = 'place_order'
  ) <> 1 then
    raise exception 'The legacy checkout overload baseline is incompatible.';
  end if;

  if pg_catalog.to_regprocedure(
       'public.review_order_cancellation(uuid,text,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.adjust_variant_stock(uuid,integer,integer,text,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.request_order_cancellation(uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.update_order_status(uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.update_order_payment_status(uuid,text)'
     ) is null then
    raise exception 'A required order, cancellation, or inventory RPC is missing.';
  end if;

  select ns.nspname
  into v_extension_schema
  from pg_catalog.pg_extension as extension_definition
  join pg_catalog.pg_namespace as ns
    on ns.oid = extension_definition.extnamespace
  where extension_definition.extname = 'pgcrypto';

  if v_extension_schema is distinct from 'extensions' then
    raise exception 'pgcrypto must exist in the extensions schema.';
  end if;

  if pg_catalog.to_regclass('public.products') is null
     or pg_catalog.to_regclass('public.product_variants') is null
     or pg_catalog.to_regclass('public.inventory_movements') is null
     or pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regclass('public.order_items') is null
     or pg_catalog.to_regclass('public.cart_items') is null
     or pg_catalog.to_regclass('public.variant_cart_items') is null
     or pg_catalog.to_regclass('public.order_checkout_receipts_v2') is null then
    raise exception 'A required checkout, cart, order, or inventory table is missing.';
  end if;

  if not (
    select cls.relrowsecurity
    from pg_catalog.pg_class as cls
    where cls.oid = 'public.order_checkout_receipts_v2'::regclass
  ) then
    raise exception 'RLS must be enabled on order_checkout_receipts_v2.';
  end if;

  -- The cutover must validate the deployed checkout contract, not repair it.
  -- Every check in this block runs before the first V2 privilege mutation.
  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.order_checkout_receipts_v2'::regclass
      and con.contype = 'p'
      and con.convalidated
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(con.conkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = con.conrelid
         and attribute.attnum = key_column.attnum
      ) = array['user_id', 'idempotency_key']::name[]
      and exists (
        select 1
        from pg_catalog.pg_index as identity_index
        where identity_index.indexrelid = con.conindid
          and identity_index.indrelid = con.conrelid
          and identity_index.indisunique
          and identity_index.indisvalid
          and identity_index.indisready
          and identity_index.indexprs is null
          and identity_index.indnkeyatts = 2
          and identity_index.indnatts = 2
      )
  ) then
    raise exception
      'The V2 receipt identity primary key is missing or structurally incompatible.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.order_checkout_receipts_v2'::regclass
      and con.contype = 'f'
      and con.convalidated
      and con.confrelid = 'auth.users'::regclass
      and con.confupdtype = 'r'
      and con.confdeltype = 'c'
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(con.conkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = con.conrelid
         and attribute.attnum = key_column.attnum
      ) = array['user_id']::name[]
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(con.confkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = con.confrelid
         and attribute.attnum = key_column.attnum
      ) = array['id']::name[]
  ) then
    raise exception
      'The V2 receipt user ownership foreign key is missing or incompatible.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.order_checkout_receipts_v2'::regclass
      and con.contype = 'f'
      and con.convalidated
      and con.confrelid = 'public.orders'::regclass
      and con.confupdtype = 'r'
      and con.confdeltype = 'r'
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(con.conkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = con.conrelid
         and attribute.attnum = key_column.attnum
      ) = array['order_id']::name[]
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(con.confkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = con.confrelid
         and attribute.attnum = key_column.attnum
      ) = array['id']::name[]
  ) then
    raise exception
      'The V2 receipt order-result foreign key is missing or incompatible.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.order_checkout_receipts_v2'::regclass
      and con.contype = 'c'
      and con.convalidated
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(con.conkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = con.conrelid
         and attribute.attnum = key_column.attnum
      ) = array['payload_hash']::name[]
      and pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.pg_get_expr(con.conbin, con.conrelid)),
        '[[:space:]]+',
        '',
        'g'
      ) = '(payload_hash~''^[0-9a-f]{64}$''::text)'
  ) then
    raise exception
      'The V2 receipt SHA-256 payload-hash constraint is missing or incompatible.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.order_checkout_receipts_v2'::regclass
      and con.contype = 'c'
      and con.convalidated
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(con.conkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = con.conrelid
         and attribute.attnum = key_column.attnum
      ) = array['normalized_payload']::name[]
      and pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.pg_get_expr(con.conbin, con.conrelid)),
        '[[:space:]]+',
        '',
        'g'
      ) = '(jsonb_typeof(normalized_payload)=''object''::text)'
  ) then
    raise exception
      'The V2 receipt normalized-payload constraint is missing or incompatible.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.order_checkout_receipts_v2'::regclass
      and con.contype = 'c'
      and con.convalidated
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(con.conkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = con.conrelid
         and attribute.attnum = key_column.attnum
      ) = array['result_payload']::name[]
      and pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.pg_get_expr(con.conbin, con.conrelid)),
        '[[:space:]]+',
        '',
        'g'
      ) = '((result_payloadisnull)or(jsonb_typeof(result_payload)=''object''::text))'
  ) then
    raise exception
      'The V2 receipt result-payload constraint is missing or incompatible.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.order_checkout_receipts_v2'::regclass
      and con.contype = 'c'
      and con.convalidated
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(con.conkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = con.conrelid
         and attribute.attnum = key_column.attnum
      ) = array['order_id', 'result_payload', 'completed_at']::name[]
      and pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.pg_get_expr(con.conbin, con.conrelid)),
        '[[:space:]]+',
        '',
        'g'
      ) = '(((order_idisnull)and(result_payloadisnull)and(completed_atisnull))or((order_idisnotnull)and(result_payloadisnotnull)and(completed_atisnotnull)))'
  ) then
    raise exception
      'The V2 receipt completion-state constraint is missing or incompatible.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.order_items'::regclass
      and con.contype = 'f'
      and con.convalidated
      and con.confrelid = 'public.product_variants'::regclass
      and con.confupdtype = 'r'
      and con.confdeltype = 'r'
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(con.conkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = con.conrelid
         and attribute.attnum = key_column.attnum
      ) = array['product_variant_id', 'product_id']::name[]
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(con.confkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = con.confrelid
         and attribute.attnum = key_column.attnum
      ) = array['id', 'product_id']::name[]
  ) then
    raise exception
      'The order-item variant/product foreign key is missing or incompatible.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as con
    where con.conrelid = 'public.product_variants'::regclass
      and con.contype = 'c'
      and con.convalidated
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(con.conkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = con.conrelid
         and attribute.attnum = key_column.attnum
      ) = array['stock_quantity']::name[]
      and pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.pg_get_expr(con.conbin, con.conrelid)),
        '[[:space:]]+',
        '',
        'g'
      ) = '(stock_quantity>=0)'
  ) then
    raise exception
      'The nonnegative variant-stock constraint is missing or incompatible.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index as index_definition
    where index_definition.indrelid = 'public.inventory_movements'::regclass
      and index_definition.indisunique
      and index_definition.indisvalid
      and index_definition.indisready
      and index_definition.indexprs is null
      and index_definition.indnkeyatts = 2
      and index_definition.indnatts = 2
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(index_definition.indkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = index_definition.indrelid
         and attribute.attnum = key_column.attnum
        where key_column.ordinality <= index_definition.indnkeyatts
      ) = array['order_id', 'product_variant_id']::name[]
      and pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.pg_get_expr(
          index_definition.indpred,
          index_definition.indrelid
        )),
        '[[:space:]()]',
        '',
        'g'
      ) in (
        'movement_type=''orderdeduction''::textandorder_idisnotnull',
        'movement_type=''orderdeduction''andorder_idisnotnull'
      )
  ) then
    raise exception
      'The Order Deduction uniqueness protection is missing or incompatible.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index as index_definition
    where index_definition.indrelid = 'public.inventory_movements'::regclass
      and index_definition.indisunique
      and index_definition.indisvalid
      and index_definition.indisready
      and index_definition.indexprs is null
      and index_definition.indnkeyatts = 2
      and index_definition.indnatts = 2
      and (
        select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
        from pg_catalog.unnest(index_definition.indkey)
          with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = index_definition.indrelid
         and attribute.attnum = key_column.attnum
        where key_column.ordinality <= index_definition.indnkeyatts
      ) = array['order_id', 'product_variant_id']::name[]
      and pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.pg_get_expr(
          index_definition.indpred,
          index_definition.indrelid
        )),
        '[[:space:]()]',
        '',
        'g'
      ) in (
        'movement_type=''cancellationrestoration''::textandorder_idisnotnull',
        'movement_type=''cancellationrestoration''andorder_idisnotnull'
      )
  ) then
    raise exception
      'The Cancellation Restoration uniqueness protection is missing or incompatible.';
  end if;

  select owner_role.rolname
  into v_v1_owner
  from pg_catalog.pg_proc as proc
  join pg_catalog.pg_roles as owner_role on owner_role.oid = proc.proowner
  where proc.oid = v_v1_oid;

  select owner_role.rolname
  into v_v2_owner
  from pg_catalog.pg_proc as proc
  join pg_catalog.pg_roles as owner_role on owner_role.oid = proc.proowner
  where proc.oid = v_v2_oid;

  if v_v1_owner is distinct from 'postgres'
     or v_v2_owner is distinct from 'postgres'
     or v_v1_owner is distinct from v_v2_owner then
    raise exception
      'Checkout functions must retain the expected postgres owner; V1 owner %, V2 owner %.',
      v_v1_owner,
      v_v2_owner;
  end if;

  for v_proc in
    select proc.oid, ns.nspname, proc.proname, proc.prosecdef, proc.proconfig
    from pg_catalog.pg_proc as proc
    join pg_catalog.pg_namespace as ns on ns.oid = proc.pronamespace
    where proc.oid in (
      v_v1_oid,
      v_v2_oid,
      pg_catalog.to_regprocedure(
        'public.review_order_cancellation(uuid,text,text)'
      ),
      pg_catalog.to_regprocedure(
        'public.adjust_variant_stock(uuid,integer,integer,text,uuid)'
      )
    )
  loop
    if not v_proc.prosecdef then
      raise exception '%.% must remain SECURITY DEFINER.',
        v_proc.nspname,
        v_proc.proname;
    end if;

    if not exists (
      select 1
      from pg_catalog.unnest(
        coalesce(v_proc.proconfig, array[]::text[])
      ) as setting(value)
      where setting.value in ('search_path=', 'search_path=""')
    ) then
      raise exception '%.% must retain an empty search_path.',
        v_proc.nspname,
        v_proc.proname;
    end if;
  end loop;

  if pg_catalog.has_function_privilege('anon', v_v1_oid, 'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'authenticated', v_v1_oid, 'EXECUTE'
     )
     or exists (
       select 1
       from pg_catalog.pg_proc as proc
       cross join lateral pg_catalog.aclexplode(
         coalesce(
           proc.proacl,
           pg_catalog.acldefault('f', proc.proowner)
         )
       ) as acl
       where proc.oid = v_v1_oid
         and acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
     ) then
    raise exception 'V1 must be authenticated-only before Stage 1.';
  end if;

  if pg_catalog.has_function_privilege('anon', v_v2_oid, 'EXECUTE')
     or exists (
       select 1
       from pg_catalog.pg_proc as proc
       cross join lateral pg_catalog.aclexplode(
         coalesce(
           proc.proacl,
           pg_catalog.acldefault('f', proc.proowner)
         )
       ) as acl
       where proc.oid = v_v2_oid
         and acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
     ) then
    raise exception 'V2 must not be executable by anon or PUBLIC before Stage 1.';
  end if;

  if (select count(*) from public.product_variants) <> 381 then
    raise exception 'Expected exactly 381 product variants before cutover.';
  end if;

  if exists (
    select 1
    from public.product_variants as variant
    where variant.stock_quantity < 0
  ) then
    raise exception 'Inventory contains a negative stock quantity.';
  end if;
end
$preconditions$;

-- =========================================================
-- 2. IMMUTABLE FUNCTION AND DATA BASELINES
-- =========================================================

create temporary table _phase2c_stage1_function_baseline
on commit drop
as
select
  proc.oid,
  proc.proowner,
  pg_catalog.pg_get_functiondef(proc.oid) as function_definition,
  proc.proacl::text as function_acl
from pg_catalog.pg_proc as proc
where proc.oid in (
  pg_catalog.to_regprocedure(
    'public.place_order(text,text,text,text,text,text,text,jsonb,uuid)'
  ),
  pg_catalog.to_regprocedure('public.place_order_v2(jsonb,jsonb,uuid)'),
  pg_catalog.to_regprocedure('public.request_order_cancellation(uuid,text)'),
  pg_catalog.to_regprocedure(
    'public.review_order_cancellation(uuid,text,text)'
  ),
  pg_catalog.to_regprocedure('public.update_order_status(uuid,text)'),
  pg_catalog.to_regprocedure(
    'public.update_order_payment_status(uuid,text)'
  ),
  pg_catalog.to_regprocedure(
    'public.adjust_variant_stock(uuid,integer,integer,text,uuid)'
  )
);

create temporary table _phase2c_stage1_data_baseline
on commit drop
as
select
  (select count(*) from public.product_variants) as variant_rows,
  (
    select coalesce(sum(variant.stock_quantity), 0)
    from public.product_variants as variant
  ) as stock_total,
  (select count(*) from public.orders) as order_rows,
  (select count(*) from public.order_items) as order_item_rows,
  (select count(*) from public.cart_items) as v1_cart_rows,
  (select count(*) from public.variant_cart_items) as v2_cart_rows,
  (select count(*) from public.inventory_movements) as movement_rows,
  (select count(*) from public.order_checkout_receipts_v2) as receipt_rows,
  pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'products', coalesce(
            (
              select pg_catalog.jsonb_agg(
                pg_catalog.to_jsonb(product) order by product.id
              )
              from public.products as product
            ),
            '[]'::jsonb
          ),
          'variants', coalesce(
            (
              select pg_catalog.jsonb_agg(
                pg_catalog.to_jsonb(variant) order by variant.id
              )
              from public.product_variants as variant
            ),
            '[]'::jsonb
          ),
          'movements', coalesce(
            (
              select pg_catalog.jsonb_agg(
                pg_catalog.to_jsonb(movement) order by movement.id
              )
              from public.inventory_movements as movement
            ),
            '[]'::jsonb
          )
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) as inventory_fingerprint,
  pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'orders', coalesce(
            (
              select pg_catalog.jsonb_agg(
                pg_catalog.to_jsonb(customer_order) order by customer_order.id
              )
              from public.orders as customer_order
            ),
            '[]'::jsonb
          ),
          'order_items', coalesce(
            (
              select pg_catalog.jsonb_agg(
                pg_catalog.to_jsonb(order_item) order by order_item.id
              )
              from public.order_items as order_item
            ),
            '[]'::jsonb
          ),
          'v1_cart', coalesce(
            (
              select pg_catalog.jsonb_agg(
                pg_catalog.to_jsonb(cart_line)
                order by cart_line.user_id, cart_line.product_id
              )
              from public.cart_items as cart_line
            ),
            '[]'::jsonb
          ),
          'v2_cart', coalesce(
            (
              select pg_catalog.jsonb_agg(
                pg_catalog.to_jsonb(variant_cart_line)
                order by variant_cart_line.id
              )
              from public.variant_cart_items as variant_cart_line
            ),
            '[]'::jsonb
          ),
          'receipts', coalesce(
            (
              select pg_catalog.jsonb_agg(
                pg_catalog.to_jsonb(receipt)
                order by receipt.user_id, receipt.idempotency_key
              )
              from public.order_checkout_receipts_v2 as receipt
            ),
            '[]'::jsonb
          )
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) as application_fingerprint;

-- =========================================================
-- 3. PRIVILEGE-ONLY CUTOVER
-- =========================================================

revoke all on function public.place_order_v2(jsonb, jsonb, uuid)
from public, anon, authenticated;

grant execute on function public.place_order_v2(jsonb, jsonb, uuid)
to authenticated;

-- =========================================================
-- 4. TRANSACTIONAL VALIDATION
-- =========================================================

do $validation$
declare
  baseline pg_temp._phase2c_stage1_data_baseline%rowtype;
  v_current_inventory_fingerprint text;
  v_current_application_fingerprint text;
  v_v1_oid regprocedure := pg_catalog.to_regprocedure(
    'public.place_order(text,text,text,text,text,text,text,jsonb,uuid)'
  );
  v_v2_oid regprocedure := pg_catalog.to_regprocedure(
    'public.place_order_v2(jsonb,jsonb,uuid)'
  );
begin
  select * into baseline from pg_temp._phase2c_stage1_data_baseline;

  if (select count(*) from pg_temp._phase2c_stage1_function_baseline) <> 7
     or (
       select count(*)
       from pg_temp._phase2c_stage1_function_baseline as saved
       join pg_catalog.pg_proc as proc on proc.oid = saved.oid
     ) <> 7 then
    raise exception 'The protected function snapshot is incomplete.';
  end if;

  if not pg_catalog.has_function_privilege(
       'authenticated', v_v2_oid, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege('anon', v_v2_oid, 'EXECUTE')
     or exists (
       select 1
       from pg_catalog.pg_proc as proc
       cross join lateral pg_catalog.aclexplode(
         coalesce(
           proc.proacl,
           pg_catalog.acldefault('f', proc.proowner)
         )
       ) as acl
       where proc.oid = v_v2_oid
         and acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
     ) then
    raise exception 'Stage 1 did not establish the required V2 privileges.';
  end if;

  if not pg_catalog.has_function_privilege(
       'authenticated', v_v1_oid, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege('anon', v_v1_oid, 'EXECUTE') then
    raise exception 'Stage 1 changed or disabled the temporary V1 checkout path.';
  end if;

  if exists (
    select 1
    from pg_temp._phase2c_stage1_function_baseline as saved
    join pg_catalog.pg_proc as proc on proc.oid = saved.oid
    where proc.proowner is distinct from saved.proowner
       or pg_catalog.pg_get_functiondef(proc.oid)
            is distinct from saved.function_definition
       or (
         proc.oid <> v_v2_oid
         and proc.proacl::text is distinct from saved.function_acl
       )
  ) then
    raise exception 'Stage 1 changed a function owner, body, or unrelated ACL.';
  end if;

  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'products', coalesce(
            (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) order by p.id) from public.products as p),
            '[]'::jsonb
          ),
          'variants', coalesce(
            (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v) order by v.id) from public.product_variants as v),
            '[]'::jsonb
          ),
          'movements', coalesce(
            (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) order by m.id) from public.inventory_movements as m),
            '[]'::jsonb
          )
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) into v_current_inventory_fingerprint;

  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'orders', coalesce(
            (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.id) from public.orders as o),
            '[]'::jsonb
          ),
          'order_items', coalesce(
            (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) order by i.id) from public.order_items as i),
            '[]'::jsonb
          ),
          'v1_cart', coalesce(
            (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) order by c.user_id, c.product_id) from public.cart_items as c),
            '[]'::jsonb
          ),
          'v2_cart', coalesce(
            (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(vc) order by vc.id) from public.variant_cart_items as vc),
            '[]'::jsonb
          ),
          'receipts', coalesce(
            (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by r.user_id, r.idempotency_key) from public.order_checkout_receipts_v2 as r),
            '[]'::jsonb
          )
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) into v_current_application_fingerprint;

  if baseline.variant_rows <> (select count(*) from public.product_variants)
     or baseline.stock_total <> (
       select coalesce(sum(v.stock_quantity), 0)
       from public.product_variants as v
     )
     or baseline.order_rows <> (select count(*) from public.orders)
     or baseline.order_item_rows <> (select count(*) from public.order_items)
     or baseline.v1_cart_rows <> (select count(*) from public.cart_items)
     or baseline.v2_cart_rows <> (select count(*) from public.variant_cart_items)
     or baseline.movement_rows <> (select count(*) from public.inventory_movements)
     or baseline.receipt_rows <> (
       select count(*) from public.order_checkout_receipts_v2
     )
     or baseline.inventory_fingerprint is distinct from v_current_inventory_fingerprint
     or baseline.application_fingerprint is distinct from v_current_application_fingerprint then
    raise exception 'Stage 1 changed application or inventory data.';
  end if;
end
$validation$;

-- Safe rerun: browser grants are normalized to authenticated-only and all
-- function/data invariants are revalidated.
-- Emergency rollback before frontend activation:
--   revoke all on function public.place_order_v2(jsonb, jsonb, uuid)
--   from public, anon, authenticated;
-- V1 remains authenticated during this stage.

commit;
