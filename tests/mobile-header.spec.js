const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { expect, test } = require("@playwright/test");

const screenshotDir = path.join(process.cwd(), "screenshots");
const productCatalogueFixturePath = path.join(process.cwd(), "tests", "fixtures", "product-catalog-ids.json");
const storefrontProductPages = new Map([
  ["index.html", 16],
  ["products.html", 16],
  ["football-shoes.html", 20],
  ["jerseys.html", 20],
  ["t-shirts.html", 20],
  ["footballs.html", 20],
  ["accessories.html", 20],
]);

function readStaticProductCards(fileName) {
  const html = fs.readFileSync(path.join(process.cwd(), fileName), "utf8");
  return [...html.matchAll(/<article\b([^>]*\bclass="[^"]*\bproduct-card\b[^"]*"[^>]*)>([\s\S]*?)<\/article>/g)]
    .map((match) => ({
      fileName,
      id: match[1].match(/\bdata-product-id="([^"]*)"/)?.[1]?.trim() || "",
      name: match[2].match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1]?.replace(/<[^>]+>/g, "").trim() || "",
    }));
}

async function expectNoHorizontalOverflow(page) {
  const sizes = await page.evaluate(() => ({
    htmlScrollWidth: document.documentElement.scrollWidth,
    htmlClientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    windowWidth: window.innerWidth,
  }));

  expect(sizes.htmlScrollWidth).toBeLessThanOrEqual(sizes.htmlClientWidth + 1);
  expect(sizes.bodyScrollWidth).toBeLessThanOrEqual(sizes.windowWidth + 1);
}

async function expectInViewport(locator, viewportWidth, viewportHeight) {
  const box = await locator.boundingBox();

  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth);
  expect(box.y + box.height).toBeLessThanOrEqual(viewportHeight);
}

async function visibleProductCount(page) {
  return page.locator(".product-card").evaluateAll((cards) =>
    cards.filter((card) => {
      const styles = window.getComputedStyle(card);
      const rect = card.getBoundingClientRect();
      return styles.display !== "none" && styles.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }).length
  );
}

async function waitForImages(locator) {
  await locator.evaluateAll((images) =>
    Promise.all(
      images.map(async (image) => {
        if (!image.complete) {
          await new Promise((resolve) => image.addEventListener("load", resolve, { once: true }));
        }

        if (image.decode) {
          await image.decode().catch(() => {});
        }
      })
    )
  );
}

function createVariantRows(productId, labels, states = {}) {
  return labels.map((variantLabel, index) => {
    const configuredState = states[variantLabel] || "In Stock";
    const purchasableQuantity = configuredState === "Out of Stock"
      ? 0
      : configuredState === "Low Stock"
        ? 2
        : 10;
    const variantIdSuffix = crypto.createHash("sha256")
      .update(`${productId}:${variantLabel}:${index}`)
      .digest("hex")
      .slice(0, 12);
    return {
      variant_id: `00000000-0000-4000-8000-${variantIdSuffix}`,
      product_id: productId,
      sku: `ATF-${productId}-${variantLabel}`.toUpperCase().replace(/[^A-Z0-9]+/g, "-"),
      variant_label: variantLabel,
      purchasable_quantity: purchasableQuantity,
      low_stock_threshold: 3,
      stock_state: configuredState,
      product_is_active: true,
      variant_is_active: true,
    };
  });
}

function createAdminInventoryFixtures() {
  const products = {
    shoes: {
      id: "predator-elite-fg",
      name: "Predator Elite FG",
      category: "Football Shoes",
      image: "assets/shoe-retro-leather.avif",
      is_active: true,
    },
    jersey: {
      id: "elite-home-jersey",
      name: "Elite Home Jersey",
      category: "Jerseys",
      image: "assets/jersey-elite-home.avif",
      is_active: true,
    },
    ball: {
      id: "premier-match-ball",
      name: "Premier Match Ball",
      category: "Footballs",
      image: "assets/football-fan-edition-ball.avif",
      is_active: true,
    },
  };
  const inventoryVariants = [
    {
      id: "10000000-0000-4000-8000-000000000001",
      product_id: products.shoes.id,
      sku: "ATF-PREDATOR-ELITE-FG-UK6",
      variant_label: "UK 6",
      stock_quantity: 10,
      low_stock_threshold: 3,
      is_active: true,
      updated_at: "2026-07-17T09:00:00.000Z",
      products: products.shoes,
    },
    {
      id: "10000000-0000-4000-8000-000000000002",
      product_id: products.shoes.id,
      sku: "ATF-PREDATOR-ELITE-FG-UK7",
      variant_label: "UK 7",
      stock_quantity: 2,
      low_stock_threshold: 3,
      is_active: true,
      updated_at: "2026-07-17T09:05:00.000Z",
      products: products.shoes,
    },
    {
      id: "10000000-0000-4000-8000-000000000003",
      product_id: products.jersey.id,
      sku: "ATF-ELITE-HOME-JERSEY-M",
      variant_label: "M",
      stock_quantity: 0,
      low_stock_threshold: 3,
      is_active: true,
      updated_at: "2026-07-17T09:10:00.000Z",
      products: products.jersey,
    },
    {
      id: "10000000-0000-4000-8000-000000000004",
      product_id: products.jersey.id,
      sku: "ATF-ELITE-HOME-JERSEY-L",
      variant_label: "L",
      stock_quantity: 7,
      low_stock_threshold: 3,
      is_active: false,
      updated_at: "2026-07-17T09:15:00.000Z",
      products: products.jersey,
    },
    {
      id: "10000000-0000-4000-8000-000000000005",
      product_id: products.ball.id,
      sku: "ATF-PREMIER-MATCH-BALL-SIZE5",
      variant_label: "Size 5",
      stock_quantity: 12,
      low_stock_threshold: 3,
      is_active: true,
      updated_at: "2026-07-17T09:20:00.000Z",
      products: products.ball,
    },
  ];
  const movement = (index, variantIndex, movementType, delta, resultingStock, orderId = null) => {
    const variant = inventoryVariants[variantIndex];
    return {
      id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      product_variant_id: variant.id,
      order_id: orderId,
      movement_type: movementType,
      quantity_delta: delta,
      resulting_stock_quantity: resultingStock,
      reason: `${movementType} test record`,
      created_at: `2026-07-17T0${index}:00:00.000Z`,
      product_variants: {
        id: variant.id,
        product_id: variant.product_id,
        sku: variant.sku,
        variant_label: variant.variant_label,
        products: variant.products,
      },
    };
  };
  return {
    inventoryVariants,
    inventoryMovements: [
      movement(4, 0, "Cancellation Restoration", 1, 10, "order-restored"),
      movement(3, 0, "Order Deduction", -1, 9, "order-deducted"),
      movement(2, 1, "Admin Adjustment", -2, 2),
      movement(1, 4, "Initial Stock", 10, 10),
    ],
  };
}

function createAdminInventoryVariantSet(count = 381, namePrefix = "Catalogue Product") {
  const categories = ["Football Shoes", "Jerseys", "T-Shirts", "Footballs", "Accessories"];
  return Array.from({ length: count }, (_, index) => {
    const productIndex = index % 105;
    const productId = `catalog-product-${String(productIndex + 1).padStart(3, "0")}`;
    const sequence = String(index + 1).padStart(12, "0");
    return {
      id: `40000000-0000-4000-8000-${sequence}`,
      product_id: productId,
      sku: `ATF-CATALOG-${String(index + 1).padStart(3, "0")}`,
      variant_label: `Variant ${String(index + 1).padStart(3, "0")}`,
      stock_quantity: 10,
      low_stock_threshold: 3,
      is_active: true,
      updated_at: `2026-07-17T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
      products: {
        id: productId,
        name: `${namePrefix} ${String(productIndex + 1).padStart(3, "0")}`,
        category: categories[productIndex % categories.length],
        image: "assets/hero-football-boot.avif",
        is_active: true,
      },
    };
  });
}

async function openDrawer(page) {
  const menuButton = page.locator(".menu-toggle");
  const drawer = page.locator("#mobile-drawer");
  const overlay = page.locator(".drawer-overlay");
  const viewport = page.viewportSize();

  await menuButton.click();
  await expect(drawer).toHaveClass(/open/);
  await expect(overlay).toHaveClass(/show/);

  await expect
    .poll(async () => {
      const drawerBox = await drawer.boundingBox();
      return drawerBox ? Math.round(drawerBox.x + drawerBox.width) : 0;
    })
    .toBe(viewport.width);
}

async function exposeCheckoutTestHooks(page) {
  await page.route("**/script.js", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = "  function boot() {";
    const exposed = `  window.__phase2A3CheckoutTestHooks = { handleCheckoutSubmit, createCheckoutModal };\n\n${marker}`;
    expect(source).toContain(marker);
    await route.fulfill({ response, body: source.replace(marker, exposed) });
  });
}


async function installSupabaseStub(page, options = {}) {
  await page.addInitScript((config) => {
    if (config.variantUi === true || config.variantCartV2 === true || config.variantCheckoutV2 === true) {
      const features = {
        variantUi: config.variantUi === true,
        variantCartV2: config.variantCartV2 === true,
      };
      if (!config.omitVariantCheckoutFlag) features.variantCheckoutV2 = config.variantCheckoutV2 === true;
      window.__ATTRACTION_FEATURES__ = features;
    }
    let currentUser = config.user || null;
    let remainingPlaceOrderFailures = Number(config.failPlaceOrderAttempts || 0);
    let remainingCartMergeFailures = Number(config.failCartMergeAttempts || 0);
    let remainingOrderLoadFailures = Number(config.failOrderLoadAttempts || 0);
    let remainingAdjustmentFailures = Number(config.failAdjustmentAttempts || 0);
    let remainingInventoryLoadFailures = Number(config.failInventoryLoadAttempts || 0);
    let remainingPlaceOrderV2Failures = Number(config.failPlaceOrderV2Attempts || 0);
    let remainingPlaceOrderV2UnknownResults = Number(config.unknownPlaceOrderV2Attempts || 0);
    let remainingPlaceOrderV2Conflicts = Number(config.placeOrderV2IdempotencyConflictAttempts || 0);
    const listeners = [];
    const state = {
      rpcs: [],
      placeOrderCalls: [],
      placeOrderV2Calls: [],
      statusUpdateCalls: [],
      paymentStatusUpdateCalls: [],
      cancellationRequestCalls: [],
      cancellationReviewCalls: [],
      adjustmentCalls: [],
      inserts: [],
      updates: [],
      selects: [],
      cloudCarts: JSON.parse(JSON.stringify(config.cloudCarts || {})),
      cloudVariantCarts: JSON.parse(JSON.stringify(config.cloudVariantCarts || {})),
      legacyVariantCarts: JSON.parse(JSON.stringify(config.legacyVariantCarts || {})),
      cloudWishlists: JSON.parse(JSON.stringify(config.cloudWishlists || {})),
      variantRows: JSON.parse(JSON.stringify(config.variantRows || [])),
      inventoryVariants: JSON.parse(JSON.stringify(config.inventoryVariants || [])),
      inventoryVariantsByUser: JSON.parse(JSON.stringify(config.inventoryVariantsByUser || {})),
      inventoryMovements: JSON.parse(JSON.stringify(config.inventoryMovements || [])),
      inventorySelectCalls: 0,
      inventoryLoadDelayByUser: JSON.parse(JSON.stringify(config.inventoryLoadDelayByUser || {})),
    };
    window.__attractionSupabaseTestState = state;

    const catalog = {
      "predator-elite-fg": {
        id: "predator-elite-fg",
        name: "Predator Elite FG",
        category: "Football Shoes",
        price: 219.99,
        image: "assets/shoe-retro-leather.avif",
        is_active: true,
      },
      "phantom-control-pro": {
        id: "phantom-control-pro",
        name: "Phantom Control Pro",
        category: "Football Shoes",
        price: 199.99,
        image: "assets/shoe-honeycomb-control.avif",
        is_active: true,
      },
      ...(config.catalog || {}),
    };
    const mergeReceipts = new Set();
    const variantMergeReceipts = new Map();
    const adjustmentReceipts = new Map();
    const placeOrderV2Receipts = new Map();

    const cartFor = (userId) => {
      if (!state.cloudCarts[userId]) state.cloudCarts[userId] = [];
      return state.cloudCarts[userId];
    };
    const wishlistFor = (userId) => {
      if (!state.cloudWishlists[userId]) state.cloudWishlists[userId] = [];
      return state.cloudWishlists[userId];
    };
    const variantCartFor = (userId) => {
      if (!state.cloudVariantCarts[userId]) state.cloudVariantCarts[userId] = [];
      return state.cloudVariantCarts[userId];
    };
    const legacyVariantCartFor = (userId) => {
      if (!state.legacyVariantCarts[userId]) state.legacyVariantCarts[userId] = [];
      return state.legacyVariantCarts[userId];
    };
    const variantRowFor = (variantId) => state.variantRows.find((row) => row.variant_id === variantId);
    const productFor = (productId) => catalog[productId] || {
      id: productId,
      name: productId,
      category: "Product",
      price: 0,
      image: "",
      is_active: true,
    };
    const joinedVariantCartRows = (userId) => variantCartFor(userId).map((item, index) => {
      const variant = variantRowFor(item.product_variant_id) || {};
      const product = productFor(item.product_id);
      return {
        cart_line_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        product_id: item.product_id,
        product_variant_id: item.product_variant_id,
        variant_sku: variant.sku || "",
        variant_label: variant.variant_label || "Selected option",
        product_name: product.name,
        category: product.category,
        unit_price: product.price,
        image: product.image,
        quantity: item.quantity,
        product_is_active: item.product_is_active ?? product.is_active !== false,
        variant_is_active: item.variant_is_active ?? variant.variant_is_active !== false,
        purchasable_quantity: item.purchasable_quantity ?? variant.purchasable_quantity ?? 0,
        stock_state: item.stock_state || variant.stock_state || "Unavailable",
        checkout_resolution_required: false,
        created_at: `2026-07-15T00:00:${String(index).padStart(2, "0")}.000Z`,
        updated_at: `2026-07-15T00:00:${String(index).padStart(2, "0")}.000Z`,
      };
    });
    const joinedLegacyVariantRows = (userId) => legacyVariantCartFor(userId).map((item) => {
      const product = productFor(item.product_id);
      const variants = state.variantRows.filter((row) => row.product_id === item.product_id && row.variant_is_active !== false);
      const automatic = variants.length === 1 ? variants[0] : null;
      return {
        product_id: item.product_id,
        product_name: product.name,
        category: product.category,
        unit_price: product.price,
        image: product.image,
        quantity: item.quantity,
        product_is_active: product.is_active !== false,
        active_variant_count: variants.length,
        automatic_variant_id: automatic?.variant_id || null,
        automatic_variant_sku: automatic?.sku || null,
        automatic_variant_label: automatic?.variant_label || null,
        resolution_status: variants.length === 1
          ? "Automatic"
          : variants.length > 1 ? "Size selection required" : "No active variants",
      };
    });
    const joinedCartRows = (userId) => cartFor(userId).map((item, index) => ({
      product_id: item.product_id,
      quantity: item.quantity,
      created_at: item.created_at || `2026-07-12T00:00:${String(index).padStart(2, "0")}.000Z`,
      products: catalog[item.product_id] || {
        id: item.product_id,
        name: item.product_id,
        category: "Product",
        price: 0,
        image: "",
        is_active: true,
      },
    }));
    const joinedWishlistRows = (userId) => wishlistFor(userId).map((item, index) => ({
      product_id: typeof item === "string" ? item : item.product_id,
      created_at: `2026-07-12T00:01:${String(index).padStart(2, "0")}.000Z`,
      products: catalog[typeof item === "string" ? item : item.product_id] || {
        id: typeof item === "string" ? item : item.product_id,
        name: typeof item === "string" ? item : item.product_id,
        category: "Product",
        price: 0,
        image: "",
        is_active: true,
      },
    }));

    const sessionForUser = () => (currentUser ? { user: currentUser } : null);

    window.__attractionSupabaseClient = {
      auth: {
        getSession: async () => {
          if (config.sessionDelay) await new Promise((resolve) => setTimeout(resolve, config.sessionDelay));
          return { data: { session: sessionForUser() }, error: null };
        },
        onAuthStateChange: (callback) => {
          listeners.push(callback);
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
        signInWithPassword: async ({ email }) => {
          currentUser = config.usersByEmail?.[email] || {
            id: "auth-user-1",
            email,
            user_metadata: { full_name: "Admin User", phone: "+91 98765 43210" },
          };
          listeners.forEach((listener) => listener("SIGNED_IN", { user: currentUser }));
          return { data: { user: currentUser, session: { user: currentUser } }, error: null };
        },
        signUp: async ({ email, options }) => ({ data: { user: { email, user_metadata: options.data }, session: null }, error: null }),
        signOut: async () => {
          currentUser = null;
          listeners.forEach((listener) => listener("SIGNED_OUT", null));
          return { error: null };
        },
      },
      rpc: async (name, payload = {}) => {
        state.rpcs.push({ name, payload });
        if (name === "get_storefront_variants") {
          if (config.failVariantRpc) {
            return { data: null, error: { message: "Private test detail" } };
          }
          const requestedIds = new Set(payload.p_product_ids || []);
          return {
            data: state.variantRows.filter((row) => requestedIds.has(row.product_id)),
            error: null,
          };
        }
        if ([
          "get_cart_v2",
          "get_legacy_cart_items_v2",
          "set_cart_item_v2",
          "remove_cart_item_v2",
          "clear_cart_v2",
          "resolve_legacy_cart_item_v2",
          "merge_guest_cart_v2",
        ].includes(name)) {
          const userId = currentUser?.id;
          if (!userId) return { data: null, error: { code: "42501", message: "Authentication required" } };
          if (config.failVariantCartRpc === name || config.failVariantCartRpc === true) {
            return { data: null, error: { message: "Private variant cart failure" } };
          }
          if (name === "get_cart_v2") {
            const delay = Number(config.variantCartLoadDelays?.[userId] || 0);
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
            return { data: joinedVariantCartRows(userId), error: null };
          }
          if (name === "get_legacy_cart_items_v2") return { data: joinedLegacyVariantRows(userId), error: null };

          const userCart = variantCartFor(userId);
          if (name === "set_cart_item_v2") {
            const delay = Number(config.variantMutationDelay || 0);
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
            const existing = userCart.find((item) => item.product_variant_id === payload.p_product_variant_id);
            if (existing) existing.quantity = payload.p_quantity;
            else userCart.push({
              product_id: payload.p_product_id,
              product_variant_id: payload.p_product_variant_id,
              quantity: payload.p_quantity,
            });
            return { data: payload.p_quantity, error: null };
          }
          if (name === "remove_cart_item_v2") {
            const index = userCart.findIndex((item) => item.product_variant_id === payload.p_product_variant_id);
            if (index >= 0) userCart.splice(index, 1);
            return { data: index >= 0, error: null };
          }
          if (name === "clear_cart_v2") {
            const count = userCart.length;
            userCart.splice(0, userCart.length);
            return { data: count, error: null };
          }
          if (name === "resolve_legacy_cart_item_v2") {
            const legacy = legacyVariantCartFor(userId);
            const index = legacy.findIndex((item) => item.product_id === payload.p_product_id);
            if (index < 0) return { data: { status: "No legacy item" }, error: null };
            const [item] = legacy.splice(index, 1);
            const existing = userCart.find((saved) => saved.product_variant_id === payload.p_product_variant_id);
            if (existing) existing.quantity = Math.min(20, existing.quantity + item.quantity);
            else userCart.push({
              product_id: item.product_id,
              product_variant_id: payload.p_product_variant_id,
              quantity: Math.min(20, item.quantity),
            });
            return { data: { status: "Resolved" }, error: null };
          }

          const normalized = [...(payload.p_items || [])]
            .map((item) => ({
              productId: item.productId,
              productVariantId: item.productVariantId,
              quantity: item.quantity,
            }))
            .sort((first, second) => first.productVariantId.localeCompare(second.productVariantId));
          const signature = JSON.stringify(normalized);
          const receiptKey = `${userId}:${payload.p_merge_token}`;
          const existingReceipt = variantMergeReceipts.get(receiptKey);
          if (existingReceipt && existingReceipt !== signature) {
            return { data: null, error: { message: "Merge token payload mismatch" } };
          }
          if (existingReceipt) return { data: { idempotent_replay: true }, error: null };
          if (config.failVariantMergeAttempts > 0) {
            config.failVariantMergeAttempts -= 1;
            return { data: null, error: { message: "Temporary variant merge failure" } };
          }
          variantMergeReceipts.set(receiptKey, signature);
          normalized.forEach((item) => {
            const existing = userCart.find((saved) => saved.product_variant_id === item.productVariantId);
            if (existing) existing.quantity = Math.min(20, existing.quantity + item.quantity);
            else userCart.push({
              product_id: item.productId,
              product_variant_id: item.productVariantId,
              quantity: Math.min(20, item.quantity),
            });
          });
          return { data: { idempotent_replay: false }, error: null };
        }
        if (name === "is_admin") {
          const adminUserId = currentUser?.id;
          const delay = Number(config.adminCheckDelayByUser?.[adminUserId] || config.adminCheckDelay || 0);
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          const isAdmin = config.adminByUserId
            ? Boolean(config.adminByUserId[adminUserId])
            : Boolean(config.isAdmin);
          return { data: isAdmin, error: config.adminError ? { message: config.adminError } : null };
        }
        if (name === "adjust_variant_stock") {
          state.adjustmentCalls.push(payload);
          if (!currentUser) return { data: null, error: { message: "Authentication required." } };
          if (!config.isAdmin) return { data: null, error: { message: "Admin access required." } };
          if (config.adjustmentDelay) await new Promise((resolve) => setTimeout(resolve, config.adjustmentDelay));
          if (remainingAdjustmentFailures > 0) {
            remainingAdjustmentFailures -= 1;
            return { data: null, error: { message: config.adjustmentError || "Temporary network failure" } };
          }
          if (config.adjustmentError && !config.failAdjustmentAttempts) {
            return { data: null, error: { message: config.adjustmentError } };
          }

          const signature = JSON.stringify({
            variant: payload.p_product_variant_id,
            expected: payload.p_expected_stock_quantity,
            quantity: payload.p_new_stock_quantity,
            reason: payload.p_reason,
          });
          const receiptKey = `${currentUser.id}:${payload.p_idempotency_key}`;
          const existingReceipt = adjustmentReceipts.get(receiptKey);
          if (existingReceipt) {
            if (existingReceipt.signature !== signature) {
              return { data: null, error: { message: "This adjustment identifier was already used for different inventory details." } };
            }
            return { data: [{ ...existingReceipt.result, idempotent_replay: true }], error: null };
          }

          const variant = state.inventoryVariants.find((row) => row.id === payload.p_product_variant_id);
          if (!variant) return { data: null, error: { message: "Product variant not found." } };
          if (config.staleVariantId === variant.id && !config.staleVariantTriggered) {
            config.staleVariantTriggered = true;
            variant.stock_quantity = Number(config.staleStockQuantity ?? variant.stock_quantity + 1);
            variant.updated_at = "2026-07-17T10:20:00.000Z";
          }
          if (variant.stock_quantity !== payload.p_expected_stock_quantity) {
            return { data: null, error: { message: "Inventory changed. Refresh the variant and try again." } };
          }
          if (variant.stock_quantity === payload.p_new_stock_quantity) {
            return { data: null, error: { message: "Stock quantity is already set to this value." } };
          }

          const previousStock = variant.stock_quantity;
          const newStock = payload.p_new_stock_quantity;
          const delta = newStock - previousStock;
          const adjustedAt = "2026-07-17T10:30:00.000Z";
          const movementId = `30000000-0000-4000-8000-${String(state.inventoryMovements.length + 1).padStart(12, "0")}`;
          variant.stock_quantity = newStock;
          variant.updated_at = adjustedAt;
          const product = Array.isArray(variant.products) ? variant.products[0] : variant.products;
          state.inventoryMovements.unshift({
            id: movementId,
            product_variant_id: variant.id,
            order_id: null,
            movement_type: "Admin Adjustment",
            quantity_delta: delta,
            resulting_stock_quantity: newStock,
            reason: payload.p_reason,
            created_at: adjustedAt,
            product_variants: {
              id: variant.id,
              product_id: variant.product_id,
              sku: variant.sku,
              variant_label: variant.variant_label,
              products: product,
            },
          });
          const stockState = newStock === 0
            ? "Out of Stock"
            : newStock <= variant.low_stock_threshold ? "Low Stock" : "In Stock";
          const result = {
            product_variant_id: variant.id,
            product_id: variant.product_id,
            sku: variant.sku,
            variant_label: variant.variant_label,
            previous_stock_quantity: previousStock,
            new_stock_quantity: newStock,
            quantity_delta: delta,
            low_stock_threshold: variant.low_stock_threshold,
            stock_state: stockState,
            movement_id: movementId,
            adjusted_at: adjustedAt,
            idempotent_replay: false,
          };
          adjustmentReceipts.set(receiptKey, { signature, result });
          return { data: [result], error: null };
        }
        if (["set_cart_item", "remove_cart_item", "clear_cart", "merge_guest_cart"].includes(name)) {
          if (name === "merge_guest_cart" && remainingCartMergeFailures > 0) {
            remainingCartMergeFailures -= 1;
            return { data: null, error: { message: "Temporary cart migration failure" } };
          }
          if (config.failCartRpc === name || config.failCartRpc === true) {
            return { data: null, error: { message: "Cart synchronization failed" } };
          }
          const userId = currentUser?.id;
          if (!userId) return { data: null, error: { code: "42501", message: "Authentication required" } };
          const userCart = cartFor(userId);

          if (name === "set_cart_item") {
            const existing = userCart.find((item) => item.product_id === payload.p_product_id);
            if (existing) existing.quantity = payload.p_quantity;
            else userCart.push({ product_id: payload.p_product_id, quantity: payload.p_quantity });
            return { data: payload.p_quantity, error: null };
          }
          if (name === "remove_cart_item") {
            const index = userCart.findIndex((item) => item.product_id === payload.p_product_id);
            if (index >= 0) userCart.splice(index, 1);
            const legacyCart = legacyVariantCartFor(userId);
            const legacyIndex = legacyCart.findIndex((item) => item.product_id === payload.p_product_id);
            if (legacyIndex >= 0) legacyCart.splice(legacyIndex, 1);
            return { data: index >= 0 || legacyIndex >= 0, error: null };
          }
          if (name === "clear_cart") {
            const count = userCart.length;
            userCart.splice(0, userCart.length);
            return { data: count, error: null };
          }

          const receipt = `${userId}:${payload.p_merge_token}`;
          if (mergeReceipts.has(receipt)) {
            return { data: { merged: true, already_processed: true, item_count: 0 }, error: null };
          }
          mergeReceipts.add(receipt);
          for (const item of payload.p_items || []) {
            const existing = userCart.find((saved) => saved.product_id === item.product_id);
            if (existing) existing.quantity = Math.min(20, existing.quantity + item.quantity);
            else userCart.push({ product_id: item.product_id, quantity: Math.min(20, item.quantity) });
          }
          return { data: { merged: true, already_processed: false, item_count: payload.p_items?.length || 0 }, error: null };
        }
        if (["set_wishlist_item", "remove_wishlist_item", "merge_guest_wishlist"].includes(name)) {
          if (config.failWishlistRpc === name || config.failWishlistRpc === true) {
            return { data: null, error: { message: "Wishlist synchronization failed" } };
          }
          const userId = currentUser?.id;
          if (!userId) return { data: null, error: { code: "42501", message: "Authentication required" } };
          const userWishlist = wishlistFor(userId);
          if (name === "set_wishlist_item") {
            if (!userWishlist.includes(payload.p_product_id)) userWishlist.push(payload.p_product_id);
            return { data: true, error: null };
          }
          if (name === "remove_wishlist_item") {
            const index = userWishlist.indexOf(payload.p_product_id);
            if (index >= 0) userWishlist.splice(index, 1);
            return { data: index >= 0, error: null };
          }
          for (const item of payload.p_items || []) {
            if (!userWishlist.includes(item.product_id)) userWishlist.push(item.product_id);
          }
          return { data: payload.p_items?.length || 0, error: null };
        }
        if (name === "place_order") {
          state.placeOrderCalls.push(payload);
          if (config.placeOrderDelay) await new Promise((resolve) => setTimeout(resolve, config.placeOrderDelay));
          if (remainingPlaceOrderFailures > 0) {
            remainingPlaceOrderFailures -= 1;
            return {
              data: null,
              error: {
                code: config.placeOrderErrorCode || "P0001",
                message: config.failPlaceOrder || "Order failed",
              },
            };
          }
          if (config.failPlaceOrder && !config.failPlaceOrderAttempts) {
            return {
              data: null,
              error: {
                code: config.placeOrderErrorCode || "P0001",
                message: config.failPlaceOrder,
              },
            };
          }
          return {
            data: [{
              order_id: config.orderId || "order-test-001",
              total_amount: config.serverTotal ?? 219.99,
              order_status: "Pending",
              payment_method: "COD",
              payment_status: "Unpaid",
            }],
            error: null,
          };
        }
        if (name === "place_order_v2") {
          state.placeOrderV2Calls.push(payload);
          const userId = currentUser?.id;
          if (!userId) return { data: null, error: { message: "Authentication required." } };
          const normalizedItems = [...(payload.p_items || [])]
            .map((item) => ({
              product_id: item.product_id,
              product_variant_id: item.product_variant_id,
              quantity: item.quantity,
            }))
            .sort((first, second) => first.product_variant_id.localeCompare(second.product_variant_id));
          const signature = JSON.stringify({
            items: normalizedItems,
            shipping: payload.p_shipping_details,
          });
          const receiptKey = `${userId}:${payload.p_idempotency_key}`;
          const existingReceipt = placeOrderV2Receipts.get(receiptKey);
          if (existingReceipt) {
            if (existingReceipt.signature !== signature) {
              return { data: null, error: { message: "This checkout identifier was already used for different order details." } };
            }
            return { data: [{ ...existingReceipt.result, idempotent_replay: true }], error: null };
          }
          if (config.placeOrderV2Delay) {
            await new Promise((resolve) => setTimeout(resolve, config.placeOrderV2Delay));
          }
          if (remainingPlaceOrderV2Conflicts > 0) {
            remainingPlaceOrderV2Conflicts -= 1;
            return { data: null, error: { message: "This checkout identifier was already used for different order details." } };
          }
          if (remainingPlaceOrderV2Failures > 0) {
            remainingPlaceOrderV2Failures -= 1;
            return { data: null, error: { message: config.failPlaceOrderV2 || "Temporary checkout failure" } };
          }
          if (config.failPlaceOrderV2 && !config.failPlaceOrderV2Attempts) {
            return { data: null, error: { message: config.failPlaceOrderV2 } };
          }
          const result = {
            order_id: config.orderV2Id || "order-v2-test-001",
            total_amount: config.serverV2Total ?? 219.99,
            order_status: "Pending",
            payment_method: "COD",
            payment_status: "Unpaid",
            inventory_deducted_at: "2026-07-18T10:00:00.000Z",
            item_count: normalizedItems.length,
            idempotent_replay: false,
          };
          placeOrderV2Receipts.set(receiptKey, { signature, result });
          if (!config.keepVariantCartAfterSuccess) {
            const submittedIds = new Set(normalizedItems.map((item) => item.product_variant_id));
            const userCart = variantCartFor(userId);
            for (let index = userCart.length - 1; index >= 0; index -= 1) {
              if (submittedIds.has(userCart[index].product_variant_id)) userCart.splice(index, 1);
            }
          }
          if (remainingPlaceOrderV2UnknownResults > 0) {
            remainingPlaceOrderV2UnknownResults -= 1;
            return { data: null, error: { message: "Network request timed out" } };
          }
          return { data: [result], error: null };
        }
        if (name === "update_order_status") {
          state.statusUpdateCalls.push(payload);
          if (config.failStatusUpdate) return { data: null, error: { message: config.failStatusUpdate } };
          return {
            data: [{
              order_id: payload.p_order_id,
              order_status: payload.p_new_status,
              status_updated_at: "2026-07-11T11:00:00.000Z",
            }],
            error: null,
          };
        }
        if (name === "update_order_payment_status") {
          state.paymentStatusUpdateCalls.push(payload);
          if (config.failPaymentStatusUpdate) {
            return { data: null, error: { message: config.failPaymentStatusUpdate } };
          }
          return {
            data: [{
              order_id: payload.p_order_id,
              payment_method: "COD",
              payment_status: payload.p_payment_status,
              payment_collected_at: payload.p_payment_status === "Paid"
                ? "2026-07-11T12:00:00.000Z"
                : null,
            }],
            error: null,
          };
        }
        if (name === "request_order_cancellation") {
          state.cancellationRequestCalls.push(payload);
          if (config.cancellationRequestDelay) {
            await new Promise((resolve) => setTimeout(resolve, config.cancellationRequestDelay));
          }
          if (config.failCancellationRequest) {
            return { data: null, error: { message: config.failCancellationRequest } };
          }
          const order = (config.orders || []).find((entry) => entry.id === payload.p_order_id);
          if (!order) return { data: null, error: { message: "Order was not found" } };
          order.cancellation_request_status = "Pending";
          order.cancellation_reason = payload.p_reason;
          order.cancellation_requested_at = "2026-07-13T10:15:00.000Z";
          return {
            data: [{
              order_id: order.id,
              cancellation_request_status: "Pending",
              cancellation_reason: payload.p_reason,
              cancellation_requested_at: order.cancellation_requested_at,
            }],
            error: null,
          };
        }
        if (name === "review_order_cancellation") {
          state.cancellationReviewCalls.push(payload);
          if (config.failCancellationReview) {
            return { data: null, error: { message: config.failCancellationReview } };
          }
          const order = (config.orders || []).find((entry) => entry.id === payload.p_order_id);
          if (!order || order.cancellation_request_status !== "Pending") {
            return { data: null, error: { message: "Cancellation request has already been reviewed" } };
          }
          order.cancellation_request_status = payload.p_decision;
          order.cancellation_reviewed_at = "2026-07-13T11:00:00.000Z";
          order.cancellation_reviewed_by = currentUser?.id || null;
          order.cancellation_admin_note = payload.p_admin_note;
          if (payload.p_decision === "Approved") {
            order.status = "Cancelled";
            order.cancelled_at = "2026-07-13T11:00:00.000Z";
          }
          return {
            data: [{
              order_id: order.id,
              order_status: order.status,
              cancellation_request_status: order.cancellation_request_status,
              cancellation_reviewed_at: order.cancellation_reviewed_at,
              cancellation_admin_note: order.cancellation_admin_note,
              cancelled_at: order.cancelled_at || null,
            }],
            error: null,
          };
        }
        return { data: null, error: { message: "Unknown RPC" } };
      },
      from: (table) => ({
        insert: (payload) => {
          state.inserts.push({ table, payload });
          return Promise.resolve({ data: payload, error: null });
        },
        select: (columns = "*") => {
          const selectUserId = currentUser?.id;
          const filters = [];
          const orderBy = [];
          let limitCount = null;
          let rangeStart = null;
          let rangeEnd = null;
          const selectRecord = { table, columns, filters, orderBy, range: null };
          state.selects.push(selectRecord);
          const execute = async () => {
            if (table === "cart_items") {
              if (config.collectionLoadDelay) await new Promise((resolve) => setTimeout(resolve, config.collectionLoadDelay));
              if (config.failCartLoad) return { data: null, error: { message: "Cart load failed" } };
              const userId = filters.find(([column]) => column === "user_id")?.[1] || currentUser?.id;
              return { data: joinedCartRows(userId), error: null };
            }
            if (table === "wishlist_items") {
              if (config.collectionLoadDelay) await new Promise((resolve) => setTimeout(resolve, config.collectionLoadDelay));
              if (config.failWishlistLoad) return { data: null, error: { message: "Wishlist load failed" } };
              const userId = filters.find(([column]) => column === "user_id")?.[1] || currentUser?.id;
              return { data: joinedWishlistRows(userId), error: null };
            }
            if (table === "orders") {
              if (config.ordersDelay) await new Promise((resolve) => setTimeout(resolve, config.ordersDelay));
              if (remainingOrderLoadFailures > 0) {
                remainingOrderLoadFailures -= 1;
                return { data: null, error: { message: config.ordersError || "Orders load failed" } };
              }
              if (config.ordersError && !config.failOrderLoadAttempts) {
                return { data: null, error: { message: config.ordersError } };
              }

              let rows = [...(config.orders || [])];
              filters.forEach(([column, value]) => {
                rows = rows.filter((row) => row[column] === value);
              });
              if (orderBy.length) {
                rows.sort((first, second) => {
                  for (const order of orderBy) {
                    const direction = order.ascending ? 1 : -1;
                    const result = String(first[order.column]).localeCompare(String(second[order.column])) * direction;
                    if (result) return result;
                  }
                  return 0;
                });
              }
              return { data: rows, error: null };
            }
            if (table === "product_variants") {
              state.inventorySelectCalls += 1;
              const delay = Number(state.inventoryLoadDelayByUser?.[selectUserId] || config.inventoryLoadDelay || 0);
              if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
              if ((config.failInventoryLoadOnCalls || []).includes(state.inventorySelectCalls)) {
                return { data: null, error: { message: "Private inventory load failure" } };
              }
              if (remainingInventoryLoadFailures > 0) {
                remainingInventoryLoadFailures -= 1;
                return { data: null, error: { message: "Private inventory load failure" } };
              }
              if (config.inventoryVariantsError) return { data: null, error: { message: config.inventoryVariantsError } };
              const ownedRows = state.inventoryVariantsByUser[selectUserId] || state.inventoryVariants;
              let rows = [...ownedRows];
              filters.forEach(([column, value]) => {
                rows = rows.filter((row) => row[column] === value);
              });
              if (orderBy.length) {
                rows.sort((first, second) => {
                  for (const order of orderBy) {
                    const direction = order.ascending ? 1 : -1;
                    const result = String(first[order.column] || "").localeCompare(String(second[order.column] || "")) * direction;
                    if (result) return result;
                  }
                  return 0;
                });
              }
              if (rangeStart !== null && rangeEnd !== null) rows = rows.slice(rangeStart, rangeEnd + 1);
              else if (limitCount) rows = rows.slice(0, limitCount);
              return { data: rows, error: null };
            }
            if (table === "inventory_movements") {
              if (config.inventoryMovementsError) return { data: null, error: { message: config.inventoryMovementsError } };
              let rows = [...state.inventoryMovements];
              if (orderBy.length) {
                rows.sort((first, second) => {
                  for (const order of orderBy) {
                    const direction = order.ascending ? 1 : -1;
                    const result = String(first[order.column] || "").localeCompare(String(second[order.column] || "")) * direction;
                    if (result) return result;
                  }
                  return 0;
                });
              }
              return { data: limitCount ? rows.slice(0, limitCount) : rows, error: null };
            }

            return { data: [], error: null };
          };
          const builder = {
            eq: (column, value) => {
              filters.push([column, value]);
              return builder;
            },
            order: (column, options = {}) => {
              orderBy.push({ column, ascending: options.ascending !== false });
              return builder;
            },
            limit: (count) => {
              limitCount = count;
              return builder;
            },
            range: (from, to) => {
              rangeStart = from;
              rangeEnd = to;
              selectRecord.range = [from, to];
              return builder;
            },
            then: (resolve, reject) => execute().then(resolve, reject),
          };
          return builder;
        },
        update: (payload) => ({
          eq: async (column, value) => {
            state.updates.push({ table, payload, column, value });
            return { data: null, error: null };
          },
        }),
      }),
    };
    window.__setAttractionTestUser = (nextUser, event = nextUser ? "SIGNED_IN" : "SIGNED_OUT") => {
      currentUser = nextUser;
      listeners.forEach((listener) => listener(event, nextUser ? { user: nextUser } : null));
    };
  }, options);
}

function createSharedCloudState() {
  return {
    carts: new Map(),
    wishlists: new Map(),
    catalog: new Map([
      ["predator-elite-fg", {
        id: "predator-elite-fg",
        name: "Predator Elite FG",
        category: "Football Shoes",
        price: 219.99,
        image: "assets/shoe-retro-leather.avif",
        is_active: true,
      }],
      ["phantom-control-pro", {
        id: "phantom-control-pro",
        name: "Phantom Control Pro",
        category: "Football Shoes",
        price: 199.99,
        image: "assets/shoe-honeycomb-control.avif",
        is_active: true,
      }],
    ]),
  };
}

async function installSharedCloudSupabaseStub(page, cloud, user) {
  await page.exposeFunction("__attractionCloudRequest", async ({ type, name, payload, table, userId }) => {
    const cart = cloud.carts.get(userId) || [];
    const wishlist = cloud.wishlists.get(userId) || [];
    cloud.carts.set(userId, cart);
    cloud.wishlists.set(userId, wishlist);

    if (type === "select") {
      if (table === "cart_items") {
        return {
          data: cart.map((item, index) => ({
            ...item,
            created_at: `2026-07-12T01:00:${String(index).padStart(2, "0")}.000Z`,
            products: cloud.catalog.get(item.product_id),
          })),
          error: null,
        };
      }
      if (table === "wishlist_items") {
        return {
          data: wishlist.map((productId, index) => ({
            product_id: productId,
            created_at: `2026-07-12T01:01:${String(index).padStart(2, "0")}.000Z`,
            products: cloud.catalog.get(productId),
          })),
          error: null,
        };
      }
      return { data: [], error: null };
    }

    if (name === "set_cart_item") {
      const existing = cart.find((item) => item.product_id === payload.p_product_id);
      if (existing) existing.quantity = payload.p_quantity;
      else cart.push({ product_id: payload.p_product_id, quantity: payload.p_quantity });
      return { data: payload.p_quantity, error: null };
    }
    if (name === "remove_cart_item") {
      const index = cart.findIndex((item) => item.product_id === payload.p_product_id);
      if (index >= 0) cart.splice(index, 1);
      return { data: index >= 0, error: null };
    }
    if (name === "clear_cart") {
      const count = cart.length;
      cart.splice(0, cart.length);
      return { data: count, error: null };
    }
    if (name === "set_wishlist_item") {
      if (!wishlist.includes(payload.p_product_id)) wishlist.push(payload.p_product_id);
      return { data: true, error: null };
    }
    if (name === "remove_wishlist_item") {
      const index = wishlist.indexOf(payload.p_product_id);
      if (index >= 0) wishlist.splice(index, 1);
      return { data: index >= 0, error: null };
    }
    if (name === "merge_guest_cart" || name === "merge_guest_wishlist") {
      return { data: name === "merge_guest_cart" ? { merged: true } : 0, error: null };
    }
    if (name === "is_admin") return { data: false, error: null };
    return { data: null, error: { message: `Unknown RPC: ${name}` } };
  });

  await page.addInitScript((initialUser) => {
    localStorage.setItem("attractionCookieConsent", "accepted");
    let currentUser = initialUser;
    const listeners = [];
    window.__attractionSupabaseClient = {
      auth: {
        getSession: async () => ({ data: { session: currentUser ? { user: currentUser } : null }, error: null }),
        onAuthStateChange: (callback) => {
          listeners.push(callback);
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
        signInWithPassword: async () => ({ data: { user: currentUser, session: { user: currentUser } }, error: null }),
        signUp: async () => ({ data: { user: null, session: null }, error: null }),
        signOut: async () => {
          currentUser = null;
          listeners.forEach((listener) => listener("SIGNED_OUT", null));
          return { error: null };
        },
      },
      rpc: (name, payload = {}) => window.__attractionCloudRequest({
        type: "rpc",
        name,
        payload,
        userId: currentUser?.id,
      }),
      from: (table) => ({
        select: () => {
          const filters = [];
          const execute = () => window.__attractionCloudRequest({
            type: "select",
            table,
            userId: filters.find(([column]) => column === "user_id")?.[1] || currentUser?.id,
          });
          const builder = {
            eq: (column, value) => {
              filters.push([column, value]);
              return builder;
            },
            order: () => execute(),
            then: (resolve, reject) => execute().then(resolve, reject),
          };
          return builder;
        },
      }),
    };
  }, user);
}

async function addFirstProductToCart(page) {
  const firstProduct = page.locator(".product-card").first();
  await firstProduct.getByRole("button", { name: "Add to Cart" }).click();
  await expect(page.locator(".cart-count")).toHaveText("1");
}

async function openCheckoutWithProduct(page) {
  await addFirstProductToCart(page);
  await page.locator(".cart-button").click();
  await page.locator(".cart-drawer").getByRole("button", { name: "Checkout" }).click();
}

async function fillCheckoutDelivery(page, values = {}) {
  await page.locator("#checkout-address").fill(values.address || "42 Football Street");
  await page.locator("#checkout-city").fill(values.city || "Kolkata");
  await page.locator("#checkout-state").fill(values.state || "West Bengal");
  await page.locator("#checkout-pin").fill(values.pin || "700001");
  if (values.note) await page.locator("#checkout-note").fill(values.note);
}

async function reviewCashOnDeliveryOrder(page) {
  const modal = page.locator(".checkout-modal");
  await modal.getByRole("button", { name: "Review Cash on Delivery Order" }).click();
  await expect(modal.locator("[data-checkout-confirmation]")).toBeVisible();
  return modal;
}

async function confirmCashOnDeliveryOrder(page) {
  const modal = page.locator(".checkout-modal");
  const checkbox = modal.locator("[data-cod-confirm-checkbox]");
  await checkbox.check();
  await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  return modal;
}

async function openVariantCheckout(page) {
  await page.locator(".cart-button").click();
  const checkout = page.locator(".cart-drawer").getByRole("button", { name: "Checkout", exact: true });
  await expect(checkout).toBeEnabled();
  await checkout.click();
  await expect(page.locator(".checkout-modal")).toHaveClass(/is-open/);
}

async function reviewVariantCheckout(page, values = {}) {
  await fillCheckoutDelivery(page, values);
  return reviewCashOnDeliveryOrder(page);
}

async function prepareVariantCheckout(page, options = {}) {
  const user = options.user || {
    id: "phase2b4-correction-user",
    email: "phase2b4-correction@example.test",
    user_metadata: { full_name: "Variant Buyer", phone: "+91 90000 11000" },
  };
  const variants = options.variants || createVariantRows("predator-elite-fg", ["UK 8"]);
  const cloudItems = options.cloudItems || [{
    product_id: "predator-elite-fg",
    product_variant_id: variants[0].variant_id,
    quantity: 1,
  }];
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantCheckoutV2: true,
    variantRows: variants,
    cloudVariantCarts: { [user.id]: cloudItems },
    ...(options.stub || {}),
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await openVariantCheckout(page);
  const modal = await reviewVariantCheckout(page, options.delivery || {});
  await modal.locator("[data-cod-confirm-checkbox]").check();
  return { user, variants, modal };
}

async function loginAs(page, email) {
  await page.locator('.header-actions button[aria-label="Account"]').click();
  const modal = page.locator(".login-modal");
  await expect(modal).toHaveClass(/is-open/);
  await modal.locator("#login-email").fill(email);
  await modal.locator("#login-password").fill("valid-password");
  await modal.locator("[data-login-form] [type=submit]").click();
  await expect(modal).not.toHaveClass(/is-open/);
}

async function logoutCurrentUser(page) {
  await page.locator('.header-actions button[aria-label="Account"]').click();
  const modal = page.locator(".login-modal");
  await expect(modal).toHaveClass(/is-open/);
  await modal.getByRole("button", { name: "Logout", exact: true }).click();
  await expect(modal).not.toHaveClass(/is-open/);
}


test.beforeEach(async ({ page }) => {
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("attractionCookieConsent", "accepted");
    document.querySelector("[data-cookie-banner]")?.classList.remove("is-visible");
  });
});

test("all storefront product cards use verified immutable catalogue IDs", async () => {
  const catalogueIdList = JSON.parse(fs.readFileSync(productCatalogueFixturePath, "utf8"));
  const catalogueIds = new Set(catalogueIdList);
  const occurrences = [];

  for (const [fileName, expectedCount] of storefrontProductPages) {
    const cards = readStaticProductCards(fileName);
    expect(cards, `${fileName} product-card count`).toHaveLength(expectedCount);
    occurrences.push(...cards);
  }

  expect(catalogueIdList).toHaveLength(105);
  expect(catalogueIds.size).toBe(105);
  expect(catalogueIdList).toEqual([...catalogueIdList].sort());
  expect(occurrences).toHaveLength(132);
  expect(occurrences.filter((card) => !card.id)).toEqual([]);

  const storefrontIds = new Set(occurrences.map((card) => card.id));
  expect(storefrontIds.size).toBe(105);
  expect([...storefrontIds].filter((id) => !catalogueIds.has(id))).toEqual([]);
  expect([...catalogueIds].filter((id) => !storefrontIds.has(id))).toEqual([]);

  const idsByName = new Map();
  occurrences.forEach(({ name, id }) => {
    if (!idsByName.has(name)) idsByName.set(name, new Set());
    idsByName.get(name).add(id);
  });
  expect([...idsByName.entries()].filter(([, ids]) => ids.size > 1)).toEqual([]);

  for (const productId of [
    "predator-elite-fg",
    "velocity-grip-sg",
    "premier-match-ball",
    "matchday-travel-tee",
    "pro-grip-gloves",
  ]) {
    const repeatedCards = occurrences.filter((card) => card.id === productId);
    expect(repeatedCards.length, `${productId} should appear on multiple pages`).toBeGreaterThan(1);
    expect(new Set(repeatedCards.map((card) => card.id))).toEqual(new Set([productId]));
  }

  const source = fs.readFileSync(path.join(process.cwd(), "script.js"), "utf8");
  expect(source).toContain("card.dataset.productId");
  expect(source).toContain("product_id: item.id");
  expect(source).not.toContain("slugify");
  expect(source).not.toMatch(/card\.dataset\.id\s*\|\|/);
  expect(source).not.toMatch(/rawItem\.id\s*\|\|\s*slugify/);
});

test("cart and wishlist preserve representative explicit product-card IDs", async ({ page }) => {
  await installSupabaseStub(page, { user: null });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });

  const representativeIds = [
    "predator-elite-fg",
    "velocity-grip-sg",
    "premier-match-ball",
    "matchday-travel-tee",
    "pro-grip-gloves",
  ];
  for (const productId of representativeIds) {
    const card = page.locator(`.product-card[data-product-id="${productId}"]`);
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: "Add to Cart" }).click();
    await card.locator(".wish").click();
  }

  const guestData = await page.evaluate(() => ({
    cart: JSON.parse(localStorage.getItem("attractionCart:guest") || "[]"),
    wishlist: JSON.parse(localStorage.getItem("attractionWishlist:guest") || "[]"),
  }));
  expect(guestData.cart.map((item) => item.id).sort()).toEqual([...representativeIds].sort());
  expect(guestData.wishlist.map((item) => item.id).sort()).toEqual([...representativeIds].sort());
  expect(guestData.cart.every((item) => item.qty === 1)).toBe(true);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".cart-count")).toHaveText("5");
  await expect(page.locator(".wishlist-count")).toHaveText("5");
});

test("a product card missing data-product-id fails closed", async ({ page }) => {
  await installSupabaseStub(page, { user: null });
  const configurationErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") configurationErrors.push(message.text());
  });
  await page.route("**/products.html", async (route) => {
    const html = fs.readFileSync(path.join(process.cwd(), "products.html"), "utf8");
    await route.fulfill({
      contentType: "text/html",
      body: html.replace(' data-product-id="predator-elite-fg"', ""),
    });
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });

  const card = page.locator(".product-card", { hasText: "Predator Elite FG" });
  const cartButton = card.getByRole("button", { name: "Add to Cart" });
  const wishlistButton = card.getByLabel("Add Predator Elite FG to wishlist");
  await expect(cartButton).toBeDisabled();
  await expect(cartButton).toHaveAttribute("aria-disabled", "true");
  await expect(wishlistButton).toBeDisabled();
  await expect(wishlistButton).toHaveAttribute("aria-disabled", "true");

  await cartButton.evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await wishlistButton.evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(page.locator(".cart-count")).toHaveText("0");
  await expect(page.locator(".wishlist-count")).toHaveText("0");
  expect(configurationErrors).toContain("Product card configuration error: missing data-product-id.");

  const guestData = await page.evaluate(() => ({
    cart: JSON.parse(localStorage.getItem("attractionCart:guest") || "[]"),
    wishlist: JSON.parse(localStorage.getItem("attractionWishlist:guest") || "[]"),
  }));
  expect(guestData).toEqual({ cart: [], wishlist: [] });
});

test("variant preview is off by default and leaves product-level cart behavior unchanged", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("variantUi", "true");
  });
  await installSupabaseStub(page, {
    user: null,
    variantRows: createVariantRows("predator-elite-fg", ["UK 6", "UK 7", "UK 8", "UK 9", "UK 10", "UK 11"]),
  });
  await page.goto("/products.html?variantUi=true#variantUi", { waitUntil: "domcontentloaded" });

  await expect(page.locator("[data-variant-selector]")).toHaveCount(0);
  const variantCalls = await page.evaluate(() =>
    window.__attractionSupabaseTestState.rpcs.filter((call) => call.name === "get_storefront_variants")
  );
  expect(variantCalls).toEqual([]);

  await page.locator('.product-card[data-product-id="predator-elite-fg"]')
    .getByRole("button", { name: "Add to Cart" })
    .click();
  await expect(page.locator(".cart-count")).toHaveText("1");
});

test("variant preview blocks existing cart mutations and checkout without altering loaded cart data", async ({ page }) => {
  const user = { id: "variant-preview-user", user_metadata: {} };
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    cloudCarts: { [user.id]: [{ product_id: "predator-elite-fg", quantity: 1 }] },
    variantRows: createVariantRows("predator-elite-fg", ["UK 6", "UK 7", "UK 8", "UK 9", "UK 10", "UK 11"]),
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".cart-count")).toHaveText("1");

  await page.locator(".cart-button").click();
  await page.locator('[data-cart-change="1"]').click();
  await expect(page.locator(".toast")).toHaveText("Variant cart not enabled yet");
  await page.locator("[data-checkout]").click();
  await expect(page.locator(".checkout-modal")).toHaveCount(0);

  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.cloudCarts[user.id]).toEqual([{ product_id: "predator-elite-fg", quantity: 1 }]);
  expect(state.rpcs.filter((call) => ["set_cart_item", "remove_cart_item", "clear_cart", "place_order"].includes(call.name))).toEqual([]);
});

test("variant preview orders shoe sizes canonically and exposes stock and accessibility states", async ({ page }) => {
  const shoeRows = createVariantRows(
    "predator-elite-fg",
    ["UK 11", "UK 8", "UK 6", "UK 10", "UK 7", "UK 9"],
    { "UK 9": "Low Stock", "UK 11": "Out of Stock" }
  );
  await installSupabaseStub(page, { user: null, variantUi: true, variantRows: shoeRows });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });

  const card = page.locator('.product-card[data-product-id="predator-elite-fg"]');
  const selector = card.locator("[data-variant-selector]");
  await expect(selector.getByRole("group", { name: "Select size for Predator Elite FG" })).toBeVisible();
  await expect(selector.locator(".variant-option > span:first-child")).toHaveText([
    "UK 6", "UK 7", "UK 8", "UK 9", "UK 10", "UK 11",
  ]);
  await expect(selector.locator('.variant-option[aria-pressed="true"]')).toHaveCount(0);

  const lowStock = selector.getByRole("button", { name: /UK 9 Low Stock/ });
  const outOfStock = selector.getByRole("button", { name: /UK 11 Out of Stock/ });
  await expect(lowStock).toContainText("Low Stock");
  await expect(outOfStock).toBeDisabled();
  await selector.getByRole("button", { name: "UK 8", exact: true }).click();
  await expect(selector.getByRole("button", { name: "UK 8", exact: true })).toHaveAttribute("aria-pressed", "true");

  const previewButton = card.getByRole("button", { name: "Variant cart not enabled yet" });
  await expect(previewButton).toBeDisabled();
  await previewButton.evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(page.locator(".cart-count")).toHaveText("0");

  await card.locator(".wish").click();
  await expect(page.locator(".wishlist-count").first()).toHaveText("1");
  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.rpcs.filter((call) => call.name === "get_storefront_variants")).toHaveLength(1);
  expect(state.rpcs.filter((call) => ["set_cart_item", "remove_cart_item", "clear_cart", "place_order"].includes(call.name))).toEqual([]);
});

test("variant preview uses canonical clothing order and auto-selects single football and accessory variants", async ({ page }) => {
  const variantRows = [
    ...createVariantRows("legendary-home-jersey", ["XXL", "M", "S", "XL", "L"]),
    ...createVariantRows("matchday-travel-tee", ["L", "XXL", "S", "XL", "M"]),
    ...createVariantRows("pro-grip-gloves", ["One Size"]),
    ...createVariantRows("futsal-precision-ball", ["Size 4"]),
    ...createVariantRows("premier-match-ball", ["Size 5"]),
  ];
  await installSupabaseStub(page, { user: null, variantUi: true, variantRows });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });

  for (const productId of ["legendary-home-jersey", "matchday-travel-tee"]) {
    const selector = page.locator(`.product-card[data-product-id="${productId}"] [data-variant-selector]`);
    await expect(selector.locator(".variant-option > span:first-child")).toHaveText(["S", "M", "L", "XL", "XXL"]);
    await expect(selector.locator('.variant-option[aria-pressed="true"]')).toHaveCount(0);
  }

  for (const [productId, label] of [
    ["pro-grip-gloves", "One Size"],
    ["futsal-precision-ball", "Size 4"],
    ["premier-match-ball", "Size 5"],
  ]) {
    const option = page.locator(`.product-card[data-product-id="${productId}"] .variant-option`, { hasText: label });
    await expect(option).toHaveAttribute("aria-pressed", "true");
  }
});

test("duplicate product cards share one variant response and synchronized selection", async ({ page }) => {
  const html = fs.readFileSync(path.join(process.cwd(), "products.html"), "utf8");
  const productCard = html.match(/<article\b[^>]*data-product-id="predator-elite-fg"[^>]*>[\s\S]*?<\/article>/)?.[0];
  expect(productCard).toBeTruthy();
  await page.route("**/products.html", (route) => route.fulfill({
    contentType: "text/html",
    body: html.replace(productCard, `${productCard}${productCard}`),
  }));
  await installSupabaseStub(page, {
    user: null,
    variantUi: true,
    variantRows: createVariantRows("predator-elite-fg", ["UK 6", "UK 7", "UK 8", "UK 9", "UK 10", "UK 11"]),
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });

  const duplicateCards = page.locator('.product-card[data-product-id="predator-elite-fg"]');
  await expect(duplicateCards).toHaveCount(2);
  await duplicateCards.first().getByRole("button", { name: "UK 10", exact: true }).click();
  await expect(duplicateCards.locator('.variant-option[data-variant-id][aria-pressed="true"]')).toHaveCount(2);
  await expect(duplicateCards.locator('.variant-option[aria-pressed="true"] > span:first-child')).toHaveText(["UK 10", "UK 10"]);

  const calls = await page.evaluate(() =>
    window.__attractionSupabaseTestState.rpcs.filter((call) => call.name === "get_storefront_variants")
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].payload.p_product_ids.filter((id) => id === "predator-elite-fg")).toHaveLength(1);
});

test("variant preview fails closed when the variant RPC fails", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await installSupabaseStub(page, { user: null, variantUi: true, failVariantRpc: true });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });

  const card = page.locator('.product-card[data-product-id="predator-elite-fg"]');
  await expect(card.locator(".variant-selector__message")).toHaveText("Variant options are unavailable.");
  await expect(card.getByRole("button", { name: "Variant cart not enabled yet" })).toBeDisabled();
  expect(errors.filter((message) => message === "Variant options are unavailable.")).toHaveLength(1);
  expect(errors.join(" ")).not.toContain("Private test detail");
});

test("variant preview shows no-variant state, hydrates wishlist cards, and remains mobile-safe", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("attractionWishlist:guest", JSON.stringify([{
      id: "pro-grip-gloves",
      name: "Pro Grip Gloves",
      category: "Accessories",
      price: 49.99,
      image: "assets/accessory-pro-grip-gloves-real.avif",
    }]));
  });
  await installSupabaseStub(page, {
    user: null,
    variantUi: true,
    variantRows: createVariantRows("pro-grip-gloves", ["One Size"]),
  });
  await page.goto("/wishlist.html", { waitUntil: "domcontentloaded" });

  const card = page.locator('.wishlist-product-card[data-product-id="pro-grip-gloves"]');
  await expect(card).toBeVisible();
  await expect(card.getByRole("group", { name: "Select size for Pro Grip Gloves" })).toBeVisible();
  await expect(card.getByRole("button", { name: "One Size", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByRole("button", { name: "Variant cart not enabled yet" })).toBeDisabled();
  const optionBox = await card.getByRole("button", { name: "One Size", exact: true }).boundingBox();
  expect(optionBox.height).toBeGreaterThanOrEqual(44);
  await expectNoHorizontalOverflow(page);

  await card.getByRole("button", { name: /Remove Pro Grip Gloves from wishlist/ }).click();
  await expect(page.locator("[data-wishlist-empty]")).toContainText("Your wishlist is empty.");
});

test("variant preview displays Currently unavailable when an RPC returns no variants", async ({ page }) => {
  await installSupabaseStub(page, { user: null, variantUi: true, variantRows: [] });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });

  const card = page.locator('.product-card[data-product-id="predator-elite-fg"]');
  await expect(card.locator(".variant-selector__message")).toHaveText("Currently unavailable");
  await expect(card.locator(".variant-option")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Variant cart not enabled yet" })).toBeDisabled();
});

test("variant cart flags stay default-off and selector-only mode never touches V2 state", async ({ page }) => {
  await page.addInitScript(() => {
    window.__variantStorageAccesses = [];
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.getItem = function getItem(key) {
      if (String(key).startsWith("attractionCartV2")) window.__variantStorageAccesses.push(["get", key]);
      return originalGetItem.call(this, key);
    };
    Storage.prototype.setItem = function setItem(key, value) {
      if (String(key).startsWith("attractionCartV2")) window.__variantStorageAccesses.push(["set", key]);
      return originalSetItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function removeItem(key) {
      if (String(key).startsWith("attractionCartV2")) window.__variantStorageAccesses.push(["remove", key]);
      return originalRemoveItem.call(this, key);
    };
  });
  await installSupabaseStub(page, {
    user: null,
    variantUi: true,
    variantRows: createVariantRows("predator-elite-fg", ["UK 6", "UK 7"]),
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });

  await page.locator('.product-card[data-product-id="predator-elite-fg"]')
    .getByRole("button", { name: "UK 6", exact: true })
    .click();
  await expect(page.locator('.product-card[data-product-id="predator-elite-fg"]')
    .getByRole("button", { name: "Variant cart not enabled yet" })).toBeDisabled();

  const result = await page.evaluate(() => ({
    storageAccesses: window.__variantStorageAccesses,
    calls: window.__attractionSupabaseTestState.rpcs.map((call) => call.name),
  }));
  expect(result.storageAccesses).toEqual([]);
  expect(result.calls.filter((name) => name.endsWith("_v2"))).toEqual([]);
});

test("guest V2 cart keeps shoe sizes as separate persistent lines and increments only the selected size", async ({ page }) => {
  const variants = createVariantRows("predator-elite-fg", ["UK 6", "UK 7"]);
  await installSupabaseStub(page, { user: null, variantUi: true, variantCartV2: true, variantRows: variants });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  const card = page.locator('.product-card[data-product-id="predator-elite-fg"]');

  await card.getByRole("button", { name: "UK 6", exact: true }).click();
  await card.getByRole("button", { name: "Add to Cart", exact: true }).click();
  await card.getByRole("button", { name: "UK 7", exact: true }).click();
  await card.getByRole("button", { name: "Add to Cart", exact: true }).click();
  await card.getByRole("button", { name: "UK 6", exact: true }).click();
  await card.getByRole("button", { name: "Add to Cart", exact: true }).click();

  await expect(page.locator(".cart-count")).toHaveText("3");
  await page.locator(".cart-button").click();
  await expect(page.locator("[data-variant-cart-line]")).toHaveCount(2);
  await expect(page.locator(".cart-items")).toContainText("Size: UK 6");
  await expect(page.locator(".cart-items")).toContainText("Size: UK 7");
  await expect(page.locator(`[data-variant-cart-line="${variants[0].variant_id}"] .cart-controls strong`)).toHaveText("2");
  await expect(page.locator(`[data-variant-cart-line="${variants[1].variant_id}"] .cart-controls strong`)).toHaveText("1");

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("attractionCartV2:guest")));
  expect(stored).toEqual([
    { productId: "predator-elite-fg", productVariantId: variants[0].variant_id, quantity: 2 },
    { productId: "predator-elite-fg", productVariantId: variants[1].variant_id, quantity: 1 },
  ]);
  expect(await page.evaluate(() => localStorage.getItem("attractionCart:guest"))).toBeNull();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".cart-count")).toHaveText("3");
});

test("guest V2 malformed storage fails safely and unavailable lines remain removable", async ({ page }) => {
  const [variant] = createVariantRows("predator-elite-fg", ["UK 8"], { "UK 8": "Out of Stock" });
  await page.addInitScript(({ variantId }) => {
    localStorage.setItem("attractionCartV2:guest", JSON.stringify([
      { productId: "predator-elite-fg", productVariantId: variantId, quantity: 2 },
      { productId: "bad", productVariantId: "not-a-uuid", quantity: 99 },
    ]));
  }, { variantId: variant.variant_id });
  await installSupabaseStub(page, { user: null, variantUi: true, variantCartV2: true, variantRows: [variant] });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".cart-count")).toHaveText("2");
  await page.locator(".cart-button").click();
  const line = page.locator(`[data-variant-cart-line="${variant.variant_id}"]`);
  await expect(line).toContainText("Out of Stock");
  await expect(line.getByRole("button", { name: /Increase/ })).toBeDisabled();
  await line.getByRole("button", { name: /Decrease/ }).click();
  await line.getByRole("button", { name: /Decrease/ }).click();
  await expect(page.locator("[data-variant-cart-line]")).toHaveCount(0);
});

test("authenticated V2 cart renders authoritative rows and uses absolute set/remove mutations", async ({ page }) => {
  const user = { id: "variant-v2-user", email: "variant@example.test", user_metadata: {} };
  const variants = createVariantRows("predator-elite-fg", ["UK 8", "UK 9"]);
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantRows: variants,
    cloudVariantCarts: {
      [user.id]: variants.map((variant) => ({
        product_id: "predator-elite-fg",
        product_variant_id: variant.variant_id,
        quantity: 1,
      })),
    },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".cart-count")).toHaveText("2");
  await page.locator(".cart-button").click();
  await page.locator(`[data-variant-cart-line="${variants[0].variant_id}"]`).getByRole("button", { name: /Increase/ }).click();
  await expect(page.locator(`[data-variant-cart-line="${variants[0].variant_id}"] .cart-controls strong`)).toHaveText("2");
  await page.locator(`[data-variant-cart-line="${variants[1].variant_id}"]`).getByRole("button", { name: /Decrease/ }).click();
  await expect(page.locator(`[data-variant-cart-line="${variants[1].variant_id}"]`)).toHaveCount(0);

  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.rpcs);
  expect(calls.find((call) => call.name === "set_cart_item_v2")?.payload.p_quantity).toBe(2);
  expect(calls.find((call) => call.name === "remove_cart_item_v2")?.payload.p_product_variant_id).toBe(variants[1].variant_id);
  expect(calls.filter((call) => ["set_cart_item", "remove_cart_item"].includes(call.name))).toEqual([]);
});

test("clear_cart_v2 clears resolved rows without deleting authenticated legacy rows", async ({ page }) => {
  const user = { id: "variant-clear-user", email: "clear@example.test", user_metadata: {} };
  const variants = createVariantRows("predator-elite-fg", ["UK 6", "UK 7"]);
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantRows: variants,
    cloudVariantCarts: { [user.id]: [{ product_id: "predator-elite-fg", product_variant_id: variants[0].variant_id, quantity: 1 }] },
    legacyVariantCarts: { [user.id]: [{ product_id: "phantom-control-pro", quantity: 2 }] },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await page.locator(".cart-button").click();
  await page.getByRole("button", { name: "Clear Cart", exact: true }).click();
  await expect(page.locator("[data-variant-cart-line]")).toHaveCount(0);
  await expect(page.locator('[data-legacy-cart-line="phantom-control-pro"]')).toBeVisible();
  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.cloudVariantCarts[user.id]).toEqual([]);
  expect(state.legacyVariantCarts[user.id]).toEqual([{ product_id: "phantom-control-pro", quantity: 2 }]);
  expect(state.rpcs.some((call) => call.name === "clear_cart")).toBe(false);
});

test("authenticated legacy cart resolves automatic variants once", async ({ page }) => {
  const user = { id: "legacy-auto-user", email: "legacy-auto@example.test", user_metadata: {} };
  const [variant] = createVariantRows("premier-match-ball", ["Size 5"]);
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantRows: [variant],
    legacyVariantCarts: { [user.id]: [{ product_id: "premier-match-ball", quantity: 3 }] },
    catalog: { "premier-match-ball": { id: "premier-match-ball", name: "Premier Match Ball", category: "Footballs", price: 89.99, image: "", is_active: true } },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".cart-count")).toHaveText("3");
  await page.locator(".cart-button").click();
  await expect(page.locator(`[data-variant-cart-line="${variant.variant_id}"]`)).toContainText("Size: Size 5");
  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.rpcs.filter((call) => call.name === "resolve_legacy_cart_item_v2"));
  expect(calls).toHaveLength(1);
});

test("multi-size authenticated legacy cart requires explicit selection and retry cannot increment twice", async ({ page }) => {
  const user = { id: "legacy-select-user", email: "legacy-select@example.test", user_metadata: {} };
  const variants = createVariantRows("predator-elite-fg", ["UK 8", "UK 9"]);
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantRows: variants,
    legacyVariantCarts: { [user.id]: [{ product_id: "predator-elite-fg", quantity: 2 }] },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await page.locator(".cart-button").click();
  const legacy = page.locator('[data-legacy-cart-line="predator-elite-fg"]');
  await expect(legacy).toContainText("Size selection required");
  await legacy.locator("[data-legacy-variant-select]").selectOption(variants[1].variant_id);
  await legacy.getByRole("button", { name: "Use Selected Size" }).click();
  await expect(page.locator(`[data-variant-cart-line="${variants[1].variant_id}"] .cart-controls strong`)).toHaveText("2");
  await page.evaluate(({ productId, variantId }) => window.__attractionSupabaseClient.rpc("resolve_legacy_cart_item_v2", {
    p_product_id: productId,
    p_product_variant_id: variantId,
  }), { productId: "predator-elite-fg", variantId: variants[1].variant_id });
  expect(await page.evaluate((userId) => window.__attractionSupabaseTestState.cloudVariantCarts[userId][0].quantity, user.id)).toBe(2);
});

test("legacy item with no active variant stays visible and removable", async ({ page }) => {
  const user = { id: "legacy-unavailable-user", email: "legacy-unavailable@example.test", user_metadata: {} };
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantRows: [],
    legacyVariantCarts: { [user.id]: [{ product_id: "predator-elite-fg", quantity: 1 }] },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await page.locator(".cart-button").click();
  const legacy = page.locator('[data-legacy-cart-line="predator-elite-fg"]');
  await expect(legacy).toContainText("Currently unavailable");
  await legacy.getByRole("button", { name: /Remove Predator Elite FG/ }).click();
  await expect(legacy).toHaveCount(0);
});

test("guest legacy conversion is partial, automatic for one variant, and explicit for multiple sizes", async ({ page }) => {
  const ballVariant = createVariantRows("premier-match-ball", ["Size 5"])[0];
  const shoeVariants = createVariantRows("predator-elite-fg", ["UK 8", "UK 9"]);
  await page.addInitScript(() => {
    localStorage.setItem("attractionCart:guest", JSON.stringify([
      { id: "premier-match-ball", name: "Premier Match Ball", category: "Footballs", price: 89.99, image: "", qty: 2 },
      { id: "predator-elite-fg", name: "Predator Elite FG", category: "Football Shoes", price: 219.99, image: "", qty: 1 },
    ]));
  });
  await installSupabaseStub(page, {
    user: null,
    variantUi: true,
    variantCartV2: true,
    variantRows: [ballVariant, ...shoeVariants],
    catalog: { "premier-match-ball": { id: "premier-match-ball", name: "Premier Match Ball", category: "Footballs", price: 89.99, image: "", is_active: true } },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await page.locator(".cart-button").click();
  await expect(page.locator(`[data-variant-cart-line="${ballVariant.variant_id}"]`)).toBeVisible();
  const legacy = page.locator('[data-legacy-cart-line="predator-elite-fg"]');
  await expect(legacy).toContainText("Size selection required");
  let oldStorage = await page.evaluate(() => JSON.parse(localStorage.getItem("attractionCart:guest")));
  expect(oldStorage.map((item) => item.id)).toEqual(["predator-elite-fg"]);
  await legacy.locator("[data-legacy-variant-select]").selectOption(shoeVariants[0].variant_id);
  await legacy.getByRole("button", { name: "Use Selected Size" }).click();
  await expect(page.locator(`[data-variant-cart-line="${shoeVariants[0].variant_id}"]`)).toBeVisible();
  oldStorage = await page.evaluate(() => JSON.parse(localStorage.getItem("attractionCart:guest")));
  expect(oldStorage).toEqual([]);
});

test("guest V2 merge is idempotent, reuses its token after failure, and never calls the V1 merge", async ({ page }) => {
  const user = { id: "variant-merge-user", email: "merge@example.test", user_metadata: {} };
  const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
  await page.addInitScript(({ variantId }) => {
    localStorage.setItem("attractionCartV2:guest", JSON.stringify([{
      productId: "predator-elite-fg",
      productVariantId: variantId,
      quantity: 2,
    }]));
  }, { variantId: variant.variant_id });
  await installSupabaseStub(page, {
    user: null,
    usersByEmail: { [user.email]: user },
    variantUi: true,
    variantCartV2: true,
    variantRows: [variant],
    failVariantMergeAttempts: 1,
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await loginAs(page, user.email);
  await expect(page.locator(".cart-count")).toHaveText("2");
  const firstToken = await page.evaluate((userId) => JSON.parse(localStorage.getItem(`attractionCartV2MergeToken:${userId}:resolved`)).token, user.id);
  await logoutCurrentUser(page);
  await loginAs(page, user.email);
  await expect(page.locator(".cart-count")).toHaveText("2");
  const mergeCalls = await page.evaluate(() => window.__attractionSupabaseTestState.rpcs.filter((call) => call.name === "merge_guest_cart_v2"));
  expect(mergeCalls).toHaveLength(2);
  expect(mergeCalls[0].payload.p_merge_token).toBe(firstToken);
  expect(mergeCalls[1].payload.p_merge_token).toBe(firstToken);
  expect(await page.evaluate(() => localStorage.getItem("attractionCartV2:guest"))).toBeNull();
  expect(await page.evaluate(() => window.__attractionSupabaseTestState.rpcs.some((call) => call.name === "merge_guest_cart"))).toBe(false);
});

test("unresolved guest lines stay device-local across login and logout never exposes the cloud cart", async ({ page }) => {
  const user = { id: "variant-isolation-user", email: "isolation@example.test", user_metadata: {} };
  const variants = createVariantRows("predator-elite-fg", ["UK 8", "UK 9"]);
  await page.addInitScript(() => {
    localStorage.setItem("attractionCart:guest", JSON.stringify([{
      id: "predator-elite-fg",
      name: "Predator Elite FG",
      category: "Football Shoes",
      price: 219.99,
      image: "",
      qty: 1,
    }]));
  });
  await installSupabaseStub(page, {
    user: null,
    usersByEmail: { [user.email]: user },
    variantUi: true,
    variantCartV2: true,
    variantRows: variants,
    cloudVariantCarts: { [user.id]: [{ product_id: "predator-elite-fg", product_variant_id: variants[0].variant_id, quantity: 3 }] },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await loginAs(page, user.email);
  await expect(page.locator(".cart-count")).toHaveText("4");
  await page.locator(".cart-button").click();
  await expect(page.locator('[data-legacy-cart-line="predator-elite-fg"]')).toContainText("Size selection required");
  await page.locator("[data-close-cart]").click();
  await logoutCurrentUser(page);
  await expect(page.locator(".cart-count")).toHaveText("1");
  await page.locator(".cart-button").click();
  await expect(page.locator("[data-variant-cart-line]")).toHaveCount(0);
  await expect(page.locator('[data-legacy-cart-line="predator-elite-fg"]')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("attractionCart:guest")))).toHaveLength(1);
});

test("guest legacy selection after login reuses a persistent token when merge retry is needed", async ({ page }) => {
  const user = { id: "legacy-guest-retry-user", email: "legacy-retry@example.test", user_metadata: {} };
  const variants = createVariantRows("predator-elite-fg", ["UK 8", "UK 9"]);
  await page.addInitScript(() => {
    localStorage.setItem("attractionCart:guest", JSON.stringify([{
      id: "predator-elite-fg", name: "Predator Elite FG", category: "Football Shoes", price: 219.99, image: "", qty: 2,
    }]));
  });
  await installSupabaseStub(page, {
    user: null,
    usersByEmail: { [user.email]: user },
    variantUi: true,
    variantCartV2: true,
    variantRows: variants,
    failVariantMergeAttempts: 1,
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await loginAs(page, user.email);
  await page.locator(".cart-button").click();
  let legacy = page.locator('[data-legacy-cart-line="predator-elite-fg"]');
  await legacy.locator("[data-legacy-variant-select]").selectOption(variants[1].variant_id);
  await legacy.getByRole("button", { name: "Use Selected Size" }).click();
  await expect(legacy).toBeVisible();
  legacy = page.locator('[data-legacy-cart-line="predator-elite-fg"]');
  await legacy.locator("[data-legacy-variant-select]").selectOption(variants[1].variant_id);
  await legacy.getByRole("button", { name: "Use Selected Size" }).click();
  await expect(page.locator(`[data-variant-cart-line="${variants[1].variant_id}"] .cart-controls strong`)).toHaveText("2");
  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.rpcs.filter((call) => call.name === "merge_guest_cart_v2"));
  expect(calls).toHaveLength(2);
  expect(calls[1].payload.p_merge_token).toBe(calls[0].payload.p_merge_token);
});

test("authenticated inactive variant lines remain visible and removable", async ({ page }) => {
  const user = { id: "inactive-variant-user", email: "inactive@example.test", user_metadata: {} };
  const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantRows: [variant],
    cloudVariantCarts: { [user.id]: [{
      product_id: "predator-elite-fg",
      product_variant_id: variant.variant_id,
      quantity: 1,
      variant_is_active: false,
      purchasable_quantity: 0,
      stock_state: "Unavailable",
    }] },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await page.locator(".cart-button").click();
  const line = page.locator(`[data-variant-cart-line="${variant.variant_id}"]`);
  await expect(line).toContainText("Unavailable");
  await expect(line.getByRole("button", { name: /Increase/ })).toBeDisabled();
  await line.getByRole("button", { name: /Decrease/ }).click();
  await expect(line).toHaveCount(0);
});

test("V2 RPC failure preserves visible cart data and exposes only a safe retry message", async ({ page }) => {
  const user = { id: "variant-failure-user", email: "failure@example.test", user_metadata: {} };
  const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantRows: [variant],
    cloudVariantCarts: { [user.id]: [{ product_id: "predator-elite-fg", product_variant_id: variant.variant_id, quantity: 1 }] },
    failVariantCartRpc: "set_cart_item_v2",
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await page.locator(".cart-button").click();
  await page.locator(`[data-variant-cart-line="${variant.variant_id}"]`).getByRole("button", { name: /Increase/ }).click();
  await expect(page.locator(".toast")).toContainText("We could not sync your cart");
  await expect(page.locator(`[data-variant-cart-line="${variant.variant_id}"] .cart-controls strong`)).toHaveText("1");
  await expect(page.locator("body")).not.toContainText("Private variant cart failure");
});

test("variant mode blocks checkout and place_order while wishlist remains product-level", async ({ page }) => {
  const variants = createVariantRows("predator-elite-fg", ["UK 8", "UK 9"]);
  await installSupabaseStub(page, { user: null, variantUi: true, variantCartV2: true, variantRows: variants });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  const card = page.locator('.product-card[data-product-id="predator-elite-fg"]');
  await card.locator(".wish").click();
  await expect(page.locator(".wishlist-count").first()).toHaveText("1");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("attractionWishlist:guest"))[0].id)).toBe("predator-elite-fg");
  await expect(card.getByRole("button", { name: "Add to Cart" })).toBeDisabled();
  await card.getByRole("button", { name: "UK 8", exact: true }).click();
  await card.getByRole("button", { name: "Add to Cart" }).click();
  await page.locator(".cart-button").click();
  await expect(page.locator(".variant-checkout-message")).toHaveText("Variant checkout is not enabled yet");
  await expect(page.getByRole("button", { name: "Checkout", exact: true })).toBeDisabled();
  const checkoutCalls = await page.evaluate(() => ({
    v1: window.__attractionSupabaseTestState.placeOrderCalls,
    v2: window.__attractionSupabaseTestState.placeOrderV2Calls,
  }));
  expect(checkoutCalls).toEqual({ v1: [], v2: [] });
});

test("variant cart drawer is accessible and has no mobile horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const variants = createVariantRows("predator-elite-fg", ["UK 8", "UK 9"]);
  await installSupabaseStub(page, { user: null, variantUi: true, variantCartV2: true, variantRows: variants });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  const card = page.locator('.product-card[data-product-id="predator-elite-fg"]');
  await expect(card.getByRole("group", { name: "Select size for Predator Elite FG" })).toBeVisible();
  await card.getByRole("button", { name: "UK 8", exact: true }).click();
  await card.getByRole("button", { name: "Add to Cart" }).click();
  await page.locator(".cart-button").click();
  await expect(page.locator(".variant-cart-status")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator('[data-variant-cart-change="-1"]')).toHaveAttribute("aria-label", /Decrease Predator Elite FG UK 8/);
  await expectNoHorizontalOverflow(page);
});

test("V2 checkout handler blocks direct invocation before every order or cart RPC", async ({ page }) => {
  await exposeCheckoutTestHooks(page);
  const user = { id: "direct-checkout-user", email: "direct-checkout@example.test", user_metadata: {} };
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantRows: createVariantRows("predator-elite-fg", ["UK 8"]),
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });

  const prevented = await page.evaluate(async () => {
    window.__phase2A3CheckoutTestHooks.createCheckoutModal();
    const form = document.querySelector("[data-checkout-form]");
    let wasPrevented = false;
    await window.__phase2A3CheckoutTestHooks.handleCheckoutSubmit({
      currentTarget: form,
      preventDefault() {
        wasPrevented = true;
      },
    });
    return wasPrevented;
  });

  expect(prevented).toBe(true);
  await expect(page.locator("[data-checkout-error]")).toHaveText("Variant checkout is not enabled yet");
  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.rpcs.filter((call) => ["place_order", "clear_cart", "clear_cart_v2"].includes(call.name))).toEqual([]);
});

test("V2 checkout form submission is prevented before validation or COD handling", async ({ page }) => {
  await exposeCheckoutTestHooks(page);
  await installSupabaseStub(page, {
    user: { id: "form-checkout-user", email: "form-checkout@example.test", user_metadata: {} },
    variantUi: true,
    variantCartV2: true,
    variantRows: createVariantRows("predator-elite-fg", ["UK 8"]),
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });

  const submissionWasPrevented = await page.evaluate(() => {
    window.__phase2A3CheckoutTestHooks.createCheckoutModal();
    const form = document.querySelector("[data-checkout-form]");
    return form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) === false;
  });

  expect(submissionWasPrevented).toBe(true);
  await expect(page.locator("[data-checkout-error]")).toHaveText("Variant checkout is not enabled yet");
  expect(await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderCalls)).toEqual([]);
});

test("failed guest merge lines stay local through quantity and removal changes without V2 mutations", async ({ page }) => {
  const user = { id: "pending-merge-user", email: "pending-merge@example.test", user_metadata: {} };
  const variants = createVariantRows("predator-elite-fg", ["UK 8", "UK 9"]);
  await page.addInitScript(({ firstVariantId, secondVariantId }) => {
    localStorage.setItem("attractionCartV2:guest", JSON.stringify([
      { productId: "predator-elite-fg", productVariantId: firstVariantId, quantity: 2 },
      { productId: "predator-elite-fg", productVariantId: secondVariantId, quantity: 1 },
    ]));
  }, { firstVariantId: variants[0].variant_id, secondVariantId: variants[1].variant_id });
  await installSupabaseStub(page, {
    user: null,
    usersByEmail: { [user.email]: user },
    variantUi: true,
    variantCartV2: true,
    variantRows: variants,
    failVariantMergeAttempts: 1,
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await loginAs(page, user.email);
  await page.locator(".cart-button").click();

  const firstPending = page.locator(`[data-variant-cart-line="${variants[0].variant_id}"][data-variant-cart-source="pending-guest-v2"]`);
  const secondPending = page.locator(`[data-variant-cart-line="${variants[1].variant_id}"][data-variant-cart-source="pending-guest-v2"]`);
  await expect(firstPending).toContainText("Waiting for synchronization");
  await firstPending.getByRole("button", { name: /Increase/ }).click();
  await secondPending.getByRole("button", { name: /Decrease/ }).click();
  await expect(secondPending).toHaveCount(0);

  let state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.rpcs.filter((call) => ["set_cart_item_v2", "remove_cart_item_v2"].includes(call.name))).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("attractionCartV2:guest")))).toEqual([{
    productId: "predator-elite-fg",
    productVariantId: variants[0].variant_id,
    quantity: 3,
  }]);

  await page.locator("[data-close-cart]").click();
  await logoutCurrentUser(page);
  await loginAs(page, user.email);
  state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.cloudVariantCarts[user.id]).toEqual([{
    product_id: "predator-elite-fg",
    product_variant_id: variants[0].variant_id,
    quantity: 3,
  }]);
  const mergeCalls = state.rpcs.filter((call) => call.name === "merge_guest_cart_v2");
  expect(mergeCalls).toHaveLength(2);
  expect(mergeCalls[1].payload.p_merge_token).not.toBe(mergeCalls[0].payload.p_merge_token);
});

test("guest V2 clear preserves unresolved legacy guest lines", async ({ page }) => {
  const ballVariant = createVariantRows("premier-match-ball", ["Size 5"])[0];
  const shoeVariants = createVariantRows("predator-elite-fg", ["UK 8", "UK 9"]);
  await page.addInitScript(({ ballVariantId }) => {
    localStorage.setItem("attractionCartV2:guest", JSON.stringify([{
      productId: "premier-match-ball",
      productVariantId: ballVariantId,
      quantity: 1,
    }]));
    localStorage.setItem("attractionCart:guest", JSON.stringify([{
      id: "predator-elite-fg", name: "Predator Elite FG", category: "Football Shoes", price: 219.99, image: "", qty: 2,
    }]));
  }, { ballVariantId: ballVariant.variant_id });
  await installSupabaseStub(page, {
    user: null,
    variantUi: true,
    variantCartV2: true,
    variantRows: [ballVariant, ...shoeVariants],
    catalog: { "premier-match-ball": { id: "premier-match-ball", name: "Premier Match Ball", category: "Footballs", price: 89.99, image: "", is_active: true } },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await page.locator(".cart-button").click();
  await page.getByRole("button", { name: "Clear Cart", exact: true }).click();

  expect(await page.evaluate(() => localStorage.getItem("attractionCartV2:guest"))).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("attractionCart:guest")))).toHaveLength(1);
  await expect(page.locator('[data-legacy-cart-line="predator-elite-fg"]')).toBeVisible();
  await expect(page.locator(".toast")).toHaveText("Resolved variant items cleared. Legacy items still require attention.");
});

test("guest legacy conversion restores exact state when legacy persistence fails", async ({ page }) => {
  const [variant] = createVariantRows("premier-match-ball", ["Size 5"]);
  await page.addInitScript(({ variantId }) => {
    localStorage.setItem("attractionCartV2:guest", JSON.stringify([{
      productId: "premier-match-ball", productVariantId: variantId, quantity: 2,
    }]));
    localStorage.setItem("attractionCart:guest", JSON.stringify([{
      id: "premier-match-ball", name: "Premier Match Ball", category: "Footballs", price: 89.99, image: "", qty: 3,
    }]));
    const originalSetItem = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function setItem(key, value) {
      if (!failed && key === "attractionCart:guest" && value === "[]") {
        failed = true;
        throw new Error("Simulated legacy storage failure");
      }
      return originalSetItem.call(this, key, value);
    };
  }, { variantId: variant.variant_id });
  await installSupabaseStub(page, {
    user: null,
    variantUi: true,
    variantCartV2: true,
    variantRows: [variant],
    catalog: { "premier-match-ball": { id: "premier-match-ball", name: "Premier Match Ball", category: "Footballs", price: 89.99, image: "", is_active: true } },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".cart-count")).toHaveText("5");

  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("attractionCartV2:guest")))).toEqual([{
    productId: "premier-match-ball", productVariantId: variant.variant_id, quantity: 2,
  }]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("attractionCart:guest")))).toEqual([{
    id: "premier-match-ball", name: "Premier Match Ball", category: "Footballs", price: 89.99, image: "", qty: 3,
  }]);
});

test("completed guest merge retains its token until local payload deletion succeeds", async ({ page }) => {
  const user = { id: "cleanup-retry-user", email: "cleanup-retry@example.test", user_metadata: {} };
  const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
  await page.addInitScript(({ variantId }) => {
    localStorage.setItem("attractionCartV2:guest", JSON.stringify([{
      productId: "predator-elite-fg", productVariantId: variantId, quantity: 2,
    }]));
    const originalRemoveItem = Storage.prototype.removeItem;
    let failed = false;
    Storage.prototype.removeItem = function removeItem(key) {
      if (!failed && key === "attractionCartV2:guest") {
        failed = true;
        throw new Error("Simulated payload cleanup failure");
      }
      return originalRemoveItem.call(this, key);
    };
  }, { variantId: variant.variant_id });
  await installSupabaseStub(page, {
    user: null,
    usersByEmail: { [user.email]: user },
    variantUi: true,
    variantCartV2: true,
    variantRows: [variant],
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await loginAs(page, user.email);

  const tokenKey = `attractionCartV2MergeToken:${user.id}:resolved`;
  const firstToken = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).token, tokenKey);
  expect(await page.evaluate(() => localStorage.getItem("attractionCartV2:guest"))).not.toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(key), tokenKey)).not.toBeNull();

  await logoutCurrentUser(page);
  await loginAs(page, user.email);
  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  const calls = state.rpcs.filter((call) => call.name === "merge_guest_cart_v2");
  expect(calls).toHaveLength(2);
  expect(calls[0].payload.p_merge_token).toBe(firstToken);
  expect(calls[1].payload.p_merge_token).toBe(firstToken);
  expect(state.cloudVariantCarts[user.id][0].quantity).toBe(2);
  expect(await page.evaluate(() => localStorage.getItem("attractionCartV2:guest"))).toBeNull();
});

test("V2 auth switching ignores stale User A cart responses and shows only User B", async ({ page }) => {
  const userA = { id: "variant-user-a", email: "variant-user-a@example.test", user_metadata: {} };
  const userB = { id: "variant-user-b", email: "variant-user-b@example.test", user_metadata: {} };
  const [variantA] = createVariantRows("predator-elite-fg", ["UK 8"]);
  const [variantB] = createVariantRows("phantom-control-pro", ["UK 9"]);
  await installSupabaseStub(page, {
    user: userA,
    usersByEmail: { [userB.email]: userB },
    variantUi: true,
    variantCartV2: true,
    variantRows: [variantA, variantB],
    variantCartLoadDelays: { [userA.id]: 500 },
    cloudVariantCarts: {
      [userA.id]: [{ product_id: "predator-elite-fg", product_variant_id: variantA.variant_id, quantity: 4 }],
      [userB.id]: [{ product_id: "phantom-control-pro", product_variant_id: variantB.variant_id, quantity: 2 }],
    },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await page.evaluate(async (email) => {
    await window.__attractionSupabaseClient.auth.signOut();
    await window.__attractionSupabaseClient.auth.signInWithPassword({ email, password: "valid-password" });
  }, userB.email);

  await expect(page.locator(".cart-count")).toHaveText("2");
  await page.waitForTimeout(650);
  await expect(page.locator(".cart-count")).toHaveText("2");
  await page.locator(".cart-button").click();
  await expect(page.locator(`[data-variant-cart-line="${variantB.variant_id}"]`)).toBeVisible();
  await expect(page.locator(`[data-variant-cart-line="${variantA.variant_id}"]`)).toHaveCount(0);
});

test("rapid authenticated V2 quantity clicks serialize to the newest absolute quantity", async ({ page }) => {
  const user = { id: "rapid-variant-user", email: "rapid-variant@example.test", user_metadata: {} };
  const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantRows: [variant],
    variantMutationDelay: 75,
    cloudVariantCarts: { [user.id]: [{ product_id: "predator-elite-fg", product_variant_id: variant.variant_id, quantity: 1 }] },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await page.locator(".cart-button").click();
  const line = page.locator(`[data-variant-cart-line="${variant.variant_id}"]`);
  await line.getByRole("button", { name: /Increase/ }).evaluate((button) => {
    button.click();
    button.click();
  });

  await expect(line.locator(".cart-controls strong")).toHaveText("3");
  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.rpcs
    .filter((call) => call.name === "set_cart_item_v2")
    .map((call) => call.payload.p_quantity));
  expect(calls).toEqual([2, 3]);
});

test("Phase 2B4 submits only authoritative variant IDs and shipping fields, then renders the server result", async ({ page }) => {
  const user = {
    id: "checkout-v2-user",
    email: "checkout-v2@example.test",
    user_metadata: { full_name: "Variant Buyer", phone: "+91 90000 10000" },
  };
  const variants = createVariantRows("predator-elite-fg", ["UK 8", "UK 9"], { "UK 9": "Low Stock" });
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantCheckoutV2: true,
    variantRows: variants,
    serverV2Total: 659.97,
    cloudVariantCarts: { [user.id]: [
      { product_id: "predator-elite-fg", product_variant_id: variants[0].variant_id, quantity: 1 },
      { product_id: "predator-elite-fg", product_variant_id: variants[1].variant_id, quantity: 2 },
    ] },
    cloudCarts: { [user.id]: [{ product_id: "phantom-control-pro", quantity: 3 }] },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await openVariantCheckout(page);
  const modal = await reviewVariantCheckout(page, { note: "Side entrance" });
  await expect(modal.locator("[data-cod-confirmation-items]")).toContainText("Size: UK 8");
  await expect(modal.locator("[data-cod-confirmation-items]")).toContainText("Size: UK 9");
  await modal.locator("[data-cod-confirm-checkbox]").check();
  await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).evaluate((button) => {
    button.click();
    button.click();
  });

  await expect(modal.locator("[data-checkout-success-panel]")).toBeVisible();
  await expect(modal.locator("[data-cod-success-total]")).toHaveText("$659.97");
  await expect(modal.locator("[data-v2-success-order-status]")).toHaveText("Pending");
  await expect(modal.locator("[data-v2-success-item-count]")).toHaveText("2 items");
  await expect(modal.locator("[data-v2-success-inventory]")).toHaveText("Stock deducted");
  await expect(modal.locator("[data-v2-success-variants]")).toContainText("Predator Elite FG · UK 8");

  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.placeOrderV2Calls).toHaveLength(1);
  const payload = state.placeOrderV2Calls[0];
  expect(Object.keys(payload).sort()).toEqual(["p_idempotency_key", "p_items", "p_shipping_details"]);
  expect(payload.p_items).toEqual([
    { product_id: "predator-elite-fg", product_variant_id: variants[0].variant_id, quantity: 1 },
    { product_id: "predator-elite-fg", product_variant_id: variants[1].variant_id, quantity: 2 },
  ].sort((first, second) => first.product_variant_id.localeCompare(second.product_variant_id)));
  expect(payload.p_items.every((item) => Object.keys(item).sort().join(",") === "product_id,product_variant_id,quantity")).toBe(true);
  expect(payload.p_shipping_details).toEqual({
    customer_name: "Variant Buyer",
    customer_phone: "+91 90000 10000",
    address: "42 Football Street",
    city: "Kolkata",
    state: "West Bengal",
    pin_code: "700001",
    note: "Side entrance",
  });
  expect(state.placeOrderCalls).toEqual([]);
  expect(state.rpcs.filter((call) => call.name === "clear_cart_v2")).toEqual([]);
  expect(state.cloudCarts[user.id]).toEqual([{ product_id: "phantom-control-pro", quantity: 3 }]);
  expect(state.cloudVariantCarts[user.id]).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("attractionCheckoutV2Attempt"))).toBeNull();
});

for (const scenario of [
  {
    name: "pending guest merge",
    expected: "still synchronizing",
    setup: async (page, user, variant) => {
      await page.addInitScript(({ variantId }) => {
        localStorage.setItem("attractionCartV2:guest", JSON.stringify([{
          productId: "predator-elite-fg", productVariantId: variantId, quantity: 1,
        }]));
      }, { variantId: variant.variant_id });
      return { failVariantMergeAttempts: 1 };
    },
  },
  {
    name: "local-only merge payload",
    expected: "still synchronizing",
    setup: async (page, user, variant) => {
      await page.addInitScript(({ variantId }) => {
        localStorage.setItem("attractionCartV2:guest", JSON.stringify([{
          productId: "predator-elite-fg", productVariantId: variantId, quantity: 1,
        }]));
        const originalRemoveItem = Storage.prototype.removeItem;
        let blocked = false;
        Storage.prototype.removeItem = function removeItem(key) {
          if (!blocked && key === "attractionCartV2:guest") {
            blocked = true;
            throw new Error("Simulated local-only payload");
          }
          return originalRemoveItem.call(this, key);
        };
      }, { variantId: variant.variant_id });
      return {};
    },
  },
  {
    name: "authenticated legacy line",
    expected: "Select an option",
    config: (user) => ({ legacyVariantCarts: { [user.id]: [{ product_id: "phantom-control-pro", quantity: 1 }] } }),
  },
  {
    name: "guest legacy line",
    expected: "Select an option",
    setup: async (page) => {
      await page.addInitScript(() => {
        localStorage.setItem("attractionCart:guest", JSON.stringify([{
          id: "phantom-control-pro", name: "Phantom Control Pro", category: "Football Shoes", price: 199.99, image: "", qty: 1,
        }]));
      });
      return {};
    },
  },
  {
    name: "out-of-stock variant",
    expected: "out of stock",
    item: { stock_state: "Out of Stock", purchasable_quantity: 0 },
  },
  {
    name: "inactive product",
    expected: "products are unavailable",
    item: { product_is_active: false },
  },
  {
    name: "inactive variant",
    expected: "selected options are unavailable",
    item: { variant_is_active: false, stock_state: "Unavailable", purchasable_quantity: 0 },
  },
  {
    name: "exponent quantity",
    expected: "invalid quantity",
    item: { quantity: "1e2" },
  },
]) {
  test(`Phase 2B4 blocks ${scenario.name} before checkout`, async ({ page }) => {
    const user = {
      id: `blocked-${scenario.name.replace(/\W+/g, "-")}`,
      email: "blocked@example.test",
      user_metadata: { full_name: "Blocked Buyer", phone: "+91 90000 10001" },
    };
    const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
    const setupConfig = scenario.setup ? await scenario.setup(page, user, variant) : {};
    const extraConfig = scenario.config ? scenario.config(user) : {};
    await installSupabaseStub(page, {
      user,
      variantUi: true,
      variantCartV2: true,
      variantCheckoutV2: true,
      variantRows: [variant],
      cloudVariantCarts: { [user.id]: [{
        product_id: "predator-elite-fg",
        product_variant_id: variant.variant_id,
        quantity: 1,
        ...scenario.item,
      }] },
      ...setupConfig,
      ...extraConfig,
    });
    await page.goto("/products.html", { waitUntil: "domcontentloaded" });
    await page.locator(".cart-button").click();
    const drawer = page.locator(".cart-drawer");
    await expect(drawer.locator(".variant-checkout-message")).toContainText(new RegExp(scenario.expected, "i"));
    await expect(drawer.getByRole("button", { name: "Checkout", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderV2Calls)).toEqual([]);
  });
}

test("Phase 2B4 reuses one idempotency UUID after failure and unknown-result retry", async ({ page }) => {
  const user = {
    id: "retry-v2-user",
    email: "retry-v2@example.test",
    user_metadata: { full_name: "Retry Buyer", phone: "+91 90000 10002" },
  };
  const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantCheckoutV2: true,
    variantRows: [variant],
    cloudVariantCarts: { [user.id]: [{ product_id: "predator-elite-fg", product_variant_id: variant.variant_id, quantity: 1 }] },
    failPlaceOrderV2Attempts: 1,
    failPlaceOrderV2: "Temporary network failure",
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await openVariantCheckout(page);
  const modal = await reviewVariantCheckout(page);
  await modal.locator("[data-cod-confirm-checkbox]").check();
  await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect(modal.locator("[data-checkout-error]")).toHaveText("We could not place your order. Please try again.");
  const savedAttempt = await page.evaluate(() => JSON.parse(localStorage.getItem("attractionCheckoutV2Attempt")));
  expect(Object.keys(savedAttempt).sort()).toEqual(["fingerprint", "idempotencyKey", "userId"]);
  expect(savedAttempt.userId).toBe(user.id);

  await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect(modal.locator("[data-checkout-success-panel]")).toBeVisible();
  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderV2Calls);
  expect(calls).toHaveLength(2);
  expect(calls[1].p_idempotency_key).toBe(calls[0].p_idempotency_key);
});

test("Phase 2B4 recovers an unknown committed response with the same UUID and idempotent replay", async ({ page }) => {
  const user = {
    id: "unknown-v2-user",
    email: "unknown-v2@example.test",
    user_metadata: { full_name: "Unknown Buyer", phone: "+91 90000 10003" },
  };
  const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantCheckoutV2: true,
    variantRows: [variant],
    cloudVariantCarts: { [user.id]: [{ product_id: "predator-elite-fg", product_variant_id: variant.variant_id, quantity: 1 }] },
    unknownPlaceOrderV2Attempts: 1,
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await openVariantCheckout(page);
  const modal = await reviewVariantCheckout(page);
  await modal.locator("[data-cod-confirm-checkbox]").check();
  await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect(modal.locator("[data-checkout-error]")).toContainText("try again");
  await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect(modal.locator("[data-checkout-success-panel]")).toBeVisible();
  const result = await page.evaluate(() => ({
    calls: window.__attractionSupabaseTestState.placeOrderV2Calls,
    attempt: localStorage.getItem("attractionCheckoutV2Attempt"),
    toast: document.querySelector(".toast")?.textContent,
  }));
  expect(result.calls).toHaveLength(2);
  expect(result.calls[1].p_idempotency_key).toBe(result.calls[0].p_idempotency_key);
  expect(result.attempt).toBeNull();
  expect(result.toast).toContain("order confirmed");
});

test("Phase 2B4 creates a new UUID when shipping or authoritative cart content changes", async ({ page }) => {
  const user = {
    id: "changed-v2-user",
    email: "changed-v2@example.test",
    user_metadata: { full_name: "Changed Buyer", phone: "+91 90000 10004" },
  };
  const variants = createVariantRows("predator-elite-fg", ["UK 8", "UK 9"]);
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantCheckoutV2: true,
    variantRows: variants,
    cloudVariantCarts: { [user.id]: [{ product_id: "predator-elite-fg", product_variant_id: variants[0].variant_id, quantity: 1 }] },
    failPlaceOrderV2Attempts: 3,
    failPlaceOrderV2: "Temporary network failure",
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });

  const attemptCheckout = async (city = "Kolkata") => {
    await openVariantCheckout(page);
    const modal = await reviewVariantCheckout(page, { city });
    await modal.locator("[data-cod-confirm-checkbox]").check();
    await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
    await expect(modal.locator("[data-checkout-error]")).toContainText("try again");
    await modal.getByRole("button", { name: "Close checkout" }).click();
  };

  await attemptCheckout();
  await attemptCheckout("Howrah");
  await page.locator(".cart-button").click();
  await page.locator(`[data-variant-cart-line="${variants[0].variant_id}"]`).getByRole("button", { name: /Decrease/ }).click();
  await page.locator("[data-close-cart]").click();
  const card = page.locator('.product-card[data-product-id="predator-elite-fg"]').first();
  await card.getByRole("button", { name: "UK 9", exact: true }).click();
  await card.getByRole("button", { name: "Add to Cart", exact: true }).click();
  await card.getByRole("button", { name: "Add to Cart", exact: true }).click();
  await attemptCheckout("Howrah");

  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderV2Calls);
  expect(new Set(calls.map((call) => call.p_idempotency_key)).size).toBe(3);
  expect(calls[2].p_items).toEqual([{
    product_id: "predator-elite-fg", product_variant_id: variants[1].variant_id, quantity: 2,
  }]);
});

test("Phase 2B4 cart-change and stock errors refresh authoritative cart without automatic retry", async ({ page }) => {
  const user = {
    id: "refresh-v2-user",
    email: "refresh-v2@example.test",
    user_metadata: { full_name: "Refresh Buyer", phone: "+91 90000 10005" },
  };
  const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantCheckoutV2: true,
    variantRows: [variant],
    cloudVariantCarts: { [user.id]: [{ product_id: "predator-elite-fg", product_variant_id: variant.variant_id, quantity: 1 }] },
    failPlaceOrderV2: "Cart changed. Please review the latest cart.",
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await openVariantCheckout(page);
  const modal = await reviewVariantCheckout(page);
  await modal.locator("[data-cod-confirm-checkbox]").check();
  await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect(modal.locator("[data-checkout-details]")).toBeVisible();
  await expect(modal.locator("[data-checkout-error]")).toContainText(/cart changed/i);
  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.placeOrderV2Calls).toHaveLength(1);
  expect(state.rpcs.filter((call) => call.name === "get_cart_v2").length).toBeGreaterThanOrEqual(2);
  expect(state.rpcs.filter((call) => call.name === "get_storefront_variants").length).toBeGreaterThanOrEqual(2);
});

test("Phase 2B4 exposes pending accessibility state and ignores stale User A checkout response", async ({ page }) => {
  const userA = {
    id: "checkout-user-a",
    email: "checkout-user-a@example.test",
    user_metadata: { full_name: "User A", phone: "+91 90000 10006" },
  };
  const userB = {
    id: "checkout-user-b",
    email: "checkout-user-b@example.test",
    user_metadata: { full_name: "User B", phone: "+91 90000 10007" },
  };
  const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
  await installSupabaseStub(page, {
    user: userA,
    usersByEmail: { [userB.email]: userB },
    variantUi: true,
    variantCartV2: true,
    variantCheckoutV2: true,
    variantRows: [variant],
    placeOrderV2Delay: 350,
    cloudVariantCarts: {
      [userA.id]: [{ product_id: "predator-elite-fg", product_variant_id: variant.variant_id, quantity: 1 }],
      [userB.id]: [{ product_id: "predator-elite-fg", product_variant_id: variant.variant_id, quantity: 2 }],
    },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await openVariantCheckout(page);
  const modal = await reviewVariantCheckout(page);
  await modal.locator("[data-cod-confirm-checkbox]").check();
  await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect(modal).toHaveAttribute("aria-busy", "true");
  await expect(modal.locator("[data-checkout-form]")).toHaveAttribute("aria-busy", "true");
  await expect(modal.locator("#checkout-address")).toBeDisabled();

  await page.evaluate(async (email) => {
    await window.__attractionSupabaseClient.auth.signOut();
    await window.__attractionSupabaseClient.auth.signInWithPassword({ email, password: "valid-password" });
  }, userB.email);
  await expect(modal).not.toHaveClass(/is-open/);
  await page.waitForTimeout(450);
  await expect(modal.locator("[data-checkout-success-panel]")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("attractionCheckoutV2Attempt"))).toBeNull();
  await expect(page.locator(".cart-count")).toHaveText("2");
});

test("Phase 2B4 checkout modal is mobile-safe and uses only V2 order RPCs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const user = {
    id: "mobile-v2-user",
    email: "mobile-v2@example.test",
    user_metadata: { full_name: "Mobile Buyer", phone: "+91 90000 10008" },
  };
  const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
  await installSupabaseStub(page, {
    user,
    variantUi: true,
    variantCartV2: true,
    variantCheckoutV2: true,
    variantRows: [variant],
    cloudVariantCarts: { [user.id]: [{ product_id: "predator-elite-fg", product_variant_id: variant.variant_id, quantity: 1 }] },
  });
  await page.goto("/products.html", { waitUntil: "domcontentloaded" });
  await openVariantCheckout(page);
  await reviewVariantCheckout(page);
  await expect(page.locator("[data-cod-confirmation-items]")).toContainText("Size: UK 8");
  await expectNoHorizontalOverflow(page);
  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.rpcs.map((call) => call.name));
  expect(calls).not.toContain("place_order");
});

for (const flagCase of [
  { name: "absent", omitVariantCheckoutFlag: true, expectedProperty: false },
  { name: "explicitly false", omitVariantCheckoutFlag: false, expectedProperty: true },
]) {
  test(`Phase 2B4 keeps checkout disabled when the third flag is ${flagCase.name}`, async ({ page }) => {
    const variants = createVariantRows("predator-elite-fg", ["UK 8"]);
    await installSupabaseStub(page, {
      user: null,
      variantUi: true,
      variantCartV2: true,
      variantCheckoutV2: false,
      omitVariantCheckoutFlag: flagCase.omitVariantCheckoutFlag,
      variantRows: variants,
    });
    await page.goto("/products.html", { waitUntil: "domcontentloaded" });
    const card = page.locator('.product-card[data-product-id="predator-elite-fg"]').first();
    await card.getByRole("button", { name: "UK 8", exact: true }).click();
    await card.getByRole("button", { name: "Add to Cart", exact: true }).click();
    await page.locator(".cart-button").click();

    await expect(page.locator(".variant-checkout-message")).toHaveText("Variant checkout is not enabled yet");
    await expect(page.getByRole("button", { name: "Checkout", exact: true })).toBeDisabled();
    const state = await page.evaluate(() => ({
      hasThirdFlag: Object.prototype.hasOwnProperty.call(window.__ATTRACTION_FEATURES__, "variantCheckoutV2"),
      thirdFlag: window.__ATTRACTION_FEATURES__.variantCheckoutV2,
      v1: window.__attractionSupabaseTestState.placeOrderCalls,
      v2: window.__attractionSupabaseTestState.placeOrderV2Calls,
    }));
    expect(state.hasThirdFlag).toBe(flagCase.expectedProperty);
    expect(state.thirdFlag).not.toBe(true);
    expect(state.v1).toEqual([]);
    expect(state.v2).toEqual([]);
  });
}

for (const malformedQuantity of [
  { name: "blank", value: "" },
  { name: "surrounding spaces", value: " 1 " },
  { name: "trailing space", value: "1 " },
  { name: "leading space", value: " 1" },
  { name: "tab", value: "1\t" },
  { name: "newline", value: "1\n" },
  { name: "negative", value: "-1" },
  { name: "explicit plus", value: "+1" },
  { name: "decimal", value: "1.5" },
  { name: "lowercase exponent", value: "1e2" },
  { name: "uppercase exponent", value: "1E2" },
  { name: "hexadecimal", value: "0x10" },
  { name: "zero", value: "0" },
  { name: "above maximum", value: "21" },
]) {
  test(`Phase 2B4 rejects ${malformedQuantity.name} cloud quantity`, async ({ page }) => {
    const user = {
      id: `invalid-quantity-${malformedQuantity.name.replace(/\W+/g, "-")}`,
      email: "invalid-quantity@example.test",
      user_metadata: {},
    };
    const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
    await installSupabaseStub(page, {
      user,
      variantUi: true,
      variantCartV2: true,
      variantCheckoutV2: true,
      variantRows: [variant],
      cloudVariantCarts: { [user.id]: [{
        product_id: "predator-elite-fg",
        product_variant_id: variant.variant_id,
        quantity: malformedQuantity.value,
      }] },
    });
    await page.goto("/products.html", { waitUntil: "domcontentloaded" });
    await page.locator(".cart-button").click();
    await expect(page.locator(".variant-checkout-message")).toHaveText("Your cart contains an invalid quantity.");
    await expect(page.getByRole("button", { name: "Checkout", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderV2Calls)).toEqual([]);
  });
}

for (const validQuantity of ["1", "10", "20"]) {
  test(`Phase 2B4 submits valid string quantity ${validQuantity} as an integer`, async ({ page }) => {
    const user = {
      id: `valid-quantity-${validQuantity}`,
      email: "valid-quantity@example.test",
      user_metadata: { full_name: "Valid Quantity", phone: "+91 90000 11001" },
    };
    const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
    const { modal } = await prepareVariantCheckout(page, {
      user,
      variants: [variant],
      cloudItems: [{
        product_id: "predator-elite-fg",
        product_variant_id: variant.variant_id,
        quantity: validQuantity,
        purchasable_quantity: 20,
      }],
    });
    await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
    await expect(modal.locator("[data-checkout-success-panel]")).toBeVisible();
    const item = await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderV2Calls[0].p_items[0]);
    expect(item.quantity).toBe(Number(validQuantity));
    expect(typeof item.quantity).toBe("number");
  });
}

test("Phase 2B4 guards two direct enabled-handler invocations synchronously", async ({ page }) => {
  await exposeCheckoutTestHooks(page);
  const { modal } = await prepareVariantCheckout(page, {
    stub: { placeOrderV2Delay: 250 },
  });

  const pending = await page.evaluate(() => {
    const form = document.querySelector("[data-checkout-form]");
    const invoke = () => window.__phase2A3CheckoutTestHooks.handleCheckoutSubmit({
      currentTarget: form,
      preventDefault() {},
    });
    const first = invoke();
    const second = invoke();
    window.__phase2B4DirectResults = Promise.all([first, second]);
    return {
      submitting: form.dataset.submitting,
      busy: form.getAttribute("aria-busy"),
      addressDisabled: document.querySelector("#checkout-address").disabled,
    };
  });
  expect(pending).toEqual({ submitting: "true", busy: "true", addressDisabled: true });
  await expect(modal).toHaveAttribute("aria-busy", "true");
  expect(await page.evaluate(() => window.__phase2B4DirectResults)).toEqual([true, false]);
  await expect(modal.locator("[data-checkout-success-panel]")).toBeVisible();
  expect(await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderV2Calls)).toHaveLength(1);
});

test("Phase 2B4 serializes a keyboard submission and button activation race", async ({ page }) => {
  const { modal } = await prepareVariantCheckout(page, {
    stub: { placeOrderV2Delay: 250 },
  });
  await modal.locator("[data-checkout-form]").evaluate((form) => {
    form.requestSubmit();
    form.querySelector("[data-place-order]").click();
  });
  await expect(modal).toHaveAttribute("aria-busy", "true");
  await expect(modal.locator("[data-place-order]")).toBeDisabled();
  await expect(modal.locator("[data-checkout-success-panel]")).toBeVisible();
  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.placeOrderV2Calls).toHaveLength(1);
  expect(new Set(state.placeOrderV2Calls.map((call) => call.p_idempotency_key)).size).toBe(1);
  expect(state.placeOrderCalls).toEqual([]);
});

test("Phase 2B4 changes the UUID when only quantity changes", async ({ page }) => {
  const { variants, modal } = await prepareVariantCheckout(page, {
    stub: { failPlaceOrderV2Attempts: 1, failPlaceOrderV2: "Network connection interrupted" },
  });
  await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect(modal.locator("[data-checkout-error]")).toContainText("try again");
  const firstCall = await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderV2Calls[0]);
  await modal.getByRole("button", { name: "Close checkout" }).click();
  await page.locator(".cart-button").click();
  await page.locator(`[data-variant-cart-line="${variants[0].variant_id}"]`).getByRole("button", { name: /Increase/ }).click();
  await page.locator("[data-close-cart]").click();

  await openVariantCheckout(page);
  const retryModal = await reviewVariantCheckout(page);
  await retryModal.locator("[data-cod-confirm-checkbox]").check();
  await retryModal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect(retryModal.locator("[data-checkout-success-panel]")).toBeVisible();
  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderV2Calls);
  expect(calls[1].p_idempotency_key).not.toBe(firstCall.p_idempotency_key);
  expect(calls[1].p_items).toEqual([{
    product_id: "predator-elite-fg",
    product_variant_id: variants[0].variant_id,
    quantity: 2,
  }]);
});

test("Phase 2B4 changes the UUID when only the selected variant changes", async ({ page }) => {
  const variants = createVariantRows("predator-elite-fg", ["UK 8", "UK 9"]);
  const { modal } = await prepareVariantCheckout(page, {
    variants,
    stub: { failPlaceOrderV2Attempts: 1, failPlaceOrderV2: "Network connection interrupted" },
  });
  await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect(modal.locator("[data-checkout-error]")).toContainText("try again");
  const firstCall = await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderV2Calls[0]);
  await modal.getByRole("button", { name: "Close checkout" }).click();
  await page.locator(".cart-button").click();
  await page.locator(`[data-variant-cart-line="${variants[0].variant_id}"]`).getByRole("button", { name: /Decrease/ }).click();
  await page.locator("[data-close-cart]").click();
  const card = page.locator('.product-card[data-product-id="predator-elite-fg"]').first();
  await card.getByRole("button", { name: "UK 9", exact: true }).click();
  await card.getByRole("button", { name: "Add to Cart", exact: true }).click();

  await openVariantCheckout(page);
  const retryModal = await reviewVariantCheckout(page);
  await retryModal.locator("[data-cod-confirm-checkbox]").check();
  await retryModal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect(retryModal.locator("[data-checkout-success-panel]")).toBeVisible();
  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderV2Calls);
  expect(calls[1].p_idempotency_key).not.toBe(firstCall.p_idempotency_key);
  expect(calls[1].p_items).toEqual([{
    product_id: "predator-elite-fg",
    product_variant_id: variants[1].variant_id,
    quantity: 1,
  }]);
});

test("Phase 2B4 refreshes cart and availability after insufficient stock", async ({ page }) => {
  const { variants, modal } = await prepareVariantCheckout(page, {
    cloudItems: [{
      product_id: "predator-elite-fg",
      product_variant_id: createVariantRows("predator-elite-fg", ["UK 8"])[0].variant_id,
      quantity: 2,
    }],
    stub: { failPlaceOrderV2Attempts: 1, failPlaceOrderV2: "Insufficient stock for selected variant." },
  });
  await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect(modal.locator("[data-checkout-error]")).toHaveText("One or more selected options do not have enough stock.");
  await expect(modal.locator("[data-checkout-details]")).toBeVisible();
  await page.waitForTimeout(100);
  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.placeOrderV2Calls).toHaveLength(1);
  expect(state.placeOrderCalls).toEqual([]);
  expect(state.rpcs.filter((call) => call.name === "get_cart_v2").length).toBeGreaterThanOrEqual(2);
  expect(state.rpcs.filter((call) => call.name === "get_storefront_variants").length).toBeGreaterThanOrEqual(2);
  const line = page.locator(`[data-variant-cart-line="${variants[0].variant_id}"]`);
  await expect(line.locator(".cart-controls strong")).toHaveText("2");
  await expect(line.getByRole("button", { name: /Decrease/ })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem("attractionCheckoutV2Attempt"))).not.toBeNull();
});

test("Phase 2B4 clears User A checkout state immediately on logout before User B login", async ({ page }) => {
  const userA = {
    id: "logout-checkout-user-a",
    email: "logout-checkout-a@example.test",
    user_metadata: { full_name: "Logout User A", phone: "+91 90000 11002" },
  };
  const userB = {
    id: "logout-checkout-user-b",
    email: "logout-checkout-b@example.test",
    user_metadata: { full_name: "Logout User B", phone: "+91 90000 11003" },
  };
  const [variant] = createVariantRows("predator-elite-fg", ["UK 8"]);
  const { modal } = await prepareVariantCheckout(page, {
    user: userA,
    variants: [variant],
    stub: {
      usersByEmail: { [userB.email]: userB },
      placeOrderV2Delay: 350,
      cloudVariantCarts: {
        [userA.id]: [{ product_id: "predator-elite-fg", product_variant_id: variant.variant_id, quantity: 1 }],
        [userB.id]: [{ product_id: "predator-elite-fg", product_variant_id: variant.variant_id, quantity: 2 }],
      },
    },
  });
  await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("attractionCheckoutV2Attempt"))).not.toBeNull();
  await expect(modal).toHaveAttribute("aria-busy", "true");

  await page.evaluate(() => window.__attractionSupabaseClient.auth.signOut());
  await expect.poll(() => page.evaluate(() => localStorage.getItem("attractionCheckoutV2Attempt"))).toBeNull();
  await expect(modal).not.toHaveClass(/is-open/);
  await expect(modal).not.toHaveAttribute("aria-busy", "true");
  await expect(modal.locator("[data-checkout-form]")).toHaveAttribute("data-submitting", "false");
  await expect(modal.locator("[data-place-order]")).toBeDisabled();
  await expect(modal.locator("[data-checkout-success-panel]")).toBeHidden();
  await page.waitForTimeout(450);
  await expect(modal.locator("[data-checkout-success-panel]")).toBeHidden();

  await page.evaluate((email) => window.__attractionSupabaseClient.auth.signInWithPassword({
    email,
    password: "valid-password",
  }), userB.email);
  await expect(page.locator(".cart-count")).toHaveText("2");
  expect(await page.evaluate(() => localStorage.getItem("attractionCheckoutV2Attempt"))).toBeNull();
  await expect(modal.locator("[data-checkout-success-panel]")).toBeHidden();
});

test("Phase 2B4 retires a definitive idempotency conflict before deliberate retry", async ({ page }) => {
  const { modal } = await prepareVariantCheckout(page, {
    stub: { placeOrderV2IdempotencyConflictAttempts: 1 },
  });
  await modal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect(modal.locator("[data-checkout-error]")).toHaveText(
    "This checkout attempt could not be reused. Please review your cart and try again."
  );
  await expect(modal.locator("[data-checkout-details]")).toBeVisible();
  const firstState = await page.evaluate(() => ({
    calls: window.__attractionSupabaseTestState.placeOrderV2Calls,
    v1: window.__attractionSupabaseTestState.placeOrderCalls,
    attempt: localStorage.getItem("attractionCheckoutV2Attempt"),
    cart: window.__attractionSupabaseTestState.cloudVariantCarts["phase2b4-correction-user"],
  }));
  expect(firstState.calls).toHaveLength(1);
  expect(firstState.v1).toEqual([]);
  expect(firstState.attempt).toBeNull();
  expect(firstState.cart).toHaveLength(1);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderV2Calls)).toHaveLength(1);

  const retryModal = await reviewVariantCheckout(page);
  await retryModal.locator("[data-cod-confirm-checkbox]").check();
  await retryModal.getByRole("button", { name: "Confirm Cash on Delivery Order" }).click();
  await expect(retryModal.locator("[data-checkout-success-panel]")).toBeVisible();
  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderV2Calls);
  expect(calls).toHaveLength(2);
  expect(calls[1].p_idempotency_key).not.toBe(calls[0].p_idempotency_key);
  expect(await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderCalls)).toEqual([]);
});

test("cookie banner appears on first visit and saves consent preferences", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.removeItem("attractionCookieConsent");
    localStorage.removeItem("attractionCookiePreferences");
  });
  await page.reload({ waitUntil: "domcontentloaded" });

  const banner = page.locator("[data-cookie-banner]");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("We use cookies and browser storage to improve your shopping experience");
  await expect(banner.getByRole("link", { name: "Cookies Policy" })).toHaveAttribute("href", "cookies.html");

  await banner.getByRole("button", { name: "Accept" }).click();
  await expect(banner).not.toHaveClass(/is-visible/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("attractionCookieConsent"))).toBe("accepted");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-cookie-banner]")).not.toHaveClass(/is-visible/);

  await page.evaluate(() => {
    localStorage.removeItem("attractionCookieConsent");
    localStorage.removeItem("attractionCookiePreferences");
  });
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Manage" }).click();

  const modal = page.locator("[data-cookie-preferences]");
  await expect(modal).toHaveClass(/is-open/);
  await expect(modal.getByText("Essential cookies / storage")).toBeVisible();
  await expect(modal.getByText("Cart & wishlist storage")).toBeVisible();
  await expect(modal.getByText("Supabase Auth", { exact: true })).toBeVisible();

  await modal.getByRole("button", { name: "Save Preferences" }).click();
  await expect(modal).not.toHaveClass(/is-open/);
  await expect(banner).not.toHaveClass(/is-visible/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("attractionCookieConsent"))).toBe("custom");
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    localStorage.removeItem("attractionCookieConsent");
    localStorage.removeItem("attractionCookiePreferences");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(banner).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("mobile header and drawer interactions work on Chromium iPhone 12 Pro viewport", async ({ page }) => {
  const viewport = page.viewportSize();
  const logo = page.locator(".brand");
  const searchButton = page.locator('.header-actions button[aria-label="Search"]');
  const accountButton = page.locator('.header-actions button[aria-label="Account"]');
  const wishlistButton = page.locator('.header-actions button[aria-label="Wishlist"]');
  const cartButton = page.locator(".cart-button");
  const menuButton = page.locator(".menu-toggle");
  const drawer = page.locator("#mobile-drawer");
  const overlay = page.locator(".drawer-overlay");
  const closeButton = drawer.locator("[data-close-menu]");
  const mobileNavLink = drawer.locator(".mobile-drawer-nav a", { hasText: "Football Shoes" });
  const desktopNav = page.locator(".main-nav");

  await expect(logo).toBeVisible();
  await expect(searchButton).toBeVisible();
  await expect(accountButton).toBeVisible();
  await expect(wishlistButton).toBeVisible();
  await expect(cartButton).toBeVisible();
  await expect(menuButton).toBeVisible();

  await expectInViewport(wishlistButton, viewport.width, viewport.height);
  await expectInViewport(cartButton, viewport.width, viewport.height);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshotDir, "mobile-header-before.png"), fullPage: true });

  await openDrawer(page);
  await page.screenshot({ path: path.join(screenshotDir, "mobile-drawer-open.png"), fullPage: true });

  await overlay.click({ position: { x: 12, y: 12 } });
  await expect(drawer).not.toHaveClass(/open/);
  await expect(overlay).not.toHaveClass(/show/);
  await page.screenshot({ path: path.join(screenshotDir, "mobile-drawer-closed.png"), fullPage: true });

  await openDrawer(page);
  await closeButton.click();
  await expect(drawer).not.toHaveClass(/open/);
  await expect(overlay).not.toHaveClass(/show/);

  await openDrawer(page);
  await mobileNavLink.click();
  await expect(drawer).not.toHaveClass(/open/);
  await expect(overlay).not.toHaveClass(/show/);

  await openDrawer(page);
  await page.keyboard.press("Escape");
  await expect(drawer).not.toHaveClass(/open/);
  await expect(overlay).not.toHaveClass(/show/);

  await openDrawer(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(drawer).not.toHaveClass(/open/);
  await expect(overlay).not.toHaveClass(/show/);
  await expect(desktopNav).toBeVisible();
  await expect(menuButton).toBeHidden();
  await expectNoHorizontalOverflow(page);
});

test("sub-380 mobile header keeps logo wishlist cart and menu, with search and account in drawer", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");

  const logo = page.locator(".brand");
  const searchButton = page.locator('.header-actions button[aria-label="Search"]');
  const accountButton = page.locator('.header-actions button[aria-label="Account"]');
  const wishlistButton = page.locator('.header-actions button[aria-label="Wishlist"]');
  const cartButton = page.locator(".cart-button");
  const menuButton = page.locator(".menu-toggle");
  const drawer = page.locator("#mobile-drawer");
  const overlay = page.locator(".drawer-overlay");
  const drawerSearch = drawer.locator("[data-drawer-search]");
  const drawerAccount = drawer.locator("[data-drawer-account]");

  await expect(logo).toBeVisible();
  await expect(wishlistButton).toBeVisible();
  await expect(cartButton).toBeVisible();
  await expect(menuButton).toBeVisible();
  await expect(searchButton).toBeHidden();
  await expect(accountButton).toBeHidden();
  await expectNoHorizontalOverflow(page);

  await menuButton.click();
  await expect(drawer).toHaveClass(/open/);
  await expect(overlay).toHaveClass(/show/);
  await expect(drawerSearch).toBeVisible();
  await expect(drawerAccount).toBeVisible();

  await drawerSearch.click();
  await expect(drawer).not.toHaveClass(/open/);
  await expect(overlay).not.toHaveClass(/show/);
  await expect(page.locator(".search-modal")).toHaveClass(/is-open/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".search-modal")).not.toHaveClass(/is-open/);

  await menuButton.click();
  await expect(drawer).toHaveClass(/open/);
  await drawerAccount.click();
  await expect(drawer).not.toHaveClass(/open/);
  await expect(page.locator(".login-modal")).toHaveClass(/is-open/);
});

test("hero boot visual renders without desktop or mobile overflow", async ({ page }) => {
  const hero = page.locator(".hero-section");
  const boot = page.locator(".hero-shoe");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(hero).toBeVisible();
  await expect(boot).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await hero.screenshot({ path: path.join(screenshotDir, "hero-section-desktop.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(hero).toBeVisible();
  await expect(boot).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await hero.screenshot({ path: path.join(screenshotDir, "hero-section-mobile.png") });
});

test("football shoes category card shows premium boot image without layout overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const categoryCard = page.locator(".shoe-card");
  const categoryBoot = categoryCard.locator(".category-shoe-img");

  await expect(categoryCard).toBeVisible();
  await expect(categoryBoot).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await categoryCard.screenshot({ path: path.join(screenshotDir, "football-shoes-category-card.png") });
});

test("wishlist header drawer and wishlist page work like cart", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const firstProduct = page.locator(".product-card", { hasText: "Predator Elite FG" }).first();
  const productHeart = firstProduct.getByLabel("Add Predator Elite FG to wishlist");
  const headerWishlist = page.locator('.header-actions button[aria-label="Wishlist"]');
  const wishlistDrawer = page.locator(".wishlist-drawer");

  await expect(headerWishlist).toBeVisible();
  await expect(headerWishlist.locator(".wishlist-count")).toHaveText("0");

  await productHeart.click();
  await expect(productHeart).toHaveClass(/is-active/);
  await expect(productHeart).toHaveText("♥");
  await expect(headerWishlist.locator(".wishlist-count")).toHaveText("1");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('.header-actions button[aria-label="Wishlist"] .wishlist-count')).toHaveText("1");
  await expect(page.locator(".product-card", { hasText: "Predator Elite FG" }).first().getByLabel("Add Predator Elite FG to wishlist")).toHaveText("♥");

  await page.locator('.header-actions button[aria-label="Wishlist"]').click();
  await expect(wishlistDrawer).toHaveClass(/is-open/);
  await expect(wishlistDrawer.getByText("Predator Elite FG")).toBeVisible();
  await expect(wishlistDrawer.getByText(/Football Shoes · .*219\.99/)).toBeVisible();
  await expect(wishlistDrawer.locator(".wishlist-item img")).toBeVisible();

  await wishlistDrawer.getByRole("button", { name: "Add to Cart", exact: true }).click();
  await expect(page.locator(".cart-count")).toHaveText("1");

  await wishlistDrawer.getByRole("link", { name: "View All Wishlist" }).click();
  await expect(page).toHaveURL(/wishlist.html/);
  await expect(page.locator("#wishlist-title")).toHaveText("Wishlist");
  await expect(page.locator(".wishlist-grid .product-card")).toHaveCount(1);
  await expect(page.locator(".wishlist-grid", { hasText: "Predator Elite FG" })).toBeVisible();

  await page.locator(".wishlist-page-remove").click();
  await expect(page.locator(".wishlist-grid .product-card")).toHaveCount(0);
  await expect(page.locator("[data-wishlist-empty]").getByText("Your wishlist is empty.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Shop Products" })).toHaveAttribute("href", "products.html");
  await expect(page.locator('.header-actions button[aria-label="Wishlist"] .wishlist-count')).toHaveText("0");
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/wishlist.html");
  await expect(page.locator("#wishlist-title")).toBeVisible();
  await expect(page.locator("[data-wishlist-empty]").getByText("Your wishlist is empty.")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("homepage featured filters show at least four products per category", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/");

  const section = page.locator("#products");
  const filters = section.locator(".filter-wrap");
  const cards = section.locator(".product-card");

  await expect(filters).toBeVisible();
  await expect(cards).toHaveCount(16);
  await waitForImages(section.locator(".product-card img"));

  const allCategories = await cards.evaluateAll((items) =>
    [...new Set(items.map((item) => item.querySelector("p")?.textContent?.trim()).filter(Boolean))]
  );
  expect(allCategories).toEqual(expect.arrayContaining(["Football Shoes", "Jersey", "T-Shirt", "Football"]));
  await expectNoHorizontalOverflow(page);
  await section.screenshot({ path: path.join(screenshotDir, "featured-filter-all.png") });

  const expectations = [
    {
      filter: "Football Shoes",
      screenshot: "featured-filter-football-shoes.png",
      names: ["Predator Elite FG", "Phantom Control Pro", "Velocity Grip SG", "Aero Touch Academy"],
    },
    {
      filter: "Jersey",
      screenshot: "featured-filter-jersey.png",
      names: ["Legendary Home Jersey", "Elite Home Jersey", "Shadow Away Jersey", "Pro Training Jersey"],
    },
    {
      filter: "T-Shirt",
      screenshot: "featured-filter-t-shirt.png",
      names: ["Performance Tee", "Performance Training Tee", "Matchday Travel Tee", "Pro Training Tee"],
    },
    {
      filter: "Football",
      screenshot: "featured-filter-football.png",
      names: ["Premier Match Ball", "Elite Training Ball", "Neon Strike Football", "Pro League Ball"],
    },
  ];

  for (const item of expectations) {
    await filters.getByRole("button", { name: item.filter, exact: true }).click({ force: true });

    const visibleCards = await cards.evaluateAll((items) =>
      items
        .filter((card) => {
          const style = window.getComputedStyle(card);
          const rect = card.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        })
        .map((card) => card.querySelector("h3")?.textContent?.trim())
        .filter(Boolean)
    );

    expect(visibleCards.length).toBeGreaterThanOrEqual(4);
    expect(visibleCards).toEqual(expect.arrayContaining(item.names));
    await expectNoHorizontalOverflow(page);
    await section.screenshot({ path: path.join(screenshotDir, item.screenshot) });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expectNoHorizontalOverflow(page);

  const mobileSection = page.locator("#products");
  const mobileFilters = mobileSection.locator(".filter-wrap");
  const mobileCards = mobileSection.locator(".product-card");

  for (const item of expectations) {
    await mobileFilters.getByRole("button", { name: item.filter, exact: true }).click({ force: true });
    const count = await mobileCards.evaluateAll((items) =>
      items.filter((card) => {
        const style = window.getComputedStyle(card);
        const rect = card.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }).length
    );
    expect(count).toBeGreaterThanOrEqual(4);
    await expectNoHorizontalOverflow(page);
  }
});

test("featured football shoe product card shows distinct premium boot image without layout overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const shoeProductCard = page.locator(".product-card", { hasText: "Predator Elite FG" });
  const shoeProductImage = shoeProductCard.locator(".product-shoe-img");

  await expect(shoeProductCard).toBeVisible();
  await expect(shoeProductImage).toBeVisible();
  await expect(shoeProductImage).toHaveJSProperty("complete", true);
  await shoeProductImage.evaluate((image) => image.decode?.());
  await expectNoHorizontalOverflow(page);

  await shoeProductCard.screenshot({ path: path.join(screenshotDir, "featured-football-shoe-product-card.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(shoeProductCard).toBeVisible();
  await expect(shoeProductImage).toBeVisible();
  await expect(shoeProductImage).toHaveJSProperty("complete", true);
  await expectNoHorizontalOverflow(page);
});

test("jersey category and featured product cards show premium jersey image without layout overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const jerseyCategoryCard = page.locator(".jersey-card");
  const jerseyProductCard = page.locator(".product-card", { hasText: "Legendary Home Jersey" });
  const categoryJersey = jerseyCategoryCard.locator(".category-jersey-img");
  const productJersey = jerseyProductCard.locator(".product-jersey-img");

  await expect(categoryJersey).toBeVisible();
  await expect(productJersey).toBeVisible();
  await expect(categoryJersey).toHaveJSProperty("complete", true);
  await expect(productJersey).toHaveJSProperty("complete", true);
  await categoryJersey.evaluate((image) => image.decode?.());
  await productJersey.evaluate((image) => image.decode?.());
  await expectNoHorizontalOverflow(page);

  await jerseyCategoryCard.screenshot({ path: path.join(screenshotDir, "jerseys-category-card.png") });
  await jerseyProductCard.screenshot({ path: path.join(screenshotDir, "jersey-product-card.png") });
});

test("t-shirt category and featured product cards show premium t-shirt image without layout overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const tshirtCategoryCard = page.locator(".tshirt-card");
  const tshirtProductCard = page.locator(".product-card", { hasText: "Performance Tee" });
  const categoryTshirt = tshirtCategoryCard.locator(".category-tshirt-img");
  const productTshirt = tshirtProductCard.locator(".product-tshirt-img");

  await expect(categoryTshirt).toBeVisible();
  await expect(productTshirt).toBeVisible();
  await expect(categoryTshirt).toHaveJSProperty("complete", true);
  await expect(productTshirt).toHaveJSProperty("complete", true);
  await categoryTshirt.evaluate((image) => image.decode?.());
  await productTshirt.evaluate((image) => image.decode?.());
  await expectNoHorizontalOverflow(page);

  await tshirtCategoryCard.screenshot({ path: path.join(screenshotDir, "tshirts-category-card.png") });
  await tshirtProductCard.screenshot({ path: path.join(screenshotDir, "tshirt-product-card.png") });
});

test("homepage t-shirts category card opens dedicated t-shirts page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/index.html#categories");

  const tshirtCategoryCard = page.locator(".category-grid .tshirt-card");
  await expect(tshirtCategoryCard).toBeVisible();
  await expect(tshirtCategoryCard).toHaveAttribute("href", "t-shirts.html");
  await tshirtCategoryCard.screenshot({ path: path.join(screenshotDir, "tshirts-category-card-navigation.png") });

  await tshirtCategoryCard.click();
  await expect(page).toHaveURL(/t-shirts\.html$/);
  await expect(page.getByRole("heading", { name: /20 Premium T-Shirts/i, level: 2 })).toBeVisible();
});

test("featured football product card shows premium match ball image without layout overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const footballProductCard = page.locator(".product-card", { hasText: "Premier Match Ball" });
  const footballProductImage = footballProductCard.locator(".product-ball-img");

  await expect(footballProductCard).toBeVisible();
  await expect(footballProductImage).toBeVisible();
  await expect(footballProductImage).toHaveJSProperty("complete", true);
  await footballProductImage.evaluate((image) => image.decode?.());
  await expectNoHorizontalOverflow(page);

  await footballProductCard.screenshot({ path: path.join(screenshotDir, "football-product-card.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(footballProductCard).toBeVisible();
  await expect(footballProductImage).toBeVisible();
  await expect(footballProductImage).toHaveJSProperty("complete", true);
  await expectNoHorizontalOverflow(page);
});

test("promo banner shows premium footballer and ball visual without layout overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const promoBanner = page.locator(".promo-banner");
  const promoVisual = promoBanner.locator(".promo-visual");
  const promoImage = promoBanner.locator(".promo-player-img");

  await expect(promoBanner).toBeVisible();
  await expect(promoVisual).toBeVisible();
  await expect(promoImage).toBeVisible();
  await expect(promoImage).toHaveJSProperty("complete", true);
  await promoImage.evaluate((image) => image.decode?.());
  await expectNoHorizontalOverflow(page);

  await promoBanner.screenshot({ path: path.join(screenshotDir, "promo-banner.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(promoBanner).toBeVisible();
  await expect(promoVisual).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await promoBanner.screenshot({ path: path.join(screenshotDir, "promo-banner-mobile.png") });
});

test("promo banner Explore Now opens the Store page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const promoExploreLink = page.locator(".promo-banner").getByRole("link", { name: /Explore Now/i });
  await expect(promoExploreLink).toHaveAttribute("href", "products.html");

  await promoExploreLink.click();
  await expect(page).toHaveURL(/products\.html$/);
  await expect(page.getByRole("heading", { name: /All Products/i, level: 1 })).toBeVisible();
});

test("footer Contact Us opens contact page with static form success", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const footer = page.locator(".site-footer");
  await footer.getByRole("link", { name: "Contact Us", exact: true }).click();
  await expect(page).toHaveURL(/contact\.html$/);
  await expect(page.getByRole("heading", { name: /Contact Us/i, level: 1 })).toBeVisible();
  await expect(page.getByText("Support Topics", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Quick Help", exact: true })).toHaveCount(0);
  const contactInfo = page.locator(".contact-info-grid");
  await expect(contactInfo.getByText("support@attractionfootball.com")).toBeVisible();
  await expect(contactInfo.getByText("+91 98765 43210")).toBeVisible();
  await expect(contactInfo.getByText("24/7 Customer Support")).toBeVisible();

  const form = page.locator("[data-contact-form]");
  await form.getByLabel("Full Name").fill("Alex Morgan");
  await form.getByLabel("Email Address").fill("alex@example.com");
  await form.getByLabel("Phone Number").fill("+91 98765 43210");
  await form.getByLabel("Subject").fill("Boot sizing help");
  await form.getByLabel("Message").fill("I need help choosing the right football boot size.");
  await form.getByRole("button", { name: "Send Message", exact: true }).click();
  await expect(page.getByText("Thank you! Your message has been received.")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshotDir, "contact-desktop.png"), fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/contact.html");
  await expect(page.getByRole("heading", { name: /Contact Us/i, level: 1 })).toBeVisible();
  await expect(page.getByText("Support Topics", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Quick Help", exact: true })).toHaveCount(0);
  const mobileContactInfo = page.locator(".contact-info-grid");
  await expect(mobileContactInfo.getByText("support@attractionfootball.com")).toBeVisible();
  await expect(mobileContactInfo.getByText("+91 98765 43210")).toBeVisible();
  await expect(mobileContactInfo.getByText("24/7 Customer Support")).toBeVisible();

  const mobileForm = page.locator("[data-contact-form]");
  await expect(mobileForm.getByLabel("Full Name")).toBeVisible();
  await expect(mobileForm.getByLabel("Email Address")).toBeVisible();
  await expect(mobileForm.getByLabel("Phone Number")).toBeVisible();
  await expect(mobileForm.getByLabel("Subject")).toBeVisible();
  await expect(mobileForm.getByLabel("Message")).toBeVisible();
  await expect(mobileForm.getByRole("button", { name: "Send Message", exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await mobileForm.getByLabel("Full Name").fill("Alex Morgan");
  await mobileForm.getByLabel("Email Address").fill("alex@example.com");
  await mobileForm.getByLabel("Phone Number").fill("+91 98765 43210");
  await mobileForm.getByLabel("Subject").fill("Mobile contact test");
  await mobileForm.getByLabel("Message").fill("Testing the mobile contact form layout.");
  await mobileForm.getByRole("button", { name: "Send Message", exact: true }).click();
  await expect(page.getByText("Thank you! Your message has been received.")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshotDir, "contact-mobile.png"), fullPage: false });
});

test("careers application form validates CV upload format", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/careers.html");

  const form = page.locator(".careers-application-form");
  const cvInput = form.locator("[data-cv-upload]");
  const cvError = form.locator("[data-cv-error]");
  const cvField = form.locator("label", { hasText: "CV Upload" });
  const success = form.locator("[data-contact-success]");
  const invalidFile = path.join(screenshotDir, "invalid-cv.txt");
  const validFile = path.join(screenshotDir, "valid-cv.pdf");

  fs.writeFileSync(invalidFile, "invalid cv format");
  fs.writeFileSync(validFile, "%PDF-1.4\n% Attraction Football test CV\n");

  await expect(cvInput).toHaveAttribute("accept", ".pdf,.jpg,.jpeg,application/pdf,image/jpeg");
  await expect(cvField.getByText("Accepted formats: PDF, JPG, JPEG")).toBeVisible();
  await cvField.screenshot({ path: path.join(screenshotDir, "careers-cv-upload-field.png") });

  await cvInput.setInputFiles(invalidFile);
  await expect(cvError).toBeVisible();
  await expect(cvError).toHaveText("Invalid format. Please upload your CV in PDF, JPG, or JPEG format only.");

  await form.getByLabel("Full Name").fill("Alex Morgan");
  await form.getByLabel("Email Address").fill("alex@example.com");
  await form.getByLabel("Phone Number").fill("+91 98765 43210");
  await form.locator("[data-career-select-trigger]").click();
  await form.getByRole("option", { name: "Frontend Developer", exact: true }).click();
  await form.getByLabel("Message").fill("I want to apply for the frontend developer role.");
  await form.getByRole("button", { name: "Send Application", exact: true }).click();
  await expect(success).toBeHidden();
  await expect(cvError).toBeVisible();

  await cvInput.setInputFiles(validFile);
  await expect(cvError).toBeHidden();

  await form.getByRole("button", { name: "Send Application", exact: true }).click();
  await expect(success).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("footer Shipping & Delivery opens shipping page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const footerShippingLink = page.locator(".site-footer").getByRole("link", { name: "Shipping & Delivery", exact: true });
  await expect(footerShippingLink).toHaveAttribute("href", "shipping-delivery.html");
  await footerShippingLink.click();
  await expect(page).toHaveURL(/shipping-delivery\.html$/);
  await expect(page.getByRole("heading", { name: /Shipping & Delivery/i, level: 1 })).toBeVisible();
  await expect(page.getByText(/3-4 days after dispatch/i)).toBeVisible();
  await expect(page.getByText("support@attractionfootball.com").first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshotDir, "shipping-delivery-desktop.png"), fullPage: false });

  const pageFooterLink = page.locator(".site-footer").getByRole("link", { name: "Shipping & Delivery", exact: true });
  await expect(pageFooterLink).toHaveAttribute("href", "shipping-delivery.html");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/shipping-delivery.html");
  await expect(page.getByRole("heading", { name: /Shipping & Delivery/i, level: 1 })).toBeVisible();
  await expect(page.getByText(/3-4 days after dispatch/i)).toBeVisible();
  await expect(page.locator(".shipping-card")).toHaveCount(5);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshotDir, "shipping-delivery-mobile.png"), fullPage: false });
});


test("footer Returns & Exchanges opens returns page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const footerReturnsLink = page.locator(".site-footer").getByRole("link", { name: "Returns & Exchanges", exact: true });
  await expect(footerReturnsLink).toHaveAttribute("href", "returns-exchanges.html");
  await footerReturnsLink.click();
  await expect(page).toHaveURL(/returns-exchanges\.html$/);
  await expect(page.getByRole("heading", { name: /Returns & Exchanges/i, level: 1 })).toBeVisible();
  await expect(page.getByText(/7 days of delivery/i)).toBeVisible();
  await expect(page.locator(".shipping-card", { hasText: "Refund Timeline" }).getByText(/refund is processed within 5-7 working days/i)).toBeVisible();
  await expect(page.locator(".shipping-card")).toHaveCount(6);
  await expect(page.locator(".returns-step-card")).toHaveCount(5);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshotDir, "returns-exchanges-desktop.png"), fullPage: false });

  const pageFooterLink = page.locator(".site-footer").getByRole("link", { name: "Returns & Exchanges", exact: true });
  await expect(pageFooterLink).toHaveAttribute("href", "returns-exchanges.html");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/returns-exchanges.html");
  await expect(page.getByRole("heading", { name: /Returns & Exchanges/i, level: 1 })).toBeVisible();
  await expect(page.getByText(/7 days of delivery/i)).toBeVisible();
  await expect(page.locator(".shipping-card", { hasText: "Refund Timeline" }).getByText(/refund is processed within 5-7 working days/i)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshotDir, "returns-exchanges-mobile.png"), fullPage: false });
});

test("premium footer renders ecommerce links newsletter trust row and responsive layout", async ({ page }) => {
  const viewports = [
    { width: 360, height: 844, screenshot: "footer-360.png" },
    { width: 390, height: 844, screenshot: "footer-mobile.png" },
    { width: 768, height: 900, screenshot: "footer-tablet.png" },
    { width: 1440, height: 1000, screenshot: "footer-desktop.png" },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");

    const footer = page.locator(".site-footer");

    await expect(footer).toBeVisible();
    await expect(footer.locator("#footer-title")).toHaveText("Attraction Football");
    await expect(footer.getByText("Premium football boots, jerseys, t-shirts, balls, and performance gear built for players.")).toBeVisible();
    await expect(footer.getByText("Join the Club")).toBeVisible();
    await expect(footer.getByRole("textbox", { name: "Email address" })).toBeVisible();
    await expect(footer.getByRole("button", { name: "Subscribe" })).toBeVisible();
    await expect(footer.getByText("support@attractionfootball.com")).toBeVisible();
    await expect(footer.getByText(/\+91\s*98765\s*43210/)).toBeVisible();
    await expect(footer.getByText("SSL Protected")).toBeVisible();
    await expect(footer.locator(".footer-socials a")).toHaveCount(4);
    await expectNoHorizontalOverflow(page);

    const footerMetrics = await page.evaluate(() => {
      const viewportWidth = window.innerWidth;
      const footer = document.querySelector(".site-footer");
      const newsletter = document.querySelector(".footer-newsletter");
      const form = document.querySelector(".newsletter-form");
      const input = document.querySelector(".newsletter-form input");
      const button = document.querySelector(".newsletter-form button");
      const linkTargets = Array.from(document.querySelectorAll(".footer-column a, .footer-contact a, .footer-bottom a"));

      const toRect = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      };

      return {
        viewportWidth,
        footer: toRect(footer),
        newsletter: toRect(newsletter),
        form: toRect(form),
        input: toRect(input),
        button: toRect(button),
        links: linkTargets.map((element) => {
          const rect = element.getBoundingClientRect();
          const styles = window.getComputedStyle(element);
          return {
            text: element.textContent.trim(),
            width: rect.width,
            height: rect.height,
            fontSize: parseFloat(styles.fontSize),
            color: styles.color,
          };
        }),
      };
    });

    for (const key of ["footer", "newsletter", "form", "input", "button"]) {
      const rect = footerMetrics[key];
      expect(rect.left).toBeGreaterThanOrEqual(-1);
      expect(rect.right).toBeLessThanOrEqual(footerMetrics.viewportWidth + 1);
      expect(rect.scrollWidth).toBeLessThanOrEqual(rect.clientWidth + 1);
    }

    expect(footerMetrics.links.length).toBeGreaterThanOrEqual(18);
    expect(footerMetrics.links.map((link) => link.text)).not.toContain("New Collection");
    for (const link of footerMetrics.links) {
      expect(link.width, `${link.text} link width`).toBeGreaterThan(0);
      expect(link.height, `${link.text} link height`).toBeGreaterThan(0);
      expect(link.fontSize, `${link.text} link font size`).toBeGreaterThanOrEqual(12);
    }

    await footer.screenshot({ path: path.join(screenshotDir, viewport.screenshot) });
  }
});

test("view all products opens products page with search filters cart wishlist and responsive layout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const desktopNav = page.locator(".main-nav");
  await expect(desktopNav.getByRole("link", { name: "Home", exact: true })).toHaveClass(/active/);
  await expect(desktopNav.getByRole("link", { name: "Store", exact: true })).toHaveAttribute("href", "products.html");

  await desktopNav.getByRole("link", { name: "Store", exact: true }).click();
  await expect(page).toHaveURL(/products\.html$/);
  await expect(page.locator(".main-nav a.active")).toHaveText("Store");
  await expectNoHorizontalOverflow(page);

  await page.goto("/");
  await page.getByRole("link", { name: /View All Products/i }).click();
  await expect(page).toHaveURL(/products\.html$/);
  await expect(page.locator(".main-nav a.active")).toHaveText("Store");
  await expect(page.getByRole("heading", { name: "All Products", level: 1 })).toBeVisible();
  await expect(page.getByText("Explore premium football boots, jerseys, t-shirts, footballs, and accessories.")).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(16);
  const productImageSources = await page.locator(".all-products-grid .product-card img").evaluateAll((images) =>
    images.map((image) => image.getAttribute("src"))
  );
  expect(productImageSources).toHaveLength(16);
  expect(new Set(productImageSources).size).toBe(productImageSources.length);
  expect(productImageSources).toEqual(expect.arrayContaining([
    "assets/store-accessory-gloves.avif",
    "assets/store-accessory-shin-guards.avif",
    "assets/store-accessory-boot-bag.avif",
  ]));
  await expectNoHorizontalOverflow(page);

  const searchInput = page.getByRole("searchbox", { name: "Search Products" });
  await expect(searchInput).toBeVisible();
  await searchInput.fill("jersey");
  await expect.poll(() => visibleProductCount(page)).toBe(3);
  await expect(page.locator(".product-card", { hasText: "Legendary Home Jersey" })).toBeVisible();

  await searchInput.fill("");
  await expect.poll(() => visibleProductCount(page)).toBe(16);

  const filters = page.locator(".filter-wrap");

  await filters.getByRole("button", { name: "Footballs", exact: true }).click({ force: true });
  await expect.poll(() => visibleProductCount(page)).toBe(3);
  await expect(page.locator(".product-card", { hasText: "Premier Match Ball" })).toBeVisible();

  await filters.getByRole("button", { name: "All", exact: true }).click({ force: true });
  await expect.poll(() => visibleProductCount(page)).toBe(16);

  await page.locator(".all-products-section").screenshot({ path: path.join(screenshotDir, "products-page-desktop.png") });

  const firstProduct = page.locator(".product-card", { hasText: "Predator Elite FG" });
  await firstProduct.getByRole("button", { name: "Add to Cart" }).click();
  await expect(page.locator(".cart-count")).toHaveText("1");

  const wishlistButton = firstProduct.getByLabel("Add Predator Elite FG to wishlist");
  await wishlistButton.click();
  await expect(wishlistButton).toHaveClass(/is-active/);
  await expect(wishlistButton).toHaveText("♥");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/products.html");
  await expect(page.getByRole("heading", { name: "All Products", level: 1 })).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(16);
  await expect(page.getByRole("searchbox", { name: "Search Products" })).toBeVisible();

  const drawer = page.locator("#mobile-drawer");
  await page.locator(".menu-toggle").click();
  await expect(drawer).toHaveClass(/open/);
  await expect(drawer.locator(".mobile-drawer-nav").getByRole("link", { name: "Store", exact: true })).toHaveAttribute(
    "href",
    "products.html"
  );
  await page.keyboard.press("Escape");
  await expect(drawer).not.toHaveClass(/open/);

  await expectNoHorizontalOverflow(page);
  await page.locator(".all-products-section").screenshot({ path: path.join(screenshotDir, "products-page-mobile.png") });
});

test("football shoes nav opens dedicated category page with filters search cart wishlist and responsive layout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const desktopNav = page.locator(".main-nav");
  await desktopNav.getByRole("link", { name: "Football Shoes", exact: true }).click();
  await expect(page).toHaveURL(/football-shoes\.html$/);
  await expect(page.locator(".main-nav a.active")).toHaveText("Football Shoes");
  await expect(page.getByRole("heading", { name: "FOOTBALL SHOES", level: 1 })).toBeVisible();
  await expect(page.getByText("Explore elite football boots built for speed, control, grip, and match-winning performance.")).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(20);
  await expectNoHorizontalOverflow(page);
  await waitForImages(page.locator(".football-shoes-grid .product-card:nth-child(-n + 4) img"));
  await page.screenshot({ path: path.join(screenshotDir, "football-shoes-desktop.png"), fullPage: false });

  const searchInput = page.locator("#football-shoes-search");
  await searchInput.fill("laceless");
  await expect.poll(() => visibleProductCount(page)).toBe(1);
  await expect(page.locator(".product-card", { hasText: "Nitro Sprint Laceless" })).toBeVisible();

  await searchInput.fill("");
  await expect.poll(() => visibleProductCount(page)).toBe(20);

  const filters = page.locator(".filter-wrap");
  await filters.getByRole("button", { name: "Speed Boots", exact: true }).click({ force: true });
  await expect.poll(() => visibleProductCount(page)).toBe(4);
  await expect(page.locator(".product-card", { hasText: "Omega Blade Speed" })).toBeVisible();

  await filters.getByRole("button", { name: "All", exact: true }).click({ force: true });
  await expect.poll(() => visibleProductCount(page)).toBe(20);

  await page.getByLabel("Sort").selectOption("price-low");
  await expect(page.locator(".product-card h3").first()).toHaveText("Academy Trainer Pro");

  const firstProduct = page.locator(".product-card", { hasText: "Academy Trainer Pro" });
  await firstProduct.getByRole("button", { name: "Add to Cart" }).click();
  await expect(page.locator(".cart-count")).toHaveText("1");

  const wishlistButton = firstProduct.getByLabel("Add Academy Trainer Pro to wishlist");
  await wishlistButton.click();
  await expect(wishlistButton).toHaveClass(/is-active/);
  await expect(wishlistButton).toHaveText("♥");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/football-shoes.html");
  await expect(page.getByRole("heading", { name: "FOOTBALL SHOES", level: 1 })).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(20);
  await expect(page.locator("#football-shoes-search")).toBeVisible();

  const drawer = page.locator("#mobile-drawer");
  await page.locator(".menu-toggle").click();
  await expect(drawer).toHaveClass(/open/);
  await expect(drawer.locator(".mobile-drawer-nav").getByRole("link", { name: "Football Shoes", exact: true })).toHaveAttribute(
    "href",
    "football-shoes.html"
  );
  await page.keyboard.press("Escape");
  await expect(drawer).not.toHaveClass(/open/);

  await expectNoHorizontalOverflow(page);
  await page.locator(".football-shoes-section").screenshot({ path: path.join(screenshotDir, "football-shoes-mobile.png") });
});

test("jerseys nav opens dedicated category page with filters search cart wishlist and responsive layout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const desktopNav = page.locator(".main-nav");
  await desktopNav.getByRole("link", { name: "Jerseys", exact: true }).click();
  await expect(page).toHaveURL(/jerseys\.html$/);
  await expect(page.locator(".main-nav a.active")).toHaveText("Jerseys");
  await expect(page.getByRole("heading", { name: "FOOTBALL JERSEYS", level: 1 })).toBeVisible();
  await expect(page.getByText("Explore premium football jerseys built for match days, training sessions, and fan lifestyle.")).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(20);
  await expectNoHorizontalOverflow(page);
  await waitForImages(page.locator(".jerseys-grid .product-card:nth-child(-n + 8) img"));
  await page.screenshot({ path: path.join(screenshotDir, "jerseys-desktop.png"), fullPage: false });

  const searchInput = page.locator("#jerseys-search");
  await searchInput.fill("goalkeeper");
  await expect.poll(() => visibleProductCount(page)).toBe(1);
  await expect(page.locator(".product-card", { hasText: "Goalkeeper Command Jersey" })).toBeVisible();

  await searchInput.fill("");
  await expect.poll(() => visibleProductCount(page)).toBe(20);

  const filters = page.locator(".filter-wrap");
  await filters.getByRole("button", { name: "Away Jersey", exact: true }).click({ force: true });
  await expect.poll(() => visibleProductCount(page)).toBe(4);
  await expect(page.locator(".product-card", { hasText: "Carbon Away Jersey" })).toBeVisible();

  await filters.getByRole("button", { name: "All", exact: true }).click({ force: true });
  await expect.poll(() => visibleProductCount(page)).toBe(20);

  await page.getByLabel("Sort").selectOption("price-low");
  await expect(page.locator(".product-card h3").first()).toHaveText("Stadium Fan Jersey");

  const firstProduct = page.locator(".product-card", { hasText: "Stadium Fan Jersey" });
  await firstProduct.getByRole("button", { name: "Add to Cart" }).click();
  await expect(page.locator(".cart-count")).toHaveText("1");

  const wishlistButton = firstProduct.getByLabel("Add Stadium Fan Jersey to wishlist");
  await wishlistButton.click();
  await expect(wishlistButton).toHaveClass(/is-active/);
  await expect(wishlistButton).toHaveText("♥");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/jerseys.html");
  await expect(page.getByRole("heading", { name: "FOOTBALL JERSEYS", level: 1 })).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(20);
  await expect(page.locator("#jerseys-search")).toBeVisible();

  const drawer = page.locator("#mobile-drawer");
  await page.locator(".menu-toggle").click();
  await expect(drawer).toHaveClass(/open/);
  await expect(drawer.locator(".mobile-drawer-nav").getByRole("link", { name: "Jerseys", exact: true })).toHaveAttribute(
    "href",
    "jerseys.html"
  );
  await page.keyboard.press("Escape");
  await expect(drawer).not.toHaveClass(/open/);

  await expectNoHorizontalOverflow(page);
  await waitForImages(page.locator(".jerseys-grid .product-card:nth-child(-n + 2) img"));
  await page.locator(".jerseys-section").screenshot({ path: path.join(screenshotDir, "jerseys-mobile.png") });
});


test("footballs nav opens dedicated category page with filters search sort cart wishlist and responsive layout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const desktopNav = page.locator(".main-nav");
  await desktopNav.getByRole("link", { name: "Footballs", exact: true }).click();
  await expect(page).toHaveURL(/footballs\.html$/);
  await expect(page.locator(".main-nav a.active")).toHaveText("Footballs");
  await expect(page.getByRole("heading", { name: "PREMIUM FOOTBALLS", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "20 PREMIUM FOOTBALLS", level: 2 })).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(20);
  const footballImageSources = await page.locator(".footballs-grid .product-card img").evaluateAll((images) =>
    images.map((image) => image.getAttribute("src"))
  );
  expect(footballImageSources).toHaveLength(20);
  expect(new Set(footballImageSources).size).toBe(20);
  await expectNoHorizontalOverflow(page);
  await waitForImages(page.locator(".footballs-grid .product-card:nth-child(-n + 8) img"));
  await page.screenshot({ path: path.join(screenshotDir, "footballs-desktop.png"), fullPage: false });

  const searchInput = page.locator("#footballs-search");
  await searchInput.fill("blackout");
  await expect.poll(() => visibleProductCount(page)).toBe(1);
  await expect(page.locator(".product-card", { hasText: "Blackout Match Ball" })).toBeVisible();

  await searchInput.fill("");
  await expect.poll(() => visibleProductCount(page)).toBe(20);

  const filters = page.locator(".filter-wrap");
  await filters.getByRole("button", { name: "Street & Futsal", exact: true }).click({ force: true });
  await expect.poll(() => visibleProductCount(page)).toBe(4);
  await expect(page.locator(".product-card", { hasText: "Urban Futsal Ball" })).toBeVisible();

  await filters.getByRole("button", { name: "All", exact: true }).click({ force: true });
  await expect.poll(() => visibleProductCount(page)).toBe(20);

  await page.getByLabel("Sort").selectOption("price-low");
  await expect(page.locator(".product-card h3").first()).toHaveText("Training Lite Ball");

  const firstProduct = page.locator(".product-card", { hasText: "Training Lite Ball" });
  await firstProduct.getByRole("button", { name: "Add to Cart" }).click();
  await expect(page.locator(".cart-count")).toHaveText("1");

  const wishlistButton = firstProduct.getByLabel("Add Training Lite Ball to wishlist");
  await wishlistButton.click();
  await expect(wishlistButton).toHaveClass(/is-active/);
  await expect(wishlistButton).toHaveText("♥");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const drawer = page.locator("#mobile-drawer");
  await page.locator(".menu-toggle").click();
  await expect(drawer).toHaveClass(/open/);
  const drawerFootballsLink = drawer.locator(".mobile-drawer-nav").getByRole("link", { name: "Footballs", exact: true });
  await expect(drawerFootballsLink).toHaveAttribute("href", "footballs.html");
  await drawerFootballsLink.click();
  await expect(page).toHaveURL(/footballs\.html$/);
  await expect(page.getByRole("heading", { name: "PREMIUM FOOTBALLS", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "20 PREMIUM FOOTBALLS", level: 2 })).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(20);
  await expect(page.locator("#footballs-search")).toBeVisible();

  await expectNoHorizontalOverflow(page);
  await waitForImages(page.locator(".footballs-grid .product-card:nth-child(-n + 2) img"));
  await page.locator(".footballs-section").screenshot({ path: path.join(screenshotDir, "footballs-mobile.png") });
});


test("accessories nav opens dedicated category page with filters search sort cart wishlist and responsive layout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const desktopNav = page.locator(".main-nav");
  await desktopNav.getByRole("link", { name: "Accessories", exact: true }).click();
  await expect(page).toHaveURL(/accessories\.html$/);
  await expect(page.locator(".main-nav a.active")).toHaveText("Accessories");
  await expect(page.getByRole("heading", { name: "PREMIUM ACCESSORIES", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "20 PREMIUM ACCESSORIES", level: 2 })).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(20);
  const accessoryImageSources = await page.locator(".accessories-grid .product-card img").evaluateAll((images) =>
    images.map((image) => image.getAttribute("src"))
  );
  expect(accessoryImageSources).toHaveLength(20);
  expect(new Set(accessoryImageSources).size).toBe(20);
  await expectNoHorizontalOverflow(page);
  await waitForImages(page.locator(".accessories-grid .product-card:nth-child(-n + 8) img"));
  await page.screenshot({ path: path.join(screenshotDir, "accessories-desktop.png"), fullPage: false });

  const searchInput = page.locator("#accessories-search");
  await searchInput.fill("tactics");
  await expect.poll(() => visibleProductCount(page)).toBe(1);
  await expect(page.locator(".product-card", { hasText: "Coach Tactics Board" })).toBeVisible();

  await searchInput.fill("");
  await expect.poll(() => visibleProductCount(page)).toBe(20);

  const filters = page.locator(".filter-wrap");
  await filters.getByRole("button", { name: "Protection", exact: true }).click({ force: true });
  await expect.poll(() => visibleProductCount(page)).toBe(3);
  await expect(page.locator(".product-card", { hasText: "Carbon Shin Guards" })).toBeVisible();

  await filters.getByRole("button", { name: "All", exact: true }).click({ force: true });
  await expect.poll(() => visibleProductCount(page)).toBe(20);

  await page.getByLabel("Sort").selectOption("price-low");
  await expect(page.locator(".product-card h3").first()).toHaveText("Pro Sports Tape");

  const firstProduct = page.locator(".product-card", { hasText: "Pro Sports Tape" });
  await firstProduct.getByRole("button", { name: "Add to Cart" }).click();
  await expect(page.locator(".cart-count")).toHaveText("1");

  const wishlistButton = firstProduct.getByLabel("Add Pro Sports Tape to wishlist");
  await wishlistButton.click();
  await expect(wishlistButton).toHaveClass(/is-active/);
  await expect(wishlistButton).toHaveText("♥");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const drawer = page.locator("#mobile-drawer");
  await page.locator(".menu-toggle").click();
  await expect(drawer).toHaveClass(/open/);
  const drawerAccessoriesLink = drawer.locator(".mobile-drawer-nav").getByRole("link", { name: "Accessories", exact: true });
  await expect(drawerAccessoriesLink).toHaveAttribute("href", "accessories.html");
  await drawerAccessoriesLink.click();
  await expect(page).toHaveURL(/accessories\.html$/);
  await expect(page.getByRole("heading", { name: "PREMIUM ACCESSORIES", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "20 PREMIUM ACCESSORIES", level: 2 })).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(20);
  await expect(page.locator("#accessories-search")).toBeVisible();

  await expectNoHorizontalOverflow(page);
  await waitForImages(page.locator(".accessories-grid .product-card:nth-child(-n + 2) img"));
  await page.locator(".accessories-section").screenshot({ path: path.join(screenshotDir, "accessories-mobile.png") });
});

test("t-shirts nav opens dedicated category page with filters search sort cart wishlist and responsive layout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const desktopNav = page.locator(".main-nav");
  await desktopNav.getByRole("link", { name: "T-Shirts", exact: true }).click();
  await expect(page).toHaveURL(/t-shirts\.html$/);
  await expect(page.locator(".main-nav a.active")).toHaveText("T-Shirts");
  await expect(page.getByRole("heading", { name: "PREMIUM T-SHIRTS", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: /20 Premium T-Shirts/i, level: 2 })).toBeVisible();
  await expect(page.getByText("Explore premium football training tees, matchday t-shirts, and performance wear built for comfort and speed.")).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(20);
  await expectNoHorizontalOverflow(page);
  await waitForImages(page.locator(".tshirts-grid .product-card:nth-child(-n + 8) img"));
  await page.screenshot({ path: path.join(screenshotDir, "t-shirts-desktop.png"), fullPage: false });

  const searchInput = page.locator("#tshirts-search");
  await searchInput.fill("compression");
  await expect.poll(() => visibleProductCount(page)).toBe(3);
  await expect(page.locator(".product-card", { hasText: "Elite Compression Tee" })).toBeVisible();

  await searchInput.fill("");
  await expect.poll(() => visibleProductCount(page)).toBe(20);

  const filters = page.locator(".filter-wrap");
  await filters.getByRole("button", { name: "Lifestyle", exact: true }).click({ force: true });
  await expect.poll(() => visibleProductCount(page)).toBe(4);
  await expect(page.locator(".product-card", { hasText: "Premium Club Tee" })).toBeVisible();

  await filters.getByRole("button", { name: "All", exact: true }).click({ force: true });
  await expect.poll(() => visibleProductCount(page)).toBe(20);

  await page.getByLabel("Sort").selectOption("price-low");
  await expect(page.locator(".product-card h3").first()).toHaveText("Fan Edition Logo Tee");

  const firstProduct = page.locator(".product-card", { hasText: "Fan Edition Logo Tee" });
  await firstProduct.getByRole("button", { name: "Add to Cart" }).click();
  await expect(page.locator(".cart-count")).toHaveText("1");

  const wishlistButton = firstProduct.getByLabel("Add Fan Edition Logo Tee to wishlist");
  await wishlistButton.click();
  await expect(wishlistButton).toHaveClass(/is-active/);
  await expect(wishlistButton).toHaveText("♥");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const drawer = page.locator("#mobile-drawer");
  await page.locator(".menu-toggle").click();
  await expect(drawer).toHaveClass(/open/);
  const drawerTshirtsLink = drawer.locator(".mobile-drawer-nav").getByRole("link", { name: "T-Shirts", exact: true });
  await expect(drawerTshirtsLink).toHaveAttribute("href", "t-shirts.html");
  await drawerTshirtsLink.click();
  await expect(page).toHaveURL(/t-shirts\.html$/);
  await expect(page.getByRole("heading", { name: "PREMIUM T-SHIRTS", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: /20 Premium T-Shirts/i, level: 2 })).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(20);
  await expect(page.locator("#tshirts-search")).toBeVisible();

  await expectNoHorizontalOverflow(page);
  await waitForImages(page.locator(".tshirts-grid .product-card:nth-child(-n + 2) img"));
  await page.locator(".tshirts-section").screenshot({ path: path.join(screenshotDir, "t-shirts-mobile.png") });
});

test("Supabase user IDs isolate carts and wishlists while switching accounts", async ({ page }) => {
  const usersByEmail = {
    "user-a@example.com": {
      id: "user-a-id",
      email: "user-a@example.com",
      user_metadata: { full_name: "User A", phone: "+91 90000 00001" },
    },
    "user-b@example.com": {
      id: "user-b-id",
      email: "user-b@example.com",
      user_metadata: { full_name: "User B", phone: "+91 90000 00002" },
    },
  };
  await installSupabaseStub(page, { user: null, usersByEmail });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await loginAs(page, "user-a@example.com");
  const productA = page.locator(".product-card").nth(0);
  await productA.getByRole("button", { name: "Add to Cart" }).click();
  await productA.locator(".wish").click();
  await expect(page.locator(".cart-count")).toHaveText("1");
  await expect(page.locator(".wishlist-count").first()).toHaveText("1");

  await logoutCurrentUser(page);
  await expect(page.locator(".cart-count")).toHaveText("0");
  await expect(page.locator(".wishlist-count").first()).toHaveText("0");

  await loginAs(page, "user-b@example.com");
  await expect(page.locator(".cart-count")).toHaveText("0");
  await expect(page.locator(".wishlist-count").first()).toHaveText("0");
  const productB = page.locator(".product-card").nth(1);
  await productB.getByRole("button", { name: "Add to Cart" }).click();
  await productB.locator(".wish").click();
  await logoutCurrentUser(page);

  await loginAs(page, "user-a@example.com");
  await expect(page.locator(".cart-count")).toHaveText("1");
  await expect(page.locator(".wishlist-count").first()).toHaveText("1");
  await page.locator(".cart-button").click();
  await expect(page.locator(".cart-items")).toContainText("Predator Elite FG");
  await expect(page.locator(".cart-items")).not.toContainText("Phantom Control Pro");
  await page.locator(".cart-drawer [data-close-cart]").click();
  await page.locator('.header-actions button[aria-label="Wishlist"]').click();
  await expect(page.locator(".wishlist-items")).toContainText("Predator Elite FG");
  await expect(page.locator(".wishlist-items")).not.toContainText("Phantom Control Pro");

  const stored = await page.evaluate(() => ({
    userA: window.__attractionSupabaseTestState.cloudCarts["user-a-id"] || [],
    userB: window.__attractionSupabaseTestState.cloudCarts["user-b-id"] || [],
    wishA: window.__attractionSupabaseTestState.cloudWishlists["user-a-id"] || [],
    wishB: window.__attractionSupabaseTestState.cloudWishlists["user-b-id"] || [],
    localUserCart: localStorage.getItem("attractionCart:user-a-id"),
    localUserWishlist: localStorage.getItem("attractionWishlist:user-a-id"),
  }));
  expect(stored.userA.map((item) => item.product_id)).toEqual(["predator-elite-fg"]);
  expect(stored.userB.map((item) => item.product_id)).toEqual(["phantom-control-pro"]);
  expect(stored.wishA).toEqual(["predator-elite-fg"]);
  expect(stored.wishB).toEqual(["phantom-control-pro"]);
  expect(stored.localUserCart).toBeNull();
  expect(stored.localUserWishlist).toBeNull();
});

test("guest cart and wishlist merge once into the logged-in user with capped quantities", async ({ page }) => {
  const userA = {
    id: "merge-user-a",
    email: "merge-a@example.com",
    user_metadata: { full_name: "Merge User", phone: "+91 90000 00003" },
  };
  await installSupabaseStub(page, { user: null, usersByEmail: { "merge-a@example.com": userA } });
  await page.evaluate(() => {
    const product = {
      id: "predator-elite-fg",
      name: "Predator Elite FG",
      category: "Football Shoes",
      price: 219.99,
      image: "assets/shoe-retro-leather.avif",
    };
    localStorage.setItem("attractionCart:guest", JSON.stringify([{ ...product, qty: 5 }]));
    localStorage.setItem("attractionCart:merge-user-a", JSON.stringify([{ ...product, qty: 19 }]));
    localStorage.setItem("attractionWishlist:guest", JSON.stringify([product]));
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".cart-count")).toHaveText("5");

  await loginAs(page, "merge-a@example.com");
  await expect(page.locator(".cart-count")).toHaveText("20");
  await expect(page.locator(".wishlist-count").first()).toHaveText("1");
  expect(await page.evaluate(() => localStorage.getItem("attractionCart:guest"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("attractionWishlist:guest"))).toBeNull();

  await logoutCurrentUser(page);
  await expect(page.locator(".cart-count")).toHaveText("0");
  await expect(page.locator(".wishlist-count").first()).toHaveText("0");
  await loginAs(page, "merge-a@example.com");
  await expect(page.locator(".cart-count")).toHaveText("20");
  const userCart = await page.evaluate(() => window.__attractionSupabaseTestState.cloudCarts["merge-user-a"] || []);
  expect(userCart).toHaveLength(1);
  expect(userCart[0].quantity).toBe(20);
  expect(await page.evaluate(() => localStorage.getItem("attractionCart:merge-user-a"))).toBeNull();
});

test("legacy shared cart and wishlist migrate once to the resolved guest owner", async ({ page }) => {
  await installSupabaseStub(page, { user: null });
  await page.evaluate(() => {
    const product = {
      id: "predator-elite-fg",
      name: "Predator Elite FG",
      category: "Football Shoes",
      price: 219.99,
      image: "assets/shoe-retro-leather.avif",
      qty: 2,
    };
    localStorage.setItem("attraction_cart_v1", JSON.stringify([product]));
    localStorage.setItem("attraction_wishlist_v1", JSON.stringify([product]));
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.locator(".cart-count")).toHaveText("2");
  await expect(page.locator(".wishlist-count").first()).toHaveText("1");
  const migration = await page.evaluate(() => ({
    oldCart: localStorage.getItem("attraction_cart_v1"),
    oldWishlist: localStorage.getItem("attraction_wishlist_v1"),
    guestCart: JSON.parse(localStorage.getItem("attractionCart:guest") || "[]"),
    guestWishlist: JSON.parse(localStorage.getItem("attractionWishlist:guest") || "[]"),
  }));
  expect(migration.oldCart).toBeNull();
  expect(migration.oldWishlist).toBeNull();
  expect(migration.guestCart[0].qty).toBe(2);
  expect(migration.guestWishlist).toHaveLength(1);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".cart-count")).toHaveText("2");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("attractionCart:guest") || "[]"))).toHaveLength(1);
});

test("legacy shared cart and wishlist migrate once to the resolved authenticated owner", async ({ page }) => {
  const user = {
    id: "legacy-user-a",
    email: "legacy@example.com",
    user_metadata: { full_name: "Legacy User", phone: "+91 90000 00005" },
  };
  await installSupabaseStub(page, { user });
  await page.evaluate(() => {
    const product = {
      id: "predator-elite-fg",
      name: "Predator Elite FG",
      category: "Football Shoes",
      price: 219.99,
      image: "assets/shoe-retro-leather.avif",
      qty: 3,
    };
    localStorage.setItem("attraction_cart_v1", JSON.stringify([product]));
    localStorage.setItem("attraction_wishlist_v1", JSON.stringify([product]));
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.locator(".cart-count")).toHaveText("3");
  await expect(page.locator(".wishlist-count").first()).toHaveText("1");
  const migration = await page.evaluate(() => ({
    oldCart: localStorage.getItem("attraction_cart_v1"),
    oldWishlist: localStorage.getItem("attraction_wishlist_v1"),
    userCart: window.__attractionSupabaseTestState.cloudCarts["legacy-user-a"] || [],
    userWishlist: window.__attractionSupabaseTestState.cloudWishlists["legacy-user-a"] || [],
    localUserCart: localStorage.getItem("attractionCart:legacy-user-a"),
    localUserWishlist: localStorage.getItem("attractionWishlist:legacy-user-a"),
    guestCart: localStorage.getItem("attractionCart:guest"),
  }));
  expect(migration.oldCart).toBeNull();
  expect(migration.oldWishlist).toBeNull();
  expect(migration.userCart[0].quantity).toBe(3);
  expect(migration.userWishlist).toHaveLength(1);
  expect(migration.localUserCart).toBeNull();
  expect(migration.localUserWishlist).toBeNull();
  expect(migration.guestCart).toBeNull();
});

test("cart stays empty until the authenticated session owner is resolved", async ({ page }) => {
  const userA = {
    id: "delayed-user-a",
    email: "delayed@example.com",
    user_metadata: { full_name: "Delayed User", phone: "+91 90000 00004" },
  };
  await installSupabaseStub(page, { user: userA, sessionDelay: 250 });
  await page.evaluate(() => {
    const base = {
      name: "Stored Product",
      category: "Football Shoes",
      price: 100,
      image: "",
    };
    localStorage.setItem("attractionCart:delayed-user-a", JSON.stringify([{ ...base, id: "user-a-product", qty: 1 }]));
    localStorage.setItem("attractionCart:other-user", JSON.stringify([{ ...base, id: "wrong-product", qty: 7 }]));
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.locator(".cart-count")).toHaveText("0");
  await page.waitForTimeout(80);
  await expect(page.locator(".cart-count")).toHaveText("0");
  await expect(page.locator(".cart-count")).toHaveText("1", { timeout: 1500 });
});

test("same authenticated user sees cloud cart and wishlist changes across browser contexts", async ({ browser, baseURL }) => {
  const cloud = createSharedCloudState();
  const user = {
    id: "cross-device-user",
    email: "cross-device@example.com",
    user_metadata: { full_name: "Cross Device User", phone: "+91 90000 00006" },
  };
  const contextOptions = {
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  };
  const contextA = await browser.newContext(contextOptions);
  const contextB = await browser.newContext(contextOptions);

  try {
    const pageA = await contextA.newPage();
    await installSharedCloudSupabaseStub(pageA, cloud, user);
    await pageA.goto("/", { waitUntil: "domcontentloaded" });
    await pageA.locator(".product-card").first().getByRole("button", { name: "Add to Cart" }).click();
    await pageA.locator(".product-card").first().locator(".wish").click();
    await expect(pageA.locator(".cart-count")).toHaveText("1");
    await expect(pageA.locator(".wishlist-count").first()).toHaveText("1");

    const pageB = await contextB.newPage();
    await installSharedCloudSupabaseStub(pageB, cloud, user);
    await pageB.goto("/", { waitUntil: "domcontentloaded" });
    await expect(pageB.locator(".cart-count")).toHaveText("1");
    await expect(pageB.locator(".wishlist-count").first()).toHaveText("1");

    await pageB.locator(".cart-button").click();
    await pageB.locator('[data-cart-change="1"]').click();
    await expect(pageB.locator(".cart-count")).toHaveText("2");

    await pageA.reload({ waitUntil: "domcontentloaded" });
    await expect(pageA.locator(".cart-count")).toHaveText("2");
    await expect(pageA.locator(".wishlist-count").first()).toHaveText("1");
    expect(cloud.carts.get(user.id)).toEqual([{ product_id: "predator-elite-fg", quantity: 2 }]);
    expect(cloud.wishlists.get(user.id)).toEqual(["predator-elite-fg"]);

    const localStorageState = await Promise.all([pageA, pageB].map((target) => target.evaluate((userId) => ({
      cart: localStorage.getItem(`attractionCart:${userId}`),
      wishlist: localStorage.getItem(`attractionWishlist:${userId}`),
    }), user.id)));
    expect(localStorageState).toEqual([
      { cart: null, wishlist: null },
      { cart: null, wishlist: null },
    ]);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("failed cloud cart mutation preserves the visible cart", async ({ page }) => {
  const user = {
    id: "cart-failure-user",
    email: "cart-failure@example.com",
    user_metadata: { full_name: "Cart Failure User" },
  };
  await installSupabaseStub(page, {
    user,
    failCartRpc: "set_cart_item",
    cloudCarts: {
      [user.id]: [{ product_id: "predator-elite-fg", quantity: 1 }],
    },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".cart-count")).toHaveText("1");

  await page.locator(".product-card").first().getByRole("button", { name: "Add to Cart" }).click();
  await expect(page.locator(".toast")).toContainText("We could not sync your cart");
  await expect(page.locator(".cart-count")).toHaveText("1");
  const cloudCart = await page.evaluate(() => window.__attractionSupabaseTestState.cloudCarts["cart-failure-user"]);
  expect(cloudCart).toEqual([{ product_id: "predator-elite-fg", quantity: 1 }]);
});

test("guest cart migration reuses its token after failure and merges once", async ({ page }) => {
  const user = {
    id: "migration-retry-user",
    email: "migration-retry@example.com",
    user_metadata: { full_name: "Migration Retry User" },
  };
  await installSupabaseStub(page, {
    user: null,
    usersByEmail: { [user.email]: user },
    failCartMergeAttempts: 1,
  });
  await page.evaluate(() => {
    localStorage.setItem("attractionCart:guest", JSON.stringify([{
      id: "predator-elite-fg",
      name: "Predator Elite FG",
      category: "Football Shoes",
      price: 219.99,
      image: "assets/shoe-retro-leather.avif",
      qty: 2,
    }]));
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await loginAs(page, user.email);
  await expect(page.locator(".cart-count")).toHaveText("0");
  const firstToken = await page.evaluate(() => JSON.parse(
    localStorage.getItem("attractionCartMergeToken:migration-retry-user:guest")
  ));
  expect(firstToken).toMatch(/^[0-9a-f-]{36}$/i);
  expect(await page.evaluate(() => localStorage.getItem("attractionCart:guest"))).not.toBeNull();

  await logoutCurrentUser(page);
  await expect(page.locator(".cart-count")).toHaveText("2");
  await loginAs(page, user.email);
  await expect(page.locator(".cart-count")).toHaveText("2");

  const result = await page.evaluate(() => ({
    calls: window.__attractionSupabaseTestState.rpcs.filter((call) => call.name === "merge_guest_cart"),
    cloudCart: window.__attractionSupabaseTestState.cloudCarts["migration-retry-user"],
    guestCart: localStorage.getItem("attractionCart:guest"),
    token: localStorage.getItem("attractionCartMergeToken:migration-retry-user:guest"),
  }));
  expect(result.calls).toHaveLength(2);
  expect(result.calls[0].payload.p_merge_token).toBe(firstToken);
  expect(result.calls[1].payload.p_merge_token).toBe(firstToken);
  expect(result.cloudCart).toEqual([{ product_id: "predator-elite-fg", quantity: 2 }]);
  expect(result.guestCart).toBeNull();
  expect(result.token).toBeNull();
});

test("logout replaces authenticated cloud collections with guest-only storage", async ({ page }) => {
  const user = {
    id: "logout-owner-user",
    email: "logout-owner@example.com",
    user_metadata: { full_name: "Logout Owner" },
  };
  await installSupabaseStub(page, {
    user,
    cloudCarts: {
      [user.id]: [{ product_id: "predator-elite-fg", quantity: 1 }],
    },
    cloudWishlists: {
      [user.id]: ["predator-elite-fg"],
    },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".cart-count")).toHaveText("1");
  await expect(page.locator(".wishlist-count").first()).toHaveText("1");
  await page.evaluate(() => {
    const guest = {
      id: "phantom-control-pro",
      name: "Phantom Control Pro",
      category: "Football Shoes",
      price: 199.99,
      image: "assets/shoe-honeycomb-control.avif",
    };
    localStorage.setItem("attractionCart:guest", JSON.stringify([{ ...guest, qty: 3 }]));
    localStorage.setItem("attractionWishlist:guest", JSON.stringify([guest]));
  });

  await logoutCurrentUser(page);
  await expect(page.locator(".cart-count")).toHaveText("3");
  await expect(page.locator(".wishlist-count").first()).toHaveText("1");
  await page.locator(".cart-button").click();
  await expect(page.locator(".cart-items")).toContainText("Phantom Control Pro");
  await expect(page.locator(".cart-items")).not.toContainText("Predator Elite FG");
  expect(await page.evaluate(() => window.__attractionSupabaseTestState.cloudCarts["logout-owner-user"])).toEqual([
    { product_id: "predator-elite-fg", quantity: 1 },
  ]);
});

test("checkout requires login before placing an order", async ({ page }) => {
  await installSupabaseStub(page, { user: null });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await openCheckoutWithProduct(page);

  const loginModal = page.locator(".login-modal");
  await expect(loginModal).toHaveClass(/is-open/);
  await expect(loginModal.getByRole("heading", { name: "Login", exact: true })).toBeVisible();
  await expect(page.locator(".cart-count")).toHaveText("1");
});

test("checkout is a fixed responsive modal above page content", async ({ page }) => {
  await installSupabaseStub(page, {
    user: {
      id: "user-modal-1",
      email: "buyer@example.com",
      user_metadata: { full_name: "Modal Buyer", phone: "+91 98765 43210" },
    },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openCheckoutWithProduct(page);

  const modal = page.locator(".checkout-modal");
  const panel = page.locator(".checkout-modal__box");
  await expect(modal).toHaveClass(/is-open/);
  const desktopState = await modal.evaluate((element) => {
    const styles = getComputedStyle(element);
    const panelElement = element.querySelector(".checkout-modal__box");
    const panelStyles = getComputedStyle(panelElement);
    const textareaStyles = getComputedStyle(element.querySelector("textarea"));
    return {
      directBodyChild: element.parentElement === document.body,
      position: styles.position,
      zIndex: Number(styles.zIndex),
      panelOverflowY: panelStyles.overflowY,
      textareaBackground: textareaStyles.backgroundColor,
      bodyLocked: document.body.classList.contains("no-scroll"),
    };
  });
  expect(desktopState).toMatchObject({
    directBodyChild: true,
    position: "fixed",
    panelOverflowY: "auto",
    bodyLocked: true,
  });
  expect(desktopState.zIndex).toBeGreaterThan(1200);
  expect(desktopState.textareaBackground).not.toBe("rgb(255, 255, 255)");

  await panel.click({ position: { x: 20, y: 20 } });
  await expect(modal).toHaveClass(/is-open/);
  await page.keyboard.press("Escape");
  await expect(modal).not.toHaveClass(/is-open/);
  await expect.poll(() => page.evaluate(() => document.body.classList.contains("no-scroll"))).toBe(false);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".cart-button").click();
  await page.locator(".cart-drawer").getByRole("button", { name: "Checkout" }).click();
  await expect(modal).toHaveClass(/is-open/);
  const panelBox = await panel.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(390);
  expect(panelBox.y).toBeGreaterThanOrEqual(0);
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(844);
  await fillCheckoutDelivery(page);
  await reviewCashOnDeliveryOrder(page);
  await expect(modal.locator("[data-checkout-confirmation]")).toBeVisible();
  await expect(modal.getByRole("button", { name: "Confirm Cash on Delivery Order" })).toBeDisabled();
  await expectNoHorizontalOverflow(page);
});

test("checkout validates required fields before order insert", async ({ page }) => {
  await installSupabaseStub(page, {
    user: { id: "user-checkout-1", email: "buyer@example.com", user_metadata: { full_name: "Buyer One" } },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await openCheckoutWithProduct(page);

  const modal = page.locator(".checkout-modal");
  await expect(modal).toHaveClass(/is-open/);
  await modal.getByRole("button", { name: "Review Cash on Delivery Order" }).click();
  await expect(modal.getByText("Please complete all required checkout fields.")).toBeVisible();

  const placeOrderCalls = await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderCalls.length);
  expect(placeOrderCalls).toBe(0);
});

test("checkout uses place_order RPC with server-authoritative fields and total", async ({ page }) => {
  await installSupabaseStub(page, {
    orderId: "order-test-123",
    serverTotal: 487.65,
    user: {
      id: "user-checkout-2",
      email: "buyer@example.com",
      user_metadata: { full_name: "Buyer Two", phone: "+91 98765 43210" },
    },
    cloudCarts: {
      "unrelated-cloud-user": [{ product_id: "phantom-control-pro", quantity: 3 }],
    },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("attractionCart:unrelated-user", JSON.stringify([{
      id: "other-user-product",
      name: "Other User Product",
      category: "Footballs",
      price: 59.99,
      image: "",
      qty: 3,
    }]));
  });

  await openCheckoutWithProduct(page);

  await expect(page.locator("#checkout-email")).toHaveValue("buyer@example.com");
  await expect(page.locator("#checkout-email")).toHaveAttribute("readonly", "");
  await fillCheckoutDelivery(page, { note: "Call before delivery" });
  const modal = await reviewCashOnDeliveryOrder(page);
  await expect(modal.locator("[data-cod-payment-option]")).toContainText("Cash on Delivery");
  await expect(modal.locator("[data-cod-confirmation-items]")).toContainText("Predator Elite FG");
  await expect(modal.locator("[data-cod-confirmation-items]")).toContainText("Quantity: 1");
  await expect(modal.locator("[data-cod-confirmation-address]")).toHaveText("42 Football Street, Kolkata, West Bengal, 700001");
  await expect(modal.locator("[data-cod-confirmation-phone]")).toHaveText("+91 98765 43210");
  await expect(modal.locator("[data-cod-confirmation-total]")).toHaveText("$219.99");
  await expect(modal.locator("[data-cod-payment-message]")).toHaveText("You will pay $219.99 when the order is delivered.");
  const finalButton = modal.getByRole("button", { name: "Confirm Cash on Delivery Order" });
  await expect(finalButton).toBeDisabled();
  expect(await modal.locator('input[name*="card" i], input[name*="upi" i], input[name*="cvv" i], input[name*="expiry" i]').count()).toBe(0);
  expect(await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderCalls.length)).toBe(0);
  await confirmCashOnDeliveryOrder(page);

  await expect(modal.getByText("Cash on Delivery order placed successfully.")).toBeVisible();
  await expect(modal.locator("[data-cod-success-order-id]")).toHaveText("order-test-123");
  await expect(modal.locator("[data-cod-success-total]")).toHaveText("$487.65");
  await expect(modal.locator("[data-cod-success-payment-method]")).toHaveText("Cash on Delivery");
  await expect(modal.locator("[data-cod-success-payment-status]")).toHaveText("Unpaid");
  await expect(modal).toContainText("Please keep the order amount ready when your order is delivered.");
  await expect(page.locator(".cart-count")).toHaveText("0");

  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.placeOrderCalls).toHaveLength(1);
  const payload = state.placeOrderCalls[0];
  expect(Object.keys(payload).sort()).toEqual([
    "p_address",
    "p_checkout_token",
    "p_city",
    "p_customer_name",
    "p_customer_phone",
    "p_items",
    "p_note",
    "p_pin_code",
    "p_state",
  ]);
  expect(payload.p_items).toEqual([{ product_id: "predator-elite-fg", quantity: 1 }]);
  expect(payload.p_checkout_token).toMatch(/^[0-9a-f-]{36}$/i);
  expect(payload).not.toHaveProperty("customer_email");
  expect(payload).not.toHaveProperty("user_id");
  expect(payload).not.toHaveProperty("status");
  expect(payload).not.toHaveProperty("total_amount");
  expect(payload).not.toHaveProperty("payment_method");
  expect(payload).not.toHaveProperty("payment_status");
  expect(payload).not.toHaveProperty("payment_collected_at");
  expect(payload.p_items[0]).not.toHaveProperty("product_price");
  expect(payload.p_items[0]).not.toHaveProperty("product_name");
  expect(payload.p_items[0]).not.toHaveProperty("product_category");
  expect(payload.p_items[0]).not.toHaveProperty("product_image");
  expect(state.inserts).toEqual([]);
  expect(await page.evaluate(() => window.__attractionSupabaseTestState.cloudCarts["user-checkout-2"] || [])).toEqual([]);
  expect(await page.evaluate(() => window.__attractionSupabaseTestState.cloudCarts["unrelated-cloud-user"] || [])).toEqual([
    { product_id: "phantom-control-pro", quantity: 3 },
  ]);
  expect(await page.evaluate(() => localStorage.getItem("attractionCart:user-checkout-2"))).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("attractionCart:unrelated-user") || "[]"))).toHaveLength(1);
});

test("failed order creation keeps cart contents", async ({ page }) => {
  await installSupabaseStub(page, {
    failPlaceOrder: "relation public.orders leaked internal database detail",
    user: {
      id: "user-checkout-3",
      email: "buyer@example.com",
      user_metadata: { full_name: "Buyer Three", phone: "+91 98765 43210" },
    },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await openCheckoutWithProduct(page);

  await fillCheckoutDelivery(page, {
    address: "21 Neon Road",
    city: "Mumbai",
    state: "Maharashtra",
    pin: "400001",
  });
  await reviewCashOnDeliveryOrder(page);
  await confirmCashOnDeliveryOrder(page);

  await expect(page.locator(".checkout-modal").getByText("We could not place your order. Please try again.")).toBeVisible();
  await expect(page.locator(".checkout-modal")).not.toContainText("public.orders");
  await expect(page.locator(".cart-count")).toHaveText("1");
  expect(await page.evaluate(() => (window.__attractionSupabaseTestState.cloudCarts["user-checkout-3"] || []).length)).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("attractionCart:user-checkout-3"))).toBeNull();
});

test("checkout safely reports unavailable products and keeps the cart", async ({ page }) => {
  await installSupabaseStub(page, {
    failPlaceOrder: "One or more products are unavailable. SQL detail must stay private.",
    user: {
      id: "user-checkout-4",
      email: "buyer@example.com",
      user_metadata: { full_name: "Buyer Four", phone: "+91 98765 43210" },
    },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openCheckoutWithProduct(page);
  await fillCheckoutDelivery(page);
  await reviewCashOnDeliveryOrder(page);
  await confirmCashOnDeliveryOrder(page);

  await expect(page.locator(".checkout-modal").getByText("One or more products are unavailable.")).toBeVisible();
  await expect(page.locator(".checkout-modal")).not.toContainText("SQL detail");
  await expect(page.locator(".cart-count")).toHaveText("1");
});

test("checkout reuses its token when a failed submission is retried", async ({ page }) => {
  await installSupabaseStub(page, {
    failPlaceOrder: "Temporary database failure",
    failPlaceOrderAttempts: 1,
    orderId: "order-retry-001",
    serverTotal: 219.99,
    user: {
      id: "user-checkout-5",
      email: "buyer@example.com",
      user_metadata: { full_name: "Buyer Five", phone: "+91 98765 43210" },
    },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openCheckoutWithProduct(page);
  await fillCheckoutDelivery(page);

  const modal = await reviewCashOnDeliveryOrder(page);
  const placeOrder = modal.getByRole("button", { name: "Confirm Cash on Delivery Order" });
  await modal.locator("[data-cod-confirm-checkbox]").check();
  await placeOrder.click();
  await expect(page.locator(".checkout-modal").getByText("We could not place your order. Please try again.")).toBeVisible();
  await expect(placeOrder).toBeEnabled();
  await placeOrder.click();
  await expect(page.locator("[data-cod-success-order-id]")).toHaveText("order-retry-001");

  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderCalls);
  expect(calls).toHaveLength(2);
  expect(calls[1].p_checkout_token).toBe(calls[0].p_checkout_token);
});

test("checkout blocks rapid duplicate submissions", async ({ page }) => {
  await installSupabaseStub(page, {
    placeOrderDelay: 150,
    orderId: "order-single-001",
    user: {
      id: "user-checkout-6",
      email: "buyer@example.com",
      user_metadata: { full_name: "Buyer Six", phone: "+91 98765 43210" },
    },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openCheckoutWithProduct(page);
  await fillCheckoutDelivery(page);
  await reviewCashOnDeliveryOrder(page);
  await page.locator("[data-cod-confirm-checkbox]").check();

  await page.locator("[data-checkout-form]").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  await expect(page.locator("[data-cod-success-order-id]")).toHaveText("order-single-001");
  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.placeOrderCalls);
  expect(calls).toHaveLength(1);
});

test("admin page denies non-admin users before showing order data", async ({ page }) => {
  await installSupabaseStub(page, {
    isAdmin: false,
    user: { id: "user-not-admin", email: "player@example.com", user_metadata: { full_name: "Player" } },
    orders: [
      {
        id: "hidden-order",
        customer_name: "Hidden Customer",
        order_items: [],
      },
    ],
  });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Access denied", exact: true })).toBeVisible();
  await expect(page.getByText("Hidden Customer")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("admin dashboard renders orders and updates order status", async ({ page }) => {
  await installSupabaseStub(page, {
    isAdmin: true,
    user: { id: "admin-user", email: "ag203328@gmail.com", user_metadata: { full_name: "Admin" } },
    orders: [
      {
        id: "order-admin-001",
        created_at: "2026-07-11T10:30:00.000Z",
        customer_name: "Ravi Customer",
        customer_email: "ravi@example.com",
        customer_phone: "+91 90000 11111",
        address: "11 Match Street",
        city: "Delhi",
        state: "Delhi",
        pin_code: "110001",
        note: "Leave at reception",
        total_amount: 4299,
        status: "Pending",
        payment_method: "COD",
        payment_status: "Unpaid",
        payment_collected_at: null,
        inventory_deducted_at: "2026-07-11T10:31:00.000Z",
        inventory_restored_at: null,
        order_items: [
          {
            product_image: "assets/hero-football-boot.avif",
            product_name: "Predator Elite FG",
            product_category: "Football Shoes",
            product_variant_id: "00000000-0000-4000-8000-000000000888",
            variant_label: "UK 8",
            variant_sku: "ATF-PREDATOR-ELITE-FG-UK8",
            product_price: 4299,
            quantity: 1,
          },
        ],
      },
    ],
  });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Customer Orders" })).toBeVisible();
  await expect(page.getByText("Ravi Customer")).toBeVisible();
  await expect(page.getByText("Predator Elite FG")).toBeVisible();
  await expect(page.getByText("Size: UK 8")).toBeVisible();
  await expect(page.getByText("SKU: ATF-PREDATOR-ELITE-FG-UK8")).toBeVisible();
  await expect(page.getByText("Inventory Deducted:")).toBeVisible();
  await expect(page.getByText("Inventory Restored:")).toHaveCount(0);
  await expect(page.getByText(/4299\.00/).first()).toBeVisible();
  await expect(page.getByText("Payment Method:")).toBeVisible();
  await expect(page.locator("[data-admin-current-payment-status]")).toHaveText("Unpaid");

  await page.locator("[data-admin-status]").selectOption("Shipped");
  await page.getByRole("button", { name: "Save Status" }).click();
  await expect(page.getByText("Order order-admin-001 status updated to Shipped.")).toBeVisible();
  await expect(page.locator("[data-admin-current-status]")).toHaveText("Shipped");

  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.statusUpdateCalls).toEqual([{
    p_order_id: "order-admin-001",
    p_new_status: "Shipped",
  }]);

  await page.locator("[data-admin-payment-status]").selectOption("Paid");
  await page.getByRole("button", { name: "Save Payment" }).click();
  await expect(page.getByText("Order order-admin-001 payment status updated to Paid.")).toBeVisible();
  await expect(page.locator("[data-admin-current-payment-status]")).toHaveText("Paid");
  await expect(page.locator("[data-admin-payment-collected]")).toBeVisible();

  const updatedState = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(updatedState.paymentStatusUpdateCalls).toEqual([{
    p_order_id: "order-admin-001",
    p_payment_status: "Paid",
  }]);
  expect(state.updates).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
});

test("admin inventory stays hidden until authorization and is unavailable to non-admin users", async ({ page }) => {
  const fixtures = createAdminInventoryFixtures();
  await installSupabaseStub(page, {
    isAdmin: false,
    sessionDelay: 150,
    user: { id: "inventory-non-admin", email: "player@example.com", user_metadata: { full_name: "Player" } },
    ...fixtures,
  });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Checking admin access..." })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Inventory" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Access denied", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Inventory" })).toBeHidden();

  const selectedTables = await page.evaluate(() => window.__attractionSupabaseTestState.selects.map((entry) => entry.table));
  expect(selectedTables).not.toContain("product_variants");
  expect(selectedTables).not.toContain("inventory_movements");
});

test("admin account switching synchronously removes the previous inventory and ignores stale reads", async ({ page }) => {
  const fixtures = createAdminInventoryFixtures();
  const userA = { id: "inventory-admin-a", email: "admin-a@example.com" };
  const userB = { id: "inventory-admin-b", email: "admin-b@example.com" };
  const userARow = structuredClone(fixtures.inventoryVariants[0]);
  userARow.products.name = "User A Private Inventory";
  const userBRow = structuredClone(fixtures.inventoryVariants[4]);
  userBRow.products.name = "User B Authorized Inventory";
  await installSupabaseStub(page, {
    user: userA,
    adminByUserId: { [userA.id]: true, [userB.id]: true },
    collectionLoadDelay: 150,
    inventoryVariantsByUser: { [userA.id]: [userARow], [userB.id]: [userBRow] },
    inventoryMovements: [],
  });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Inventory" }).click();
  const mobileInventory = page.locator("[data-inventory-mobile-list]");
  await expect(mobileInventory.getByText("User A Private Inventory")).toBeVisible();
  await mobileInventory.locator('[data-inventory-row] [data-inventory-adjust]').first().click();
  await expect(page.locator("[data-inventory-adjust-modal]")).toBeVisible();

  await page.evaluate(({ nextUser }) => {
    window.__attractionSupabaseTestState.inventoryLoadDelayByUser["inventory-admin-a"] = 250;
    document.querySelector("[data-inventory-refresh]").click();
    window.__setAttractionTestUser(nextUser, "SIGNED_IN");
  }, { nextUser: userB });

  await expect(page.getByRole("heading", { name: "Checking admin access..." })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Inventory" })).toBeHidden();
  await expect(page.locator("[data-inventory-table-body] tr")).toHaveCount(0);
  await expect(page.getByText("User A Private Inventory")).toHaveCount(0);
  await expect(page.locator("[data-inventory-adjust-modal]")).toBeHidden();

  await expect(page.getByRole("tab", { name: "Inventory" })).toBeVisible();
  await page.getByRole("tab", { name: "Inventory" }).click();
  await expect(mobileInventory.getByText("User B Authorized Inventory")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByText("User A Private Inventory")).toHaveCount(0);
});

test("admin inventory calculates metrics and supports search filters sorting activity and mobile cards", async ({ page }) => {
  const fixtures = createAdminInventoryFixtures();
  await installSupabaseStub(page, {
    isAdmin: true,
    user: { id: "inventory-admin", email: "admin@example.com", user_metadata: { full_name: "Inventory Admin" } },
    ...fixtures,
  });
  await page.setViewportSize({ width: 1391, height: 871 });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Inventory" }).click();

  await expect(page.getByRole("heading", { name: "Inventory Management" })).toBeVisible();
  await expect(page.locator('[data-inventory-metric="products"]')).toHaveText("3");
  await expect(page.locator('[data-inventory-metric="variants"]')).toHaveText("5");
  await expect(page.locator('[data-inventory-metric="stock"]')).toHaveText("31");
  await expect(page.locator('[data-inventory-metric="low"]')).toHaveText("1");
  await expect(page.locator('[data-inventory-metric="out"]')).toHaveText("1");
  await expect(page.locator('[data-inventory-metric="inactive"]')).toHaveText("1");
  await expect(page.locator("[data-inventory-table-body] tr")).toHaveCount(5);
  await expect(page.locator("[data-inventory-table-body]")).toContainText("UK 6");
  await expect(page.locator("[data-inventory-table-body]")).toContainText("UK 7");

  const activity = page.locator("[data-inventory-activity-list]");
  await expect(activity).toContainText("Initial Stock");
  await expect(activity).toContainText("Admin Adjustment");
  await expect(activity).toContainText("Order Deduction");
  await expect(activity).toContainText("Cancellation Restoration");
  await expect(activity).toContainText("+1");
  await expect(activity).toContainText("−1");

  await page.locator("[data-inventory-search]").fill("ATF-PREDATOR-ELITE-FG-UK7");
  await expect(page.locator("[data-inventory-table-body] tr")).toHaveCount(1);
  await expect(page.locator("[data-inventory-table-body]")).toContainText("UK 7");
  await page.getByRole("button", { name: "Clear Filters" }).click();

  await page.locator("[data-inventory-category]").selectOption("Jerseys");
  await expect(page.locator("[data-inventory-table-body] tr")).toHaveCount(2);
  await page.locator("[data-inventory-category]").selectOption("all");
  await page.locator("[data-inventory-stock-filter]").selectOption("Low Stock");
  await expect(page.locator("[data-inventory-table-body] tr")).toHaveCount(1);
  await expect(page.locator("[data-inventory-table-body]")).toContainText("UK 7");
  await page.locator("[data-inventory-stock-filter]").selectOption("all");
  await page.locator("[data-inventory-active-filter]").selectOption("inactive");
  await expect(page.locator("[data-inventory-table-body] tr")).toHaveCount(1);
  await expect(page.locator("[data-inventory-table-body]")).toContainText("Inactive");
  await page.getByRole("button", { name: "Clear Filters" }).click();

  await page.locator("[data-inventory-sort]").selectOption("stock-asc");
  await expect(page.locator("[data-inventory-table-body] tr").first().locator("[data-inventory-stock-value]")).toHaveText("0");
  await page.locator("[data-inventory-movement-filter]").selectOption("Order Deduction");
  await expect(page.locator("[data-inventory-activity-list] .admin-inventory-activity-item")).toHaveCount(1);
  await expect(page.locator("[data-inventory-activity-list]")).toContainText("order-deducted");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("[data-inventory-table-wrap]")).toBeHidden();
  await expect(page.locator("[data-inventory-mobile-list] .admin-inventory-mobile-card")).toHaveCount(5);
  await expect(page.locator("[data-inventory-mobile-list] .admin-inventory-adjust-button").first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("admin inventory paginates all 381 variants and deduplicates repeated UUIDs", async ({ page }) => {
  const variants = createAdminInventoryVariantSet();
  const rowsWithDuplicate = [...variants, structuredClone(variants[199])];
  await installSupabaseStub(page, {
    isAdmin: true,
    user: { id: "pagination-admin", email: "admin@example.com" },
    inventoryVariants: rowsWithDuplicate,
    inventoryMovements: [],
  });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Inventory" }).click();

  await expect(page.locator('[data-inventory-metric="products"]')).toHaveText("105");
  await expect(page.locator('[data-inventory-metric="variants"]')).toHaveText("381");
  await expect(page.locator('[data-inventory-metric="stock"]')).toHaveText("3,810");
  await expect(page.locator("[data-inventory-table-body] tr")).toHaveCount(381);
  const ranges = await page.evaluate(() => window.__attractionSupabaseTestState.selects
    .filter((entry) => entry.table === "product_variants")
    .map((entry) => entry.range));
  expect(ranges).toEqual([[0, 199], [200, 399]]);
  await expect(page.locator(`[data-inventory-table-body] [data-inventory-row="${variants[199].id}"]`)).toHaveCount(1);
});

test("admin inventory load failure is retryable without exposing private errors", async ({ page }) => {
  const fixtures = createAdminInventoryFixtures();
  await installSupabaseStub(page, {
    isAdmin: true,
    failInventoryLoadAttempts: 1,
    user: { id: "inventory-retry-admin", email: "admin@example.com" },
    ...fixtures,
  });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Inventory" }).click();

  await expect(page.getByText("Inventory could not be loaded. Please try again.")).toBeVisible();
  await expect(page.getByText("Private inventory load failure")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator('[data-inventory-metric="variants"]')).toHaveText("5");
});

test("admin stock adjustment validates inputs, submits exact RPC data once, and refreshes metrics and activity", async ({ page }) => {
  const fixtures = createAdminInventoryFixtures();
  const variant = fixtures.inventoryVariants[0];
  await installSupabaseStub(page, {
    isAdmin: true,
    adjustmentDelay: 100,
    user: { id: "adjustment-admin", email: "admin@example.com" },
    ...fixtures,
  });
  await page.setViewportSize({ width: 1391, height: 871 });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Inventory" }).click();
  const row = page.locator(`[data-inventory-table-body] [data-inventory-row="${variant.id}"]`);
  await row.getByRole("button", { name: /Adjust stock for Predator Elite FG, UK 6/ }).click();

  const modal = page.locator("[data-inventory-adjust-modal]");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Predator Elite FG");
  await expect(modal).toContainText("ATF-PREDATOR-ELITE-FG-UK6");
  const submit = modal.getByRole("button", { name: "Confirm Adjustment" });
  await expect(submit).toBeDisabled();
  await modal.locator("[data-adjust-new-stock]").fill("15");
  await modal.locator("[data-adjust-reason]").fill("New shipment received");
  await expect(submit).toBeEnabled();
  await expect(modal.locator("[data-adjust-preview]")).toContainText("Adjustment: +5");
  await modal.locator("[data-inventory-adjust-form]").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect(modal.locator("[data-inventory-adjust-submit]")).toBeDisabled();
  await expect(modal.locator("[data-inventory-adjust-submit]")).toHaveAttribute("aria-busy", "true");

  await expect(modal.getByRole("heading", { name: "Inventory updated successfully" })).toBeVisible();
  await expect(modal.locator("[data-adjust-success-previous]")).toHaveText("10");
  await expect(modal.locator("[data-adjust-success-new]")).toHaveText("15");
  await expect(modal.locator("[data-adjust-success-delta]")).toHaveText("+5");
  await expect(modal.locator("[data-adjust-success-movement]")).not.toBeEmpty();
  await expect(page.locator(`[data-inventory-table-body] [data-inventory-row="${variant.id}"] [data-inventory-stock-value]`)).toHaveText("15");
  await expect(page.locator('[data-inventory-metric="stock"]')).toHaveText("36");
  await expect(page.locator("[data-inventory-activity-list]")).toContainText("New shipment received");

  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.adjustmentCalls).toHaveLength(1);
  expect(state.adjustmentCalls[0]).toMatchObject({
    p_product_variant_id: variant.id,
    p_expected_stock_quantity: 10,
    p_new_stock_quantity: 15,
    p_reason: "New shipment received",
  });
  expect(state.adjustmentCalls[0].p_idempotency_key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(state.inserts).toEqual([]);
  expect(state.updates).toEqual([]);
  await modal.getByRole("button", { name: "Done" }).click();
  await expect(modal).toBeHidden();
  await expect(page.locator("[data-inventory-activity-list]", { hasText: "New shipment received" }).locator(".admin-inventory-activity-item", { hasText: "New shipment received" })).toHaveCount(1);
  await page.locator("[data-inventory-refresh]").click();
  await expect(page.locator("[data-inventory-activity-list] .admin-inventory-activity-item", { hasText: "New shipment received" })).toHaveCount(1);
});

test("admin adjustment rejects invalid values and supports decreases to zero and inactive variants", async ({ page }) => {
  const fixtures = createAdminInventoryFixtures();
  const firstVariant = fixtures.inventoryVariants[0];
  const lowVariant = fixtures.inventoryVariants[1];
  const inactiveVariant = fixtures.inventoryVariants[3];
  await installSupabaseStub(page, {
    isAdmin: true,
    user: { id: "validation-admin", email: "admin@example.com" },
    ...fixtures,
  });
  await page.setViewportSize({ width: 1391, height: 871 });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Inventory" }).click();
  await page.locator(`[data-inventory-table-body] [data-inventory-row="${firstVariant.id}"] [data-inventory-adjust]`).click();
  const modal = page.locator("[data-inventory-adjust-modal]");
  const quantity = modal.locator("[data-adjust-new-stock]");
  const reason = modal.locator("[data-adjust-reason]");
  const submit = modal.locator("[data-inventory-adjust-submit]");
  const submitForm = () => modal.locator("[data-inventory-adjust-form]").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  await quantity.fill("-1");
  await reason.fill("Physical stock correction");
  await expect(submit).toBeDisabled();
  await submitForm();
  await expect(modal.locator("[data-adjust-feedback]")).toContainText("whole stock quantity");
  await quantity.fill("10");
  await submitForm();
  await expect(modal.locator("[data-adjust-feedback]")).toContainText("already set");
  await quantity.fill("7");
  await reason.fill("x");
  await submitForm();
  await expect(modal.locator("[data-adjust-feedback]")).toContainText("between 3 and 500");
  await reason.fill("Damaged units removed");
  for (const malformedValue of ["1e2", "1E2", "1.5", "0x10"]) {
    await quantity.fill(malformedValue);
    await expect(submit).toBeDisabled();
  }
  await quantity.fill("2147483647");
  await expect(submit).toBeEnabled();
  await quantity.fill("7");
  await expect(modal.locator("[data-adjust-preview]")).toContainText("Adjustment: −3");
  await submitForm();
  await expect(modal.locator("[data-adjust-success-new]")).toHaveText("7");
  await modal.getByRole("button", { name: "Done" }).click();

  await page.locator(`[data-inventory-table-body] [data-inventory-row="${lowVariant.id}"] [data-inventory-adjust]`).click();
  await modal.locator("[data-adjust-new-stock]").fill("0");
  await modal.locator("[data-adjust-reason]").fill("Physical count reached zero");
  await expect(modal.locator("[data-adjust-preview]")).toContainText("Adjustment: −2");
  await submitForm();
  await expect(modal.locator("[data-adjust-success-new]")).toHaveText("0");
  await modal.getByRole("button", { name: "Done" }).click();

  await page.locator(`[data-inventory-table-body] [data-inventory-row="${inactiveVariant.id}"] [data-inventory-adjust]`).click();
  await modal.locator("[data-adjust-new-stock]").fill("8");
  await modal.locator("[data-adjust-reason]").fill("Inactive variant physical count correction");
  await submitForm();
  await expect(modal.locator("[data-adjust-success-new]")).toHaveText("8");
  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.adjustmentCalls).toHaveLength(3);
  expect(state.adjustmentCalls[2].p_product_variant_id).toBe(inactiveVariant.id);
});

test("admin adjustment reuses a UUID after network failure", async ({ page }) => {
  const fixtures = createAdminInventoryFixtures();
  const variant = fixtures.inventoryVariants[0];
  await installSupabaseStub(page, {
    isAdmin: true,
    failAdjustmentAttempts: 1,
    user: { id: "retry-admin", email: "admin@example.com" },
    ...fixtures,
  });
  await page.setViewportSize({ width: 1391, height: 871 });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Inventory" }).click();
  await page.locator(`[data-inventory-table-body] [data-inventory-row="${variant.id}"] [data-inventory-adjust]`).click();
  const modal = page.locator("[data-inventory-adjust-modal]");
  await modal.locator("[data-adjust-new-stock]").fill("15");
  await modal.locator("[data-adjust-reason]").fill("Demo stock reconciliation");
  await modal.getByRole("button", { name: "Confirm Adjustment" }).click();
  await expect(modal.locator("[data-adjust-feedback]")).toContainText("could not be adjusted");
  const firstToken = await page.evaluate(() => window.__attractionSupabaseTestState.adjustmentCalls[0].p_idempotency_key);
  await modal.getByRole("button", { name: "Confirm Adjustment" }).click();
  await expect(modal.locator("[data-adjust-success-new]")).toHaveText("15");
  const retryCalls = await page.evaluate(() => window.__attractionSupabaseTestState.adjustmentCalls);
  expect(retryCalls[1].p_idempotency_key).toBe(firstToken);
  await modal.getByRole("button", { name: "Done" }).click();
});

test("admin adjustment creates a new UUID when a failed payload changes", async ({ page }) => {
  const fixtures = createAdminInventoryFixtures();
  const variant = fixtures.inventoryVariants[0];
  await installSupabaseStub(page, {
    isAdmin: true,
    failAdjustmentAttempts: 2,
    user: { id: "changed-payload-admin", email: "admin@example.com" },
    ...fixtures,
  });
  await page.setViewportSize({ width: 1391, height: 871 });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Inventory" }).click();
  await page.locator(`[data-inventory-table-body] [data-inventory-row="${variant.id}"] [data-inventory-adjust]`).click();
  const modal = page.locator("[data-inventory-adjust-modal]");
  await modal.locator("[data-adjust-new-stock]").fill("15");
  await modal.locator("[data-adjust-reason]").fill("First reviewed stock count");
  await modal.getByRole("button", { name: "Confirm Adjustment" }).click();
  await expect(modal.locator("[data-adjust-feedback]")).toContainText("could not be adjusted");

  await modal.locator("[data-adjust-new-stock]").fill("16");
  await modal.locator("[data-adjust-reason]").fill("Revised physical stock count");
  await modal.getByRole("button", { name: "Confirm Adjustment" }).click();
  await expect(modal.locator("[data-adjust-feedback]")).toContainText("could not be adjusted");

  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.adjustmentCalls);
  expect(calls).toHaveLength(2);
  expect(calls[1].p_idempotency_key).not.toBe(calls[0].p_idempotency_key);
});

test("admin stale-stock handling reloads the variant and requires a new reviewed attempt", async ({ page }) => {
  const fixtures = createAdminInventoryFixtures();
  const variant = fixtures.inventoryVariants[0];
  await installSupabaseStub(page, {
    isAdmin: true,
    staleVariantId: variant.id,
    staleStockQuantity: 12,
    user: { id: "stale-admin", email: "admin@example.com" },
    ...fixtures,
  });
  await page.setViewportSize({ width: 1391, height: 871 });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Inventory" }).click();
  const trigger = page.locator(`[data-inventory-table-body] [data-inventory-row="${variant.id}"] [data-inventory-adjust]`);
  await trigger.click();
  const modal = page.locator("[data-inventory-adjust-modal]");
  await modal.locator("[data-adjust-new-stock]").fill("15");
  await modal.locator("[data-adjust-reason]").fill("Physical stock count correction");
  await modal.getByRole("button", { name: "Confirm Adjustment" }).click();

  await expect(modal.locator("[data-adjust-feedback]")).toContainText("latest quantity has been loaded");
  await expect(modal.locator("[data-adjust-current-stock]")).toHaveText("12");
  await expect(modal.locator("[data-adjust-preview]")).toContainText("Adjustment: +3");
  const firstToken = await page.evaluate(() => window.__attractionSupabaseTestState.adjustmentCalls[0].p_idempotency_key);
  await modal.getByRole("button", { name: "Confirm Adjustment" }).click();
  await expect(modal.locator("[data-adjust-success-new]")).toHaveText("15");
  const calls = await page.evaluate(() => window.__attractionSupabaseTestState.adjustmentCalls);
  expect(calls[1].p_expected_stock_quantity).toBe(12);
  expect(calls[1].p_idempotency_key).not.toBe(firstToken);
});

test("admin stale-stock refresh failure keeps submission disabled until an authoritative retry succeeds", async ({ page }) => {
  const fixtures = createAdminInventoryFixtures();
  const variant = fixtures.inventoryVariants[0];
  await installSupabaseStub(page, {
    isAdmin: true,
    staleVariantId: variant.id,
    staleStockQuantity: 12,
    failInventoryLoadOnCalls: [2],
    user: { id: "stale-refresh-admin", email: "admin@example.com" },
    ...fixtures,
  });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Inventory" }).click();
  await page.locator(`[data-inventory-mobile-list] [data-inventory-row="${variant.id}"] [data-inventory-adjust]`).click();
  const modal = page.locator("[data-inventory-adjust-modal]");
  await modal.locator("[data-adjust-new-stock]").fill("15");
  await modal.locator("[data-adjust-reason]").fill("Physical stock count correction");
  await modal.getByRole("button", { name: "Confirm Adjustment" }).click();

  await expect(modal.locator("[data-adjust-feedback]")).toContainText("latest quantity could not be loaded");
  await expect(modal.locator("[data-inventory-adjust-submit]")).toBeDisabled();
  const refresh = modal.getByRole("button", { name: "Refresh Inventory" });
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect(modal.locator("[data-adjust-current-stock]")).toHaveText("12");
  await expect(modal.locator("[data-adjust-preview]")).toContainText("Adjustment: +3");
  await expect(modal.locator("[data-inventory-adjust-submit]")).toBeEnabled();
});

test("admin inventory modal supports Escape focus restoration and mobile overflow safety", async ({ page }) => {
  const fixtures = createAdminInventoryFixtures();
  await installSupabaseStub(page, {
    isAdmin: true,
    user: { id: "keyboard-admin", email: "admin@example.com" },
    ...fixtures,
  });
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Inventory" }).click();
  const trigger = page.locator("[data-inventory-mobile-list] [data-inventory-adjust]").first();
  await trigger.click();
  const modal = page.locator("[data-inventory-adjust-modal]");
  await expect(modal).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/no-scroll/);
  await expect(modal.locator("[data-adjust-new-stock]")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(modal.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(modal.locator("[data-adjust-new-stock]")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/no-scroll/);
  await expect(trigger).toBeFocused();
  await expectNoHorizontalOverflow(page);
});

test("admin inventory ignores a delayed response after logout", async ({ page }) => {
  const fixtures = createAdminInventoryFixtures();
  await installSupabaseStub(page, {
    isAdmin: true,
    inventoryLoadDelay: 200,
    user: { id: "delayed-inventory-admin", email: "admin@example.com" },
    ...fixtures,
  });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Inventory" }).click();
  await page.evaluate(() => window.__attractionSupabaseClient.auth.signOut());

  await expect(page.getByRole("heading", { name: "Admin Login Required" })).toBeVisible();
  await page.waitForTimeout(250);
  await expect(page.getByRole("tab", { name: "Inventory" })).toBeHidden();
  await expect(page.locator("[data-inventory-table-body] tr")).toHaveCount(0);
  await expect(page.getByText("Predator Elite FG")).toHaveCount(0);
});

test("admin inventory renders hostile database text literally without creating executable markup", async ({ page }) => {
  const fixtures = createAdminInventoryFixtures();
  const hostileProduct = '<img src=x onerror=alert(1)>';
  const hostileSku = '<script>bad()</script>';
  const hostileVariant = '\"><svg/onload=alert(1)>';
  const hostileReason = '<b>Physical correction</b>';
  fixtures.inventoryVariants[0].products.name = hostileProduct;
  fixtures.inventoryVariants[0].sku = hostileSku;
  fixtures.inventoryVariants[0].variant_label = hostileVariant;
  fixtures.inventoryMovements[0].reason = hostileReason;
  fixtures.inventoryMovements[0].product_variants.products.name = hostileProduct;
  fixtures.inventoryMovements[0].product_variants.sku = hostileSku;
  fixtures.inventoryMovements[0].product_variants.variant_label = hostileVariant;
  let dialogTriggered = false;
  page.on("dialog", async (dialog) => {
    dialogTriggered = true;
    await dialog.dismiss();
  });
  await installSupabaseStub(page, {
    isAdmin: true,
    user: { id: "hostile-text-admin", email: "admin@example.com" },
    ...fixtures,
  });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Inventory" }).click();

  const content = page.locator("[data-inventory-content]");
  await expect(content).toContainText(hostileProduct);
  await expect(content).toContainText(hostileSku);
  await expect(content).toContainText(hostileVariant);
  await expect(content).toContainText(hostileReason);
  await expect(content.locator("script, [onerror], svg[onload]")).toHaveCount(0);
  await page.locator(`[data-inventory-mobile-list] [data-inventory-row="${fixtures.inventoryVariants[0].id}"] [data-inventory-adjust]`).click();
  const modal = page.locator("[data-inventory-adjust-modal]");
  await expect(modal).toContainText(hostileProduct);
  await expect(modal).toContainText(hostileSku);
  await expect(modal).toContainText(hostileVariant);
  await expect(modal.locator("script, [onerror], svg[onload]")).toHaveCount(0);
  expect(dialogTriggered).toBe(false);
});

test("admin inventory frontend uses only the secure adjustment RPC for stock writes", async () => {
  const source = fs.readFileSync(path.join(process.cwd(), "script.js"), "utf8");
  expect(source).toContain('supabaseClient.rpc("adjust_variant_stock"');
  expect(source).not.toMatch(/\.from\(["']product_variants["']\)\s*\.update\s*\(/s);
  expect(source).not.toMatch(/\.from\(["']product_variants["']\)\s*\.insert\s*\(/s);
  expect(source).not.toMatch(/\.from\(["']inventory_movements["']\)\s*\.insert\s*\(/s);
  expect(source).not.toMatch(/adjust_variant_stock[\s\S]{0,500}p_user_id/);
});

test("eligible customers can request cancellation once through the secure RPC", async ({ page }) => {
  const user = { id: "cancellation-customer", email: "cancel@example.com", user_metadata: { full_name: "Cancel Customer" } };
  const recentOrderDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await installSupabaseStub(page, {
    user,
    cancellationRequestDelay: 100,
    orders: [
      {
        id: "cancel-pending-001",
        user_id: user.id,
        created_at: recentOrderDate,
        total_amount: 219.99,
        status: "Pending",
        payment_method: "COD",
        payment_status: "Unpaid",
        cancellation_request_status: "None",
        order_items: [{ product_price: 219.99, quantity: 1 }],
      },
      {
        id: "cancel-confirmed-002",
        user_id: user.id,
        created_at: recentOrderDate,
        total_amount: 199.99,
        status: "Confirmed",
        payment_method: "COD",
        payment_status: "Unpaid",
        cancellation_request_status: "None",
        order_items: [{ product_price: 199.99, quantity: 1 }],
      },
    ],
  });
  await page.goto("/my-orders.html", { waitUntil: "domcontentloaded" });

  await expect(page.getByText("Please request cancellation within 24 hours of placing the order.")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Request Cancellation" })).toHaveCount(2);

  await page.locator('[data-customer-order-id="cancel-pending-001"] [data-request-cancellation]').click();
  const modal = page.locator("[data-cancellation-modal]");
  await expect(modal).toHaveClass(/is-open/);
  await expect(modal).toContainText("cancel-pending-001");
  await expect(modal).toContainText("Cash on Delivery");
  await expect(modal).toContainText("Submitting this request does not immediately cancel your order. It must be approved by the store administrator.");

  await modal.locator("[data-cancellation-reason]").fill("no");
  await modal.getByRole("button", { name: "Submit Cancellation Request" }).click();
  await expect(modal.getByText("Reason must be between 5 and 300 characters.")).toBeVisible();

  await modal.locator("[data-cancellation-reason]").fill("Ordered the wrong boot size");
  await modal.locator("[data-cancellation-form]").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  const pendingCard = page.locator('[data-customer-order-id="cancel-pending-001"]');
  const pendingSummary = pendingCard.locator('[data-customer-cancellation-state="Pending"]');
  await expect(pendingSummary).toContainText("Cancellation Request");
  await expect(pendingSummary).toContainText("Awaiting Approval");
  await expect(pendingSummary).not.toContainText("Ordered the wrong boot size");
  await expect(pendingSummary).not.toContainText("Requested At");
  await expect(pendingCard.locator("[data-request-cancellation]")).toHaveCount(0);

  await pendingCard.getByRole("button", { name: "View Details" }).click();
  const detailsModal = page.locator("[data-order-details-modal]");
  await expect(detailsModal).toHaveClass(/is-open/);
  await expect(detailsModal).toContainText("Customer Reason");
  await expect(detailsModal).toContainText("Ordered the wrong boot size");
  await expect(detailsModal).toContainText("Requested At");
  await expect(detailsModal).toContainText("Your cancellation request is awaiting administrator approval.");
  await detailsModal.getByRole("button", { name: "Close order details" }).click();

  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.cancellationRequestCalls).toEqual([{
    p_order_id: "cancel-pending-001",
    p_reason: "Ordered the wrong boot size",
  }]);
  expect(state.updates).toEqual([]);

  await page.locator('[data-customer-order-id="cancel-confirmed-002"] [data-request-cancellation]').click();
  await expect(modal).toHaveClass(/is-open/);
  await page.keyboard.press("Escape");
  await expect(modal).not.toHaveClass(/is-open/);
  await expect(page.locator("body")).not.toHaveClass(/no-scroll/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-customer-order-id="cancel-confirmed-002"] [data-request-cancellation]').click();
  await expectNoHorizontalOverflow(page);
  await expectInViewport(modal.locator(".order-cancellation-panel"), 390, 844);
  await modal.getByRole("button", { name: "Close cancellation request" }).click();
});

test("failed cancellation requests keep the order eligible and hide database errors", async ({ page }) => {
  const user = { id: "cancellation-error-user", email: "error@example.com", user_metadata: {} };
  await installSupabaseStub(page, {
    user,
    failCancellationRequest: "private postgres cancellation detail",
    orders: [{
      id: "cancel-error-order",
      user_id: user.id,
      created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      total_amount: 89.99,
      status: "Pending",
      payment_method: "COD",
      payment_status: "Unpaid",
      cancellation_request_status: "None",
      order_items: [{ product_price: 89.99, quantity: 1 }],
    }],
  });
  await page.goto("/my-orders.html", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "Request Cancellation" }).click();
  const modal = page.locator("[data-cancellation-modal]");
  await modal.locator("[data-cancellation-reason]").fill("I selected the wrong product");
  await modal.getByRole("button", { name: "Submit Cancellation Request" }).click();

  await expect(modal.getByText("We could not submit your cancellation request. Please try again.")).toBeVisible();
  await expect(modal.getByText("private postgres cancellation detail")).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "Submit Cancellation Request" })).toBeEnabled();
  await modal.getByRole("button", { name: "Keep Order" }).click();
  await expect(page.getByRole("button", { name: "Request Cancellation" })).toBeVisible();
});

test("my orders enforces expiry payment fulfilment and reviewed cancellation states", async ({ page }) => {
  const user = { id: "cancellation-states", email: "states@example.com", user_metadata: {} };
  const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const longReason = "I need to cancel because the selected product and delivery plan no longer match the intended team order, and this longer explanation must wrap safely inside the details panel without widening the page.";
  const longAdminResponse = "The request was reviewed after fulfilment preparation started. Please contact support so the team can explain the available assistance without exposing any internal order controls.";
  const base = {
    user_id: user.id,
    total_amount: 49.99,
    payment_method: "COD",
    payment_status: "Unpaid",
    cancellation_request_status: "None",
    order_items: [{ product_price: 49.99, quantity: 1 }],
  };
  await installSupabaseStub(page, {
    user,
    orders: [
      { ...base, id: "expired-order", created_at: expired, status: "Pending" },
      { ...base, id: "paid-order", created_at: recent, status: "Confirmed", payment_status: "Paid" },
      { ...base, id: "shipped-order", created_at: recent, status: "Shipped" },
      { ...base, id: "delivered-order", created_at: recent, status: "Delivered" },
      { ...base, id: "pending-request-order", created_at: recent, status: "Pending", cancellation_request_status: "Pending", cancellation_reason: "Awaiting review", cancellation_requested_at: recent },
      { ...base, id: "cancelled-order", created_at: recent, status: "Cancelled", cancellation_request_status: "Approved", cancellation_reason: "No longer needed", cancellation_requested_at: recent, cancelled_at: recent },
      { ...base, id: "rejected-order", created_at: recent, status: "Confirmed", cancellation_request_status: "Rejected", cancellation_reason: longReason, cancellation_requested_at: recent, cancellation_admin_note: longAdminResponse, cancellation_reviewed_at: recent },
    ],
  });
  await page.goto("/my-orders.html", { waitUntil: "domcontentloaded" });

  await expect(page.locator('[data-customer-order-id="expired-order"]')).toContainText("The 24-hour cancellation window has closed. Please contact support for assistance.");
  await expect(page.locator('[data-customer-order-id="paid-order"]')).toContainText("Paid orders require support assistance.");
  await expect(page.locator('[data-customer-order-id="shipped-order"]')).toContainText("This order can no longer be cancelled.");
  await expect(page.locator('[data-customer-order-id="delivered-order"]')).toContainText("This order can no longer be cancelled.");
  const approvedCard = page.locator('[data-customer-order-id="cancelled-order"]');
  const approvedSummary = approvedCard.locator('[data-customer-cancellation-state="Approved"]');
  await expect(approvedCard.locator(".order-status")).toHaveText("Cancelled");
  await expect(approvedSummary).toContainText("Cancellation Request");
  await expect(approvedSummary).toContainText("Approved");
  await expect(approvedSummary).not.toContainText("No longer needed");
  await expect(approvedSummary).not.toContainText("Cancelled At");

  const rejectedCard = page.locator('[data-customer-order-id="rejected-order"]');
  const rejectedSummary = rejectedCard.locator('[data-customer-cancellation-state="Rejected"]');
  await expect(rejectedCard.locator(".order-status")).toHaveText("Confirmed");
  await expect(rejectedSummary).toContainText("Cancellation Request");
  await expect(rejectedSummary).toContainText("Rejected");
  await expect(rejectedSummary).not.toContainText(longReason);
  await expect(rejectedSummary).not.toContainText(longAdminResponse);
  await expect(rejectedSummary).not.toContainText("contact support");

  const cancellationCardIds = ["pending-request-order", "cancelled-order", "rejected-order"];
  for (const viewport of [{ width: 1391, height: 871 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page);
    const measurements = await page.evaluate((orderIds) => orderIds.map((orderId) => {
      const card = document.querySelector(`[data-customer-order-id="${orderId}"]`);
      const orderLabel = card.querySelector(".customer-order-card__label--order").getBoundingClientRect();
      const productsLabel = card.querySelector(".customer-order-card__label--products").getBoundingClientRect();
      const productsValue = card.querySelector(".customer-order-card__metric--products").getBoundingClientRect();
      const cancellationLabel = card.querySelector(".customer-cancellation-heading .order-card-label").getBoundingClientRect();
      const cancellationBadge = card.querySelector(".customer-cancellation-heading .cancellation-state").getBoundingClientRect();
      return {
        orderLabelLeft: orderLabel.left,
        productsLabelLeft: productsLabel.left,
        productsValueLeft: productsValue.left,
        cancellationLabelLeft: cancellationLabel.left,
        cancellationBadgeLeft: cancellationBadge.left,
      };
    }), cancellationCardIds);

    for (const measurement of measurements) {
      expect(Math.abs(measurement.cancellationLabelLeft - measurement.orderLabelLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(measurement.cancellationBadgeLeft - measurement.productsLabelLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(measurement.cancellationBadgeLeft - measurement.productsValueLeft)).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...measurements.map((entry) => entry.cancellationBadgeLeft)) - Math.min(...measurements.map((entry) => entry.cancellationBadgeLeft))).toBeLessThanOrEqual(1);
  }

  for (const viewport of [{ width: 430, height: 932 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page);
    const mobileLayout = await page.evaluate((orderIds) => orderIds.map((orderId) => {
      const heading = document.querySelector(`[data-customer-order-id="${orderId}"] .customer-cancellation-heading`);
      const label = heading.querySelector(".order-card-label").getBoundingClientRect();
      const badge = heading.querySelector(".cancellation-state").getBoundingClientRect();
      return {
        flexDirection: getComputedStyle(heading).flexDirection,
        labelBottom: label.bottom,
        labelLeft: label.left,
        badgeTop: badge.top,
        badgeLeft: badge.left,
      };
    }), cancellationCardIds);
    for (const measurement of mobileLayout) {
      expect(measurement.flexDirection).toBe("column");
      expect(measurement.badgeTop).toBeGreaterThanOrEqual(measurement.labelBottom - 1);
      expect(Math.abs(measurement.badgeLeft - measurement.labelLeft)).toBeLessThanOrEqual(1);
    }
  }

  await rejectedCard.getByRole("button", { name: "View Details" }).click();
  const detailsModal = page.locator("[data-order-details-modal]");
  await expect(detailsModal).toContainText("Customer Reason");
  await expect(detailsModal).toContainText(longReason);
  await expect(detailsModal).toContainText("Requested At");
  await expect(detailsModal).toContainText("Reviewed At");
  await expect(detailsModal).toContainText("Admin Response");
  await expect(detailsModal).toContainText(longAdminResponse);
  await expect(detailsModal).toContainText("Your cancellation request has been reviewed. Please contact support for further assistance.");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await detailsModal.getByRole("button", { name: "Close order details" }).click();

  await page.setViewportSize({ width: 1391, height: 871 });
  await expectNoHorizontalOverflow(page);
  await approvedCard.getByRole("button", { name: "View Details" }).click();
  await expect(detailsModal).toContainText("Customer Reason");
  await expect(detailsModal).toContainText("No longer needed");
  await expect(detailsModal).toContainText("Requested At");
  await expect(detailsModal).toContainText("Cancelled At");
  await detailsModal.getByRole("button", { name: "Close order details" }).click();
  await expect(page.getByRole("button", { name: "Request Cancellation" })).toHaveCount(0);
});

test("admin reviews cancellations and locks order and payment controls safely", async ({ page }) => {
  const recent = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const pendingCancellation = (id, status) => ({
    id,
    created_at: recent,
    customer_name: "Cancellation Customer",
    customer_email: "cancel@example.com",
    customer_phone: "+91 90000 12345",
    address: "12 Pitch Road",
    city: "Kolkata",
    state: "West Bengal",
    pin_code: "700001",
    total_amount: 219.99,
    status,
    payment_method: "COD",
    payment_status: "Unpaid",
    cancellation_request_status: "Pending",
    cancellation_reason: "Ordered the wrong product",
    cancellation_requested_at: recent,
    order_items: [],
  });
  await installSupabaseStub(page, {
    isAdmin: true,
    user: { id: "admin-user", email: "ag203328@gmail.com", user_metadata: { full_name: "Admin" } },
    orders: [
      pendingCancellation("approve-cancellation", "Pending"),
      pendingCancellation("reject-cancellation", "Confirmed"),
    ],
  });
  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });

  let approveCard = page.locator('[data-order-id="approve-cancellation"]');
  let rejectCard = page.locator('[data-order-id="reject-cancellation"]');
  await expect(approveCard.getByText("Awaiting Approval")).toBeVisible();
  await expect(approveCard.locator("[data-admin-status]")).toBeDisabled();
  await expect(approveCard.locator("[data-admin-payment-status]")).toBeDisabled();
  await expect(approveCard).toContainText("Review the pending cancellation request first.");

  await rejectCard.getByRole("button", { name: "Reject Cancellation" }).click();
  await expect(rejectCard.getByText("Please provide a clear rejection explanation.")).toBeVisible();
  await rejectCard.locator("[data-admin-cancellation-note]").fill("Customer request is outside fulfilment handling rules");
  await rejectCard.getByRole("button", { name: "Reject Cancellation" }).click();

  rejectCard = page.locator('[data-order-id="reject-cancellation"]');
  await expect(rejectCard.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(rejectCard.locator("[data-admin-status]")).toBeEnabled();
  await expect(rejectCard.locator("[data-admin-payment-status]")).toBeEnabled();
  await expect(rejectCard.locator('[data-admin-status] option[value="Cancelled"]')).toHaveCount(0);
  await expect(rejectCard.locator("[data-admin-current-status]")).toHaveText("Confirmed");

  approveCard = page.locator('[data-order-id="approve-cancellation"]');
  await approveCard.getByRole("button", { name: "Approve Cancellation" }).click();
  approveCard = page.locator('[data-order-id="approve-cancellation"]');
  await expect(approveCard.getByText("Approved", { exact: true })).toBeVisible();
  await expect(approveCard.locator("[data-admin-current-status]")).toHaveText("Cancelled");
  await expect(approveCard.locator("[data-admin-status]")).toBeDisabled();
  await expect(approveCard.locator("[data-admin-payment-status]")).toBeDisabled();
  await expect(approveCard.locator("[data-admin-status-save]")).toBeDisabled();
  await expect(approveCard.locator("[data-admin-payment-status-save]")).toBeDisabled();

  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  expect(state.cancellationReviewCalls).toEqual([
    {
      p_order_id: "reject-cancellation",
      p_decision: "Rejected",
      p_admin_note: "Customer request is outside fulfilment handling rules",
    },
    {
      p_order_id: "approve-cancellation",
      p_decision: "Approved",
      p_admin_note: null,
    },
  ]);
  expect(state.updates).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
});

test("my orders keeps the loading state until auth resolves, then requires login", async ({ page }) => {
  await installSupabaseStub(page, { user: null, sessionDelay: 250 });
  await page.goto("/my-orders.html", { waitUntil: "domcontentloaded" });

  await expect(page.locator("[data-orders-loading]")).toBeVisible();
  await expect(page.locator("[data-orders-login]")).toBeHidden();
  await expect(page.locator("[data-orders-empty]")).toBeHidden();
  await expect(page.locator("[data-orders-list]")).toBeHidden();

  await expect(page.getByText("Please log in to view your orders.")).toBeVisible();
  await expect(page.locator("[data-orders-loading]")).toBeHidden();
  await page.getByRole("button", { name: "Log In", exact: true }).click();
  await expect(page.locator(".login-modal")).toHaveClass(/is-open/);
});

test("my orders loads only the signed-in user's newest orders through the nested RLS query", async ({ page }) => {
  const user = { id: "customer-one", email: "customer@example.com", user_metadata: { full_name: "Customer One" } };
  await page.setViewportSize({ width: 1391, height: 871 });
  await installSupabaseStub(page, {
    user,
    orders: [
      {
        id: "11111111-old-order",
        user_id: user.id,
        created_at: "2026-06-01T09:00:00.000Z",
        total_amount: 49.99,
        status: "Delivered",
        order_items: [{ product_price: 49.99, quantity: 1 }],
      },
      {
        id: "22222222-new-order",
        user_id: user.id,
        created_at: "2026-07-11T14:30:00.000Z",
        total_amount: 159.97,
        status: "Confirmed",
        order_items: [{ product_price: 39.99, quantity: 2 }, { product_price: 79.99, quantity: 1 }],
      },
      {
        id: "99999999-other-order",
        user_id: "another-customer",
        created_at: "2026-07-12T14:30:00.000Z",
        total_amount: 999.99,
        status: "Pending",
        order_items: [],
      },
    ],
  });
  await page.goto("/my-orders.html", { waitUntil: "domcontentloaded" });

  const cards = page.locator("[data-customer-order-id]");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toHaveAttribute("data-customer-order-id", "22222222-new-order");
  await expect(cards.first().locator(".order-status")).toHaveText("Confirmed");
  await expect(cards.first().locator(".customer-order-card__metric--products")).toHaveText("3 Products");
  await expect(cards.nth(1).locator(".customer-order-card__metric--products")).toHaveText("1 Product");
  await expect(cards.first().locator(".customer-order-card__metric--total")).toHaveText("$159.97");
  await expect(page.getByText("#99999999")).toHaveCount(0);

  const rowAlignment = await cards.first().evaluate((card) => {
    const labels = [...card.querySelectorAll(":scope > .customer-order-card__label")];
    const values = [...card.querySelectorAll(":scope > .customer-order-card__primary")];
    const textBottom = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().bottom;
    };
    return {
      labelTops: labels.map((label) => label.getBoundingClientRect().top),
      textBottoms: values.map(textBottom),
    };
  });
  expect(Math.max(...rowAlignment.labelTops) - Math.min(...rowAlignment.labelTops)).toBeLessThanOrEqual(1);
  expect(Math.max(...rowAlignment.textBottoms) - Math.min(...rowAlignment.textBottoms)).toBeLessThanOrEqual(2);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cards.first().locator(".customer-order-card__metric--products")).toHaveText("3 Products");
  await expect(cards.first().locator(".customer-order-card__metric--total")).toHaveText("$159.97");
  await expectNoHorizontalOverflow(page);

  const state = await page.evaluate(() => window.__attractionSupabaseTestState);
  const orderSelect = state.selects.find((query) => query.table === "orders" && query.columns.includes("order_items"));
  expect(orderSelect.filters).toEqual([["user_id", user.id]]);
});

test("my order details use historical item snapshots and close with Escape", async ({ page }) => {
  const user = { id: "customer-details", email: "buyer@example.com", user_metadata: { full_name: "Buyer" } };
  await installSupabaseStub(page, {
    user,
    orders: [{
      id: "94227091-6585-4682-8d1b-0c7e000d7735",
      user_id: user.id,
      created_at: "2026-07-10T10:15:00.000Z",
      customer_name: "Aarav Player",
      customer_email: "buyer@example.com",
      customer_phone: "+91 90000 12345",
      address: "22 Football Avenue",
      city: "Kolkata",
      state: "West Bengal",
      pin_code: "700001",
      note: "Call before delivery",
      total_amount: 89.98,
      status: "Shipped",
      payment_method: "COD",
      payment_status: "Paid",
      payment_collected_at: "2026-07-11T12:00:00.000Z",
      order_items: [{
        id: "snapshot-item-1",
        order_id: "94227091-6585-4682-8d1b-0c7e000d7735",
        product_id: "historical-product",
        product_variant_id: "00000000-0000-4000-8000-000000000888",
        variant_label: "M",
        variant_sku: "ATF-HISTORICAL-MATCH-TEE-M",
        product_name: "Historical Match Tee",
        product_category: "T-Shirts",
        product_price: 39.99,
        quantity: 2,
        product_image: "assets/premium-football-tshirt.avif",
      }, {
        id: "snapshot-item-legacy",
        order_id: "94227091-6585-4682-8d1b-0c7e000d7735",
        product_id: "legacy-product",
        product_name: "Legacy Wristband",
        product_category: "Accessories",
        product_price: 10,
        quantity: 1,
        product_image: "assets/accessory-flex-wristbands-real.avif",
      }],
    }],
  });
  await page.goto("/my-orders.html", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "View Details" }).click();
  const modal = page.locator("[data-order-details-modal]");
  await expect(modal).toHaveClass(/is-open/);
  await expect(modal).toContainText("94227091-6585-4682-8d1b-0c7e000d7735");
  await expect(modal).toContainText("Historical Match Tee");
  await expect(modal).toContainText("Size: M");
  await expect(modal).toContainText("SKU: ATF-HISTORICAL-MATCH-TEE-M");
  const legacyItem = modal.locator(".customer-order-item", { hasText: "Legacy Wristband" });
  await expect(legacyItem).not.toContainText("Size:");
  await expect(legacyItem).not.toContainText("SKU:");
  await expect(modal).toContainText("$39.99 × 2");
  await expect(modal.locator(".customer-order-item b")).toHaveText(["$79.98", "$10.00"]);
  await expect(modal.locator(".order-details-total strong")).toHaveText("$89.98");
  await expect(modal).toContainText("Call before delivery");
  await expect(modal.locator(".order-status")).toHaveText("Shipped");
  await expect(modal).toContainText("Payment Method: Cash on Delivery");
  await expect(modal).toContainText("Payment Status: Paid");
  await expect(modal).toContainText("Payment Collected At:");
  await expect(modal.locator("[data-admin-payment-status], [data-admin-payment-status-save]")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(modal).not.toHaveClass(/is-open/);
  await expect(page.locator("body")).not.toHaveClass(/no-scroll/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "View Details" }).click();
  await expect(modal).toHaveClass(/is-open/);
  await expectNoHorizontalOverflow(page);
  await modal.getByRole("button", { name: "Close order details" }).click();
});

test("my orders distinguishes empty history from a failed query and supports retry", async ({ page }) => {
  const user = { id: "customer-retry", email: "retry@example.com", user_metadata: {} };
  await installSupabaseStub(page, {
    user,
    failOrderLoadAttempts: 1,
    ordersError: "private database detail",
    orders: [{
      id: "33333333-retry-order",
      user_id: user.id,
      created_at: "2026-07-09T10:00:00.000Z",
      total_amount: 29.99,
      status: "Pending",
      order_items: [],
    }],
  });
  await page.goto("/my-orders.html", { waitUntil: "domcontentloaded" });

  await expect(page.getByText("We could not load your orders. Please try again.")).toBeVisible();
  await expect(page.locator("[data-orders-empty]")).toBeHidden();
  await expect(page.getByText("private database detail")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator('[data-customer-order-id="33333333-retry-order"]')).toBeVisible();
});

test("my orders shows the empty state and remains responsive on iPhone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSupabaseStub(page, {
    user: { id: "customer-empty", email: "empty@example.com", user_metadata: {} },
    orders: [],
  });
  await page.goto("/my-orders.html", { waitUntil: "domcontentloaded" });

  await expect(page.getByText("Your order history is empty.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Start Shopping" })).toHaveAttribute("href", "products.html");
  await expectNoHorizontalOverflow(page);
});

test("signed-in account modal exposes My Orders while logged-out mode does not", async ({ page }) => {
  const user = { id: "account-orders-user", email: "orders@example.com", user_metadata: { full_name: "Orders User" } };
  await installSupabaseStub(page, { user: null, usersByEmail: { "orders@example.com": user } });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const accountButton = page.locator('.header-actions button[aria-label="Account"]');
  const myOrdersLink = page.locator("[data-my-orders-link]");
  await accountButton.click();
  await expect(myOrdersLink).toBeHidden();

  await page.locator("#login-email").fill("orders@example.com");
  await page.locator("#login-password").fill("valid-password");
  await page.locator("[data-login-form]").getByRole("button", { name: "Login", exact: true }).click();
  await expect(page.locator(".login-modal")).not.toHaveClass(/is-open/);
  await accountButton.click();
  await expect(myOrdersLink).toBeVisible();
  await expect(myOrdersLink).toHaveAttribute("href", "my-orders.html");
});

test("customer order history code remains read-only", async () => {
  const source = fs.readFileSync(path.join(process.cwd(), "script.js"), "utf8");
  const start = source.indexOf("function setMyOrdersView");
  const end = source.indexOf("function getCookieConsent", start);
  const customerOrdersSource = source.slice(start, end);

  expect(customerOrdersSource).toContain('.from("orders")');
  expect(customerOrdersSource).toContain('.eq("user_id", userId)');
  expect(customerOrdersSource).not.toMatch(/update_order_status|\.update\s*\(|\.delete\s*\(|\.insert\s*\(/);
  expect(customerOrdersSource).not.toMatch(/cancel order|delete order|edit address/i);
});

test("order writes are RPC-only in the frontend source", async () => {
  const source = fs.readFileSync(path.join(process.cwd(), "script.js"), "utf8");

  expect(source).toContain('supabaseClient.rpc("place_order"');
  expect(source).toContain('supabaseClient.rpc("update_order_status"');
  expect(source).toContain('supabaseClient.rpc("update_order_payment_status"');
  expect(source).toContain('supabaseClient.rpc("request_order_cancellation"');
  expect(source).toContain('supabaseClient.rpc("review_order_cancellation"');
  expect(source).not.toMatch(/\.from\(["']orders["']\)\s*\.insert\s*\(/s);
  expect(source).not.toMatch(/\.from\(["']order_items["']\)\s*\.insert\s*\(/s);
  expect(source).not.toMatch(/\.from\(["']orders["']\)\s*\.update\s*\(/s);
  expect(source).not.toMatch(/\.from\(["']orders["']\)[\s\S]*?payment_(?:method|status|collected_at)[\s\S]*?\.update\s*\(/s);
});

test("authenticated cart and wishlist are never persisted to localStorage", async () => {
  const source = fs.readFileSync(path.join(process.cwd(), "script.js"), "utf8");

  expect(source).toContain('writeStorage(getCartStorageKey(null), cart)');
  expect(source).toContain('writeStorage(getWishlistStorageKey(null), wishlist)');
  expect(source).not.toContain('writeStorage(getCartStorageKey(authUser)');
  expect(source).not.toContain('writeStorage(getWishlistStorageKey(authUser)');
  expect(source).toContain('"set_cart_item"');
  expect(source).toContain('"set_wishlist_item"');
});


test("account modal switches between login and register with frontend validation", async ({ page }) => {
  await page.addInitScript(() => {
    let currentUser = null;
    const listeners = [];
    const notify = () => listeners.forEach((listener) => listener("SIGNED_IN", currentUser ? { user: currentUser } : null));

    window.__attractionSupabaseClient = {
      auth: {
        getSession: async () => ({ data: { session: currentUser ? { user: currentUser } : null }, error: null }),
        onAuthStateChange: (callback) => {
          listeners.push(callback);
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
        signInWithPassword: async ({ email, password }) => {
          if (password === "wrong-password") {
            return { data: { user: null, session: null }, error: { message: "Invalid login credentials" } };
          }

          currentUser = {
            id: "demo-player-id",
            email,
            user_metadata: { full_name: "Demo Player", phone: "+91 98765 43210" },
          };
          notify();
          return { data: { user: currentUser, session: { user: currentUser } }, error: null };
        },
        signUp: async ({ email, options }) => ({
          data: { user: { email, user_metadata: options.data }, session: null },
          error: null,
        }),
        signOut: async () => {
          currentUser = null;
          listeners.forEach((listener) => listener("SIGNED_OUT", null));
          return { error: null };
        },
      },
    };
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const modal = page.locator(".login-modal");
  await page.locator('.header-actions button[aria-label="Account"]').click();
  await expect(modal).toHaveClass(/is-open/);
  await expect(modal.getByRole("heading", { name: /Login|Account/ })).toBeVisible();
  await expect(modal.getByText("New here?")).toBeVisible();

  await page.locator("#login-email").fill("demo@example.com");
  await page.locator("#login-password").fill("wrong-password");
  await modal.getByRole("button", { name: "Login", exact: true }).click();
  await expect(modal.getByText("Invalid login credentials.")).toBeVisible();

  await modal.getByRole("button", { name: "Create an account", exact: true }).click();
  await expect(modal.getByRole("heading", { name: "Register", exact: true })).toBeVisible();
  await expect(page.locator("#register-name")).toBeVisible();

  await page.locator("#register-name").fill("Demo Player");
  await page.locator("#register-email").fill("demo@example.com");
  await page.locator("#register-phone").fill("+91 98765 43210");
  await page.locator("#register-password").fill("NeonPass123");
  await page.locator("#register-confirm-password").fill("DifferentPass123");
  await modal.getByRole("button", { name: "Create Account", exact: true }).click();
  await expect(modal.getByText("Passwords do not match.")).toBeVisible();

  await page.locator("#register-confirm-password").fill("NeonPass123");
  await modal.getByRole("button", { name: "Create Account", exact: true }).click();
  await expect(modal.getByText("Account created successfully. Please check your email to confirm your account.")).toBeVisible();

  await modal.getByRole("button", { name: "Login", exact: true }).click();
  await expect(modal.getByRole("heading", { name: /Login|Account/ })).toBeVisible();
  await page.locator("#login-email").fill("demo@example.com");
  await page.locator("#login-password").fill("valid-password");
  await modal.getByRole("button", { name: "Login", exact: true }).click();
  await expect(modal).not.toHaveClass(/is-open/);

  await page.locator('.header-actions button[aria-label="Account"]').click();
  await expect(modal.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(modal.getByText("Logged in as:")).toBeVisible();
  await expect(modal.getByText("demo@example.com")).toBeVisible();

  await modal.getByRole("button", { name: "Logout", exact: true }).click();
  await expect(modal).not.toHaveClass(/is-open/);

  await page.locator('.header-actions button[aria-label="Account"]').click();
  await expect(modal.getByRole("heading", { name: "Login", exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(modal).not.toHaveClass(/is-open/);
  await expectNoHorizontalOverflow(page);
});
