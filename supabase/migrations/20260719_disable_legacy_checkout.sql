begin;
set transaction isolation level repeatable read;

-- Phase 2C Stage 3: remove browser access to the stock-neutral V1 checkout
-- after the V2 frontend deployment and controlled production verification.
--
-- This migration preserves all function bodies and ownership. It changes only
-- the exact V1 checkout ACL and does not call checkout or mutate application
-- data, stock, carts, receipts, orders, or inventory movements.

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
       'public.request_order_cancellation(uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.review_order_cancellation(uuid,text,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.update_order_status(uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.update_order_payment_status(uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.adjust_variant_stock(uuid,integer,integer,text,uuid)'
     ) is null then
    raise exception 'A protected order, cancellation, or inventory RPC is missing.';
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
    raise exception 'RLS must remain enabled on order_checkout_receipts_v2.';
  end if;

  for v_proc in
    select
      proc.oid,
      ns.nspname,
      proc.proname,
      owner_role.rolname as owner_name,
      proc.prosecdef,
      proc.proconfig
    from pg_catalog.pg_proc as proc
    join pg_catalog.pg_namespace as ns on ns.oid = proc.pronamespace
    join pg_catalog.pg_roles as owner_role on owner_role.oid = proc.proowner
    where proc.oid in (
      v_v1_oid,
      v_v2_oid,
      pg_catalog.to_regprocedure(
        'public.request_order_cancellation(uuid,text)'
      ),
      pg_catalog.to_regprocedure(
        'public.review_order_cancellation(uuid,text,text)'
      ),
      pg_catalog.to_regprocedure(
        'public.update_order_status(uuid,text)'
      ),
      pg_catalog.to_regprocedure(
        'public.update_order_payment_status(uuid,text)'
      ),
      pg_catalog.to_regprocedure(
        'public.adjust_variant_stock(uuid,integer,integer,text,uuid)'
      )
    )
  loop
    if v_proc.owner_name is distinct from 'postgres' then
      raise exception '%.% has unexpected owner %.',
        v_proc.nspname,
        v_proc.proname,
        v_proc.owner_name;
    end if;

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

  if not pg_catalog.has_function_privilege(
       'authenticated', v_v2_oid, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege('anon', v_v2_oid, 'EXECUTE')
     or exists (
       select 1
       from pg_catalog.pg_proc as proc
       cross join lateral pg_catalog.aclexplode(
         coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
       ) as acl
       where proc.oid = v_v2_oid
         and acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
     ) then
    raise exception 'Stage 1 V2 privileges are not in the required state.';
  end if;

  if pg_catalog.has_function_privilege('anon', v_v1_oid, 'EXECUTE')
     or exists (
       select 1
       from pg_catalog.pg_proc as proc
       cross join lateral pg_catalog.aclexplode(
         coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
       ) as acl
       where proc.oid = v_v1_oid
         and acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
     ) then
    raise exception 'V1 must not be executable by anon or PUBLIC.';
  end if;

  -- authenticated V1 may be true on the first run or false on a safe rerun.
  if not pg_catalog.has_function_privilege(
       'authenticated',
       pg_catalog.to_regprocedure(
         'public.request_order_cancellation(uuid,text)'
       ),
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       pg_catalog.to_regprocedure(
         'public.review_order_cancellation(uuid,text,text)'
       ),
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       pg_catalog.to_regprocedure('public.update_order_status(uuid,text)'),
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       pg_catalog.to_regprocedure(
         'public.update_order_payment_status(uuid,text)'
       ),
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       pg_catalog.to_regprocedure(
         'public.adjust_variant_stock(uuid,integer,integer,text,uuid)'
       ),
       'EXECUTE'
     ) then
    raise exception 'A required authenticated admin/customer RPC grant is missing.';
  end if;

  for v_proc in
    select protected_oid as oid
    from pg_catalog.unnest(array[
      pg_catalog.to_regprocedure(
        'public.request_order_cancellation(uuid,text)'
      ),
      pg_catalog.to_regprocedure(
        'public.review_order_cancellation(uuid,text,text)'
      ),
      pg_catalog.to_regprocedure(
        'public.update_order_status(uuid,text)'
      ),
      pg_catalog.to_regprocedure(
        'public.update_order_payment_status(uuid,text)'
      ),
      pg_catalog.to_regprocedure(
        'public.adjust_variant_stock(uuid,integer,integer,text,uuid)'
      )
    ]) as protected_rpc(protected_oid)
  loop
    if pg_catalog.has_function_privilege('anon', v_proc.oid, 'EXECUTE')
       or exists (
         select 1
         from pg_catalog.pg_proc as proc
         cross join lateral pg_catalog.aclexplode(
           coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
         ) as acl
         where proc.oid = v_proc.oid
           and acl.grantee = 0
           and acl.privilege_type = 'EXECUTE'
       ) then
      raise exception 'A protected RPC has an incompatible browser ACL.';
    end if;
  end loop;
end
$preconditions$;

-- =========================================================
-- 2. IMMUTABLE FUNCTION AND DATA BASELINES
-- =========================================================

create temporary table _phase2c_stage3_function_baseline
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

create temporary table _phase2c_stage3_data_baseline
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
  ) as inventory_fingerprint,
  pg_catalog.encode(
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
  ) as application_fingerprint;

-- =========================================================
-- 3. PRIVILEGE-ONLY LEGACY LOCKDOWN
-- =========================================================

revoke all on function public.place_order(
  text, text, text, text, text, text, text, jsonb, uuid
)
from public, anon, authenticated;

-- =========================================================
-- 4. TRANSACTIONAL VALIDATION
-- =========================================================

do $validation$
declare
  baseline pg_temp._phase2c_stage3_data_baseline%rowtype;
  v_current_inventory_fingerprint text;
  v_current_application_fingerprint text;
  v_v1_oid regprocedure := pg_catalog.to_regprocedure(
    'public.place_order(text,text,text,text,text,text,text,jsonb,uuid)'
  );
  v_v2_oid regprocedure := pg_catalog.to_regprocedure(
    'public.place_order_v2(jsonb,jsonb,uuid)'
  );
begin
  select * into baseline from pg_temp._phase2c_stage3_data_baseline;

  if (select count(*) from pg_temp._phase2c_stage3_function_baseline) <> 7
     or (
       select count(*)
       from pg_temp._phase2c_stage3_function_baseline as saved
       join pg_catalog.pg_proc as proc on proc.oid = saved.oid
     ) <> 7 then
    raise exception 'The protected function snapshot is incomplete.';
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated', v_v1_oid, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege('anon', v_v1_oid, 'EXECUTE')
     or exists (
       select 1
       from pg_catalog.pg_proc as proc
       cross join lateral pg_catalog.aclexplode(
         coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
       ) as acl
       where proc.oid = v_v1_oid
         and acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
     ) then
    raise exception 'Stage 3 did not fully revoke browser V1 execution.';
  end if;

  if not pg_catalog.has_function_privilege(
       'authenticated', v_v2_oid, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege('anon', v_v2_oid, 'EXECUTE')
     or exists (
       select 1
       from pg_catalog.pg_proc as proc
       cross join lateral pg_catalog.aclexplode(
         coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
       ) as acl
       where proc.oid = v_v2_oid
         and acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
     ) then
    raise exception 'Stage 3 changed or disabled the V2 checkout path.';
  end if;

  if not pg_catalog.has_function_privilege('postgres', v_v1_oid, 'EXECUTE') then
    raise exception 'The database owner must retain legacy checkout access.';
  end if;

  if exists (
    select 1
    from pg_temp._phase2c_stage3_function_baseline as saved
    join pg_catalog.pg_proc as proc on proc.oid = saved.oid
    where proc.proowner is distinct from saved.proowner
       or pg_catalog.pg_get_functiondef(proc.oid)
            is distinct from saved.function_definition
       or (
         proc.oid <> v_v1_oid
         and proc.proacl::text is distinct from saved.function_acl
       )
  ) then
    raise exception 'Stage 3 changed a function body, owner, or protected ACL.';
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
    raise exception 'Stage 3 changed application or inventory data.';
  end if;
end
$validation$;

-- Safe rerun: repeated REVOKE operations are idempotent and all invariants are
-- checked again without changing function bodies or data.
--
-- Emergency rollback (only after production V2 flags have been turned off):
--   begin;
--   revoke all on function public.place_order(
--     text, text, text, text, text, text, text, jsonb, uuid
--   ) from public, anon;
--   grant execute on function public.place_order(
--     text, text, text, text, text, text, text, jsonb, uuid
--   ) to authenticated;
--   commit;
-- Never expose V1 to anon or PUBLIC, and never run both frontend checkout modes.

commit;
