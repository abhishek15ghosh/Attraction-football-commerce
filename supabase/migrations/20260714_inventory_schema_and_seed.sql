begin;

-- Purpose: prepare additive inventory infrastructure without changing live checkout.
-- Seed source: supabase/seeds/20260714_inventory_variants.csv.
--
-- PHASE 1 STOCK BASELINE WARNING:
-- This migration creates a prepared inventory baseline only.
-- The currently deployed public.place_order function does not deduct stock.
-- Orders placed between Phase 1 and Phase 2 are not reflected in
-- public.product_variants.
-- Inventory must not be treated as authoritative until Phase 2 activates
-- stock-aware checkout.
--
-- Immediately before Phase 2:
-- 1. Pause checkout briefly.
-- 2. Reconcile current physical/test stock.
-- 3. Reconcile orders placed after this Phase 1 seed.
-- 4. Adjust variant quantities through the future audited admin process.
-- 5. Activate stock-aware checkout only after reconciliation completes.
--
-- Phase 1 does not modify public.place_order or any existing cart, order,
-- COD, payment, status, or cancellation RPC.

-- =========================================================
-- 1. PRODUCT VARIANTS
-- =========================================================

create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id text not null,
  sku text not null,
  variant_label text not null,
  stock_quantity integer not null default 0,
  low_stock_threshold integer not null default 3,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint product_variants_product_id_fkey
    foreign key (product_id)
    references public.products(id)
    on update restrict
    on delete restrict,

  constraint product_variants_sku_check
    check (length(btrim(sku)) between 1 and 64),

  constraint product_variants_variant_label_check
    check (length(btrim(variant_label)) between 1 and 80),

  constraint product_variants_stock_quantity_check
    check (stock_quantity >= 0),

  constraint product_variants_low_stock_threshold_check
    check (low_stock_threshold >= 0)
);

create unique index if not exists product_variants_sku_ci_uidx
  on public.product_variants ((lower(btrim(sku))));

create unique index if not exists product_variants_product_label_ci_uidx
  on public.product_variants (
    (lower(btrim(product_id))),
    (lower(btrim(variant_label)))
  );

create index if not exists product_variants_product_id_idx
  on public.product_variants (product_id);

create index if not exists product_variants_active_product_idx
  on public.product_variants (product_id, variant_label)
  where is_active = true;

create or replace function public.touch_product_variants_updated_at()
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

drop trigger if exists product_variants_updated_at_trigger
on public.product_variants;

create trigger product_variants_updated_at_trigger
before update on public.product_variants
for each row
execute function public.touch_product_variants_updated_at();

revoke all
on function public.touch_product_variants_updated_at()
from public, anon, authenticated;

-- =========================================================
-- 2. INVENTORY MOVEMENT LEDGER
-- =========================================================

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_variant_id uuid not null,
  order_id uuid,
  movement_type text not null,
  quantity_delta integer not null,
  resulting_stock_quantity integer not null,
  actor_user_id uuid,
  reason text,
  created_at timestamptz not null default now(),

  constraint inventory_movements_variant_fkey
    foreign key (product_variant_id)
    references public.product_variants(id)
    on delete restrict,

  constraint inventory_movements_order_fkey
    foreign key (order_id)
    references public.orders(id)
    on delete restrict,

  constraint inventory_movements_actor_fkey
    foreign key (actor_user_id)
    references auth.users(id)
    on delete set null,

  constraint inventory_movements_type_check
    check (
      movement_type in (
        'Initial Stock',
        'Order Deduction',
        'Cancellation Restoration',
        'Admin Adjustment'
      )
    ),

  constraint inventory_movements_quantity_delta_check
    check (quantity_delta <> 0),

  constraint inventory_movements_quantity_direction_check
    check (
      (movement_type = 'Initial Stock' and quantity_delta > 0)
      or
      (movement_type = 'Order Deduction' and quantity_delta < 0)
      or
      (movement_type = 'Cancellation Restoration' and quantity_delta > 0)
      or
      (movement_type = 'Admin Adjustment' and quantity_delta <> 0)
    ),

  constraint inventory_movements_resulting_stock_check
    check (resulting_stock_quantity >= 0),

  constraint inventory_movements_order_requirement_check
    check (
      (
        movement_type = 'Initial Stock'
        and order_id is null
      )
      or
      (
        movement_type in (
          'Order Deduction',
          'Cancellation Restoration'
        )
        and order_id is not null
      )
      or movement_type = 'Admin Adjustment'
    ),

  constraint inventory_movements_reason_length_check
    check (
      reason is null
      or length(btrim(reason)) between 1 and 1000
    )
);

create index if not exists inventory_movements_variant_date_idx
  on public.inventory_movements (
    product_variant_id,
    created_at desc
  );

create index if not exists inventory_movements_order_idx
  on public.inventory_movements (order_id)
  where order_id is not null;

create index if not exists inventory_movements_created_at_idx
  on public.inventory_movements (created_at desc);

create unique index if not exists inventory_movements_initial_stock_uidx
  on public.inventory_movements (product_variant_id)
  where movement_type = 'Initial Stock';

create unique index if not exists inventory_movements_order_deduction_uidx
  on public.inventory_movements (order_id, product_variant_id)
  where movement_type = 'Order Deduction'
    and order_id is not null;

create unique index if not exists inventory_movements_cancellation_restore_uidx
  on public.inventory_movements (order_id, product_variant_id)
  where movement_type = 'Cancellation Restoration'
    and order_id is not null;

-- =========================================================
-- 3. NULLABLE ORDER COMPATIBILITY FIELDS
-- =========================================================

alter table public.order_items
  add column if not exists product_variant_id uuid,
  add column if not exists variant_sku text,
  add column if not exists variant_label text;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.order_items'::regclass
      and conname = 'order_items_product_variant_id_fkey'
  ) then
    alter table public.order_items
      add constraint order_items_product_variant_id_fkey
      foreign key (product_variant_id)
      references public.product_variants(id)
      on delete restrict;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.order_items'::regclass
      and conname = 'order_items_variant_sku_check'
  ) then
    alter table public.order_items
      add constraint order_items_variant_sku_check
      check (
        variant_sku is null
        or length(btrim(variant_sku)) between 1 and 64
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.order_items'::regclass
      and conname = 'order_items_variant_label_check'
  ) then
    alter table public.order_items
      add constraint order_items_variant_label_check
      check (
        variant_label is null
        or length(btrim(variant_label)) between 1 and 80
      );
  end if;
end
$migration$;

create index if not exists order_items_product_variant_id_idx
  on public.order_items (product_variant_id)
  where product_variant_id is not null;

alter table public.orders
  add column if not exists inventory_deducted_at timestamptz,
  add column if not exists inventory_restored_at timestamptz;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_inventory_timeline_check'
  ) then
    alter table public.orders
      add constraint orders_inventory_timeline_check
      check (
        inventory_restored_at is null
        or (
          inventory_deducted_at is not null
          and inventory_restored_at >= inventory_deducted_at
        )
      );
  end if;
end
$migration$;

-- =========================================================
-- 4. TRANSACTION-LOCAL APPROVED SEED SOURCE
-- =========================================================

drop table if exists pg_temp.inventory_variant_seed;
drop table if exists pg_temp.inventory_variant_spec;
drop table if exists pg_temp.inventory_product_seed;

create temporary table inventory_product_seed (
  product_id text not null,
  product_name text not null,
  category text not null,
  product_is_active boolean not null
) on commit drop;

insert into pg_temp.inventory_product_seed (
  product_id,
  product_name,
  category,
  product_is_active
)
values
  ('academy-trainer-pro', 'Academy Trainer Pro', 'Football Shoes', true),
  ('aero-touch-academy', 'Aero Touch Academy', 'Football Shoes', true),
  ('carbon-speed-elite', 'Carbon Speed Elite', 'Football Shoes', true),
  ('classic-leather-fg', 'Classic Leather FG', 'Football Shoes', true),
  ('control-collar-elite', 'Control Collar Elite', 'Football Shoes', true),
  ('control-pods-pro', 'Control Pods Pro', 'Football Shoes', true),
  ('daily-drill-trainer', 'Daily Drill Trainer', 'Football Shoes', true),
  ('graphite-power-fg', 'Graphite Power FG', 'Football Shoes', true),
  ('maestro-white-control', 'Maestro White Control', 'Football Shoes', true),
  ('nitro-sprint-laceless', 'Nitro Sprint Laceless', 'Football Shoes', true),
  ('omega-blade-speed', 'Omega Blade Speed', 'Football Shoes', true),
  ('phantom-control-pro', 'Phantom Control Pro', 'Football Shoes', true),
  ('predator-elite-fg', 'Predator Elite FG', 'Football Shoes', true),
  ('shadow-touch-fg', 'Shadow Touch FG', 'Football Shoes', true),
  ('sockfit-pro-fg', 'Sockfit Pro FG', 'Football Shoes', true),
  ('street-cage-turf', 'Street Cage Turf', 'Football Shoes', true),
  ('training-strike-tf', 'Training Strike TF', 'Football Shoes', true),
  ('urban-grip-turf', 'Urban Grip Turf', 'Football Shoes', true),
  ('velocity-grip-sg', 'Velocity Grip SG', 'Football Shoes', true),
  ('white-turf-precision', 'White Turf Precision', 'Football Shoes', true),

  ('academy-training-jersey', 'Academy Training Jersey', 'Jerseys', true),
  ('carbon-away-jersey', 'Carbon Away Jersey', 'Jerseys', true),
  ('city-home-jersey', 'City Home Jersey', 'Jerseys', true),
  ('elite-away-jersey', 'Elite Away Jersey', 'Jerseys', true),
  ('elite-home-jersey', 'Elite Home Jersey', 'Jerseys', true),
  ('fan-edition-crest-jersey', 'Fan Edition Crest Jersey', 'Jerseys', true),
  ('goalkeeper-command-jersey', 'Goalkeeper Command Jersey', 'Jerseys', true),
  ('heritage-long-sleeve-jersey', 'Heritage Long Sleeve Jersey', 'Jerseys', true),
  ('legendary-home-jersey', 'Legendary Home Jersey', 'Jerseys', true),
  ('limited-matchday-jersey', 'Limited Matchday Jersey', 'Jerseys', true),
  ('long-sleeve-match-jersey', 'Long Sleeve Match Jersey', 'Jerseys', true),
  ('matchday-pro-jersey', 'Matchday Pro Jersey', 'Jerseys', true),
  ('midnight-away-jersey', 'Midnight Away Jersey', 'Jerseys', true),
  ('neon-accent-jersey', 'Neon Accent Jersey', 'Jerseys', true),
  ('premium-black-jersey', 'Premium Black Jersey', 'Jerseys', true),
  ('pro-training-jersey', 'Pro Training Jersey', 'Jerseys', true),
  ('retro-club-jersey', 'Retro Club Jersey', 'Jerseys', true),
  ('shadow-away-jersey', 'Shadow Away Jersey', 'Jerseys', true),
  ('stadium-fan-jersey', 'Stadium Fan Jersey', 'Jerseys', true),
  ('training-match-jersey', 'Training Match Jersey', 'Jerseys', true),
  ('travel-fan-jersey', 'Travel Fan Jersey', 'Jerseys', true),
  ('white-gold-away-jersey', 'White Gold Away Jersey', 'Jerseys', true),
  ('whiteout-training-jersey', 'Whiteout Training Jersey', 'Jerseys', true),

  ('away-day-fan-tee', 'Away Day Fan Tee', 'T-Shirts', true),
  ('base-layer-compression-tee', 'Base Layer Compression Tee', 'T-Shirts', true),
  ('blackout-lifestyle-tee', 'Blackout Lifestyle Tee', 'T-Shirts', true),
  ('carbon-flex-tee', 'Carbon Flex Tee', 'T-Shirts', true),
  ('elite-compression-tee', 'Elite Compression Tee', 'T-Shirts', true),
  ('fan-edition-logo-tee', 'Fan Edition Logo Tee', 'T-Shirts', true),
  ('limited-neon-tee', 'Limited Neon Tee', 'T-Shirts', true),
  ('matchday-crest-tee', 'Matchday Crest Tee', 'T-Shirts', true),
  ('matchday-pro-tee', 'Matchday Pro Tee', 'T-Shirts', true),
  ('matchday-travel-tee', 'Matchday Travel Tee', 'T-Shirts', true),
  ('neon-strike-training-tee', 'Neon Strike Training Tee', 'T-Shirts', true),
  ('performance-tee', 'Performance Tee', 'T-Shirts', true),
  ('performance-training-tee', 'Performance Training Tee', 'T-Shirts', true),
  ('premium-club-tee', 'Premium Club Tee', 'T-Shirts', true),
  ('pro-training-tee', 'Pro Training Tee', 'T-Shirts', true),
  ('recovery-compression-tee', 'Recovery Compression Tee', 'T-Shirts', true),
  ('stadium-fan-graphic-tee', 'Stadium Fan Graphic Tee', 'T-Shirts', true),
  ('training-mesh-tee', 'Training Mesh Tee', 'T-Shirts', true),
  ('travel-club-tee', 'Travel Club Tee', 'T-Shirts', true),
  ('urban-football-tee', 'Urban Football Tee', 'T-Shirts', true),
  ('warmup-speed-tee', 'Warmup Speed Tee', 'T-Shirts', true),

  ('academy-training-ball', 'Academy Training Ball', 'Footballs', true),
  ('all-weather-ball', 'All Weather Ball', 'Footballs', true),
  ('blackout-match-ball', 'Blackout Match Ball', 'Footballs', true),
  ('carbon-flight-ball', 'Carbon Flight Ball', 'Footballs', true),
  ('elite-training-ball', 'Elite Training Ball', 'Footballs', true),
  ('fan-edition-ball', 'Fan Edition Ball', 'Footballs', true),
  ('futsal-precision-ball', 'Futsal Precision Ball', 'Footballs', true),
  ('grass-master-ball', 'Grass Master Ball', 'Footballs', true),
  ('heritage-club-ball', 'Heritage Club Ball', 'Footballs', true),
  ('indoor-control-ball', 'Indoor Control Ball', 'Footballs', true),
  ('limited-neon-ball', 'Limited Neon Ball', 'Footballs', true),
  ('matchday-precision-ball', 'Matchday Precision Ball', 'Footballs', true),
  ('neon-strike-football', 'Neon Strike Football', 'Footballs', true),
  ('night-game-ball', 'Night Game Ball', 'Footballs', true),
  ('premier-match-ball', 'Premier Match Ball', 'Footballs', true),
  ('pro-league-ball', 'Pro League Ball', 'Footballs', true),
  ('speed-touch-ball', 'Speed Touch Ball', 'Footballs', true),
  ('street-control-ball', 'Street Control Ball', 'Footballs', true),
  ('tournament-pro-ball', 'Tournament Pro Ball', 'Footballs', true),
  ('training-lite-ball', 'Training Lite Ball', 'Footballs', true),
  ('urban-futsal-ball', 'Urban Futsal Ball', 'Footballs', true),

  ('boot-care-kit', 'Boot Care Kit', 'Accessories', true),
  ('captain-elite-armband', 'Captain Elite Armband', 'Accessories', true),
  ('carbon-shin-guards', 'Carbon Shin Guards', 'Accessories', true),
  ('coach-tactics-board', 'Coach Tactics Board', 'Accessories', true),
  ('compression-arm-sleeves', 'Compression Arm Sleeves', 'Accessories', true),
  ('dual-action-ball-pump', 'Dual Action Ball Pump', 'Accessories', true),
  ('elite-boot-bag', 'Elite Boot Bag', 'Accessories', true),
  ('flex-wristbands', 'Flex Wristbands', 'Accessories', true),
  ('marker-disc-set', 'Marker Disc Set', 'Accessories', true),
  ('match-grip-socks', 'Match Grip Socks', 'Accessories', true),
  ('matchday-headband', 'Matchday Headband', 'Accessories', true),
  ('microfiber-cooling-towel', 'Microfiber Cooling Towel', 'Accessories', true),
  ('neon-training-bib', 'Neon Training Bib', 'Accessories', true),
  ('pro-grip-gloves', 'Pro Grip Gloves', 'Accessories', true),
  ('pro-hydration-bottle', 'Pro Hydration Bottle', 'Accessories', true),
  ('pro-sports-tape', 'Pro Sports Tape', 'Accessories', true),
  ('speed-agility-ladder', 'Speed Agility Ladder', 'Accessories', true),
  ('speed-training-cones', 'Speed Training Cones', 'Accessories', true),
  ('stability-ankle-supports', 'Stability Ankle Supports', 'Accessories', true),
  ('team-kit-bag', 'Team Kit Bag', 'Accessories', true);

create temporary table inventory_variant_spec (
  category text not null,
  variant_label text not null,
  variant_code text not null,
  variant_order integer not null
) on commit drop;

insert into pg_temp.inventory_variant_spec (
  category,
  variant_label,
  variant_code,
  variant_order
)
values
  ('Football Shoes', 'UK 6', 'UK6', 1),
  ('Football Shoes', 'UK 7', 'UK7', 2),
  ('Football Shoes', 'UK 8', 'UK8', 3),
  ('Football Shoes', 'UK 9', 'UK9', 4),
  ('Football Shoes', 'UK 10', 'UK10', 5),
  ('Football Shoes', 'UK 11', 'UK11', 6),
  ('Jerseys', 'S', 'S', 1),
  ('Jerseys', 'M', 'M', 2),
  ('Jerseys', 'L', 'L', 3),
  ('Jerseys', 'XL', 'XL', 4),
  ('Jerseys', 'XXL', 'XXL', 5),
  ('T-Shirts', 'S', 'S', 1),
  ('T-Shirts', 'M', 'M', 2),
  ('T-Shirts', 'L', 'L', 3),
  ('T-Shirts', 'XL', 'XL', 4),
  ('T-Shirts', 'XXL', 'XXL', 5),
  ('Footballs', 'Size 4', 'SIZE4', 1),
  ('Footballs', 'Size 5', 'SIZE5', 2),
  ('Accessories', 'One Size', 'ONESIZE', 1);

create temporary table inventory_variant_seed (
  product_id text not null,
  product_name text not null,
  category text not null,
  variant_label text not null,
  sku text not null,
  initial_stock_quantity integer not null,
  low_stock_threshold integer not null,
  product_is_active boolean not null,
  variant_is_active boolean not null
) on commit drop;

insert into pg_temp.inventory_variant_seed (
  product_id,
  product_name,
  category,
  variant_label,
  sku,
  initial_stock_quantity,
  low_stock_threshold,
  product_is_active,
  variant_is_active
)
select
  product.product_id,
  product.product_name,
  product.category,
  specification.variant_label,
  'ATF-' || upper(product.product_id) || '-' || specification.variant_code,
  10,
  3,
  product.product_is_active,
  true
from pg_temp.inventory_product_seed as product
join pg_temp.inventory_variant_spec as specification
  on specification.category = product.category
where
  product.category <> 'Footballs'
  or (
    product.product_id in (
      'futsal-precision-ball',
      'urban-futsal-ball'
    )
    and specification.variant_label = 'Size 4'
  )
  or (
    product.product_id not in (
      'futsal-precision-ball',
      'urban-futsal-ball'
    )
    and specification.variant_label = 'Size 5'
  )
order by
  case product.category
    when 'Football Shoes' then 1
    when 'Jerseys' then 2
    when 'T-Shirts' then 3
    when 'Footballs' then 4
    when 'Accessories' then 5
  end,
  product.product_id,
  specification.variant_order;

-- =========================================================
-- 5. PRE-SEED VALIDATION
-- =========================================================

do $validation$
declare
  v_details text;
begin
  if (select count(*) from pg_temp.inventory_product_seed) <> 105 then
    raise exception using
      errcode = '23514',
      message = 'Inventory seed must contain exactly 105 products.';
  end if;

  if (
    select count(distinct product_id)
    from pg_temp.inventory_product_seed
  ) <> 105 then
    raise exception using
      errcode = '23514',
      message = 'Inventory product seed contains duplicate product IDs.';
  end if;

  if (select count(*) from pg_temp.inventory_variant_seed) <> 381 then
    raise exception using
      errcode = '23514',
      message = 'Inventory seed must contain exactly 381 variants.';
  end if;

  if (
    select count(distinct lower(btrim(sku)))
    from pg_temp.inventory_variant_seed
  ) <> 381 then
    raise exception using
      errcode = '23514',
      message = 'Inventory seed contains duplicate SKUs.';
  end if;

  if exists (
    select 1
    from pg_temp.inventory_variant_seed
    group by lower(btrim(product_id)), lower(btrim(variant_label))
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23514',
      message = 'Inventory seed contains duplicate product variants.';
  end if;

  if exists (
    select 1
    from pg_temp.inventory_variant_seed
    where sku !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'
       or length(sku) > 64
       or initial_stock_quantity <> 10
       or low_stock_threshold <> 3
       or product_is_active is not true
       or variant_is_active is not true
  ) then
    raise exception using
      errcode = '23514',
      message = 'Inventory seed contains invalid SKU, stock, threshold, or active-state data.';
  end if;

  if (
    select coalesce(sum(initial_stock_quantity), 0)
    from pg_temp.inventory_variant_seed
  ) <> 3810 then
    raise exception using
      errcode = '23514',
      message = 'Inventory seed stock total must equal 3810.';
  end if;

  select string_agg(seed.product_id, ', ' order by seed.product_id)
  into v_details
  from pg_temp.inventory_product_seed as seed
  left join public.products as product
    on product.id = seed.product_id
  where product.id is null;

  if v_details is not null then
    raise exception using
      errcode = '23503',
      message = 'Inventory seed references missing products: ' || v_details;
  end if;

  select string_agg(seed.product_id, ', ' order by seed.product_id)
  into v_details
  from pg_temp.inventory_product_seed as seed
  join public.products as product
    on product.id = seed.product_id
  where product.name is distinct from seed.product_name
     or product.category is distinct from seed.category
     or product.is_active is distinct from seed.product_is_active;

  if v_details is not null then
    raise exception using
      errcode = '23514',
      message = 'Production product catalogue differs from the approved inventory seed: ' || v_details;
  end if;

  if (
    select count(distinct product_id)
    from pg_temp.inventory_variant_seed
    where category = 'Football Shoes'
  ) <> 20
  or (
    select count(*)
    from pg_temp.inventory_variant_seed
    where category = 'Football Shoes'
  ) <> 120 then
    raise exception 'Football Shoes seed totals are invalid.';
  end if;

  if (
    select count(distinct product_id)
    from pg_temp.inventory_variant_seed
    where category = 'Jerseys'
  ) <> 23
  or (
    select count(*)
    from pg_temp.inventory_variant_seed
    where category = 'Jerseys'
  ) <> 115 then
    raise exception 'Jersey seed totals are invalid.';
  end if;

  if (
    select count(distinct product_id)
    from pg_temp.inventory_variant_seed
    where category = 'T-Shirts'
  ) <> 21
  or (
    select count(*)
    from pg_temp.inventory_variant_seed
    where category = 'T-Shirts'
  ) <> 105 then
    raise exception 'T-Shirt seed totals are invalid.';
  end if;

  if (
    select count(distinct product_id)
    from pg_temp.inventory_variant_seed
    where category = 'Footballs'
  ) <> 21
  or (
    select count(*)
    from pg_temp.inventory_variant_seed
    where category = 'Footballs'
  ) <> 21 then
    raise exception 'Football seed totals are invalid.';
  end if;

  if (
    select count(distinct product_id)
    from pg_temp.inventory_variant_seed
    where category = 'Accessories'
  ) <> 20
  or (
    select count(*)
    from pg_temp.inventory_variant_seed
    where category = 'Accessories'
  ) <> 20 then
    raise exception 'Accessory seed totals are invalid.';
  end if;
end
$validation$;

-- =========================================================
-- 6. CONFLICT-SAFE VARIANT SEED
-- =========================================================
-- Existing variants are never updated by this migration.
-- Conflicts are skipped and checked by post-seed validation.
-- Any mismatch rolls back the complete transaction.

insert into public.product_variants (
  product_id,
  sku,
  variant_label,
  stock_quantity,
  low_stock_threshold,
  is_active
)
select
  seed.product_id,
  seed.sku,
  seed.variant_label,
  seed.initial_stock_quantity,
  seed.low_stock_threshold,
  seed.variant_is_active
from pg_temp.inventory_variant_seed as seed
order by seed.product_id, seed.variant_label
on conflict do nothing;

-- =========================================================
-- 7. INITIAL STOCK MOVEMENTS
-- =========================================================

insert into public.inventory_movements (
  product_variant_id,
  order_id,
  movement_type,
  quantity_delta,
  resulting_stock_quantity,
  actor_user_id,
  reason
)
select
  variant.id,
  null,
  'Initial Stock',
  seed.initial_stock_quantity,
  variant.stock_quantity,
  null,
  'Initial inventory seed'
from pg_temp.inventory_variant_seed as seed
join public.product_variants as variant
  on lower(btrim(variant.sku)) = lower(btrim(seed.sku))
 and lower(btrim(variant.product_id)) = lower(btrim(seed.product_id))
 and lower(btrim(variant.variant_label)) = lower(btrim(seed.variant_label))
where variant.stock_quantity = seed.initial_stock_quantity
on conflict do nothing;

-- =========================================================
-- 8. POST-SEED TRANSACTIONAL VALIDATION
-- =========================================================

do $validation$
begin
  if (
    select count(*)
    from pg_temp.inventory_variant_seed as seed
    join public.product_variants as variant
      on lower(btrim(variant.sku)) = lower(btrim(seed.sku))
     and lower(btrim(variant.product_id)) = lower(btrim(seed.product_id))
     and lower(btrim(variant.variant_label)) = lower(btrim(seed.variant_label))
  ) <> 381 then
    raise exception using
      errcode = '23514',
      message = 'Not every approved inventory seed variant was created or matched.';
  end if;

  if exists (
    select 1
    from pg_temp.inventory_variant_seed as seed
    join public.product_variants as variant
      on lower(btrim(variant.sku)) = lower(btrim(seed.sku))
    where variant.product_id is distinct from seed.product_id
       or variant.variant_label is distinct from seed.variant_label
       or variant.stock_quantity is distinct from seed.initial_stock_quantity
       or variant.low_stock_threshold is distinct from seed.low_stock_threshold
       or variant.is_active is distinct from seed.variant_is_active
  ) then
    raise exception using
      errcode = '23514',
      message = 'An existing inventory variant conflicts with the approved seed.';
  end if;

  if (
    select count(distinct variant.product_id)
    from pg_temp.inventory_variant_seed as seed
    join public.product_variants as variant
      on lower(btrim(variant.sku)) = lower(btrim(seed.sku))
  ) <> 105 then
    raise exception using
      errcode = '23514',
      message = 'Seeded variants do not represent exactly 105 products.';
  end if;

  if (
    select coalesce(sum(variant.stock_quantity), 0)
    from pg_temp.inventory_variant_seed as seed
    join public.product_variants as variant
      on lower(btrim(variant.sku)) = lower(btrim(seed.sku))
  ) <> 3810 then
    raise exception using
      errcode = '23514',
      message = 'Seeded variant stock does not total 3810.';
  end if;

  if (
    select count(*)
    from pg_temp.inventory_variant_seed as seed
    join public.product_variants as variant
      on lower(btrim(variant.sku)) = lower(btrim(seed.sku))
    join public.inventory_movements as movement
      on movement.product_variant_id = variant.id
     and movement.movement_type = 'Initial Stock'
  ) <> 381 then
    raise exception using
      errcode = '23514',
      message = 'Each seeded variant must have one Initial Stock movement.';
  end if;

  if (
    select coalesce(sum(movement.quantity_delta), 0)
    from pg_temp.inventory_variant_seed as seed
    join public.product_variants as variant
      on lower(btrim(variant.sku)) = lower(btrim(seed.sku))
    join public.inventory_movements as movement
      on movement.product_variant_id = variant.id
     and movement.movement_type = 'Initial Stock'
  ) <> 3810 then
    raise exception using
      errcode = '23514',
      message = 'Initial Stock movement quantities do not total 3810.';
  end if;

  if exists (
    select 1
    from pg_temp.inventory_variant_seed as seed
    join public.product_variants as variant
      on lower(btrim(variant.sku)) = lower(btrim(seed.sku))
    join public.inventory_movements as movement
      on movement.product_variant_id = variant.id
     and movement.movement_type = 'Initial Stock'
    where movement.order_id is not null
       or movement.actor_user_id is not null
       or movement.quantity_delta <> 10
       or movement.resulting_stock_quantity <> 10
       or movement.reason <> 'Initial inventory seed'
  ) then
    raise exception using
      errcode = '23514',
      message = 'Initial Stock movement data does not match the approved seed.';
  end if;

  if exists (
    select 1
    from public.product_variants
    where stock_quantity < 0
       or low_stock_threshold < 0
  ) then
    raise exception using
      errcode = '23514',
      message = 'Negative inventory values are not allowed.';
  end if;
end
$validation$;

-- =========================================================
-- 9. RLS AND DIRECT TABLE PERMISSIONS
-- =========================================================

alter table public.product_variants enable row level security;
alter table public.inventory_movements enable row level security;

revoke all
on table public.product_variants
from public, anon, authenticated;

revoke all
on table public.inventory_movements
from public, anon, authenticated;

grant select
on table public.product_variants
to authenticated;

grant select
on table public.inventory_movements
to authenticated;

drop policy if exists product_variants_admin_select
on public.product_variants;

create policy product_variants_admin_select
on public.product_variants
for select
to authenticated
using (coalesce((select public.is_admin()), false));

drop policy if exists inventory_movements_admin_select
on public.inventory_movements;

create policy inventory_movements_admin_select
on public.inventory_movements
for select
to authenticated
using (coalesce((select public.is_admin()), false));

-- =========================================================
-- 10. SAFE ACTIVE-ONLY STOREFRONT READ RPC
-- =========================================================
-- Only active products with active variants are returned.
-- Inactive product and variant records expose no storefront row.
-- Active zero-stock variants remain visible as Out of Stock.

create or replace function public.get_storefront_variants(
  p_product_ids text[] default null
)
returns table (
  variant_id uuid,
  product_id text,
  sku text,
  variant_label text,
  purchasable_quantity integer,
  low_stock_threshold integer,
  stock_state text,
  product_is_active boolean,
  variant_is_active boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    variant.id as variant_id,
    variant.product_id,
    variant.sku,
    variant.variant_label,
    least(20, greatest(variant.stock_quantity, 0))::integer
      as purchasable_quantity,
    variant.low_stock_threshold,
    case
      when variant.stock_quantity = 0
        then 'Out of Stock'
      when variant.stock_quantity between 1 and variant.low_stock_threshold
        then 'Low Stock'
      else 'In Stock'
    end::text as stock_state,
    product.is_active as product_is_active,
    variant.is_active as variant_is_active
  from public.product_variants as variant
  join public.products as product
    on product.id = variant.product_id
  where product.is_active = true
    and variant.is_active = true
    and (
      p_product_ids is null
      or variant.product_id = any(p_product_ids)
    )
  order by variant.product_id, variant.variant_label;
$$;

revoke all
on function public.get_storefront_variants(text[])
from public, anon, authenticated;

grant execute
on function public.get_storefront_variants(text[])
to anon, authenticated;

commit;
