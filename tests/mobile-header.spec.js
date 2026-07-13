const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

const screenshotDir = path.join(process.cwd(), "screenshots");

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


async function installSupabaseStub(page, options = {}) {
  await page.addInitScript((config) => {
    let currentUser = config.user || null;
    let remainingPlaceOrderFailures = Number(config.failPlaceOrderAttempts || 0);
    let remainingCartMergeFailures = Number(config.failCartMergeAttempts || 0);
    let remainingOrderLoadFailures = Number(config.failOrderLoadAttempts || 0);
    const listeners = [];
    const state = {
      rpcs: [],
      placeOrderCalls: [],
      statusUpdateCalls: [],
      paymentStatusUpdateCalls: [],
      cancellationRequestCalls: [],
      cancellationReviewCalls: [],
      inserts: [],
      updates: [],
      selects: [],
      cloudCarts: JSON.parse(JSON.stringify(config.cloudCarts || {})),
      cloudWishlists: JSON.parse(JSON.stringify(config.cloudWishlists || {})),
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

    const cartFor = (userId) => {
      if (!state.cloudCarts[userId]) state.cloudCarts[userId] = [];
      return state.cloudCarts[userId];
    };
    const wishlistFor = (userId) => {
      if (!state.cloudWishlists[userId]) state.cloudWishlists[userId] = [];
      return state.cloudWishlists[userId];
    };
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
        if (name === "is_admin") return { data: Boolean(config.isAdmin), error: config.adminError ? { message: config.adminError } : null };
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
            return { data: index >= 0, error: null };
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
          const filters = [];
          let orderBy = null;
          state.selects.push({ table, columns, filters });
          const execute = async () => {
            if (table === "cart_items") {
              if (config.failCartLoad) return { data: null, error: { message: "Cart load failed" } };
              const userId = filters.find(([column]) => column === "user_id")?.[1] || currentUser?.id;
              return { data: joinedCartRows(userId), error: null };
            }
            if (table === "wishlist_items") {
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
              if (orderBy) {
                rows.sort((first, second) => {
                  const firstValue = first[orderBy.column];
                  const secondValue = second[orderBy.column];
                  const direction = orderBy.ascending ? 1 : -1;
                  return String(firstValue).localeCompare(String(secondValue)) * direction;
                });
              }
              return { data: rows, error: null };
            }

            return { data: [], error: null };
          };
          const builder = {
            eq: (column, value) => {
              filters.push([column, value]);
              return builder;
            },
            order: (column, options = {}) => {
              orderBy = { column, ascending: options.ascending !== false };
              return execute();
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

test("same authenticated user sees cloud cart and wishlist changes across browser contexts", async ({ browser }) => {
  const cloud = createSharedCloudState();
  const user = {
    id: "cross-device-user",
    email: "cross-device@example.com",
    user_metadata: { full_name: "Cross Device User", phone: "+91 90000 00006" },
  };
  const contextOptions = {
    baseURL: "http://127.0.0.1:4173",
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
        order_items: [
          {
            product_image: "assets/hero-football-boot.avif",
            product_name: "Predator Elite FG",
            product_category: "Football Shoes",
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
      total_amount: 79.98,
      status: "Shipped",
      payment_method: "COD",
      payment_status: "Paid",
      payment_collected_at: "2026-07-11T12:00:00.000Z",
      order_items: [{
        id: "snapshot-item-1",
        order_id: "94227091-6585-4682-8d1b-0c7e000d7735",
        product_id: "historical-product",
        product_name: "Historical Match Tee",
        product_category: "T-Shirts",
        product_price: 39.99,
        quantity: 2,
        product_image: "assets/premium-football-tshirt.avif",
      }],
    }],
  });
  await page.goto("/my-orders.html", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "View Details" }).click();
  const modal = page.locator("[data-order-details-modal]");
  await expect(modal).toHaveClass(/is-open/);
  await expect(modal).toContainText("94227091-6585-4682-8d1b-0c7e000d7735");
  await expect(modal).toContainText("Historical Match Tee");
  await expect(modal).toContainText("$39.99 × 2");
  await expect(modal.locator(".customer-order-item b")).toHaveText("$79.98");
  await expect(modal.locator(".order-details-total strong")).toHaveText("$79.98");
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
