/* Attraction Football Store Interactions
   Features: cart, filters, search, carousel, mobile menu, wishlist, Supabase auth.
   Add Supabase JS before this file, then add before </body>: <script src="script.js" defer></script>
*/

(() => {
  "use strict";

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

  const STORAGE_KEYS = {
    cart: "attractionCart",
    wishlist: "attractionWishlist",
    cartMergeToken: "attractionCartMergeToken",
    variantCart: "attractionCartV2:guest",
    variantCartMergeToken: "attractionCartV2MergeToken",
    cookieConsent: "attractionCookieConsent",
    cookiePreferences: "attractionCookiePreferences",
  };
  const LEGACY_STORAGE_KEYS = {
    cart: "attraction_cart_v1",
    wishlist: "attraction_wishlist_v1",
  };
  const GUEST_STORAGE_ID = "guest";
  const MAX_CART_QUANTITY = 20;

  const SUPABASE_URL = "https://jvpejotupbiagwqqzzha.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_bax_rqRGPvefYdHe9hpvYw_LVKcuj5I";
  const supabaseClient =
    window.__attractionSupabaseClient ||
    (window.supabase?.createClient
      ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      : null);
  const VARIANT_UI_ENABLED = window.__ATTRACTION_FEATURES__?.variantUi === true;
  const VARIANT_CART_V2_ENABLED = VARIANT_UI_ENABLED
    && window.__ATTRACTION_FEATURES__?.variantCartV2 === true;
  const VARIANT_STOCK_STATES = new Set(["In Stock", "Low Stock", "Out of Stock"]);
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const VARIANT_LABEL_ORDER = {
    "Football Shoes": ["UK 6", "UK 7", "UK 8", "UK 9", "UK 10", "UK 11"],
    Jerseys: ["S", "M", "L", "XL", "XXL"],
    "T-Shirts": ["S", "M", "L", "XL", "XXL"],
    Footballs: ["Size 4", "Size 5"],
    Accessories: ["One Size"],
  };

  const readStorage = (key, fallback) => {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      return fallback;
    }
  };

  const writeStorage = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn("Storage unavailable", error);
      return false;
    }
  };

  const removeStorage = (key) => {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (error) {
      console.warn("Storage unavailable", error);
      return false;
    }
  };

  const hasStorageKey = (key) => {
    try {
      return localStorage.getItem(key) !== null;
    } catch (error) {
      return false;
    }
  };

  let cart = [];
  let variantCart = [];
  let pendingGuestMergeCart = [];
  let legacyVariantCart = [];
  let wishlist = [];
  let productLookup = new Map();
  let activeCategory = "All";
  let searchTerm = "";
  let currentSlide = 0;
  let authUser = null;
  let authReady = !supabaseClient;
  let authStateGeneration = 0;
  let authSessionPromise = Promise.resolve();
  let collectionOwnerId = null;
  let collectionLoadVersion = 0;
  let collectionSyncOwnerId = null;
  let collectionSyncPromise = null;
  let cartMutationQueue = Promise.resolve();
  const variantCartMutationQueues = new Map();
  let variantCartLoadVersion = 0;
  let variantCartErrorLogged = false;
  const automaticLegacyResolutions = new Set();
  let wishlistMutationQueue = Promise.resolve();
  let customerOrders = [];
  let myOrdersLoadVersion = 0;
  let activeCancellationOrderId = null;
  let cancellationRequestSubmitting = false;
  let adminAccessGeneration = 0;
  let adminInventoryLoadGeneration = 0;
  let adminInventoryRows = [];
  let adminInventoryMovements = [];
  let adminInventoryLoadedUserId = null;
  let adminAdjustmentState = null;
  let adminAdjustmentReturnFocus = null;
  const variantsByProductId = new Map();
  const selectedVariantByProductId = new Map();
  const variantLoadStateByProductId = new Map();
  const pendingVariantProductIds = new Set();
  const warnedVariantLabels = new Set();
  let variantLoadErrorLogged = false;

  const productCards = $$(".product-card");
  const cartButton = $(".cart-button");
  const cartCount = $(".cart-count");
  let wishlistButton = $(".wishlist-button");
  let wishlistCount = $(".wishlist-count");
  const searchButton = $('.header-actions button[aria-label="Search"]');
  const accountButton = $('.header-actions button[aria-label="Account"]');
  const header = $(".site-header");
  const mainNav = $(".main-nav");
  let menuToggle = $(".menu-toggle");
  let mobileDrawer = $(".mobile-drawer");
  let drawerOverlay = $(".drawer-overlay");

  const money = (number) => `${Number(number).toFixed(2)}`;
  const ORDER_STATUSES = ["Pending", "Confirmed", "Shipped", "Delivered", "Cancelled"];
  const ADMIN_ORDER_STATUSES = ["Pending", "Confirmed", "Shipped", "Delivered"];
  const PAYMENT_STATUSES = ["Unpaid", "Paid"];
  const CANCELLATION_REQUEST_STATUSES = ["None", "Pending", "Approved", "Rejected"];
  const CANCELLATION_WINDOW_MS = 24 * 60 * 60 * 1000;
  const ADMIN_INVENTORY_PAGE_SIZE = 200;
  const POSTGRESQL_INTEGER_MAX = 2147483647;

  const escapeHTML = (value = "") =>
    String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);

  const normalizePrice = (value) => Number(String(value || "0").replace(/[^0-9.]/g, "")) || 0;
  const PRODUCT_CARD_CONFIGURATION_ERROR = "Product card configuration error: missing data-product-id.";

  function hasProductIdentity(product) {
    if (String(product?.id || "").trim()) return true;
    console.error(PRODUCT_CARD_CONFIGURATION_ERROR);
    return false;
  }

  function disableProductCardCommerce(card) {
    [$(".wish", card), $(".js-add-cart", card)].filter(Boolean).forEach((control) => {
      control.disabled = true;
      control.setAttribute("aria-disabled", "true");
    });
  }

  function getProductFromCard(card, index = 0) {
    const name = $("h3", card)?.textContent.trim() || `Product ${index + 1}`;
    const category = $("p", card)?.textContent.trim() || "Product";
    const price = normalizePrice($("strong", card)?.textContent || "0");
    const id = String(card.dataset.productId || "").trim();
    const image = $("img", card)?.getAttribute("src") || "";

    return { id, name, category, price, image };
  }

  function normalizeVariantCategory(category = "") {
    const normalized = String(category).trim();
    return ({
      Jersey: "Jerseys",
      "T-Shirt": "T-Shirts",
      Football: "Footballs",
    })[normalized] || normalized;
  }

  function getVariantCards(root = document) {
    const cards = [];
    if (root instanceof Element && root.matches(".product-card[data-product-id]")) cards.push(root);
    if (root?.querySelectorAll) cards.push(...root.querySelectorAll(".product-card[data-product-id]"));
    return [...new Set(cards)];
  }

  function getVariantCategory(productId) {
    const card = $(`.product-card[data-product-id="${CSS.escape(productId)}"]`);
    return normalizeVariantCategory(card ? getProductFromCard(card).category : productLookup.get(productId)?.category);
  }

  function normalizeStorefrontVariant(row, requestedIds) {
    if (!row || typeof row !== "object") return null;

    const variantId = String(row.variant_id || "").trim();
    const productId = String(row.product_id || "").trim();
    const sku = String(row.sku || "").trim();
    const variantLabel = String(row.variant_label || "").trim();
    const purchasableQuantity = Number(row.purchasable_quantity);
    const lowStockThreshold = Number(row.low_stock_threshold);
    const stockState = String(row.stock_state || "").trim();
    const validQuantity = Number.isInteger(purchasableQuantity)
      && purchasableQuantity >= 0
      && purchasableQuantity <= MAX_CART_QUANTITY;
    const validThreshold = Number.isInteger(lowStockThreshold) && lowStockThreshold >= 0;
    const validStockState = stockState === "Out of Stock"
      ? purchasableQuantity === 0
      : stockState === "Low Stock"
        ? purchasableQuantity > 0 && purchasableQuantity <= lowStockThreshold
        : purchasableQuantity > 0;

    if (!UUID_PATTERN.test(variantId)
      || !productId
      || !requestedIds.has(productId)
      || !sku
      || !variantLabel
      || !validQuantity
      || !validThreshold
      || !VARIANT_STOCK_STATES.has(stockState)
      || !validStockState
      || row.product_is_active !== true
      || row.variant_is_active !== true) {
      return null;
    }

    return {
      variantId,
      productId,
      sku,
      variantLabel,
      purchasableQuantity,
      lowStockThreshold,
      stockState,
      productIsActive: true,
      variantIsActive: true,
    };
  }

  function sortStorefrontVariants(productId, variants) {
    const knownLabels = VARIANT_LABEL_ORDER[getVariantCategory(productId)] || [];
    return [...variants].sort((first, second) => {
      const firstIndex = knownLabels.indexOf(first.variantLabel);
      const secondIndex = knownLabels.indexOf(second.variantLabel);
      if (firstIndex !== -1 || secondIndex !== -1) {
        if (firstIndex === -1) return 1;
        if (secondIndex === -1) return -1;
        return firstIndex - secondIndex;
      }
      return first.variantLabel.localeCompare(second.variantLabel, undefined, { sensitivity: "base" });
    });
  }

  function warnForUnknownVariantLabels(productId, variants) {
    const knownLabels = VARIANT_LABEL_ORDER[getVariantCategory(productId)] || [];
    variants.forEach((variant) => {
      if (knownLabels.includes(variant.variantLabel)) return;
      const warningKey = `${productId}:${variant.variantLabel}`;
      if (warnedVariantLabels.has(warningKey)) return;
      warnedVariantLabels.add(warningKey);
      console.warn(`Variant configuration warning: unknown label "${variant.variantLabel}" for ${productId}.`);
    });
  }

  function prepareVariantPreviewCard(card) {
    if (!VARIANT_UI_ENABLED) return null;
    card.classList.add("variant-preview-card");

    const addButton = $(".js-add-cart", card);
    if (addButton) {
      addButton.disabled = true;
      addButton.setAttribute("aria-disabled", "true");
      addButton.textContent = VARIANT_CART_V2_ENABLED ? "Add to Cart" : "Variant cart not enabled yet";
    }

    let selector = $("[data-variant-selector]", card);
    if (selector) return selector;

    selector = document.createElement("section");
    selector.className = "variant-selector";
    selector.dataset.variantSelector = "";
    selector.innerHTML = `
      <div class="variant-selector__head">
        <span>Select size</span>
      </div>
      <div class="variant-selector__options" role="group"></div>
      <p class="variant-selector__message" aria-live="polite"></p>
    `;
    card.insertBefore(selector, addButton || null);
    return selector;
  }

  function renderVariantCard(card) {
    if (!VARIANT_UI_ENABLED) return;
    const productId = String(card.dataset.productId || "").trim();
    if (!productId) return;

    const selector = prepareVariantPreviewCard(card);
    if (!selector) return;
    const productName = getProductFromCard(card).name;
    const options = $(".variant-selector__options", selector);
    const message = $(".variant-selector__message", selector);
    const addButton = $(".js-add-cart", card);
    const state = variantLoadStateByProductId.get(productId) || "loading";
    options.setAttribute("aria-label", `Select size for ${productName}`);
    options.setAttribute("aria-busy", String(state === "loading"));

    if (state === "loading") {
      options.innerHTML = "";
      message.textContent = "Loading size options...";
      if (addButton) addButton.disabled = true;
      return;
    }
    if (state === "error") {
      options.innerHTML = "";
      message.textContent = "Variant options are unavailable.";
      if (addButton) addButton.disabled = true;
      return;
    }

    const variants = variantsByProductId.get(productId) || [];
    if (!variants.length) {
      options.innerHTML = "";
      message.textContent = "Currently unavailable";
      if (addButton) addButton.disabled = true;
      return;
    }

    const availableVariants = variants.filter((variant) => variant.purchasableQuantity > 0);
    let selectedVariantId = selectedVariantByProductId.get(productId);
    if (!availableVariants.some((variant) => variant.variantId === selectedVariantId)) {
      selectedVariantByProductId.delete(productId);
      selectedVariantId = null;
    }
    if (!selectedVariantId && variants.length === 1 && availableVariants.length === 1) {
      selectedVariantId = availableVariants[0].variantId;
      selectedVariantByProductId.set(productId, selectedVariantId);
    }

    options.innerHTML = variants.map((variant) => {
      const isOutOfStock = variant.purchasableQuantity === 0 || variant.stockState === "Out of Stock";
      const isSelected = variant.variantId === selectedVariantId;
      const status = variant.stockState === "Low Stock" || isOutOfStock
        ? `<span class="variant-option__state">${escapeHTML(variant.stockState)}</span>`
        : "";
      return `
        <button class="variant-option${isSelected ? " is-selected" : ""}${isOutOfStock ? " is-out-of-stock" : ""}"
          type="button"
          data-variant-id="${escapeHTML(variant.variantId)}"
          aria-pressed="${String(isSelected)}"
          ${isOutOfStock ? "disabled" : ""}>
          <span>${escapeHTML(variant.variantLabel)}</span>
          ${status}
        </button>
      `;
    }).join("");

    $$('[data-variant-id]', options).forEach((button) => {
      button.addEventListener("click", () => {
        selectedVariantByProductId.set(productId, button.dataset.variantId);
        renderVariantCardsForProduct(productId);
      });
    });

    if (!availableVariants.length) message.textContent = "Currently unavailable";
    else if (selectedVariantId) {
      const selected = variants.find((variant) => variant.variantId === selectedVariantId);
      message.textContent = `Selected: ${selected?.variantLabel || ""}`;
    } else message.textContent = "Select an available size.";

    if (addButton) {
      const canAdd = VARIANT_CART_V2_ENABLED && Boolean(selectedVariantId);
      addButton.disabled = !canAdd;
      addButton.setAttribute("aria-disabled", String(!canAdd));
      addButton.textContent = VARIANT_CART_V2_ENABLED ? "Add to Cart" : "Variant cart not enabled yet";
    }
  }

  function renderVariantCardsForProduct(productId) {
    $$(`.product-card[data-product-id="${CSS.escape(productId)}"]`).forEach(renderVariantCard);
  }

  async function loadStorefrontVariants(productIds) {
    if (!VARIANT_UI_ENABLED) return false;
    const uniqueIds = [...new Set(productIds.map((id) => String(id || "").trim()).filter(Boolean))];
    uniqueIds.forEach((productId) => {
      if (!variantLoadStateByProductId.has(productId)) variantLoadStateByProductId.set(productId, "loading");
    });
    const pendingIds = uniqueIds.filter((productId) => variantLoadStateByProductId.get(productId) === "loading"
      && !variantsByProductId.has(productId)
      && !pendingVariantProductIds.has(productId));
    if (!pendingIds.length) return true;
    pendingIds.forEach((productId) => pendingVariantProductIds.add(productId));

    if (!supabaseClient) {
      pendingIds.forEach((productId) => variantLoadStateByProductId.set(productId, "error"));
      pendingIds.forEach((productId) => pendingVariantProductIds.delete(productId));
      pendingIds.forEach(renderVariantCardsForProduct);
      if (!variantLoadErrorLogged) {
        variantLoadErrorLogged = true;
        console.error("Variant options are unavailable.");
      }
      return false;
    }

    const requestedIds = new Set(pendingIds);
    try {
      const { data, error } = await supabaseClient.rpc("get_storefront_variants", {
        p_product_ids: pendingIds,
      });
      if (error || !Array.isArray(data)) throw new Error("Variant RPC failed");

      const grouped = new Map(pendingIds.map((productId) => [productId, []]));
      let malformedRows = 0;
      data.forEach((row) => {
        const variant = normalizeStorefrontVariant(row, requestedIds);
        if (!variant) {
          malformedRows += 1;
          return;
        }
        grouped.get(variant.productId).push(variant);
      });
      if (malformedRows) console.warn(`Variant configuration warning: ignored ${malformedRows} malformed row(s).`);

      pendingIds.forEach((productId) => {
        const variants = sortStorefrontVariants(productId, grouped.get(productId) || []);
        warnForUnknownVariantLabels(productId, variants);
        variantsByProductId.set(productId, variants);
        variantLoadStateByProductId.set(productId, variants.length ? "ready" : "empty");
        pendingVariantProductIds.delete(productId);
        renderVariantCardsForProduct(productId);
      });
      if (VARIANT_CART_V2_ENABLED) {
        hydrateGuestVariantCartDetails();
        renderCartItems();
        void resolveAutomaticGuestLegacyItems();
      }
      return true;
    } catch (error) {
      pendingIds.forEach((productId) => variantLoadStateByProductId.set(productId, "error"));
      pendingIds.forEach((productId) => pendingVariantProductIds.delete(productId));
      pendingIds.forEach(renderVariantCardsForProduct);
      if (!variantLoadErrorLogged) {
        variantLoadErrorLogged = true;
        console.error("Variant options are unavailable.");
      }
      return false;
    }
  }

  async function hydrateVariantCards(root = document) {
    if (!VARIANT_UI_ENABLED) return;
    document.body.classList.add("variant-preview-enabled");
    if (VARIANT_CART_V2_ENABLED) document.body.classList.add("variant-cart-v2-enabled");
    const cards = getVariantCards(root);
    const productIds = [...new Set(cards.map((card) => String(card.dataset.productId || "").trim()).filter(Boolean))];
    if (!productIds.length) return;

    cards.forEach((card) => {
      const productId = String(card.dataset.productId || "").trim();
      if (!variantLoadStateByProductId.has(productId)) variantLoadStateByProductId.set(productId, "loading");
      renderVariantCard(card);
    });

    await loadStorefrontVariants(productIds);
  }

  function getStorageOwnerId(user = authUser) {
    return user?.id || GUEST_STORAGE_ID;
  }

  function getCartStorageKey(user = authUser) {
    return `${STORAGE_KEYS.cart}:${getStorageOwnerId(user)}`;
  }

  function getWishlistStorageKey(user = authUser) {
    return `${STORAGE_KEYS.wishlist}:${getStorageOwnerId(user)}`;
  }

  function getCartMergeTokenKey(userId, source) {
    return `${STORAGE_KEYS.cartMergeToken}:${userId}:${source}`;
  }

  function normalizeCartItems(items) {
    if (!Array.isArray(items)) return [];
    const normalized = [];

    items.forEach((rawItem) => {
      if (!rawItem || typeof rawItem !== "object") return;
      const id = String(rawItem.id || "").trim();
      if (!id) return;

      const product = productLookup.get(id) || {};
      const quantity = Math.min(
        MAX_CART_QUANTITY,
        Math.max(1, Number.parseInt(rawItem.qty, 10) || 1)
      );
      const existing = normalized.find((item) => item.id === id);
      if (existing) {
        existing.qty = Math.min(MAX_CART_QUANTITY, existing.qty + quantity);
        return;
      }

      normalized.push({
        id,
        name: rawItem.name || product.name || id.replace(/-/g, " "),
        category: rawItem.category || product.category || "Product",
        price: normalizePrice(rawItem.price ?? product.price ?? 0),
        image: rawItem.image || product.image || "",
        qty: quantity,
      });
    });

    return normalized;
  }

  function mergeCartItems(primary, secondary) {
    return normalizeCartItems([...normalizeCartItems(primary), ...normalizeCartItems(secondary)]);
  }

  function normalizeWishlistItems(items) {
    if (!Array.isArray(items)) return [];
    const normalized = [];

    items.forEach((item) => {
      const rawItem = typeof item === "string" ? { id: item } : item;
      if (!rawItem || typeof rawItem !== "object") return;

      const id = String(rawItem.id || "").trim();
      if (!id) return;

      const product = productLookup.get(id) || {};
      const nextItem = {
        id,
        name: rawItem.name || product.name || id.replace(/-/g, " "),
        category: rawItem.category || product.category || "Product",
        price: normalizePrice(rawItem.price ?? product.price ?? 0),
        image: rawItem.image || product.image || "",
      };

      if (!normalized.some((saved) => saved.id === id)) normalized.push(nextItem);
    });

    return normalized;
  }

  function mergeWishlistItems(primary, secondary) {
    return normalizeWishlistItems([...primary, ...secondary]);
  }

  function migrateLegacyStorageToGuest() {
    const cartStorageKey = getCartStorageKey(null);
    const legacyCart = normalizeCartItems(readStorage(LEGACY_STORAGE_KEYS.cart, []));
    if (legacyCart.length) {
      const migratedCart = mergeCartItems(readStorage(cartStorageKey, []), legacyCart);
      if (writeStorage(cartStorageKey, migratedCart)) removeStorage(LEGACY_STORAGE_KEYS.cart);
    } else if (hasStorageKey(LEGACY_STORAGE_KEYS.cart)) {
      removeStorage(LEGACY_STORAGE_KEYS.cart);
    }

    const wishlistStorageKey = getWishlistStorageKey(null);
    const legacyWishlistKeys = [LEGACY_STORAGE_KEYS.wishlist];

    legacyWishlistKeys.forEach((legacyKey) => {
      const legacyWishlist = normalizeWishlistItems(readStorage(legacyKey, []));
      if (legacyWishlist.length) {
        const migratedWishlist = mergeWishlistItems(readStorage(wishlistStorageKey, []), legacyWishlist);
        if (writeStorage(wishlistStorageKey, migratedWishlist)) removeStorage(legacyKey);
      } else if (hasStorageKey(legacyKey)) {
        removeStorage(legacyKey);
      }
    });
  }

  function refreshCollectionUI() {
    updateCartCount();
    renderCartItems();
    updateWishlistUI();
  }

  function saveGuestCart() {
    if (authUser?.id) {
      console.error("Refused to store an authenticated cart in localStorage.");
      return false;
    }
    cart = normalizeCartItems(cart);
    const saved = writeStorage(getCartStorageKey(null), cart);
    updateCartCount();
    renderCartItems();
    return saved;
  }

  function saveGuestWishlist() {
    if (authUser?.id) {
      console.error("Refused to store an authenticated wishlist in localStorage.");
      return false;
    }
    wishlist = normalizeWishlistItems(wishlist);
    const saved = writeStorage(getWishlistStorageKey(null), wishlist);
    updateWishlistUI();
    return saved;
  }

  function getJoinedProduct(row) {
    const joined = row?.products;
    return Array.isArray(joined) ? joined[0] : joined;
  }

  function normalizeCloudCartRows(rows) {
    if (!Array.isArray(rows)) return [];
    return normalizeCartItems(rows.flatMap((row) => {
      const product = getJoinedProduct(row);
      if (!product?.id || product.is_active === false) return [];
      return [{
        id: product.id,
        name: product.name,
        category: product.category,
        price: product.price,
        image: product.image,
        qty: row.quantity,
      }];
    }));
  }

  function normalizeCloudWishlistRows(rows) {
    if (!Array.isArray(rows)) return [];
    return normalizeWishlistItems(rows.flatMap((row) => {
      const product = getJoinedProduct(row);
      if (!product?.id || product.is_active === false) return [];
      return [{
        id: product.id,
        name: product.name,
        category: product.category,
        price: product.price,
        image: product.image,
      }];
    }));
  }

  function showSyncError(collection, error) {
    console.error(`${collection} synchronization failed`, error);
    showToast(`We could not sync your ${collection.toLowerCase()}. Please try again.`);
  }

  async function loadCloudCart(expectedUserId, { showError = true } = {}) {
    if (!supabaseClient || !expectedUserId) return false;

    try {
      const { data, error } = await supabaseClient
        .from("cart_items")
        .select("product_id,quantity,created_at,products!inner(id,name,category,price,image,is_active)")
        .eq("user_id", expectedUserId)
        .eq("products.is_active", true)
        .order("created_at", { ascending: true });
      if (error) throw error;
      if (authUser?.id !== expectedUserId || collectionOwnerId !== expectedUserId) return false;

      cart = normalizeCloudCartRows(data);
      updateCartCount();
      renderCartItems();
      return true;
    } catch (error) {
      if (showError && authUser?.id === expectedUserId) showSyncError("Cart", error);
      else console.error("Cart synchronization failed", error);
      return false;
    }
  }

  async function loadCloudWishlist(expectedUserId, { showError = true } = {}) {
    if (!supabaseClient || !expectedUserId) return false;

    try {
      const { data, error } = await supabaseClient
        .from("wishlist_items")
        .select("product_id,created_at,products!inner(id,name,category,price,image,is_active)")
        .eq("user_id", expectedUserId)
        .eq("products.is_active", true)
        .order("created_at", { ascending: true });
      if (error) throw error;
      if (authUser?.id !== expectedUserId || collectionOwnerId !== expectedUserId) return false;

      wishlist = normalizeCloudWishlistRows(data);
      updateWishlistUI();
      return true;
    } catch (error) {
      if (showError && authUser?.id === expectedUserId) showSyncError("Wishlist", error);
      else console.error("Wishlist synchronization failed", error);
      return false;
    }
  }

  function getVariantById(productId, variantId) {
    return (variantsByProductId.get(productId) || [])
      .find((variant) => variant.variantId === variantId) || null;
  }

  function getVariantProduct(productId) {
    return productLookup.get(productId) || {
      id: productId,
      name: productId.replace(/-/g, " "),
      category: "Product",
      price: 0,
      image: "",
    };
  }

  function normalizeGuestVariantCartItems(items) {
    if (!VARIANT_CART_V2_ENABLED || !Array.isArray(items)) return [];
    const normalized = [];
    const ownership = new Map();

    items.forEach((rawItem) => {
      if (!rawItem || typeof rawItem !== "object") return;
      const productId = String(rawItem.productId || "").trim();
      const productVariantId = String(rawItem.productVariantId || "").trim();
      const quantity = Number.parseInt(rawItem.quantity, 10);
      if (!productId || !UUID_PATTERN.test(productVariantId) || !Number.isInteger(quantity)) return;
      if (ownership.has(productVariantId) && ownership.get(productVariantId) !== productId) return;
      ownership.set(productVariantId, productId);

      const safeQuantity = Math.min(MAX_CART_QUANTITY, Math.max(1, quantity));
      const existing = normalized.find((item) => item.productVariantId === productVariantId);
      if (existing) {
        existing.quantity = Math.min(MAX_CART_QUANTITY, existing.quantity + safeQuantity);
        return;
      }
      normalized.push({ productId, productVariantId, quantity: safeQuantity });
    });

    return normalized;
  }

  function hydrateGuestVariantLine(item, source = "guest-v2") {
    const product = getVariantProduct(item.productId);
    const variant = getVariantById(item.productId, item.productVariantId);
    const variantState = variantLoadStateByProductId.get(item.productId);
    return {
      productId: item.productId,
      productVariantId: item.productVariantId,
      variantSku: variant?.sku || "",
      variantLabel: variant?.variantLabel || "Selected option",
      name: product.name,
      category: product.category,
      price: normalizePrice(product.price),
      image: product.image || "",
      quantity: item.quantity,
      productIsActive: true,
      variantIsActive: Boolean(variant),
      purchasableQuantity: variant?.purchasableQuantity ?? 0,
      availabilityState: variant?.stockState || (variantState === "loading" ? "Loading" : "Unavailable"),
      source,
    };
  }

  function hydrateGuestVariantCartDetails() {
    if (!VARIANT_CART_V2_ENABLED || authUser?.id) return;
    variantCart = normalizeGuestVariantCartItems(variantCart).map(hydrateGuestVariantLine);
    updateCartCount();
  }

  function serializeGuestVariantCart(items = variantCart) {
    return normalizeGuestVariantCartItems(items).map((item) => ({
      productId: item.productId,
      productVariantId: item.productVariantId,
      quantity: item.quantity,
    }));
  }

  function saveGuestVariantCart() {
    if (!VARIANT_CART_V2_ENABLED) return false;
    if (authUser?.id) {
      console.error("Refused to store an authenticated variant cart in localStorage.");
      return false;
    }
    const storedItems = serializeGuestVariantCart();
    const saved = writeStorage(STORAGE_KEYS.variantCart, storedItems);
    if (saved) variantCart = storedItems.map(hydrateGuestVariantLine);
    updateCartCount();
    renderCartItems();
    return saved;
  }

  function loadPendingGuestMergeCart(userId) {
    if (!VARIANT_CART_V2_ENABLED || authUser?.id !== userId) return [];
    return normalizeGuestVariantCartItems(readStorage(STORAGE_KEYS.variantCart, []))
      .map((item) => hydrateGuestVariantLine(item, "pending-guest-v2"));
  }

  function savePendingGuestMergeCart(userId) {
    if (!VARIANT_CART_V2_ENABLED || authUser?.id !== userId) return false;
    const storedItems = serializeGuestVariantCart(pendingGuestMergeCart);
    const saved = writeStorage(STORAGE_KEYS.variantCart, storedItems);
    if (saved) {
      pendingGuestMergeCart = storedItems
        .map((item) => hydrateGuestVariantLine(item, "pending-guest-v2"));
    }
    updateCartCount();
    renderCartItems();
    return saved;
  }

  function normalizeCloudVariantCartRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      const productId = String(row?.product_id || "").trim();
      const productVariantId = String(row?.product_variant_id || "").trim();
      const quantity = Number.parseInt(row?.quantity, 10);
      if (!productId || !UUID_PATTERN.test(productVariantId) || !Number.isInteger(quantity)) return [];
      return [{
        productId,
        productVariantId,
        variantSku: String(row.variant_sku || ""),
        variantLabel: String(row.variant_label || "Selected option"),
        name: String(row.product_name || productId.replace(/-/g, " ")),
        category: String(row.category || "Product"),
        price: normalizePrice(row.unit_price),
        image: String(row.image || ""),
        quantity: Math.min(MAX_CART_QUANTITY, Math.max(1, quantity)),
        productIsActive: row.product_is_active === true,
        variantIsActive: row.variant_is_active === true,
        purchasableQuantity: Math.min(MAX_CART_QUANTITY, Math.max(0, Number(row.purchasable_quantity) || 0)),
        availabilityState: String(row.stock_state || "Unavailable"),
        source: "authenticated-v2",
      }];
    });
  }

  function normalizeLegacyVariantCartRows(rows, source) {
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      const productId = String(row?.product_id ?? row?.id ?? "").trim();
      const quantity = Number.parseInt(row?.quantity ?? row?.qty, 10);
      if (!productId || !Number.isInteger(quantity)) return [];
      const product = getVariantProduct(productId);
      return [{
        source,
        productId,
        name: String(row.product_name || row.name || product.name),
        category: String(row.category || product.category),
        price: normalizePrice(row.unit_price ?? row.price ?? product.price),
        image: String(row.image || product.image || ""),
        quantity: Math.min(MAX_CART_QUANTITY, Math.max(1, quantity)),
        productIsActive: row.product_is_active !== false,
        activeVariantCount: Number.parseInt(row.active_variant_count, 10) || 0,
        automaticVariantId: String(row.automatic_variant_id || ""),
        automaticVariantSku: String(row.automatic_variant_sku || ""),
        automaticVariantLabel: String(row.automatic_variant_label || ""),
        resolutionStatus: String(row.resolution_status || ""),
      }];
    });
  }

  function getGuestLegacyVariantLines() {
    if (!VARIANT_CART_V2_ENABLED) return [];
    return normalizeLegacyVariantCartRows(
      normalizeCartItems(readStorage(getCartStorageKey(null), [])),
      "guest-legacy"
    );
  }

  function showVariantCartSyncError(error) {
    if (!variantCartErrorLogged) {
      variantCartErrorLogged = true;
      console.error("Variant cart synchronization failed", error);
    }
    showToast("We could not sync your cart. Please try again.");
  }

  async function loadAuthenticatedVariantCart(expectedUserId, { showError = true, resolveAutomatic = true } = {}) {
    if (!VARIANT_CART_V2_ENABLED || !supabaseClient || !expectedUserId) return false;
    const version = ++variantCartLoadVersion;
    try {
      const [cartResult, legacyResult] = await Promise.all([
        supabaseClient.rpc("get_cart_v2"),
        supabaseClient.rpc("get_legacy_cart_items_v2"),
      ]);
      if (cartResult.error) throw cartResult.error;
      if (legacyResult.error) throw legacyResult.error;
      if (authUser?.id !== expectedUserId || version !== variantCartLoadVersion) return false;

      variantCart = normalizeCloudVariantCartRows(cartResult.data);
      legacyVariantCart = [
        ...normalizeLegacyVariantCartRows(legacyResult.data, "authenticated-legacy"),
        ...getGuestLegacyVariantLines(),
      ];
      variantCartErrorLogged = false;
      updateCartCount();
      renderCartItems();
      const legacyProductIds = legacyVariantCart
        .filter((item) => item.resolutionStatus !== "Automatic")
        .map((item) => item.productId);
      if (legacyProductIds.length) void loadStorefrontVariants(legacyProductIds);
      if (resolveAutomatic) void resolveAutomaticAuthenticatedLegacyItems(expectedUserId);
      return true;
    } catch (error) {
      if (showError && authUser?.id === expectedUserId) showVariantCartSyncError(error);
      else console.error("Variant cart synchronization failed", error);
      return false;
    }
  }

  function loadGuestVariantCollections() {
    if (!VARIANT_CART_V2_ENABLED) return;
    variantCart = normalizeGuestVariantCartItems(readStorage(STORAGE_KEYS.variantCart, []))
      .map(hydrateGuestVariantLine);
    legacyVariantCart = getGuestLegacyVariantLines();
    const productIds = [...variantCart, ...legacyVariantCart].map((item) => item.productId);
    updateCartCount();
    renderCartItems();
    if (productIds.length) {
      void loadStorefrontVariants(productIds).then(() => {
        hydrateGuestVariantCartDetails();
        renderCartItems();
        return resolveAutomaticGuestLegacyItems();
      });
    }
  }

  function getVariantMergeTokenKey(userId, source = "resolved") {
    return `${STORAGE_KEYS.variantCartMergeToken}:${userId}:${source}`;
  }

  function getVariantMergeSignature(items) {
    return JSON.stringify([...items]
      .sort((first, second) => first.productVariantId.localeCompare(second.productVariantId))
      .map((item) => [item.productId, item.productVariantId, item.quantity]));
  }

  function removeMergedGuestVariantPayload(items) {
    const mergedVariantIds = new Set(items.map((item) => item.productVariantId));
    const currentItems = normalizeGuestVariantCartItems(readStorage(STORAGE_KEYS.variantCart, []));
    const remainingItems = currentItems.filter((item) => !mergedVariantIds.has(item.productVariantId));
    const persisted = remainingItems.length
      ? writeStorage(STORAGE_KEYS.variantCart, remainingItems)
      : removeStorage(STORAGE_KEYS.variantCart);
    if (!persisted) return false;

    const verifiedItems = normalizeGuestVariantCartItems(readStorage(STORAGE_KEYS.variantCart, []));
    return verifiedItems.every((item) => !mergedVariantIds.has(item.productVariantId));
  }

  async function mergeGuestVariantCartToCloud(userId) {
    if (!VARIANT_CART_V2_ENABLED || !supabaseClient || !userId) {
      return { ok: false, serverMerged: false };
    }
    const items = normalizeGuestVariantCartItems(readStorage(STORAGE_KEYS.variantCart, []));
    if (!items.length) {
      const payloadRemoved = !hasStorageKey(STORAGE_KEYS.variantCart)
        || removeStorage(STORAGE_KEYS.variantCart);
      if (payloadRemoved) removeStorage(getVariantMergeTokenKey(userId));
      return { ok: payloadRemoved, serverMerged: false };
    }

    const signature = getVariantMergeSignature(items);
    const tokenKey = getVariantMergeTokenKey(userId);
    let receipt = readStorage(tokenKey, null);
    if (!receipt || receipt.signature !== signature || !UUID_PATTERN.test(String(receipt.token || ""))) {
      receipt = { token: crypto.randomUUID(), signature };
      if (!writeStorage(tokenKey, receipt)) return { ok: false, serverMerged: false };
    }

    const { error } = await supabaseClient.rpc("merge_guest_cart_v2", {
      p_items: items,
      p_merge_token: receipt.token,
    });
    if (error) {
      console.error("Variant guest cart merge failed", error);
      return { ok: false, serverMerged: false };
    }

    if (!removeMergedGuestVariantPayload(items)) {
      console.error("Variant guest cart merged, but its local payload could not be removed safely.");
      return { ok: false, serverMerged: true };
    }
    removeStorage(tokenKey);
    return { ok: true, serverMerged: true };
  }

  function removeGuestLegacyStorageItem(productId) {
    const current = normalizeCartItems(readStorage(getCartStorageKey(null), []));
    const next = current.filter((item) => item.id !== productId);
    return writeStorage(getCartStorageKey(null), next);
  }

  async function resolveGuestLegacyLine(line, variantId) {
    const variant = getVariantById(line.productId, variantId);
    if (!variant || variant.purchasableQuantity < 1) {
      showToast("Selected option is unavailable.");
      return false;
    }

    if (authUser?.id) {
      const userId = authUser.id;
      const items = [{ productId: line.productId, productVariantId: variant.variantId, quantity: line.quantity }];
      const signature = getVariantMergeSignature(items);
      const tokenKey = getVariantMergeTokenKey(userId, `legacy:${line.productId}`);
      let receipt = readStorage(tokenKey, null);
      if (!receipt || receipt.signature !== signature || !UUID_PATTERN.test(String(receipt.token || ""))) {
        receipt = { token: crypto.randomUUID(), signature };
        if (!writeStorage(tokenKey, receipt)) return false;
      }
      const { error } = await supabaseClient.rpc("merge_guest_cart_v2", {
        p_items: items,
        p_merge_token: receipt.token,
      });
      if (error || authUser?.id !== userId) {
        if (error && authUser?.id === userId) showVariantCartSyncError(error);
        return false;
      }
      if (!removeGuestLegacyStorageItem(line.productId)) return false;
      removeStorage(tokenKey);
      return loadAuthenticatedVariantCart(userId, { resolveAutomatic: false });
    }

    const previousCart = serializeGuestVariantCart(variantCart)
      .map((item) => hydrateGuestVariantLine(item));
    const existing = variantCart.find((item) => item.productVariantId === variant.variantId);
    variantCart = existing
      ? variantCart.map((item) => (item.productVariantId === variant.variantId
        ? { ...item, quantity: Math.min(MAX_CART_QUANTITY, item.quantity + line.quantity) }
        : item))
      : [...variantCart, hydrateGuestVariantLine({
        productId: line.productId,
        productVariantId: variant.variantId,
        quantity: line.quantity,
      })];
    if (!saveGuestVariantCart() || !removeGuestLegacyStorageItem(line.productId)) {
      variantCart = previousCart;
      saveGuestVariantCart();
      return false;
    }
    legacyVariantCart = getGuestLegacyVariantLines();
    updateCartCount();
    renderCartItems();
    return true;
  }

  async function resolveAuthenticatedLegacyLine(line, variantId) {
    const userId = authUser?.id;
    if (!VARIANT_CART_V2_ENABLED || !userId || !supabaseClient) return false;
    try {
      const { error } = await supabaseClient.rpc("resolve_legacy_cart_item_v2", {
        p_product_id: line.productId,
        p_product_variant_id: variantId,
      });
      if (error) throw error;
      if (authUser?.id !== userId) return false;
      return loadAuthenticatedVariantCart(userId, { resolveAutomatic: false });
    } catch (error) {
      if (authUser?.id === userId) showVariantCartSyncError(error);
      return false;
    }
  }

  async function resolveLegacyVariantLine(line, variantId) {
    if (!line || !UUID_PATTERN.test(String(variantId || ""))) return false;
    return line.source === "authenticated-legacy"
      ? resolveAuthenticatedLegacyLine(line, variantId)
      : resolveGuestLegacyLine(line, variantId);
  }

  async function resolveAutomaticAuthenticatedLegacyItems(userId) {
    if (!VARIANT_CART_V2_ENABLED || authUser?.id !== userId) return;
    const automatic = legacyVariantCart.filter((item) => item.source === "authenticated-legacy"
      && item.resolutionStatus === "Automatic"
      && UUID_PATTERN.test(item.automaticVariantId));
    for (const line of automatic) {
      const key = `${userId}:${line.productId}`;
      if (automaticLegacyResolutions.has(key)) continue;
      automaticLegacyResolutions.add(key);
      try {
        await resolveAuthenticatedLegacyLine(line, line.automaticVariantId);
      } finally {
        automaticLegacyResolutions.delete(key);
      }
    }
  }

  async function resolveAutomaticGuestLegacyItems() {
    if (!VARIANT_CART_V2_ENABLED) return;
    const automatic = legacyVariantCart.filter((item) => item.source === "guest-legacy")
      .filter((item) => (variantsByProductId.get(item.productId) || []).length === 1);
    for (const line of automatic) {
      const variant = (variantsByProductId.get(line.productId) || [])[0];
      const key = `guest:${line.productId}`;
      if (!variant || automaticLegacyResolutions.has(key)) continue;
      automaticLegacyResolutions.add(key);
      try {
        await resolveGuestLegacyLine(line, variant.variantId);
      } finally {
        automaticLegacyResolutions.delete(key);
      }
    }
  }

  async function migrateCartStorageKey(userId, storageKey, source) {
    const items = normalizeCartItems(readStorage(storageKey, []));
    const tokenKey = getCartMergeTokenKey(userId, source);
    if (!items.length) {
      if (hasStorageKey(storageKey)) removeStorage(storageKey);
      removeStorage(tokenKey);
      return true;
    }

    let mergeToken = readStorage(tokenKey, null);
    if (!mergeToken) {
      mergeToken = crypto.randomUUID();
      if (!writeStorage(tokenKey, mergeToken)) {
        console.error("Cart migration token could not be persisted", { storageKey, userId });
        return false;
      }
    }

    const payload = {
      p_items: items.map((item) => ({ product_id: item.id, quantity: item.qty })),
      p_merge_token: mergeToken,
    };
    const { error } = await supabaseClient.rpc("merge_guest_cart", payload);
    if (error) {
      console.error("Cart migration RPC failed", { error, storageKey, userId });
      return false;
    }

    removeStorage(storageKey);
    removeStorage(tokenKey);
    return true;
  }

  async function migrateWishlistStorageKey(userId, storageKey) {
    const items = normalizeWishlistItems(readStorage(storageKey, []));
    if (!items.length) {
      if (hasStorageKey(storageKey)) removeStorage(storageKey);
      return true;
    }

    const { error } = await supabaseClient.rpc("merge_guest_wishlist", {
      p_items: items.map((item) => ({ product_id: item.id })),
    });
    if (error) {
      console.error("Wishlist migration RPC failed", { error, storageKey, userId });
      return false;
    }

    removeStorage(storageKey);
    return true;
  }

  async function migrateLocalCollectionsToCloud(user) {
    if (!supabaseClient || !user?.id) return false;

    const cartResults = [];
    cartResults.push(await migrateCartStorageKey(user.id, getCartStorageKey(user), "user"));
    cartResults.push(await migrateCartStorageKey(user.id, getCartStorageKey(null), "guest"));
    cartResults.push(await migrateCartStorageKey(user.id, LEGACY_STORAGE_KEYS.cart, "legacy"));

    const wishlistResults = [];
    wishlistResults.push(await migrateWishlistStorageKey(user.id, getWishlistStorageKey(user)));
    wishlistResults.push(await migrateWishlistStorageKey(user.id, getWishlistStorageKey(null)));
    wishlistResults.push(await migrateWishlistStorageKey(user.id, LEGACY_STORAGE_KEYS.wishlist));
    wishlistResults.push(await migrateWishlistStorageKey(
      user.id,
      `${LEGACY_STORAGE_KEYS.wishlist}:${user.id}`
    ));

    const migrated = [...cartResults, ...wishlistResults].every(Boolean);
    if (!migrated && authUser?.id === user.id) {
      showToast("Some saved items could not sync. They will be retried after your next login.");
    }
    return migrated;
  }

  function migrateLegacyWishlistToGuest() {
    const wishlistStorageKey = getWishlistStorageKey(null);
    [LEGACY_STORAGE_KEYS.wishlist].forEach((legacyKey) => {
      const legacyWishlist = normalizeWishlistItems(readStorage(legacyKey, []));
      if (legacyWishlist.length) {
        const migrated = mergeWishlistItems(readStorage(wishlistStorageKey, []), legacyWishlist);
        if (writeStorage(wishlistStorageKey, migrated)) removeStorage(legacyKey);
      } else if (hasStorageKey(legacyKey)) removeStorage(legacyKey);
    });
  }

  function loadGuestWishlistOnly({ migrateLegacy = true } = {}) {
    if (migrateLegacy) migrateLegacyWishlistToGuest();
    wishlist = normalizeWishlistItems(readStorage(getWishlistStorageKey(null), []));
    updateWishlistUI();
  }

  async function migrateWishlistCollectionsToCloud(user) {
    if (!supabaseClient || !user?.id) return false;
    const results = [];
    results.push(await migrateWishlistStorageKey(user.id, getWishlistStorageKey(user)));
    results.push(await migrateWishlistStorageKey(user.id, getWishlistStorageKey(null)));
    results.push(await migrateWishlistStorageKey(user.id, LEGACY_STORAGE_KEYS.wishlist));
    results.push(await migrateWishlistStorageKey(user.id, `${LEGACY_STORAGE_KEYS.wishlist}:${user.id}`));
    return results.every(Boolean);
  }

  function loadGuestCollections({ migrateLegacy = true } = {}) {
    if (migrateLegacy) migrateLegacyStorageToGuest();
    collectionOwnerId = GUEST_STORAGE_ID;
    cart = normalizeCartItems(readStorage(getCartStorageKey(null), []));
    wishlist = normalizeWishlistItems(readStorage(getWishlistStorageKey(null), []));
    refreshCollectionUI();
  }

  async function activateVariantCollectionOwner(user, { migrate = true } = {}) {
    const expectedOwnerId = user?.id || GUEST_STORAGE_ID;
    const version = ++collectionLoadVersion;
    const ownerChanged = collectionOwnerId !== expectedOwnerId;
    collectionOwnerId = expectedOwnerId;

    if (ownerChanged) {
      cart = [];
      variantCart = [];
      pendingGuestMergeCart = [];
      legacyVariantCart = [];
      wishlist = [];
      refreshCollectionUI();
    }

    if (!user?.id) {
      if (version !== collectionLoadVersion) return false;
      loadGuestWishlistOnly({ migrateLegacy: migrate });
      loadGuestVariantCollections();
      return true;
    }

    let migrationsSucceeded = true;
    let variantMigrated = true;
    let variantMergeOutcome = { ok: true, serverMerged: false };
    if (migrate) {
      const migrationResults = await Promise.all([
        mergeGuestVariantCartToCloud(user.id),
        migrateWishlistCollectionsToCloud(user),
      ]);
      [variantMergeOutcome] = migrationResults;
      variantMigrated = variantMergeOutcome.ok;
      const wishlistMigrated = migrationResults[1];
      migrationsSucceeded = variantMigrated && wishlistMigrated;
      if (!migrationsSucceeded && authUser?.id === user.id) {
        showToast("Some saved items could not sync. They will be retried after your next login.");
      }
    }
    if (version !== collectionLoadVersion || authUser?.id !== user.id) return false;

    const [cartLoaded, wishlistLoaded] = await Promise.all([
      loadAuthenticatedVariantCart(user.id),
      loadCloudWishlist(user.id),
    ]);
    pendingGuestMergeCart = !variantMigrated
      && !variantMergeOutcome.serverMerged
      && authUser?.id === user.id
      ? loadPendingGuestMergeCart(user.id)
      : [];
    if (authUser?.id === user.id) {
      updateCartCount();
      renderCartItems();
    }
    return migrationsSucceeded && cartLoaded && wishlistLoaded;
  }

  async function activateCollectionOwner(user, { migrate = true } = {}) {
    if (VARIANT_CART_V2_ENABLED) return activateVariantCollectionOwner(user, { migrate });
    const expectedOwnerId = user?.id || GUEST_STORAGE_ID;
    const version = ++collectionLoadVersion;
    const ownerChanged = collectionOwnerId !== expectedOwnerId;
    collectionOwnerId = expectedOwnerId;

    if (ownerChanged) {
      cart = [];
      wishlist = [];
      refreshCollectionUI();
    }

    if (!user?.id) {
      if (version === collectionLoadVersion) loadGuestCollections({ migrateLegacy: migrate });
      return true;
    }

    if (migrate) await migrateLocalCollectionsToCloud(user);
    if (version !== collectionLoadVersion || authUser?.id !== user.id) return false;

    const [cartLoaded, wishlistLoaded] = await Promise.all([
      loadCloudCart(user.id),
      loadCloudWishlist(user.id),
    ]);
    return cartLoaded && wishlistLoaded;
  }

  function synchronizeCollectionOwner(user, options = {}) {
    const ownerId = user?.id || GUEST_STORAGE_ID;
    if (collectionSyncPromise && collectionSyncOwnerId === ownerId) return collectionSyncPromise;

    collectionSyncOwnerId = ownerId;
    const pending = activateCollectionOwner(user, options);
    const tracked = pending.finally(() => {
      if (collectionSyncPromise === tracked) {
        collectionSyncPromise = null;
        collectionSyncOwnerId = null;
      }
    });
    collectionSyncPromise = tracked;
    return tracked;
  }

  function enqueueCartMutation(operation) {
    const pending = cartMutationQueue.then(operation, operation);
    cartMutationQueue = pending.catch(() => {});
    return pending;
  }

  function enqueueVariantCartMutation(productVariantId, operation) {
    const previous = variantCartMutationQueues.get(productVariantId) || Promise.resolve();
    const pending = previous.then(operation, operation);
    const tracked = pending.catch(() => {});
    variantCartMutationQueues.set(productVariantId, tracked);
    return pending.finally(() => {
      if (variantCartMutationQueues.get(productVariantId) === tracked) {
        variantCartMutationQueues.delete(productVariantId);
      }
    });
  }

  function enqueueWishlistMutation(operation) {
    const pending = wishlistMutationQueue.then(operation, operation);
    wishlistMutationQueue = pending.catch(() => {});
    return pending;
  }

  function isWishlisted(id) {
    return wishlist.some((item) => item.id === id);
  }

  function injectInteractionStyles() {
    const style = document.createElement("style");
    style.textContent = `
      body.no-scroll { overflow: hidden; }
      .menu-toggle {
        width: 34px !important;
        height: 34px !important;
        border: 1px solid rgba(207,255,32,.32) !important;
        border-radius: 8px !important;
        background: rgba(207,255,32,.08) !important;
        color: var(--text) !important;
        display: none !important;
        place-items: center !important;
        gap: 4px !important;
      }
      .menu-toggle span,
      .menu-toggle::before,
      .menu-toggle::after {
        content: "";
        width: 16px;
        height: 2px;
        display: block;
        background: currentColor;
        border-radius: 99px;
      }
      .mobile-panel,
      .cart-drawer,
      .wishlist-drawer,
      .login-modal,
      .search-modal {
        position: fixed;
        inset: 0;
        z-index: 999;
        pointer-events: none;
      }
      .mobile-panel::before,
      .cart-drawer::before,
      .wishlist-drawer::before,
      .login-modal::before,
      .search-modal::before {
        content: "";
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,.68);
        opacity: 0;
        transition: opacity .25s ease;
      }
      .mobile-panel.is-open,
      .cart-drawer.is-open,
      .wishlist-drawer.is-open,
      .login-modal.is-open,
      .search-modal.is-open {
        pointer-events: auto;
      }
      .mobile-panel.is-open::before,
      .cart-drawer.is-open::before,
      .wishlist-drawer.is-open::before,
      .login-modal.is-open::before,
      .search-modal.is-open::before {
        opacity: 1;
      }
      .mobile-panel__content,
      .cart-drawer__content,
      .wishlist-drawer__content {
        position: absolute;
        top: 0;
        right: 0;
        width: min(92vw, 430px);
        height: 100%;
        padding: 30px;
        background: linear-gradient(180deg, #101216, #050607);
        border-left: 1px solid rgba(255,255,255,.14);
        box-shadow: -30px 0 80px rgba(0,0,0,.65);
        transform: translateX(105%);
        transition: transform .28s ease;
        overflow-y: auto;
      }
      .mobile-panel.is-open .mobile-panel__content,
      .cart-drawer.is-open .cart-drawer__content,
      .wishlist-drawer.is-open .wishlist-drawer__content {
        transform: translateX(0);
      }
      .drawer-head,
      .modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 28px;
      }
      .drawer-head h3,
      .modal-head h3 {
        margin: 0;
        font-family: var(--font-heading);
        font-size: 34px;
        text-transform: uppercase;
      }
      .close-btn {
        width: 36px;
        height: 36px;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 9px;
        color: var(--text);
        background: rgba(255,255,255,.05);
        cursor: pointer;
        font-size: 20px;
      }
      .mobile-panel nav {
        display: grid;
        gap: 18px;
      }
      .mobile-panel nav a {
        padding: 17px 0;
        border-bottom: 1px solid rgba(255,255,255,.1);
        text-transform: uppercase;
        font-size: 14px;
        font-weight: 900;
        letter-spacing: .06em;
      }
      .filter-wrap {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
        margin: 0 16px 24px;
      }
      .filter-btn,
      .js-add-cart,
      .cart-checkout,
      .clear-cart-btn,
      .login-submit,
      .search-clear {
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 999px;
        background: rgba(255,255,255,.04);
        color: var(--text);
        cursor: pointer;
        font-size: 12px;
        font-weight: 900;
        letter-spacing: .04em;
        text-transform: uppercase;
        transition: transform .2s ease, border-color .2s ease, background .2s ease;
      }
      .filter-btn {
        padding: 11px 17px;
      }
      .filter-btn:hover,
      .filter-btn.is-active {
        color: #080900;
        border-color: var(--lime);
        background: var(--lime);
      }
      .js-add-cart {
        width: 100%;
        margin-top: 18px;
        padding: 13px 16px;
        color: #080900;
        border-color: var(--lime);
        background: linear-gradient(135deg, var(--lime), #e2ff57);
      }
      .js-add-cart:hover,
      .cart-checkout:hover,
      .login-submit:hover {
        transform: translateY(-2px);
      }
      .wish.is-active {
        color: var(--lime);
        transform: scale(1.08);
      }
      .cart-item,
      .wishlist-item {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 14px;
        padding: 17px 0;
        border-bottom: 1px solid rgba(255,255,255,.1);
      }
      .cart-item h4,
      .wishlist-item h4 {
        margin: 0 0 7px;
        font-size: 14px;
        text-transform: uppercase;
      }
      .cart-item p,
      .wishlist-item p {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
      }
      .cart-controls {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 9px;
      }
      .cart-controls button {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 1px solid rgba(255,255,255,.16);
        background: rgba(255,255,255,.06);
        color: var(--text);
        cursor: pointer;
      }
      .wishlist-item {
        grid-template-columns: 76px 1fr;
        align-items: center;
      }
      .wishlist-item img {
        width: 76px;
        height: 76px;
        object-fit: contain;
        border: 1px solid rgba(255,255,255,.1);
        border-radius: 12px;
        background: radial-gradient(circle, rgba(207,255,32,.12), rgba(255,255,255,.03));
      }
      .wishlist-item-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 9px;
        margin-top: 12px;
      }
      .wishlist-item-actions button,
      .wishlist-view-all,
      .wishlist-shop-link,
      .wishlist-page-remove {
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 999px;
        background: rgba(255,255,255,.05);
        color: var(--text);
        cursor: pointer;
        font-size: 11px;
        font-weight: 900;
        letter-spacing: .04em;
        padding: 10px 14px;
        text-transform: uppercase;
      }
      .wishlist-item-actions [data-wishlist-add-cart],
      .wishlist-shop-link {
        color: #080900;
        border-color: var(--lime);
        background: var(--lime);
      }
      .wishlist-view-all {
        display: grid;
        place-items: center;
        text-decoration: none;
      }
      .wishlist-button {
        color: var(--lime) !important;
      }
      .wishlist-count {
        position: absolute;
        top: -10px;
        right: -10px;
        width: 18px;
        height: 18px;
        border-radius: 999px;
        border: 2px solid var(--bg);
        background: var(--lime);
        color: #101010;
        display: grid;
        place-items: center;
        font-size: 10px;
        font-weight: 900;
      }
      .cart-total {
        display: flex;
        justify-content: space-between;
        margin: 26px 0 18px;
        font-size: 20px;
        font-weight: 900;
      }
      .cart-checkout,
      .login-submit {
        width: 100%;
        padding: 15px 18px;
        color: #080900;
        border-color: var(--lime);
        background: linear-gradient(135deg, var(--lime), #e2ff57);
      }
      .clear-cart-btn {
        width: 100%;
        margin-top: 12px;
        padding: 13px 18px;
        border-radius: 8px;
      }
      .empty-message,
      .no-product-message {
        color: var(--muted);
        line-height: 1.7;
        text-align: center;
        padding: 34px 20px;
        border: 1px dashed rgba(255,255,255,.15);
        border-radius: 14px;
        background: rgba(255,255,255,.03);
      }
      .login-modal__box,
      .search-modal__box {
        position: absolute;
        left: 50%;
        top: 50%;
        width: min(92vw, 480px);
        padding: 28px;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 18px;
        background: linear-gradient(180deg, #12141a, #070809);
        box-shadow: 0 30px 90px rgba(0,0,0,.72);
        transform: translate(-50%, -45%) scale(.96);
        opacity: 0;
        transition: transform .25s ease, opacity .25s ease;
      }
      .login-modal__box {
        width: min(94vw, 520px);
        max-height: min(90vh, 760px);
        overflow-y: auto;
      }
      .login-modal.is-open .login-modal__box,
      .search-modal.is-open .search-modal__box {
        transform: translate(-50%, -50%) scale(1);
        opacity: 1;
      }
      .login-form[hidden],
      .register-form[hidden] {
        display: none;
      }
      .form-field {
        display: grid;
        gap: 8px;
        margin-bottom: 16px;
      }
      .form-field label {
        font-size: 12px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: .07em;
      }
      .form-field input,
      .search-modal input {
        width: 100%;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 10px;
        padding: 15px 16px;
        background: rgba(255,255,255,.05);
        color: var(--text);
        outline: 0;
      }
      .form-field input:focus,
      .search-modal input:focus {
        border-color: var(--lime);
      }
      .login-note,
      .search-note {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
        margin: 14px 0 0;
      }
      .auth-switch {
        margin: 16px 0 0;
        color: #d7d9d3;
        font-size: 13px;
        line-height: 1.5;
        text-align: center;
      }
      .auth-link {
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--lime);
        cursor: pointer;
        font-weight: 900;
        text-transform: none;
      }
      .auth-link:hover {
        text-decoration: underline;
      }
      .auth-message {
        margin: 0 0 14px;
        padding: 12px 14px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 800;
        line-height: 1.45;
      }
      .auth-error {
        border: 1px solid rgba(255,92,92,.36);
        color: #ffd7d7;
        background: rgba(255,92,92,.12);
      }
      .auth-success {
        border: 1px solid rgba(207,255,32,.36);
        color: var(--lime);
        background: rgba(207,255,32,.1);
      }
      .account-panel[hidden] {
        display: none;
      }
      .account-panel h4 {
        margin: 8px 0 8px;
        font-family: var(--font-heading);
        font-size: 30px;
        line-height: 1;
        text-transform: uppercase;
      }
      .account-panel .login-submit {
        margin-top: 18px;
      }
      .toast {
        position: fixed;
        left: 50%;
        bottom: 28px;
        z-index: 1200;
        min-width: min(92vw, 330px);
        padding: 14px 18px;
        border: 1px solid rgba(207,255,32,.35);
        border-radius: 999px;
        color: var(--text);
        background: rgba(8,10,8,.95);
        box-shadow: 0 18px 50px rgba(0,0,0,.55);
        text-align: center;
        transform: translate(-50%, 22px);
        opacity: 0;
        pointer-events: none;
        transition: opacity .22s ease, transform .22s ease;
      }
      .toast.show {
        opacity: 1;
        transform: translate(-50%, 0);
      }
      .slider-actions {
        position: absolute;
        right: 0;
        bottom: 72px;
        z-index: 5;
        display: flex;
        gap: 10px;
      }
      .slider-actions button {
        width: 42px;
        height: 42px;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 10px;
        color: var(--text);
        background: rgba(255,255,255,.06);
        cursor: pointer;
      }
      .search-clear {
        margin-top: 14px;
        padding: 12px 16px;
        border-radius: 8px;
      }
      .cookie-banner {
        position: fixed;
        left: 50%;
        bottom: 22px;
        z-index: 980;
        width: min(1120px, calc(100vw - 32px));
        display: grid;
        grid-template-columns: 1fr auto;
        align-items: center;
        gap: 18px;
        padding: 18px;
        border: 1px solid rgba(207,255,32,.32);
        border-radius: 18px;
        background:
          radial-gradient(circle at 12% 0%, rgba(207,255,32,.14), transparent 34%),
          linear-gradient(135deg, rgba(16,18,22,.98), rgba(5,7,6,.98));
        box-shadow: 0 22px 70px rgba(0,0,0,.62);
        transform: translate(-50%, calc(100% + 32px));
        opacity: 0;
        pointer-events: none;
        transition: opacity .25s ease, transform .25s ease;
      }
      .cookie-banner.is-visible {
        transform: translate(-50%, 0);
        opacity: 1;
        pointer-events: auto;
      }
      .cookie-banner__copy {
        display: grid;
        gap: 6px;
      }
      .cookie-banner__copy strong {
        font-family: var(--font-heading);
        font-size: 24px;
        line-height: 1;
        text-transform: uppercase;
      }
      .cookie-banner__copy p {
        margin: 0;
        max-width: 760px;
        color: #d9ddd1;
        font-size: 14px;
        line-height: 1.55;
      }
      .cookie-banner__actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: 10px;
      }
      .cookie-banner button,
      .cookie-banner a,
      .cookie-preferences-modal button {
        min-height: 42px;
        border-radius: 9px;
        padding: 11px 15px;
        font-size: 11px;
        font-weight: 900;
        letter-spacing: .04em;
        text-transform: uppercase;
        text-decoration: none;
      }
      .cookie-accept,
      .cookie-save,
      .cookie-accept-all {
        border: 1px solid var(--lime);
        color: #080900;
        background: var(--lime);
      }
      .cookie-manage,
      .cookie-policy-link {
        border: 1px solid rgba(255,255,255,.16);
        color: var(--text);
        background: rgba(255,255,255,.06);
      }
      .cookie-preferences-modal {
        position: fixed;
        inset: 0;
        z-index: 1001;
        opacity: 0;
        pointer-events: none;
        transition: opacity .22s ease;
      }
      .cookie-preferences-modal::before {
        content: "";
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,.7);
      }
      .cookie-preferences-modal.is-open {
        opacity: 1;
        pointer-events: auto;
      }
      .cookie-preferences__box {
        position: absolute;
        left: 50%;
        top: 50%;
        width: min(92vw, 520px);
        padding: 28px;
        border: 1px solid rgba(207,255,32,.28);
        border-radius: 18px;
        background: linear-gradient(180deg, #12151a, #070907);
        box-shadow: 0 30px 90px rgba(0,0,0,.72);
        transform: translate(-50%, -47%) scale(.96);
        transition: transform .22s ease;
      }
      .cookie-preferences-modal.is-open .cookie-preferences__box {
        transform: translate(-50%, -50%) scale(1);
      }
      .cookie-preferences__box h3 {
        margin: 0;
        font-family: var(--font-heading);
        font-size: 32px;
        line-height: 1;
        text-transform: uppercase;
      }
      .cookie-preferences__intro {
        margin: 12px 0 20px;
        color: var(--muted);
        line-height: 1.6;
      }
      .cookie-option {
        display: grid;
        gap: 6px;
        margin: 12px 0;
        padding: 14px;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 12px;
        background: rgba(255,255,255,.04);
      }
      .cookie-option__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        color: var(--text);
        font-weight: 900;
      }
      .cookie-option p {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }
      .cookie-option input {
        width: 18px;
        height: 18px;
        accent-color: var(--lime);
      }
      .cookie-option__status {
        color: var(--lime);
        font-size: 12px;
        font-weight: 900;
        text-transform: uppercase;
      }
      .cookie-preferences__actions {
        display: flex;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 20px;
      }
      @media (max-width: 900px) {
        .menu-toggle { display: grid !important; }
      }
      @media (max-width: 560px) {
        .filter-wrap { margin-inline: 0; }
        .mobile-panel__content,
        .cart-drawer__content,
        .wishlist-drawer__content { padding: 22px; }
        .login-modal__box {
          width: min(94vw, 360px);
          padding: 22px;
          border-radius: 14px;
        }
        .login-modal__box .modal-head {
          margin-bottom: 22px;
        }
        .login-modal__box .modal-head h3 {
          font-size: 28px;
        }
        .form-field {
          margin-bottom: 14px;
        }
        .form-field input {
          min-height: 48px;
          padding: 13px 14px;
        }
        .cookie-banner {
          bottom: 14px;
          width: calc(100vw - 24px);
          grid-template-columns: 1fr;
          align-items: stretch;
          padding: 16px;
          border-radius: 14px;
        }
        .cookie-banner__copy strong {
          font-size: 22px;
        }
        .cookie-banner__actions {
          justify-content: stretch;
        }
        .cookie-banner__actions > * {
          flex: 1 1 120px;
          display: grid;
          place-items: center;
        }
        .cookie-preferences__box {
          width: min(94vw, 370px);
          padding: 22px;
          border-radius: 14px;
        }
        .cookie-preferences__box h3 {
          font-size: 28px;
        }
        .cookie-preferences__actions {
          display: grid;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function collectProducts() {
    productLookup = new Map();

    productCards.forEach((card, index) => {
      const product = getProductFromCard(card, index);
      const filter = card.dataset.filter || product.category;

      card.dataset.index = String(index);
      card.dataset.name = product.name;
      card.dataset.category = product.category;
      card.dataset.filter = filter;
      card.dataset.price = String(product.price);
      card.dataset.image = product.image;
      let addButton = $(`.js-add-cart`, card);
      if (!addButton) {
        const button = document.createElement("button");
        button.className = "js-add-cart";
        button.type = "button";
        button.textContent = "Add to Cart";
        card.appendChild(button);
        addButton = button;
      }

      if (!product.id) {
        console.error(PRODUCT_CARD_CONFIGURATION_ERROR);
        disableProductCardCommerce(card);
        return;
      }

      productLookup.set(product.id, product);
      if (VARIANT_UI_ENABLED) {
        prepareVariantPreviewCard(card);
        if (VARIANT_CART_V2_ENABLED) addButton.addEventListener("click", () => addToCart(product));
      } else addButton.addEventListener("click", () => addToCart(product));
    });
  }

  function showToast(message) {
    let toast = $(".toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1800);
  }

  function setAdminView(page, state, message = "") {
    const loading = $("[data-admin-loading]", page);
    const login = $("[data-admin-login-state]", page);
    const denied = $("[data-admin-denied]", page);
    const dashboard = $("[data-admin-dashboard]", page);
    [loading, login, denied, dashboard].forEach((element) => {
      if (element) element.hidden = true;
    });
    const target = {
      loading,
      login,
      denied,
      dashboard,
    }[state];
    if (target) target.hidden = false;
    if (message && target) {
      const messageNode = $("[data-admin-state-message]", target);
      if (messageNode) messageNode.textContent = message;
    }
  }

  function showAdminFeedback(page, type, message) {
    const feedback = $("[data-admin-feedback]", page);
    if (!feedback) return;
    feedback.textContent = message;
    feedback.className = `admin-feedback admin-feedback--${type}`;
    feedback.hidden = false;
  }

  function hideAdminFeedback(page) {
    const feedback = $("[data-admin-feedback]", page);
    if (!feedback) return;
    feedback.hidden = true;
    feedback.textContent = "";
  }

  function formatOrderDate(value) {
    if (!value) return "Not available";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function getRelatedRecord(value) {
    return Array.isArray(value) ? value[0] || null : value || null;
  }

  function getAdminInventoryStockState(row) {
    if (!row.variantActive || !row.productActive) return "Inactive";
    if (row.stockQuantity === 0) return "Out of Stock";
    if (row.stockQuantity <= row.lowStockThreshold) return "Low Stock";
    return "In Stock";
  }

  function normalizeAdminInventoryRow(row) {
    const product = getRelatedRecord(row?.products);
    const stockQuantity = Number(row?.stock_quantity);
    const lowStockThreshold = Number(row?.low_stock_threshold);
    const normalized = {
      id: String(row?.id || ""),
      productId: String(row?.product_id || product?.id || ""),
      productName: String(product?.name || row?.product_name || row?.product_id || "Unknown Product"),
      category: String(product?.category || row?.category || "Uncategorized"),
      image: String(product?.image || row?.image || "assets/hero-football-boot.avif"),
      productActive: product?.is_active !== false,
      sku: String(row?.sku || ""),
      variantLabel: String(row?.variant_label || ""),
      stockQuantity: Number.isInteger(stockQuantity) && stockQuantity >= 0 ? stockQuantity : 0,
      lowStockThreshold: Number.isInteger(lowStockThreshold) && lowStockThreshold >= 0 ? lowStockThreshold : 0,
      variantActive: row?.is_active === true,
      updatedAt: String(row?.updated_at || ""),
    };
    normalized.effectiveActive = normalized.productActive && normalized.variantActive;
    normalized.stockState = getAdminInventoryStockState(normalized);
    normalized.variantState = normalized.variantActive
      ? normalized.productActive ? "Active" : "Product Inactive"
      : "Inactive";
    return normalized;
  }

  function normalizeAdminInventoryMovement(row) {
    const variant = getRelatedRecord(row?.product_variants);
    const product = getRelatedRecord(variant?.products);
    const delta = Number(row?.quantity_delta);
    const resultingStock = Number(row?.resulting_stock_quantity);
    return {
      id: String(row?.id || ""),
      productVariantId: String(row?.product_variant_id || variant?.id || ""),
      productId: String(variant?.product_id || product?.id || ""),
      productName: String(product?.name || variant?.product_id || "Unknown Product"),
      category: String(product?.category || "Uncategorized"),
      variantLabel: String(variant?.variant_label || "Unknown Variant"),
      sku: String(variant?.sku || "Not available"),
      movementType: String(row?.movement_type || "Inventory Movement"),
      quantityDelta: Number.isInteger(delta) ? delta : 0,
      resultingStock: Number.isInteger(resultingStock) ? resultingStock : 0,
      reason: String(row?.reason || "No reason recorded"),
      orderId: row?.order_id ? String(row.order_id) : "",
      createdAt: String(row?.created_at || ""),
    };
  }

  function getAdminInventoryMetrics(rows) {
    const activeRows = rows.filter((row) => row.effectiveActive);
    return {
      products: new Set(rows.map((row) => row.productId).filter(Boolean)).size,
      variants: rows.length,
      stock: rows.reduce((total, row) => total + row.stockQuantity, 0),
      low: activeRows.filter((row) => row.stockState === "Low Stock").length,
      out: activeRows.filter((row) => row.stockState === "Out of Stock").length,
      inactive: rows.filter((row) => !row.effectiveActive).length,
    };
  }

  function getAdminInventoryStatusClass(value) {
    return String(value || "").toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
  }

  function updateAdminInventoryMetrics(page) {
    const metrics = getAdminInventoryMetrics(adminInventoryRows);
    Object.entries(metrics).forEach(([name, value]) => {
      const node = $(`[data-inventory-metric="${name}"]`, page);
      if (node) node.textContent = Number(value).toLocaleString("en-IN");
    });
  }

  function updateAdminInventoryCategories(page) {
    const select = $("[data-inventory-category]", page);
    if (!select) return;
    const currentValue = select.value;
    const categories = [...new Set(adminInventoryRows.map((row) => row.category).filter(Boolean))]
      .sort((first, second) => first.localeCompare(second));
    select.innerHTML = `<option value="all">All Categories</option>${categories
      .map((category) => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`)
      .join("")}`;
    select.value = categories.includes(currentValue) ? currentValue : "all";
  }

  function getFilteredAdminInventoryRows(page) {
    const search = String($("[data-inventory-search]", page)?.value || "").trim().toLowerCase();
    const category = $("[data-inventory-category]", page)?.value || "all";
    const stockState = $("[data-inventory-stock-filter]", page)?.value || "all";
    const activeState = $("[data-inventory-active-filter]", page)?.value || "all";
    const sort = $("[data-inventory-sort]", page)?.value || "product";

    const rows = adminInventoryRows.filter((row) => {
      const searchable = [row.productName, row.productId, row.sku, row.variantLabel]
        .join(" ")
        .toLowerCase();
      if (search && !searchable.includes(search)) return false;
      if (category !== "all" && row.category !== category) return false;
      if (stockState !== "all" && row.stockState !== stockState) return false;
      if (activeState === "active" && !row.effectiveActive) return false;
      if (activeState === "inactive" && row.effectiveActive) return false;
      return true;
    });

    const compareText = (first, second) => first.localeCompare(second, undefined, { numeric: true });
    rows.sort((first, second) => {
      if (sort === "sku") return compareText(first.sku, second.sku);
      if (sort === "stock-asc") return first.stockQuantity - second.stockQuantity || compareText(first.sku, second.sku);
      if (sort === "stock-desc") return second.stockQuantity - first.stockQuantity || compareText(first.sku, second.sku);
      if (sort === "updated") {
        return new Date(second.updatedAt || 0).getTime() - new Date(first.updatedAt || 0).getTime()
          || compareText(first.sku, second.sku);
      }
      return compareText(first.productName, second.productName)
        || compareText(first.variantLabel, second.variantLabel);
    });
    return rows;
  }

  function renderAdminInventoryRows(page) {
    const rows = getFilteredAdminInventoryRows(page);
    const tableBody = $("[data-inventory-table-body]", page);
    const mobileList = $("[data-inventory-mobile-list]", page);
    const empty = $("[data-inventory-empty]", page);
    const tableWrap = $("[data-inventory-table-wrap]", page);
    const resultCount = $("[data-inventory-result-count]", page);
    if (resultCount) resultCount.textContent = `${rows.length.toLocaleString("en-IN")} ${rows.length === 1 ? "variant" : "variants"}`;
    if (empty) empty.hidden = rows.length > 0;
    if (tableWrap) tableWrap.hidden = rows.length === 0;
    if (mobileList) mobileList.hidden = rows.length === 0;

    const renderButton = (row) => `
      <button class="admin-inventory-adjust-button" type="button" data-inventory-adjust="${escapeHTML(row.id)}" aria-label="Adjust stock for ${escapeHTML(row.productName)}, ${escapeHTML(row.variantLabel)}">Adjust Stock</button>
    `;
    const renderBadge = (value, type = "stock") => `
      <span class="admin-inventory-badge admin-inventory-badge--${type}-${getAdminInventoryStatusClass(value)}">${escapeHTML(value)}</span>
    `;

    if (tableBody) {
      tableBody.innerHTML = rows.map((row) => `
        <tr data-inventory-row="${escapeHTML(row.id)}">
          <td>
            <div class="admin-inventory-product">
              <img src="${escapeHTML(row.image)}" alt="" loading="lazy" decoding="async" />
              <div><strong>${escapeHTML(row.productName)}</strong><small>${escapeHTML(row.productId)}${row.productActive ? "" : " · Product Inactive"}</small></div>
            </div>
          </td>
          <td>${escapeHTML(row.category)}</td>
          <td><strong>${escapeHTML(row.variantLabel)}</strong></td>
          <td><code>${escapeHTML(row.sku)}</code></td>
          <td class="numeric" data-inventory-stock-value>${row.stockQuantity.toLocaleString("en-IN")}</td>
          <td class="numeric">${row.lowStockThreshold.toLocaleString("en-IN")}</td>
          <td>${renderBadge(row.stockState)}</td>
          <td>${renderBadge(row.variantState, "variant")}</td>
          <td><time datetime="${escapeHTML(row.updatedAt)}">${escapeHTML(formatOrderDate(row.updatedAt))}</time></td>
          <td>${renderButton(row)}</td>
        </tr>
      `).join("");
    }

    if (mobileList) {
      mobileList.innerHTML = rows.map((row) => `
        <article class="admin-inventory-mobile-card" data-inventory-row="${escapeHTML(row.id)}">
          <div class="admin-inventory-mobile-head">
            <div class="admin-inventory-product">
              <img src="${escapeHTML(row.image)}" alt="" loading="lazy" decoding="async" />
              <div><strong>${escapeHTML(row.productName)}</strong><small>${escapeHTML(row.category)}</small></div>
            </div>
            ${renderBadge(row.stockState)}
          </div>
          <dl>
            <div><dt>Product ID</dt><dd>${escapeHTML(row.productId)}</dd></div>
            <div><dt>Variant</dt><dd>${escapeHTML(row.variantLabel)}</dd></div>
            <div><dt>SKU</dt><dd><code>${escapeHTML(row.sku)}</code></dd></div>
            <div><dt>Current Stock</dt><dd data-inventory-stock-value>${row.stockQuantity.toLocaleString("en-IN")}</dd></div>
            <div><dt>Low-Stock Threshold</dt><dd>${row.lowStockThreshold.toLocaleString("en-IN")}</dd></div>
            <div><dt>Variant Status</dt><dd>${renderBadge(row.variantState, "variant")}</dd></div>
            <div><dt>Last Updated</dt><dd>${escapeHTML(formatOrderDate(row.updatedAt))}</dd></div>
          </dl>
          ${renderButton(row)}
        </article>
      `).join("");
    }
  }

  function getAdminInventoryActivityRows(page) {
    const search = String($("[data-inventory-activity-search]", page)?.value || "").trim().toLowerCase();
    const movementType = $("[data-inventory-movement-filter]", page)?.value || "all";
    const selectedDate = $("[data-inventory-activity-date]", page)?.value || "";
    return adminInventoryMovements.filter((movement) => {
      const searchable = [movement.productName, movement.productId, movement.sku, movement.variantLabel]
        .join(" ")
        .toLowerCase();
      if (search && !searchable.includes(search)) return false;
      if (movementType !== "all" && movement.movementType !== movementType) return false;
      if (selectedDate) {
        const createdAt = new Date(movement.createdAt);
        if (Number.isNaN(createdAt.getTime())) return false;
        const localDate = [
          createdAt.getFullYear(),
          String(createdAt.getMonth() + 1).padStart(2, "0"),
          String(createdAt.getDate()).padStart(2, "0"),
        ].join("-");
        if (localDate !== selectedDate) return false;
      }
      return true;
    });
  }

  function formatInventoryDelta(value) {
    if (value > 0) return `+${value}`;
    if (value < 0) return `\u2212${Math.abs(value)}`;
    return "0";
  }

  function renderAdminInventoryActivity(page) {
    const rows = getAdminInventoryActivityRows(page);
    const list = $("[data-inventory-activity-list]", page);
    const empty = $("[data-inventory-activity-empty]", page);
    const count = $("[data-inventory-activity-count]", page);
    if (count) count.textContent = `${rows.length.toLocaleString("en-IN")} ${rows.length === 1 ? "movement" : "movements"}`;
    if (empty) empty.hidden = rows.length > 0;
    if (!list) return;
    list.hidden = rows.length === 0;
    list.innerHTML = rows.map((movement) => `
      <article class="admin-inventory-activity-item">
        <div class="admin-inventory-activity-time">
          <time datetime="${escapeHTML(movement.createdAt)}">${escapeHTML(formatOrderDate(movement.createdAt))}</time>
          <span class="admin-inventory-movement-type admin-inventory-movement-type--${getAdminInventoryStatusClass(movement.movementType)}">${escapeHTML(movement.movementType)}</span>
        </div>
        <div class="admin-inventory-activity-product">
          <strong>${escapeHTML(movement.productName)}</strong>
          <span>${escapeHTML(movement.variantLabel)} · <code>${escapeHTML(movement.sku)}</code></span>
        </div>
        <div class="admin-inventory-activity-quantity">
          <strong aria-label="Quantity change ${movement.quantityDelta}">${escapeHTML(formatInventoryDelta(movement.quantityDelta))}</strong>
          <span>Resulting stock: ${movement.resultingStock.toLocaleString("en-IN")}</span>
        </div>
        <div class="admin-inventory-activity-reason">
          <span>${escapeHTML(movement.reason)}</span>
          ${movement.orderId ? `<small>Order: ${escapeHTML(movement.orderId)}</small>` : ""}
        </div>
      </article>
    `).join("");
  }

  function renderAdminInventory(page) {
    updateAdminInventoryMetrics(page);
    updateAdminInventoryCategories(page);
    renderAdminInventoryRows(page);
    renderAdminInventoryActivity(page);
  }

  function setAdminInventoryView(page, state) {
    const loading = $("[data-inventory-loading]", page);
    const error = $("[data-inventory-error]", page);
    const content = $("[data-inventory-content]", page);
    if (loading) loading.hidden = state !== "loading";
    if (error) error.hidden = state !== "error";
    if (content) content.hidden = state !== "content";
  }

  function showAdminInventoryFeedback(page, type, message) {
    const feedback = $("[data-inventory-feedback]", page);
    if (!feedback) return;
    feedback.textContent = message;
    feedback.className = `admin-inventory-feedback admin-inventory-feedback--${type}`;
    feedback.hidden = !message;
  }

  function resetAdminInventoryFilters(page) {
    const resetValues = {
      "[data-inventory-search]": "",
      "[data-inventory-category]": "all",
      "[data-inventory-stock-filter]": "all",
      "[data-inventory-active-filter]": "all",
      "[data-inventory-sort]": "product",
      "[data-inventory-activity-search]": "",
      "[data-inventory-movement-filter]": "all",
      "[data-inventory-activity-date]": "",
    };
    Object.entries(resetValues).forEach(([selector, value]) => {
      const control = $(selector, page);
      if (control) control.value = value;
    });
    const category = $("[data-inventory-category]", page);
    if (category) category.innerHTML = '<option value="all">All Categories</option>';
  }

  function resetAdminTabView(page) {
    $$("[data-admin-tab]", page).forEach((tab) => {
      const selected = tab.dataset.adminTab === "orders";
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (tab.dataset.adminTab === "inventory") tab.hidden = true;
    });
    $$("[data-admin-panel]", page).forEach((panel) => {
      panel.hidden = panel.dataset.adminPanel !== "orders";
    });
  }

  function resetAdminInventoryState(page) {
    adminInventoryLoadGeneration += 1;
    adminInventoryRows = [];
    adminInventoryMovements = [];
    adminInventoryLoadedUserId = null;
    if (page) {
      delete page.dataset.adminAuthorizedUserId;
      setAdminInventoryView(page, "loading");
      showAdminInventoryFeedback(page, "", "");
      resetAdminInventoryFilters(page);
      resetAdminTabView(page);
      const tableBody = $("[data-inventory-table-body]", page);
      const mobileList = $("[data-inventory-mobile-list]", page);
      const activityList = $("[data-inventory-activity-list]", page);
      $$('[data-inventory-metric]', page).forEach((metric) => { metric.textContent = "0"; });
      const resultCount = $("[data-inventory-result-count]", page);
      const activityCount = $("[data-inventory-activity-count]", page);
      if (resultCount) resultCount.textContent = "0 variants";
      if (activityCount) activityCount.textContent = "0 movements";
      if (tableBody) tableBody.innerHTML = "";
      if (mobileList) mobileList.innerHTML = "";
      if (activityList) activityList.innerHTML = "";
    }
    closeAdminInventoryAdjustment(true);
  }

  function invalidateAdminAccessForAuthChange() {
    adminAccessGeneration += 1;
    const page = $("[data-admin-page]");
    if (!page || page.dataset.adminBound !== "true") {
      adminInventoryLoadGeneration += 1;
      adminInventoryRows = [];
      adminInventoryMovements = [];
      adminInventoryLoadedUserId = null;
      closeAdminInventoryAdjustment(true);
      return;
    }
    page.dataset.adminChecking = "false";
    setAdminView(page, "loading");
    hideAdminFeedback(page);
    resetAdminInventoryState(page);
    const ordersContainer = $("[data-admin-orders]", page);
    if (ordersContainer) ordersContainer.innerHTML = "";
  }

  function isAdminInventoryRequestCurrent(page, userId, loadGeneration, accessGeneration) {
    return Boolean(
      page
      && loadGeneration === adminInventoryLoadGeneration
      && accessGeneration === adminAccessGeneration
      && authUser?.id === userId
      && page.dataset.adminAuthorizedUserId === userId
    );
  }

  async function loadAllAdminInventoryVariants(page, userId, loadGeneration, accessGeneration) {
    const rowsById = new Map();
    const pageSignatures = new Set();
    let offset = 0;

    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      if (!isAdminInventoryRequestCurrent(page, userId, loadGeneration, accessGeneration)) return null;
      const { data, error } = await supabaseClient
        .from("product_variants")
        .select("id,product_id,sku,variant_label,stock_quantity,low_stock_threshold,is_active,updated_at,products!inner(id,name,category,image,is_active)")
        .order("product_id", { ascending: true })
        .order("variant_label", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + ADMIN_INVENTORY_PAGE_SIZE - 1);
      if (!isAdminInventoryRequestCurrent(page, userId, loadGeneration, accessGeneration)) return null;
      if (error) throw error;

      const pageRows = Array.isArray(data) ? data : [];
      const signature = JSON.stringify([
        pageRows.length,
        String(pageRows[0]?.id || ""),
        String(pageRows.at(-1)?.id || ""),
      ]);
      if (pageRows.length === ADMIN_INVENTORY_PAGE_SIZE && pageSignatures.has(signature)) {
        throw new Error("Inventory pagination returned a repeated page");
      }
      pageSignatures.add(signature);
      pageRows.forEach((row) => {
        const id = String(row?.id || "");
        if (id && !rowsById.has(id)) rowsById.set(id, row);
      });
      if (pageRows.length < ADMIN_INVENTORY_PAGE_SIZE) return [...rowsById.values()];
      offset += ADMIN_INVENTORY_PAGE_SIZE;
    }
    throw new Error("Inventory pagination exceeded its safe page limit");
  }

  async function loadAdminInventory(page, { background = false } = {}) {
    const userId = authUser?.id;
    if (!page || !userId || page.dataset.adminAuthorizedUserId !== userId || !supabaseClient) return false;
    const loadGeneration = ++adminInventoryLoadGeneration;
    const accessGeneration = adminAccessGeneration;
    if (!background) setAdminInventoryView(page, "loading");
    showAdminInventoryFeedback(page, "", "");

    try {
      const [variantRows, movementResult] = await Promise.all([
        loadAllAdminInventoryVariants(page, userId, loadGeneration, accessGeneration),
        supabaseClient
          .from("inventory_movements")
          .select("id,product_variant_id,order_id,movement_type,quantity_delta,resulting_stock_quantity,reason,created_at,product_variants!inner(id,product_id,sku,variant_label,products!inner(id,name,category))")
          .order("created_at", { ascending: false })
          .limit(100),
      ]);

      if (!isAdminInventoryRequestCurrent(page, userId, loadGeneration, accessGeneration) || !variantRows) return false;
      if (movementResult.error) throw movementResult.error;

      adminInventoryRows = variantRows.map(normalizeAdminInventoryRow);
      const movementsById = new Map();
      (movementResult.data || []).forEach((movement) => {
        const normalized = normalizeAdminInventoryMovement(movement);
        if (normalized.id && !movementsById.has(normalized.id)) movementsById.set(normalized.id, normalized);
      });
      adminInventoryMovements = [...movementsById.values()]
        .sort((first, second) => (
          new Date(second.createdAt || 0) - new Date(first.createdAt || 0)
          || second.id.localeCompare(first.id)
        ));
      adminInventoryLoadedUserId = userId;
      renderAdminInventory(page);
      setAdminInventoryView(page, "content");
      return true;
    } catch (error) {
      if (!isAdminInventoryRequestCurrent(page, userId, loadGeneration, accessGeneration)) return false;
      console.error("Admin inventory could not be loaded", error);
      if (background && adminInventoryLoadedUserId === userId) {
        setAdminInventoryView(page, "content");
        showAdminInventoryFeedback(page, "error", "Inventory could not be refreshed. Please try again.");
      } else setAdminInventoryView(page, "error");
      return false;
    }
  }

  function setAdminTab(page, tabName, { focus = false } = {}) {
    if (!page || page.dataset.adminAuthorizedUserId !== authUser?.id) return;
    const tabs = $$('[data-admin-tab]', page);
    const panels = $$('[data-admin-panel]', page);
    tabs.forEach((tab) => {
      const selected = tab.dataset.adminTab === tabName;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.adminPanel !== tabName;
    });
    if (tabName === "inventory" && adminInventoryLoadedUserId !== authUser?.id) {
      void loadAdminInventory(page);
    }
  }

  function getAdminAdjustmentModal() {
    return $("[data-inventory-adjust-modal]");
  }

  function setAdminAdjustmentFeedback(message, type = "error") {
    const modal = getAdminAdjustmentModal();
    const feedback = $("[data-adjust-feedback]", modal || document);
    if (!feedback) return;
    feedback.textContent = message;
    feedback.className = `admin-inventory-adjust-feedback admin-inventory-adjust-feedback--${type}`;
    feedback.hidden = !message;
  }

  function populateAdminAdjustmentSummary(variant) {
    const modal = getAdminAdjustmentModal();
    if (!modal || !variant) return;
    const values = {
      "[data-adjust-product-name]": variant.productName,
      "[data-adjust-product-id]": variant.productId,
      "[data-adjust-variant-label]": variant.variantLabel,
      "[data-adjust-sku]": variant.sku,
      "[data-adjust-current-stock]": variant.stockQuantity.toLocaleString("en-IN"),
      "[data-adjust-threshold]": variant.lowStockThreshold.toLocaleString("en-IN"),
      "[data-adjust-stock-state]": variant.stockState,
      "[data-adjust-active-state]": variant.variantState,
    };
    Object.entries(values).forEach(([selector, value]) => {
      const node = $(selector, modal);
      if (node) node.textContent = value;
    });
  }

  function getAdminAdjustmentDraft() {
    const modal = getAdminAdjustmentModal();
    const quantityInput = $("[data-adjust-new-stock]", modal || document);
    const reasonInput = $("[data-adjust-reason]", modal || document);
    const rawQuantity = String(quantityInput?.value || "").trim();
    let newQuantity = null;
    if (/^\d+$/.test(rawQuantity)) {
      const parsedQuantity = Number(rawQuantity);
      if (
        Number.isSafeInteger(parsedQuantity)
        && parsedQuantity >= 0
        && parsedQuantity <= POSTGRESQL_INTEGER_MAX
      ) newQuantity = parsedQuantity;
    }
    return {
      rawQuantity,
      newQuantity,
      reason: String(reasonInput?.value || "").trim(),
    };
  }

  function isAdminAdjustmentDraftValid(draft = getAdminAdjustmentDraft()) {
    return Boolean(
      adminAdjustmentState
      && !adminAdjustmentState.submitting
      && !adminAdjustmentState.refreshing
      && !adminAdjustmentState.requiresAuthoritativeRefresh
      && Number.isSafeInteger(draft.newQuantity)
      && draft.newQuantity !== adminAdjustmentState.expectedQuantity
      && draft.reason.length >= 3
      && draft.reason.length <= 500
    );
  }

  function updateInventoryAdjustmentFormState() {
    const modal = getAdminAdjustmentModal();
    if (!modal) return;
    const submitting = Boolean(adminAdjustmentState?.submitting);
    const refreshing = Boolean(adminAdjustmentState?.refreshing);
    const submit = $("[data-inventory-adjust-submit]", modal);
    const refresh = $("[data-inventory-adjust-refresh]", modal);
    const draft = getAdminAdjustmentDraft();
    const canSubmit = isAdminAdjustmentDraftValid(draft);

    $$('[data-adjust-new-stock], [data-adjust-reason], [data-inventory-adjust-close], [data-inventory-adjust-cancel]', modal)
      .forEach((control) => { control.disabled = submitting; });
    if (submit) {
      submit.disabled = !canSubmit;
      submit.setAttribute("aria-disabled", String(!canSubmit));
      submit.setAttribute("aria-busy", String(submitting));
      submit.textContent = submitting ? "Adjusting..." : "Confirm Adjustment";
    }
    if (refresh) {
      refresh.hidden = !adminAdjustmentState?.requiresAuthoritativeRefresh;
      refresh.disabled = submitting || refreshing;
      refresh.setAttribute("aria-disabled", String(refresh.disabled));
      refresh.setAttribute("aria-busy", String(refreshing));
      refresh.textContent = refreshing ? "Refreshing..." : "Refresh Inventory";
    }
  }

  function getAdminAdjustmentSignature(draft = getAdminAdjustmentDraft()) {
    if (!adminAdjustmentState) return "";
    return JSON.stringify([
      adminAdjustmentState.variant.id,
      adminAdjustmentState.expectedQuantity,
      draft.rawQuantity,
      draft.reason,
    ]);
  }

  function updateAdminAdjustmentPreview() {
    const modal = getAdminAdjustmentModal();
    const preview = $("[data-adjust-preview]", modal || document);
    if (!preview || !adminAdjustmentState) return;
    const draft = getAdminAdjustmentDraft();
    if (adminAdjustmentState.signature && adminAdjustmentState.signature !== getAdminAdjustmentSignature(draft)) {
      adminAdjustmentState.signature = null;
      adminAdjustmentState.idempotencyKey = null;
    }
    if (!Number.isSafeInteger(draft.newQuantity)) {
      preview.textContent = `Current stock: ${adminAdjustmentState.expectedQuantity}. Enter a new quantity to preview the adjustment.`;
      return;
    }
    const delta = draft.newQuantity - adminAdjustmentState.expectedQuantity;
    preview.textContent = `Current stock: ${adminAdjustmentState.expectedQuantity} · New stock: ${draft.newQuantity} · Adjustment: ${formatInventoryDelta(delta)}`;
  }

  function setAdminAdjustmentPending(isPending) {
    if (adminAdjustmentState) adminAdjustmentState.submitting = isPending;
    updateInventoryAdjustmentFormState();
  }

  function openAdminInventoryAdjustment(page, variantId, trigger) {
    if (!page || page.dataset.adminAuthorizedUserId !== authUser?.id) return;
    const variant = adminInventoryRows.find((row) => row.id === variantId);
    const modal = getAdminAdjustmentModal();
    if (!variant || !modal) return;
    adminAdjustmentReturnFocus = trigger || document.activeElement;
    adminAdjustmentState = {
      variant: { ...variant },
      expectedQuantity: variant.stockQuantity,
      idempotencyKey: null,
      signature: null,
      submitting: false,
      refreshing: false,
      requiresAuthoritativeRefresh: false,
      userId: authUser.id,
      accessGeneration: adminAccessGeneration,
    };
    const form = $("[data-inventory-adjust-form]", modal);
    form?.reset();
    $("[data-inventory-adjust-form-view]", modal).hidden = false;
    $("[data-inventory-adjust-success]", modal).hidden = true;
    populateAdminAdjustmentSummary(variant);
    setAdminAdjustmentFeedback("");
    updateAdminAdjustmentPreview();
    updateInventoryAdjustmentFormState();
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("is-open");
    document.body.classList.add("no-scroll");
    window.requestAnimationFrame(() => $("[data-adjust-new-stock]", modal)?.focus());
  }

  function clearAdminInventoryAdjustmentContent(modal) {
    $("[data-inventory-adjust-form]", modal)?.reset();
    $$([
      "[data-adjust-product-name]",
      "[data-adjust-product-id]",
      "[data-adjust-variant-label]",
      "[data-adjust-sku]",
      "[data-adjust-current-stock]",
      "[data-adjust-threshold]",
      "[data-adjust-stock-state]",
      "[data-adjust-active-state]",
      "[data-adjust-preview]",
      "[data-adjust-feedback]",
      "[data-adjust-success-previous]",
      "[data-adjust-success-new]",
      "[data-adjust-success-delta]",
      "[data-adjust-success-movement]",
    ].join(","), modal).forEach((node) => { node.textContent = ""; });
    const feedback = $("[data-adjust-feedback]", modal);
    if (feedback) feedback.hidden = true;
  }

  function closeAdminInventoryAdjustment(force = false) {
    const modal = getAdminAdjustmentModal();
    if (!modal || (modal.hidden && !force)) return;
    if (adminAdjustmentState?.submitting && !force) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    modal.hidden = true;
    document.body.classList.remove("no-scroll");
    const returnFocus = adminAdjustmentReturnFocus;
    adminAdjustmentState = null;
    adminAdjustmentReturnFocus = null;
    if (force) clearAdminInventoryAdjustmentContent(modal);
    updateInventoryAdjustmentFormState();
    if (!force && returnFocus?.isConnected) returnFocus.focus();
  }

  function validateAdminAdjustmentForm() {
    const modal = getAdminAdjustmentModal();
    const form = $("[data-inventory-adjust-form]", modal || document);
    const quantityInput = $("[data-adjust-new-stock]", modal || document);
    const reasonInput = $("[data-adjust-reason]", modal || document);
    if (!form || !quantityInput || !reasonInput || !adminAdjustmentState) return null;
    quantityInput.setCustomValidity("");
    reasonInput.setCustomValidity("");
    const draft = getAdminAdjustmentDraft();
    let message = "";
    if (
      !draft.rawQuantity
      || !/^\d+$/.test(draft.rawQuantity)
      || !Number.isSafeInteger(draft.newQuantity)
      || draft.newQuantity < 0
      || draft.newQuantity > POSTGRESQL_INTEGER_MAX
    ) {
      message = "Enter a whole stock quantity between 0 and 2147483647.";
      quantityInput.setCustomValidity(message);
    } else if (draft.newQuantity === adminAdjustmentState.expectedQuantity) {
      message = "Stock quantity is already set to this value.";
      quantityInput.setCustomValidity(message);
    } else if (draft.reason.length < 3 || draft.reason.length > 500) {
      message = "Adjustment reason must be between 3 and 500 characters.";
      reasonInput.setCustomValidity(message);
    }
    if (message || !form.checkValidity()) {
      setAdminAdjustmentFeedback(message || "Please check the adjustment details.");
      form.reportValidity();
      updateInventoryAdjustmentFormState();
      return null;
    }
    setAdminAdjustmentFeedback("");
    updateInventoryAdjustmentFormState();
    return draft;
  }

  function isAdminAdjustmentContextCurrent(page, state) {
    return Boolean(
      state
      && adminAdjustmentState === state
      && authUser?.id === state.userId
      && page?.dataset.adminAuthorizedUserId === state.userId
      && adminAccessGeneration === state.accessGeneration
    );
  }

  async function refreshAdminAdjustmentAuthoritativeStock(page) {
    const state = adminAdjustmentState;
    if (!isAdminAdjustmentContextCurrent(page, state) || state.refreshing) return false;
    const variantId = state.variant.id;
    state.requiresAuthoritativeRefresh = true;
    state.refreshing = true;
    state.idempotencyKey = null;
    state.signature = null;
    updateInventoryAdjustmentFormState();
    const refreshed = await loadAdminInventory(page, { background: true });
    if (!isAdminAdjustmentContextCurrent(page, state)) return false;
    state.refreshing = false;
    const latest = refreshed ? adminInventoryRows.find((entry) => entry.id === variantId) : null;
    if (!latest) {
      state.requiresAuthoritativeRefresh = true;
      setAdminAdjustmentFeedback("Inventory changed, but the latest quantity could not be loaded. Refresh inventory and try again.");
      updateInventoryAdjustmentFormState();
      return false;
    }
    state.variant = { ...latest };
    state.expectedQuantity = latest.stockQuantity;
    state.requiresAuthoritativeRefresh = false;
    populateAdminAdjustmentSummary(latest);
    updateAdminAdjustmentPreview();
    setAdminAdjustmentFeedback("Inventory changed. The latest quantity has been loaded. Review the adjustment and try again.");
    updateInventoryAdjustmentFormState();
    return true;
  }

  function getAdminAdjustmentErrorMessage(error) {
    const message = String(error?.message || "").toLowerCase();
    if (message.includes("authentication required")) return "Authentication required. Please log in again.";
    if (message.includes("admin access")) return "Administrator access is required.";
    if (message.includes("not found")) return "This product variant is no longer available.";
    if (message.includes("non-negative") || message.includes("stock quantities")) return "Enter a valid non-negative stock quantity.";
    if (message.includes("reason")) return "Adjustment reason must be between 3 and 500 characters.";
    if (message.includes("already set")) return "Stock quantity is already set to this value.";
    if (message.includes("inventory changed") || message.includes("refresh the variant")) {
      return "Inventory changed. The latest quantity has been loaded. Review the adjustment and try again.";
    }
    if (message.includes("identifier") || message.includes("different inventory details")) {
      return "These adjustment details changed. Review them and submit a new attempt.";
    }
    return "Inventory could not be adjusted. Please try again.";
  }

  async function handleAdminAdjustmentSubmit(page, event) {
    event.preventDefault();
    if (!adminAdjustmentState || adminAdjustmentState.submitting) return;
    const adjustmentState = adminAdjustmentState;
    const draft = validateAdminAdjustmentForm();
    if (!draft || !isAdminAdjustmentContextCurrent(page, adjustmentState)) return;
    const signature = getAdminAdjustmentSignature(draft);
    if (!adminAdjustmentState.idempotencyKey || adminAdjustmentState.signature !== signature) {
      adminAdjustmentState.idempotencyKey = crypto.randomUUID();
      adminAdjustmentState.signature = signature;
    }
    const requestKey = adminAdjustmentState.idempotencyKey;
    const userId = adjustmentState.userId;
    const variantId = adjustmentState.variant.id;
    const expectedQuantity = adjustmentState.expectedQuantity;
    setAdminAdjustmentPending(true);

    try {
      const { data, error } = await supabaseClient.rpc("adjust_variant_stock", {
        p_product_variant_id: variantId,
        p_expected_stock_quantity: expectedQuantity,
        p_new_stock_quantity: draft.newQuantity,
        p_reason: draft.reason,
        p_idempotency_key: requestKey,
      });
      if (error) throw error;
      if (!isAdminAdjustmentContextCurrent(page, adjustmentState)) return;
      const result = Array.isArray(data) ? data[0] : data;
      if (
        !result
        || String(result.product_variant_id || "") !== variantId
        || !Number.isInteger(Number(result.previous_stock_quantity))
        || !Number.isInteger(Number(result.new_stock_quantity))
        || !Number.isInteger(Number(result.quantity_delta))
        || !result.movement_id
      ) throw new Error("Invalid inventory adjustment response");

      const row = adminInventoryRows.find((entry) => entry.id === variantId);
      if (row) {
        row.stockQuantity = Number(result.new_stock_quantity);
        row.lowStockThreshold = Number(result.low_stock_threshold);
        row.stockState = String(result.stock_state || getAdminInventoryStockState(row));
        row.updatedAt = String(result.adjusted_at || row.updatedAt);
      }
      renderAdminInventory(page);
      await loadAdminInventory(page, { background: true });
      if (!isAdminAdjustmentContextCurrent(page, adjustmentState)) return;

      const modal = getAdminAdjustmentModal();
      const successValues = {
        "[data-adjust-success-previous]": Number(result.previous_stock_quantity).toLocaleString("en-IN"),
        "[data-adjust-success-new]": Number(result.new_stock_quantity).toLocaleString("en-IN"),
        "[data-adjust-success-delta]": formatInventoryDelta(Number(result.quantity_delta)),
        "[data-adjust-success-movement]": String(result.movement_id),
      };
      Object.entries(successValues).forEach(([selector, value]) => {
        const node = $(selector, modal || document);
        if (node) node.textContent = value;
      });
      $("[data-inventory-adjust-form-view]", modal).hidden = true;
      $("[data-inventory-adjust-success]", modal).hidden = false;
      setAdminAdjustmentPending(false);
      $("[data-inventory-adjust-done]", modal)?.focus();
    } catch (error) {
      console.error("Inventory adjustment RPC failed", error);
      if (!isAdminAdjustmentContextCurrent(page, adjustmentState)) return;
      const isStale = /inventory changed|refresh the variant/i.test(String(error?.message || ""));
      const isConflict = /identifier|different inventory details/i.test(String(error?.message || ""));
      if (isStale) {
        adjustmentState.submitting = false;
        adjustmentState.requiresAuthoritativeRefresh = true;
        adjustmentState.idempotencyKey = null;
        adjustmentState.signature = null;
        updateInventoryAdjustmentFormState();
        await refreshAdminAdjustmentAuthoritativeStock(page);
        return;
      } else if (isConflict) {
        adjustmentState.idempotencyKey = null;
        adjustmentState.signature = null;
      }
      setAdminAdjustmentFeedback(getAdminAdjustmentErrorMessage(error));
      setAdminAdjustmentPending(false);
    }
  }

  function trapAdminInventoryModalFocus(event) {
    const modal = getAdminAdjustmentModal();
    if (event.key !== "Tab" || !modal || modal.hidden) return;
    const focusable = $$('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])', modal)
      .filter((element) => !element.hidden && element.getClientRects().length > 0);
    if (!focusable.length) return;
    const preferredFirst = $("[data-adjust-new-stock]", modal);
    const orderedFocusable = preferredFirst && focusable.includes(preferredFirst)
      ? [preferredFirst, ...focusable.filter((element) => element !== preferredFirst)]
      : focusable;
    const first = orderedFocusable[0];
    const last = orderedFocusable[orderedFocusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function getOrderPaymentMethod(value) {
    return value === "COD" ? "Cash on Delivery" : "Not available";
  }

  function getOrderPaymentStatus(value) {
    return PAYMENT_STATUSES.includes(value) ? value : "Unpaid";
  }

  function getCancellationRequestStatus(value) {
    return CANCELLATION_REQUEST_STATUSES.includes(value) ? value : "None";
  }

  function getCancellationDeadline(order) {
    const createdAt = new Date(order?.created_at || "");
    if (Number.isNaN(createdAt.getTime())) return null;
    return new Date(createdAt.getTime() + CANCELLATION_WINDOW_MS);
  }

  function getCancellationEligibility(order) {
    const requestStatus = getCancellationRequestStatus(order?.cancellation_request_status);
    if (requestStatus !== "None") return { eligible: false, reason: requestStatus.toLowerCase() };
    if (!["Pending", "Confirmed"].includes(order?.status)) return { eligible: false, reason: "order-status" };
    if (order?.payment_method !== "COD") return { eligible: false, reason: "payment-method" };
    if (getOrderPaymentStatus(order?.payment_status) !== "Unpaid") return { eligible: false, reason: "paid" };

    const deadline = getCancellationDeadline(order);
    if (!deadline || Date.now() >= deadline.getTime()) return { eligible: false, reason: "expired", deadline };
    return { eligible: true, reason: "eligible", deadline };
  }

  function getCancellationStateLabel(status) {
    return status === "Pending" ? "Awaiting Approval" : status;
  }

  function getCancellationRequestErrorMessage(error) {
    const message = String(error?.message || "").toLowerCase();
    if (message.includes("24") || message.includes("window") || message.includes("expired")) {
      return "The 24-hour cancellation window has closed.";
    }
    if (message.includes("already") || message.includes("awaiting") || message.includes("pending request")) {
      return "Your cancellation request is already awaiting approval.";
    }
    if (message.includes("paid") || message.includes("payment status")) {
      return "Paid orders require support assistance.";
    }
    if (
      message.includes("can no longer") ||
      message.includes("not cancellable") ||
      message.includes("order status") ||
      message.includes("not eligible")
    ) {
      return "This order can no longer be cancelled.";
    }
    return "We could not submit your cancellation request. Please try again.";
  }

  function getCancellationReviewErrorMessage(error) {
    const message = String(error?.message || "").toLowerCase();
    if (message.includes("already") || message.includes("reviewed") || message.includes("not pending")) {
      return "This cancellation request has already been reviewed.";
    }
    if (message.includes("24") || message.includes("window")) {
      return "The 24-hour cancellation window has closed.";
    }
    if (message.includes("paid") || message.includes("payment")) {
      return "This cancellation cannot be approved because the payment state changed. Reject it with an explanation.";
    }
    return "The cancellation request could not be reviewed. Please try again.";
  }

  function renderAdminOrders(page, orders) {
    const container = $("[data-admin-orders]", page);
    const count = $("[data-admin-order-count]", page);
    if (count) count.textContent = String(orders.length);
    if (!container) return;

    if (!orders.length) {
      container.innerHTML = `<div class="admin-empty">No orders found yet.</div>`;
      return;
    }

    container.innerHTML = orders
      .map((order) => {
        const items = order.order_items || [];
        const address = [order.address, order.city, order.state, order.pin_code].filter(Boolean).join(", ");
        const status = order.status || "Pending";
        const cancellationStatus = getCancellationRequestStatus(order.cancellation_request_status);
        const controlsBlocked = cancellationStatus === "Pending" || cancellationStatus === "Approved" || status === "Cancelled";
        const controlDisabled = controlsBlocked ? "disabled aria-disabled=\"true\"" : "";
        const statusOptions = status === "Cancelled"
          ? `<option value="Cancelled" selected>Cancelled</option>`
          : ADMIN_ORDER_STATUSES.map(
            (option) => `<option value="${option}" ${option === status ? "selected" : ""}>${option}</option>`
          ).join("");
        const paymentStatus = getOrderPaymentStatus(order.payment_status);
        const paymentStatusOptions = PAYMENT_STATUSES.map(
          (option) => `<option value="${option}" ${option === paymentStatus ? "selected" : ""}>${option}</option>`
        ).join("");
        const paymentCollectedAt = order.payment_collected_at
          ? formatOrderDate(order.payment_collected_at)
          : "";
        const cancellationRequestedAt = order.cancellation_requested_at
          ? formatOrderDate(order.cancellation_requested_at)
          : "Not available";
        const cancellationReviewedAt = order.cancellation_reviewed_at
          ? formatOrderDate(order.cancellation_reviewed_at)
          : "Not reviewed";
        const cancellationDeadline = getCancellationDeadline(order);
        const cancellationDeadlineLabel = cancellationDeadline
          ? formatOrderDate(cancellationDeadline.toISOString())
          : "Not available";
        const cancellationControlMessage = cancellationStatus === "Pending"
          ? "Review the pending cancellation request first."
          : controlsBlocked
            ? "Order and payment controls are unavailable for a cancelled order."
            : "";
        const cancellationDetails = cancellationStatus === "None"
          ? `<p class="admin-cancellation-empty">No cancellation request for this order.</p>`
          : `
              <div class="admin-cancellation-grid">
                <div><span class="admin-kicker">Customer Reason</span><p>${escapeHTML(order.cancellation_reason || "Not available")}</p></div>
                <div><span class="admin-kicker">Requested</span><p>${escapeHTML(cancellationRequestedAt)}</p></div>
                <div><span class="admin-kicker">24-Hour Deadline</span><p>${escapeHTML(cancellationDeadlineLabel)}</p></div>
                <div><span class="admin-kicker">Reviewed</span><p>${escapeHTML(cancellationReviewedAt)}</p></div>
                <div><span class="admin-kicker">Admin Note</span><p>${escapeHTML(order.cancellation_admin_note || "Not available")}</p></div>
              </div>
              ${cancellationStatus === "Pending" ? `
                <div class="admin-cancellation-review" data-admin-cancellation-review>
                  <label for="cancellation-note-${escapeHTML(order.id)}">Admin Note</label>
                  <textarea id="cancellation-note-${escapeHTML(order.id)}" data-admin-cancellation-note maxlength="1000" placeholder="Required when rejecting the request"></textarea>
                  <p class="admin-cancellation-feedback" data-admin-cancellation-feedback role="alert" hidden></p>
                  <div class="admin-cancellation-actions">
                    <button type="button" data-admin-cancellation-approve>Approve Cancellation</button>
                    <button type="button" class="admin-cancellation-reject" data-admin-cancellation-reject>Reject Cancellation</button>
                  </div>
                </div>
              ` : ""}
            `;
        const itemsHtml = items
          .map((item) => {
            const price = Number(item.product_price || 0);
            const qty = Number(item.quantity || 1);
            return `
              <article class="admin-order-item">
                <img src="${escapeHTML(item.product_image || "assets/hero-football-boot.avif")}" alt="${escapeHTML(item.product_name || "Product")}" loading="lazy" decoding="async" />
                <div>
                  <strong>${escapeHTML(item.product_name || "Product")}</strong>
                  <span>${escapeHTML(item.product_category || "Product")}</span>
                  <small>${money(price)} × ${qty}</small>
                </div>
                <b>${money(price * qty)}</b>
              </article>
            `;
          })
          .join("");

        return `
          <article class="admin-order-card" data-admin-order-card data-order-id="${escapeHTML(order.id)}">
            <div class="admin-order-topline">
              <div>
                <span class="admin-kicker">Order ID</span>
                <h3>${escapeHTML(order.id)}</h3>
                <p>${formatOrderDate(order.created_at)}</p>
              </div>
              <div class="admin-order-controls">
                <div class="admin-status-control">
                  <label for="status-${escapeHTML(order.id)}">Order Status</label>
                  <select id="status-${escapeHTML(order.id)}" data-admin-status ${controlDisabled}>
                    ${statusOptions}
                  </select>
                  <button type="button" data-admin-status-save ${controlDisabled}>Save Status</button>
                </div>
                <div class="admin-status-control admin-payment-status-control">
                  <label for="payment-status-${escapeHTML(order.id)}">Payment Status</label>
                  <select id="payment-status-${escapeHTML(order.id)}" data-admin-payment-status ${controlDisabled}>
                    ${paymentStatusOptions}
                  </select>
                  <button type="button" data-admin-payment-status-save ${controlDisabled}>Save Payment</button>
                </div>
                ${cancellationControlMessage ? `<p class="admin-control-lock-message">${escapeHTML(cancellationControlMessage)}</p>` : ""}
              </div>
            </div>
            <div class="admin-order-grid">
              <div>
                <span class="admin-kicker">Customer</span>
                <p><strong>${escapeHTML(order.customer_name || "Not available")}</strong></p>
                <p>${escapeHTML(order.customer_email || "")}</p>
                <p>${escapeHTML(order.customer_phone || "")}</p>
              </div>
              <div>
                <span class="admin-kicker">Delivery Address</span>
                <p>${escapeHTML(address || "Not available")}</p>
                <p>${escapeHTML(order.note ? `Note: ${order.note}` : "No customer note")}</p>
              </div>
              <div>
                <span class="admin-kicker">Order Total</span>
                <p class="admin-order-total">${money(order.total_amount || 0)}</p>
                <p>Current status: <strong data-admin-current-status>${escapeHTML(status)}</strong></p>
                <p>Payment Method: <strong>${escapeHTML(getOrderPaymentMethod(order.payment_method))}</strong></p>
                <p>Payment Status: <strong data-admin-current-payment-status>${escapeHTML(paymentStatus)}</strong></p>
                <p data-admin-payment-collected ${paymentCollectedAt ? "" : "hidden"}>Payment Collected At: <strong data-admin-payment-collected-value>${escapeHTML(paymentCollectedAt)}</strong></p>
              </div>
            </div>
            <div class="admin-items-wrap">
              <span class="admin-kicker">Ordered Products</span>
              ${itemsHtml || `<p>No items found for this order.</p>`}
            </div>
            <section class="admin-cancellation-panel" data-admin-cancellation-panel>
              <div class="admin-cancellation-heading">
                <div><span class="admin-kicker">Cancellation Request</span><h4>Customer Cancellation Review</h4></div>
                <span class="cancellation-state cancellation-state--${cancellationStatus.toLowerCase()}">${escapeHTML(getCancellationStateLabel(cancellationStatus))}</span>
              </div>
              ${cancellationDetails}
            </section>
          </article>
        `;
      })
      .join("");
  }

  async function loadAdminOrders(page, expectedUserId = authUser?.id, accessGeneration = adminAccessGeneration) {
    hideAdminFeedback(page);
    const container = $("[data-admin-orders]", page);
    if (container) container.innerHTML = `<div class="admin-empty">Loading orders...</div>`;
    const { data, error } = await supabaseClient
      .from("orders")
      .select("*, order_items(*)")
      .order("created_at", { ascending: false });
    if (
      accessGeneration !== adminAccessGeneration
      || authUser?.id !== expectedUserId
      || page.dataset.adminAuthorizedUserId !== expectedUserId
    ) return;
    if (error) {
      console.error("Admin orders could not be loaded", error);
      showAdminFeedback(page, "error", "Orders could not be loaded. Please try again.");
      if (container) container.innerHTML = `<div class="admin-empty">Orders could not be loaded.</div>`;
      return;
    }
    renderAdminOrders(page, data || []);
  }

  async function updateAdminOrderStatus(page, button) {
    if (button.disabled) return;
    const card = button.closest("[data-admin-order-card]");
    const select = $("[data-admin-status]", card);
    const statusLabel = $("[data-admin-current-status]", card);
    const orderId = card?.dataset.orderId;
    const status = select?.value;
    if (!orderId || !ADMIN_ORDER_STATUSES.includes(status)) return;

    button.disabled = true;
    button.textContent = "Saving...";
    hideAdminFeedback(page);
    const { data, error } = await supabaseClient.rpc("update_order_status", {
      p_order_id: orderId,
      p_new_status: status,
    });
    if (error) {
      console.error("Order status RPC failed", error);
      showAdminFeedback(page, "error", "Status could not be updated. Please try again.");
    } else {
      const updatedOrder = Array.isArray(data) ? data[0] : data;
      const updatedStatus = updatedOrder?.order_status || status;
      if (statusLabel) statusLabel.textContent = updatedStatus;
      if (select) select.value = updatedStatus;
      showAdminFeedback(page, "success", `Order ${orderId} status updated to ${updatedStatus}.`);
    }
    button.disabled = false;
    button.textContent = "Save Status";
  }

  async function updateAdminOrderPaymentStatus(page, button) {
    if (button.disabled) return;
    const card = button.closest("[data-admin-order-card]");
    const select = $("[data-admin-payment-status]", card);
    const statusLabel = $("[data-admin-current-payment-status]", card);
    const collectedRow = $("[data-admin-payment-collected]", card);
    const collectedValue = $("[data-admin-payment-collected-value]", card);
    const orderId = card?.dataset.orderId;
    const paymentStatus = select?.value;
    if (!orderId || !PAYMENT_STATUSES.includes(paymentStatus)) return;

    button.disabled = true;
    button.textContent = "Saving...";
    hideAdminFeedback(page);
    const { data, error } = await supabaseClient.rpc("update_order_payment_status", {
      p_order_id: orderId,
      p_payment_status: paymentStatus,
    });
    if (error) {
      console.error("Order payment status RPC failed", error);
      showAdminFeedback(page, "error", "Payment status could not be updated. Please try again.");
    } else {
      const updatedOrder = Array.isArray(data) ? data[0] : data;
      const updatedStatus = getOrderPaymentStatus(updatedOrder?.payment_status || paymentStatus);
      const paymentCollectedAt = updatedOrder?.payment_collected_at || null;
      if (statusLabel) statusLabel.textContent = updatedStatus;
      if (select) select.value = updatedStatus;
      if (collectedRow) collectedRow.hidden = !paymentCollectedAt;
      if (collectedValue) collectedValue.textContent = paymentCollectedAt ? formatOrderDate(paymentCollectedAt) : "";
      showAdminFeedback(page, "success", `Order ${orderId} payment status updated to ${updatedStatus}.`);
    }
    button.disabled = false;
    button.textContent = "Save Payment";
  }

  function showAdminCancellationFeedback(card, message) {
    const feedback = $("[data-admin-cancellation-feedback]", card);
    if (!feedback) return;
    feedback.textContent = message;
    feedback.hidden = !message;
  }

  async function reviewAdminOrderCancellation(page, button, decision) {
    const card = button.closest("[data-admin-order-card]");
    const orderId = card?.dataset.orderId;
    const note = $("[data-admin-cancellation-note]", card)?.value.trim() || "";
    if (!card || !orderId || !["Approved", "Rejected"].includes(decision)) return;
    if (card.dataset.cancellationSubmitting === "true") return;

    showAdminCancellationFeedback(card, "");
    if (decision === "Rejected" && note.length < 5) {
      showAdminCancellationFeedback(card, "Please provide a clear rejection explanation.");
      return;
    }

    card.dataset.cancellationSubmitting = "true";
    const reviewButtons = $$(`[data-admin-cancellation-approve], [data-admin-cancellation-reject]`, card);
    reviewButtons.forEach((reviewButton) => {
      reviewButton.disabled = true;
    });
    const originalText = button.textContent;
    button.textContent = decision === "Approved" ? "Approving..." : "Rejecting...";
    hideAdminFeedback(page);

    const { error } = await supabaseClient.rpc("review_order_cancellation", {
      p_order_id: orderId,
      p_decision: decision,
      p_admin_note: note || null,
    });

    if (error) {
      console.error("Cancellation review RPC failed", error);
      showAdminCancellationFeedback(card, getCancellationReviewErrorMessage(error));
      reviewButtons.forEach((reviewButton) => {
        reviewButton.disabled = false;
      });
      button.textContent = originalText;
      card.dataset.cancellationSubmitting = "false";
      return;
    }

    await loadAdminOrders(page);
    showAdminFeedback(
      page,
      "success",
      `Cancellation request for order ${orderId} ${decision === "Approved" ? "approved" : "rejected"}.`
    );
  }

  async function checkAdminAccess(page) {
    if (!page) return;
    const accessGeneration = ++adminAccessGeneration;
    page.dataset.adminChecking = "true";
    setAdminView(page, "loading");
    hideAdminFeedback(page);
    resetAdminInventoryState(page);
    const ordersContainer = $("[data-admin-orders]", page);
    if (ordersContainer) ordersContainer.innerHTML = "";
    try {
      await waitForAuthReady();
      if (accessGeneration !== adminAccessGeneration) return;
      if (!supabaseClient) {
        setAdminView(page, "denied", "Supabase authentication is unavailable.");
        return;
      }
      if (!authUser) {
        setAdminView(page, "login", "Please login to view the admin dashboard.");
        return;
      }
      const expectedUserId = authUser.id;
      const { data: isAdmin, error } = await supabaseClient.rpc("is_admin");
      if (accessGeneration !== adminAccessGeneration || authUser?.id !== expectedUserId) return;
      if (error) throw error;
      if (!isAdmin) {
        setAdminView(page, "denied", "Access denied");
        return;
      }
      page.dataset.adminAuthorizedUserId = expectedUserId;
      const inventoryTab = $('[data-admin-tab="inventory"]', page);
      if (inventoryTab) inventoryTab.hidden = false;
      setAdminView(page, "dashboard");
      setAdminTab(page, "orders");
      await loadAdminOrders(page, expectedUserId, accessGeneration);
    } catch (error) {
      if (accessGeneration !== adminAccessGeneration) return;
      console.error("Admin access check failed", error);
      setAdminView(page, "denied", "Access denied");
      showAdminFeedback(page, "error", "Admin access could not be verified. Please try again.");
    } finally {
      if (accessGeneration === adminAccessGeneration) page.dataset.adminChecking = "false";
    }
  }

  function refreshAdminPageAccess() {
    const page = $("[data-admin-page]");
    if (page && page.dataset.adminBound === "true") checkAdminAccess(page);
  }

  function initAdminPage() {
    const page = $("[data-admin-page]");
    if (!page || page.dataset.adminBound === "true") return;
    page.dataset.adminBound = "true";
    page.addEventListener("click", (event) => {
      const loginButton = event.target.closest("[data-admin-login]");
      if (loginButton) openLogin();
      const refreshButton = event.target.closest("[data-admin-refresh]");
      if (refreshButton) checkAdminAccess(page);
      const tab = event.target.closest("[data-admin-tab]");
      if (tab) setAdminTab(page, tab.dataset.adminTab);
      const saveButton = event.target.closest("[data-admin-status-save]");
      if (saveButton) updateAdminOrderStatus(page, saveButton);
      const paymentSaveButton = event.target.closest("[data-admin-payment-status-save]");
      if (paymentSaveButton) updateAdminOrderPaymentStatus(page, paymentSaveButton);
      const approveCancellationButton = event.target.closest("[data-admin-cancellation-approve]");
      if (approveCancellationButton) reviewAdminOrderCancellation(page, approveCancellationButton, "Approved");
      const rejectCancellationButton = event.target.closest("[data-admin-cancellation-reject]");
      if (rejectCancellationButton) reviewAdminOrderCancellation(page, rejectCancellationButton, "Rejected");
      const inventoryRefresh = event.target.closest("[data-inventory-refresh], [data-inventory-retry]");
      if (inventoryRefresh) void loadAdminInventory(page);
      const clearInventoryFilters = event.target.closest("[data-inventory-clear]");
      if (clearInventoryFilters) {
        resetAdminInventoryFilters(page);
        updateAdminInventoryCategories(page);
        renderAdminInventoryRows(page);
        renderAdminInventoryActivity(page);
      }
      const adjustButton = event.target.closest("[data-inventory-adjust]");
      if (adjustButton) openAdminInventoryAdjustment(page, adjustButton.dataset.inventoryAdjust, adjustButton);
    });
    page.addEventListener("input", (event) => {
      if (event.target.matches("[data-inventory-search]")) renderAdminInventoryRows(page);
      if (event.target.matches("[data-inventory-activity-search], [data-inventory-activity-date]")) {
        renderAdminInventoryActivity(page);
      }
    });
    page.addEventListener("change", (event) => {
      if (event.target.matches("[data-inventory-category], [data-inventory-stock-filter], [data-inventory-active-filter], [data-inventory-sort]")) {
        renderAdminInventoryRows(page);
      }
      if (event.target.matches("[data-inventory-movement-filter], [data-inventory-activity-date]")) {
        renderAdminInventoryActivity(page);
      }
    });
    page.addEventListener("keydown", (event) => {
      const tab = event.target.closest("[data-admin-tab]");
      if (!tab || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const tabs = $$('[data-admin-tab]', page);
      const currentIndex = tabs.indexOf(tab);
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const nextTab = tabs[(currentIndex + direction + tabs.length) % tabs.length];
      setAdminTab(page, nextTab.dataset.adminTab, { focus: true });
    });

    const modal = getAdminAdjustmentModal();
    const form = $("[data-inventory-adjust-form]", modal || document);
    form?.addEventListener("submit", (event) => void handleAdminAdjustmentSubmit(page, event));
    modal?.addEventListener("input", (event) => {
      if (event.target.matches("[data-adjust-new-stock], [data-adjust-reason]")) {
        setAdminAdjustmentFeedback("");
        updateAdminAdjustmentPreview();
        updateInventoryAdjustmentFormState();
      }
    });
    modal?.addEventListener("click", (event) => {
      if (event.target === modal) closeAdminInventoryAdjustment();
      if (event.target.closest("[data-inventory-adjust-refresh]")) {
        void refreshAdminAdjustmentAuthoritativeStock(page);
      }
      if (event.target.closest("[data-inventory-adjust-close], [data-inventory-adjust-cancel], [data-inventory-adjust-done]")) {
        closeAdminInventoryAdjustment();
      }
    });
    modal?.addEventListener("keydown", trapAdminInventoryModalFocus);
    checkAdminAccess(page);
  }

  function setMyOrdersView(page, state) {
    const views = {
      loading: $("[data-orders-loading]", page),
      login: $("[data-orders-login]", page),
      empty: $("[data-orders-empty]", page),
      error: $("[data-orders-error]", page),
      list: $("[data-orders-list]", page),
    };

    Object.values(views).forEach((view) => {
      if (view) view.hidden = true;
    });
    if (views[state]) views[state].hidden = false;
  }

  function getCustomerOrderItems(order) {
    return Array.isArray(order?.order_items) ? order.order_items : [];
  }

  function getCustomerOrderStatus(status) {
    return ORDER_STATUSES.includes(status) ? status : "Pending";
  }

  function formatCustomerOrderMoney(value) {
    return `$${money(value)}`;
  }

  function getCustomerOrderItemCount(order) {
    return getCustomerOrderItems(order).reduce(
      (count, item) => count + Math.max(1, Number(item.quantity) || 1),
      0
    );
  }

  function renderCustomerCancellationPanel(order, context = "card") {
    const requestStatus = getCancellationRequestStatus(order.cancellation_request_status);
    const eligibility = getCancellationEligibility(order);
    const className = context === "details"
      ? "order-details-cancellation customer-cancellation-panel"
      : "customer-order-card__cancellation customer-cancellation-panel";
    const stateLabel = getCancellationStateLabel(requestStatus);
    const stateHeading = `
      <div class="customer-cancellation-heading">
        <span class="order-card-label">Cancellation Request</span>
        <span class="cancellation-state cancellation-state--${requestStatus.toLowerCase()}">${escapeHTML(stateLabel)}</span>
      </div>
    `;

    if (context === "card" && requestStatus !== "None") {
      return `
        <section class="${className}" data-customer-cancellation-state="${escapeHTML(requestStatus)}">
          ${stateHeading}
        </section>
      `;
    }

    const reasonField = `
      <div>
        <span class="order-card-label">Customer Reason</span>
        <p>${escapeHTML(order.cancellation_reason || "Not available")}</p>
      </div>
    `;
    const requestedField = `
      <div>
        <span class="order-card-label">Requested At</span>
        <p>${escapeHTML(formatOrderDate(order.cancellation_requested_at))}</p>
      </div>
    `;

    if (requestStatus === "Pending") {
      return `
        <section class="${className}" data-customer-cancellation-state="Pending">
          ${stateHeading}
          <div class="customer-cancellation-details-grid">
            ${reasonField}
            ${requestedField}
          </div>
          <p class="customer-cancellation-guidance">Your cancellation request is awaiting administrator approval.</p>
        </section>
      `;
    }

    if (requestStatus === "Approved") {
      return `
        <section class="${className}" data-customer-cancellation-state="Approved">
          ${stateHeading}
          <div class="customer-cancellation-details-grid">
            ${reasonField}
            ${requestedField}
            <div>
              <span class="order-card-label">Cancelled At</span>
              <p>${escapeHTML(formatOrderDate(order.cancelled_at))}</p>
            </div>
          </div>
        </section>
      `;
    }

    if (requestStatus === "Rejected") {
      return `
        <section class="${className}" data-customer-cancellation-state="Rejected">
          ${stateHeading}
          <div class="customer-cancellation-details-grid">
            ${reasonField}
            ${requestedField}
            <div>
              <span class="order-card-label">Reviewed At</span>
              <p>${escapeHTML(formatOrderDate(order.cancellation_reviewed_at))}</p>
            </div>
            <div>
              <span class="order-card-label">Admin Response</span>
              <p>${escapeHTML(order.cancellation_admin_note || "Please contact support for more information.")}</p>
            </div>
          </div>
          <p class="customer-cancellation-guidance">Your cancellation request has been reviewed. Please contact support for further assistance.</p>
        </section>
      `;
    }

    if (eligibility.eligible) {
      return `
        <section class="${className}" data-customer-cancellation-state="Eligible">
          <div>
            <span class="order-card-label">Cancellation</span>
            <p>Please request cancellation within 24 hours of placing the order.</p>
          </div>
          <button type="button" class="customer-cancellation-button" data-request-cancellation data-order-id="${escapeHTML(order.id)}">Request Cancellation</button>
        </section>
      `;
    }

    const restrictionMessage = eligibility.reason === "expired"
      ? "The 24-hour cancellation window has closed. Please contact support for assistance."
      : eligibility.reason === "paid"
        ? "Paid orders require support assistance."
        : "This order can no longer be cancelled.";
    return `
      <section class="${className} customer-cancellation-panel--restricted" data-customer-cancellation-state="Restricted">
        <span class="order-card-label">Cancellation</span>
        <p>${escapeHTML(restrictionMessage)}</p>
      </section>
    `;
  }

  function renderCustomerOrders(page) {
    const list = $("[data-orders-list]", page);
    if (!list) return;

    list.innerHTML = customerOrders
      .map((order) => {
        const status = getCustomerOrderStatus(order.status);
        const itemCount = getCustomerOrderItemCount(order);
        const shortId = String(order.id || "").slice(0, 8).toUpperCase();
        return `
          <article class="customer-order-card" data-customer-order-id="${escapeHTML(order.id)}">
            <span class="order-card-label customer-order-card__label customer-order-card__label--order">Order</span>
            <span class="order-card-label customer-order-card__label customer-order-card__label--products">Products</span>
            <span class="order-card-label customer-order-card__label customer-order-card__label--total">Total</span>
            <span class="order-card-label customer-order-card__label customer-order-card__label--status">Status</span>
            <span class="order-card-label customer-order-card__label customer-order-card__label--action">Action</span>
            <h3 class="customer-order-card__primary customer-order-card__order-number">#${escapeHTML(shortId || "UNKNOWN")}</h3>
            <strong class="customer-order-card__primary customer-order-card__metric customer-order-card__metric--products">${itemCount} ${itemCount === 1 ? "Product" : "Products"}</strong>
            <strong class="customer-order-card__primary customer-order-card__metric customer-order-card__metric--total">${formatCustomerOrderMoney(order.total_amount || 0)}</strong>
            <span class="customer-order-card__primary customer-order-card__status-value order-status order-status--${status.toLowerCase()}">${escapeHTML(status)}</span>
            <button class="customer-order-card__primary customer-order-card__action-value customer-order-details-button" type="button" data-view-order-details>View Details</button>
            <p class="customer-order-card__date">${escapeHTML(formatOrderDate(order.created_at))}</p>
            ${renderCustomerCancellationPanel(order)}
          </article>
        `;
      })
      .join("");
  }

  function renderCustomerOrderDetails(order) {
    const content = $("[data-order-details-content]");
    if (!content || !order) return;

    const status = getCustomerOrderStatus(order.status);
    const address = [order.address, order.city, order.state, order.pin_code].filter(Boolean).join(", ");
    const paymentMethod = getOrderPaymentMethod(order.payment_method);
    const paymentStatus = getOrderPaymentStatus(order.payment_status);
    const paymentCollectedAt = order.payment_collected_at
      ? formatOrderDate(order.payment_collected_at)
      : "";
    const itemsHtml = getCustomerOrderItems(order)
      .map((item) => {
        const price = Number(item.product_price) || 0;
        const quantity = Math.max(1, Number(item.quantity) || 1);
        return `
          <article class="customer-order-item">
            <img src="${escapeHTML(item.product_image || "assets/hero-football-boot.avif")}" alt="${escapeHTML(item.product_name || "Ordered product")}" loading="lazy" decoding="async" />
            <div class="customer-order-item__copy">
              <strong>${escapeHTML(item.product_name || "Product")}</strong>
              <span>${escapeHTML(item.product_category || "Product")}</span>
              <small>${formatCustomerOrderMoney(price)} × ${quantity}</small>
            </div>
            <b>${formatCustomerOrderMoney(price * quantity)}</b>
          </article>
        `;
      })
      .join("");

    content.innerHTML = `
      <div class="order-details-topline">
        <div>
          <span class="order-card-label">Full Order ID</span>
          <p class="order-details-id">${escapeHTML(order.id || "Not available")}</p>
          <p>${escapeHTML(formatOrderDate(order.created_at))}</p>
        </div>
        <span class="order-status order-status--${status.toLowerCase()}">${escapeHTML(status)}</span>
      </div>
      <div class="order-details-grid">
        <section>
          <span class="order-card-label">Customer</span>
          <p><strong>${escapeHTML(order.customer_name || "Not available")}</strong></p>
          <p>${escapeHTML(order.customer_email || "Not available")}</p>
          <p>${escapeHTML(order.customer_phone || "Not available")}</p>
        </section>
        <section>
          <span class="order-card-label">Delivery Address</span>
          <p>${escapeHTML(address || "Not available")}</p>
          <p>${escapeHTML(order.note ? `Note: ${order.note}` : "No customer note")}</p>
        </section>
        <section class="order-details-payment">
          <span class="order-card-label">Payment</span>
          <p>Payment Method: <strong>${escapeHTML(paymentMethod)}</strong></p>
          <p>Payment Status: <strong>${escapeHTML(paymentStatus)}</strong></p>
          ${paymentCollectedAt ? `<p>Payment Collected At: <strong>${escapeHTML(paymentCollectedAt)}</strong></p>` : ""}
        </section>
      </div>
      ${renderCustomerCancellationPanel(order, "details")}
      <section class="order-details-items" aria-label="Ordered products">
        <span class="order-card-label">Ordered Products</span>
        ${itemsHtml || "<p>No products were found for this order.</p>"}
      </section>
      <div class="order-details-total">
        <span>Complete Order Total</span>
        <strong>${formatCustomerOrderMoney(order.total_amount || 0)}</strong>
      </div>
    `;
  }

  function openCustomerOrderDetails(orderId) {
    const order = customerOrders.find((entry) => String(entry.id) === String(orderId));
    const modal = $("[data-order-details-modal]");
    if (!order || !modal) return;

    renderCustomerOrderDetails(order);
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("no-scroll");
    window.setTimeout(() => $("[data-close-order-details]", modal)?.focus(), 40);
  }

  function closeCustomerOrderDetails() {
    const modal = $("[data-order-details-modal]");
    if (!modal?.classList.contains("is-open")) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("no-scroll");
  }

  function setCancellationFormError(message = "") {
    const feedback = $("[data-cancellation-error]");
    if (!feedback) return;
    feedback.textContent = message;
    feedback.hidden = !message;
  }

  function openCustomerCancellation(orderId) {
    const order = customerOrders.find((entry) => String(entry.id) === String(orderId));
    const modal = $("[data-cancellation-modal]");
    if (!order || !modal) return;

    const eligibility = getCancellationEligibility(order);
    if (!eligibility.eligible) {
      const message = eligibility.reason === "expired"
        ? "The 24-hour cancellation window has closed."
        : eligibility.reason === "paid"
          ? "Paid orders require support assistance."
          : eligibility.reason === "pending"
            ? "Your cancellation request is already awaiting approval."
            : "This order can no longer be cancelled.";
      showToast(message);
      return;
    }

    activeCancellationOrderId = String(order.id);
    setCancellationFormError("");
    const reason = $("[data-cancellation-reason]", modal);
    const submit = $("[data-submit-cancellation]", modal);
    if (reason) reason.value = "";
    if (submit) {
      submit.disabled = false;
      submit.textContent = "Submit Cancellation Request";
    }

    const values = {
      "[data-cancellation-order-id]": order.id,
      "[data-cancellation-order-date]": formatOrderDate(order.created_at),
      "[data-cancellation-order-status]": getCustomerOrderStatus(order.status),
      "[data-cancellation-order-total]": formatCustomerOrderMoney(order.total_amount || 0),
      "[data-cancellation-payment-method]": getOrderPaymentMethod(order.payment_method),
      "[data-cancellation-deadline]": formatOrderDate(eligibility.deadline?.toISOString()),
    };
    Object.entries(values).forEach(([selector, value]) => {
      const element = $(selector, modal);
      if (element) element.textContent = value;
    });

    closeCustomerOrderDetails();
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("no-scroll");
    window.setTimeout(() => reason?.focus(), 40);
  }

  function closeCustomerCancellation() {
    const modal = $("[data-cancellation-modal]");
    if (!modal?.classList.contains("is-open")) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("no-scroll");
    activeCancellationOrderId = null;
    setCancellationFormError("");
  }

  async function submitCustomerCancellation(form) {
    if (cancellationRequestSubmitting) return;
    const modal = form.closest("[data-cancellation-modal]");
    const order = customerOrders.find(
      (entry) => String(entry.id) === String(activeCancellationOrderId)
    );
    const reason = $("[data-cancellation-reason]", form)?.value.trim() || "";
    const submit = $("[data-submit-cancellation]", form);

    setCancellationFormError("");
    if (!order) {
      setCancellationFormError("This order can no longer be cancelled.");
      return;
    }
    if (reason.length < 5 || reason.length > 300) {
      setCancellationFormError("Reason must be between 5 and 300 characters.");
      return;
    }

    const eligibility = getCancellationEligibility(order);
    if (!eligibility.eligible) {
      const message = eligibility.reason === "expired"
        ? "The 24-hour cancellation window has closed."
        : eligibility.reason === "paid"
          ? "Paid orders require support assistance."
          : eligibility.reason === "pending"
            ? "Your cancellation request is already awaiting approval."
            : "This order can no longer be cancelled.";
      setCancellationFormError(message);
      return;
    }

    cancellationRequestSubmitting = true;
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Submitting...";
    }

    const { error } = await supabaseClient.rpc("request_order_cancellation", {
      p_order_id: order.id,
      p_reason: reason,
    });

    if (error) {
      console.error("Cancellation request RPC failed", error);
      setCancellationFormError(getCancellationRequestErrorMessage(error));
      cancellationRequestSubmitting = false;
      if (submit) {
        submit.disabled = false;
        submit.textContent = "Submit Cancellation Request";
      }
      return;
    }

    cancellationRequestSubmitting = false;
    closeCustomerCancellation();
    showToast("Cancellation request submitted. Awaiting administrator approval.");
    const page = $("[data-my-orders-page]");
    if (page && authUser) await loadCustomerOrders(page, authUser.id);
  }

  function resetCustomerOrdersForAuthChange() {
    myOrdersLoadVersion += 1;
    customerOrders = [];
    closeCustomerOrderDetails();
    closeCustomerCancellation();
    const page = $("[data-my-orders-page]");
    const list = page && $("[data-orders-list]", page);
    if (list) list.innerHTML = "";
    if (page) setMyOrdersView(page, "loading");
  }

  async function loadCustomerOrders(page, userId) {
    const requestVersion = ++myOrdersLoadVersion;
    setMyOrdersView(page, "loading");

    const { data, error } = await supabaseClient
      .from("orders")
      .select("id,user_id,customer_name,customer_email,customer_phone,address,city,state,pin_code,note,total_amount,status,payment_method,payment_status,payment_collected_at,created_at,cancellation_request_status,cancellation_reason,cancellation_requested_at,cancellation_reviewed_at,cancellation_reviewed_by,cancellation_admin_note,cancelled_at,order_items(id,order_id,product_id,product_name,product_category,product_price,quantity,product_image)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (requestVersion !== myOrdersLoadVersion || authUser?.id !== userId) return;
    if (error) {
      console.error("Customer orders could not be loaded", error);
      customerOrders = [];
      setMyOrdersView(page, "error");
      return;
    }

    customerOrders = Array.isArray(data)
      ? [...data].sort((first, second) => new Date(second.created_at) - new Date(first.created_at))
      : [];
    renderCustomerOrders(page);
    setMyOrdersView(page, customerOrders.length ? "list" : "empty");
  }

  async function refreshMyOrdersPageAccess() {
    const page = $("[data-my-orders-page]");
    if (!page || page.dataset.ordersBound !== "true") return;

    const accessVersion = ++myOrdersLoadVersion;
    customerOrders = [];
    const list = $("[data-orders-list]", page);
    if (list) list.innerHTML = "";
    setMyOrdersView(page, "loading");
    await waitForAuthReady();
    if (accessVersion !== myOrdersLoadVersion) return;

    if (!supabaseClient || !authUser) {
      setMyOrdersView(page, "login");
      return;
    }

    await loadCustomerOrders(page, authUser.id);
  }

  function initMyOrdersPage() {
    const page = $("[data-my-orders-page]");
    const modal = $("[data-order-details-modal]");
    const cancellationModal = $("[data-cancellation-modal]");
    const cancellationForm = $("[data-cancellation-form]", cancellationModal || document);
    if (!page || page.dataset.ordersBound === "true") return;
    page.dataset.ordersBound = "true";

    page.addEventListener("click", (event) => {
      if (event.target.closest("[data-orders-login-button]")) openLogin();
      if (event.target.closest("[data-orders-retry]")) refreshMyOrdersPageAccess();

      const detailsButton = event.target.closest("[data-view-order-details]");
      const card = detailsButton?.closest("[data-customer-order-id]");
      if (card) openCustomerOrderDetails(card.dataset.customerOrderId);

      const cancellationButton = event.target.closest("[data-request-cancellation]");
      if (cancellationButton) openCustomerCancellation(cancellationButton.dataset.orderId);
    });

    modal?.addEventListener("click", (event) => {
      const cancellationButton = event.target.closest("[data-request-cancellation]");
      if (cancellationButton) {
        openCustomerCancellation(cancellationButton.dataset.orderId);
        return;
      }
      if (event.target === modal || event.target.closest("[data-close-order-details]")) {
        closeCustomerOrderDetails();
      }
    });

    cancellationModal?.addEventListener("click", (event) => {
      if (
        event.target === cancellationModal ||
        event.target.closest("[data-close-cancellation]") ||
        event.target.closest("[data-keep-order]")
      ) {
        closeCustomerCancellation();
      }
    });

    cancellationForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      submitCustomerCancellation(event.currentTarget);
    });

    refreshMyOrdersPageAccess();
  }

  function getCookieConsent() {
    try {
      return localStorage.getItem(STORAGE_KEYS.cookieConsent);
    } catch (error) {
      return null;
    }
  }

  function saveCookieConsent(consent = "accepted", preferences = {}) {
    const nextPreferences = {
      essential: true,
      cartWishlistStorage: true,
      loginSession: true,
      ...preferences,
      savedAt: new Date().toISOString(),
    };

    try {
      localStorage.setItem(STORAGE_KEYS.cookieConsent, consent);
      localStorage.setItem(STORAGE_KEYS.cookiePreferences, JSON.stringify(nextPreferences));
    } catch (error) {
      console.warn("Cookie preference storage unavailable", error);
    }
  }

  function createCookieConsentUI() {
    if ($("[data-cookie-banner]")) return;

    const banner = document.createElement("section");
    banner.className = "cookie-banner";
    banner.setAttribute("data-cookie-banner", "");
    banner.setAttribute("aria-label", "Cookie notice");
    banner.innerHTML = `
      <div class="cookie-banner__copy">
        <strong>Cookie Notice</strong>
        <p>We use cookies and browser storage to improve your shopping experience, keep your cart and wishlist saved, and support secure login.</p>
      </div>
      <div class="cookie-banner__actions">
        <button class="cookie-accept" type="button" data-cookie-accept>Accept</button>
        <button class="cookie-manage" type="button" data-cookie-manage>Manage</button>
        <a class="cookie-policy-link" href="cookies.html">Cookies Policy</a>
      </div>
    `;

    const preferencesModal = document.createElement("div");
    preferencesModal.className = "cookie-preferences-modal";
    preferencesModal.setAttribute("data-cookie-preferences", "");
    preferencesModal.innerHTML = `
      <div class="cookie-preferences__box" role="dialog" aria-modal="true" aria-labelledby="cookie-preferences-title">
        <div class="modal-head">
          <h3 id="cookie-preferences-title">Cookie Preferences</h3>
          <button class="close-btn" type="button" data-close-cookie-preferences aria-label="Close cookie preferences">×</button>
        </div>
        <p class="cookie-preferences__intro">Choose how Attraction Football can use browser storage for this device.</p>
        <div class="cookie-option">
          <div class="cookie-option__head">
            <span>Essential cookies / storage</span>
            <span class="cookie-option__status">Always active</span>
          </div>
          <p>Required for core website functions, security, and stable page behavior.</p>
        </div>
        <label class="cookie-option">
          <span class="cookie-option__head">
            <span>Cart &amp; wishlist storage</span>
            <input type="checkbox" data-cookie-cart-wishlist checked />
          </span>
          <p>Keeps your cart and wishlist saved in this browser after refresh.</p>
        </label>
        <div class="cookie-option">
          <div class="cookie-option__head">
            <span>Login/session support</span>
            <span class="cookie-option__status">Supabase Auth</span>
          </div>
          <p>Login sessions are handled securely by Supabase Auth. Passwords are not stored in browser localStorage.</p>
        </div>
        <div class="cookie-preferences__actions">
          <button class="cookie-save" type="button" data-cookie-save>Save Preferences</button>
          <button class="cookie-accept-all" type="button" data-cookie-accept-all>Accept All</button>
        </div>
      </div>
    `;

    document.body.appendChild(banner);
    document.body.appendChild(preferencesModal);

    const openPreferences = () => preferencesModal.classList.add("is-open");
    const closePreferences = () => preferencesModal.classList.remove("is-open");
    const hideBanner = () => banner.classList.remove("is-visible");
    const showBanner = () => {
      if (!getCookieConsent()) banner.classList.add("is-visible");
    };

    banner.querySelector("[data-cookie-accept]")?.addEventListener("click", () => {
      saveCookieConsent("accepted", { cartWishlistStorage: true });
      hideBanner();
      closePreferences();
    });

    banner.querySelector("[data-cookie-manage]")?.addEventListener("click", openPreferences);

    preferencesModal.addEventListener("click", (event) => {
      if (event.target === preferencesModal || event.target.matches("[data-close-cookie-preferences]")) {
        closePreferences();
      }
    });

    preferencesModal.querySelector("[data-cookie-save]")?.addEventListener("click", () => {
      const cartWishlistStorage = Boolean(preferencesModal.querySelector("[data-cookie-cart-wishlist]")?.checked);
      saveCookieConsent("custom", { cartWishlistStorage });
      hideBanner();
      closePreferences();
    });

    preferencesModal.querySelector("[data-cookie-accept-all]")?.addEventListener("click", () => {
      const cartWishlist = preferencesModal.querySelector("[data-cookie-cart-wishlist]");
      if (cartWishlist) cartWishlist.checked = true;
      saveCookieConsent("accepted", { cartWishlistStorage: true });
      hideBanner();
      closePreferences();
    });

    showBanner();
  }

  function closeCookiePreferences() {
    $("[data-cookie-preferences]")?.classList.remove("is-open");
  }

  function updateCartCount() {
    const count = VARIANT_CART_V2_ENABLED
      ? [...variantCart, ...pendingGuestMergeCart, ...legacyVariantCart]
        .reduce((sum, item) => sum + Number(item.quantity || 0), 0)
      : cart.reduce((sum, item) => sum + item.qty, 0);
    if (cartCount) cartCount.textContent = String(count);
  }

  function updateWishlistCount() {
    if (wishlistCount) wishlistCount.textContent = String(wishlist.length);
  }

  function createWishlistHeaderButton() {
    const headerActions = $(".header-actions", header || document);
    if (!headerActions) return;

    wishlistButton = $(".wishlist-button", headerActions);
    if (!wishlistButton) {
      wishlistButton = document.createElement("button");
      wishlistButton.className = "wishlist-button";
      wishlistButton.type = "button";
      wishlistButton.setAttribute("aria-label", "Wishlist");
      wishlistButton.innerHTML = `
        <span class="wishlist-count">0</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.3 10.6 20C5.4 15.3 2 12.2 2 8.4 2 5.3 4.4 3 7.5 3c1.7 0 3.4.8 4.5 2.1A6 6 0 0 1 16.5 3C19.6 3 22 5.3 22 8.4c0 3.8-3.4 6.9-8.6 11.6L12 21.3Zm0-2.7.1-.1C16.9 14.2 20 11.4 20 8.4 20 6.4 18.5 5 16.5 5c-1.5 0-3 1-3.6 2.4h-1.8C10.5 6 9 5 7.5 5 5.5 5 4 6.4 4 8.4c0 3 3.1 5.8 7.9 10.1l.1.1Z"/></svg>
      `;
      headerActions.insertBefore(wishlistButton, cartButton || menuToggle || null);
    }

    wishlistCount = $(".wishlist-count", wishlistButton);
    updateWishlistCount();
  }

  function updateWishlistButtons() {
    $$(".wish").forEach((button) => {
      const card = button.closest(".product-card");
      const id = button.dataset.wishlistId || card?.dataset.productId || card?.dataset.wishlistId || button.dataset.wishlistRemove;
      if (!id) return;
      const active = isWishlisted(id);
      button.classList.toggle("is-active", active);
      button.textContent = active ? "♥" : "♡";
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function updateWishlistUI() {
    updateWishlistCount();
    updateWishlistButtons();
    renderWishlistItems();
    renderWishlistPage();
  }

  async function setAuthenticatedCartQuantity(userId, productId, quantity) {
    const rpcName = quantity > 0 ? "set_cart_item" : "remove_cart_item";
    const payload = quantity > 0
      ? { p_product_id: productId, p_quantity: quantity }
      : { p_product_id: productId };
    const { error } = await supabaseClient.rpc(rpcName, payload);
    if (error) throw error;
    if (authUser?.id !== userId) return false;
    return loadCloudCart(userId, { showError: false });
  }

  function isVariantLineUnavailable(item) {
    return item.productIsActive === false
      || item.variantIsActive === false
      || ["Unavailable", "Out of Stock", "Loading"].includes(item.availabilityState);
  }

  async function setAuthenticatedVariantCartQuantity(userId, item, quantity) {
    const rpcName = quantity > 0 ? "set_cart_item_v2" : "remove_cart_item_v2";
    const payload = quantity > 0
      ? {
        p_product_id: item.productId,
        p_product_variant_id: item.productVariantId,
        p_quantity: quantity,
      }
      : { p_product_variant_id: item.productVariantId };
    const { error } = await supabaseClient.rpc(rpcName, payload);
    if (error) throw error;
    if (authUser?.id !== userId) return false;
    return loadAuthenticatedVariantCart(userId, { showError: false, resolveAutomatic: false });
  }

  async function addSelectedVariantToCart(product) {
    const selectedVariantId = selectedVariantByProductId.get(product.id);
    const variant = getVariantById(product.id, selectedVariantId);
    if (!variant || variant.purchasableQuantity < 1) {
      showToast(selectedVariantId ? "Selected option is unavailable." : "Please select a size.");
      return;
    }

    await waitForAuthReady();
    if (!authUser?.id) {
      const existing = variantCart.find((item) => item.productVariantId === variant.variantId);
      if (existing) existing.quantity = Math.min(MAX_CART_QUANTITY, existing.quantity + 1);
      else variantCart.push(hydrateGuestVariantLine({
        productId: product.id,
        productVariantId: variant.variantId,
        quantity: 1,
      }));
      if (saveGuestVariantCart()) showToast(`${product.name} · ${variant.variantLabel} added to cart`);
      return;
    }

    const userId = authUser.id;
    const pendingLocal = pendingGuestMergeCart
      .find((item) => item.productVariantId === variant.variantId);
    if (pendingLocal) {
      const previousPending = pendingGuestMergeCart;
      pendingGuestMergeCart = pendingGuestMergeCart.map((item) => (
        item.productVariantId === variant.variantId
          ? { ...item, quantity: Math.min(MAX_CART_QUANTITY, item.quantity + 1) }
          : item
      ));
      if (!savePendingGuestMergeCart(userId)) {
        pendingGuestMergeCart = previousPending;
        updateCartCount();
        renderCartItems();
        showVariantCartSyncError(new Error("Pending guest cart could not be saved."));
      } else {
        showToast(`${product.name} · ${variant.variantLabel} is waiting for synchronization`);
      }
      return;
    }

    return enqueueVariantCartMutation(variant.variantId, async () => {
      const existing = variantCart.find((item) => item.productVariantId === variant.variantId);
      const quantity = Math.min(MAX_CART_QUANTITY, Number(existing?.quantity || 0) + 1);
      try {
        const reloaded = await setAuthenticatedVariantCartQuantity(userId, {
          productId: product.id,
          productVariantId: variant.variantId,
        }, quantity);
        if (!reloaded && authUser?.id === userId) {
          showVariantCartSyncError(new Error("Variant cart changed but could not be reloaded."));
          return;
        }
        if (authUser?.id === userId) showToast(`${product.name} · ${variant.variantLabel} added to cart`);
      } catch (error) {
        if (authUser?.id === userId) showVariantCartSyncError(error);
        else console.error("Variant cart mutation failed after account change", error);
      }
    });
  }

  async function changeVariantCartQuantity(variantId, change, source = "authenticated-v2") {
    await waitForAuthReady();
    const pendingLocal = source === "pending-guest-v2"
      ? pendingGuestMergeCart.find((item) => item.productVariantId === variantId)
      : null;
    const current = pendingLocal || variantCart.find((item) => item.productVariantId === variantId);
    if (!current) return;
    if (change > 0 && isVariantLineUnavailable(current)) {
      showToast("This option is currently unavailable.");
      return;
    }

    if (!authUser?.id) {
      const quantity = Math.min(MAX_CART_QUANTITY, current.quantity + change);
      variantCart = quantity > 0
        ? variantCart.map((item) => (item.productVariantId === variantId ? { ...item, quantity } : item))
        : variantCart.filter((item) => item.productVariantId !== variantId);
      saveGuestVariantCart();
      return;
    }

    const userId = authUser.id;
    if (pendingLocal) {
      const previousPending = pendingGuestMergeCart;
      const quantity = Math.min(MAX_CART_QUANTITY, pendingLocal.quantity + change);
      pendingGuestMergeCart = quantity > 0
        ? pendingGuestMergeCart.map((item) => (item.productVariantId === variantId
          ? { ...item, quantity }
          : item))
        : pendingGuestMergeCart.filter((item) => item.productVariantId !== variantId);
      if (!savePendingGuestMergeCart(userId)) {
        pendingGuestMergeCart = previousPending;
        updateCartCount();
        renderCartItems();
        showVariantCartSyncError(new Error("Pending guest cart could not be saved."));
      }
      return;
    }

    return enqueueVariantCartMutation(variantId, async () => {
      const latest = variantCart.find((item) => item.productVariantId === variantId);
      if (!latest || authUser?.id !== userId) return;
      const quantity = Math.min(MAX_CART_QUANTITY, latest.quantity + change);
      try {
        const reloaded = await setAuthenticatedVariantCartQuantity(userId, latest, quantity);
        if (!reloaded && authUser?.id === userId) {
          showVariantCartSyncError(new Error("Variant cart changed but could not be reloaded."));
        }
      } catch (error) {
        if (authUser?.id === userId) showVariantCartSyncError(error);
        else console.error("Variant cart quantity mutation failed after account change", error);
      }
    });
  }

  async function removeLegacyVariantLine(line) {
    if (!line) return;
    await waitForAuthReady();
    if (line.source === "guest-legacy") {
      if (removeGuestLegacyStorageItem(line.productId)) {
        legacyVariantCart = legacyVariantCart.filter((item) => item !== line);
        updateCartCount();
        renderCartItems();
      }
      return;
    }

    const userId = authUser?.id;
    if (!userId) return;
    return enqueueCartMutation(async () => {
      try {
        const { error } = await supabaseClient.rpc("remove_cart_item", { p_product_id: line.productId });
        if (error) throw error;
        if (authUser?.id === userId) await loadAuthenticatedVariantCart(userId, { resolveAutomatic: false });
      } catch (error) {
        if (authUser?.id === userId) showVariantCartSyncError(error);
      }
    });
  }

  async function clearVariantCart() {
    await waitForAuthReady();
    if (!authUser?.id) {
      variantCart = [];
      removeStorage(STORAGE_KEYS.variantCart);
      legacyVariantCart = getGuestLegacyVariantLines();
      updateCartCount();
      renderCartItems();
      showToast(legacyVariantCart.length
        ? "Resolved variant items cleared. Legacy items still require attention."
        : "Cart cleared");
      return;
    }

    const userId = authUser.id;
    return enqueueCartMutation(async () => {
      try {
        const { error } = await supabaseClient.rpc("clear_cart_v2");
        if (error) throw error;
        if (authUser?.id !== userId) return;
        await loadAuthenticatedVariantCart(userId, { showError: false, resolveAutomatic: false });
        showToast(legacyVariantCart.length || pendingGuestMergeCart.length
          ? "Variant cart cleared. Local or legacy items still need attention."
          : "Cart cleared");
      } catch (error) {
        if (authUser?.id === userId) showVariantCartSyncError(error);
      }
    });
  }

  async function addToCart(product) {
    if (!hasProductIdentity(product)) return;
    if (VARIANT_CART_V2_ENABLED) return addSelectedVariantToCart(product);
    if (VARIANT_UI_ENABLED) {
      showToast("Variant cart not enabled yet");
      return;
    }
    await waitForAuthReady();
    if (!authUser?.id) {
      const existing = cart.find((item) => item.id === product.id);
      if (existing) existing.qty = Math.min(MAX_CART_QUANTITY, existing.qty + 1);
      else cart.push({ ...product, qty: 1 });
      saveGuestCart();
      showToast(`${product.name} added to cart`);
      return;
    }

    const userId = authUser.id;
    return enqueueCartMutation(async () => {
      const current = cart.find((item) => item.id === product.id);
      const quantity = Math.min(MAX_CART_QUANTITY, Number(current?.qty || 0) + 1);
      try {
        const reloaded = await setAuthenticatedCartQuantity(userId, product.id, quantity);
        if (!reloaded && authUser?.id === userId) {
          showSyncError("Cart", new Error("Cart changed but could not be reloaded."));
          return;
        }
        if (authUser?.id === userId) showToast(`${product.name} added to cart`);
      } catch (error) {
        if (authUser?.id === userId) showSyncError("Cart", error);
        else console.error("Cart mutation failed after account change", error);
      }
    });
  }

  async function changeCartQuantity(id, change) {
    if (VARIANT_CART_V2_ENABLED) return changeVariantCartQuantity(id, change);
    if (VARIANT_UI_ENABLED) {
      showToast("Variant cart not enabled yet");
      return;
    }
    await waitForAuthReady();
    const current = cart.find((item) => item.id === id);
    if (!current) return;

    if (!authUser?.id) {
      const quantity = Math.min(MAX_CART_QUANTITY, current.qty + change);
      cart = quantity > 0
        ? cart.map((item) => (item.id === id ? { ...item, qty: quantity } : item))
        : cart.filter((item) => item.id !== id);
      saveGuestCart();
      return;
    }

    const userId = authUser.id;
    return enqueueCartMutation(async () => {
      const latest = cart.find((item) => item.id === id);
      if (!latest || authUser?.id !== userId) return;
      const quantity = Math.min(MAX_CART_QUANTITY, latest.qty + change);
      try {
        const reloaded = await setAuthenticatedCartQuantity(userId, id, quantity);
        if (!reloaded && authUser?.id === userId) {
          showSyncError("Cart", new Error("Cart changed but could not be reloaded."));
        }
      } catch (error) {
        if (authUser?.id === userId) showSyncError("Cart", error);
        else console.error("Cart quantity mutation failed after account change", error);
      }
    });
  }

  async function clearCurrentCart() {
    if (VARIANT_CART_V2_ENABLED) return clearVariantCart();
    if (VARIANT_UI_ENABLED) {
      showToast("Variant cart not enabled yet");
      return;
    }
    await waitForAuthReady();
    if (!authUser?.id) {
      cart = [];
      saveGuestCart();
      showToast("Cart cleared");
      return;
    }

    const userId = authUser.id;
    return enqueueCartMutation(async () => {
      try {
        const { error } = await supabaseClient.rpc("clear_cart");
        if (error) throw error;
        if (authUser?.id !== userId) return;
        const reloaded = await loadCloudCart(userId, { showError: false });
        if (!reloaded) {
          cart = [];
          updateCartCount();
          renderCartItems();
          showSyncError("Cart", new Error("Cleared cart could not be reloaded."));
          return;
        }
        showToast("Cart cleared");
      } catch (error) {
        if (authUser?.id === userId) showSyncError("Cart", error);
        else console.error("Clear cart failed after account change", error);
      }
    });
  }

  function getCartTotal() {
    return cart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 0), 0);
  }

  function getCheckoutErrorMessage(error) {
    const message = String(error?.message || "").toLowerCase();
    const code = String(error?.code || "");

    if (code === "42501" || message.includes("authentication required") || message.includes("jwt")) {
      return "Please log in to continue.";
    }
    if (message.includes("invalid checkout details") || message.includes("pin code")) {
      return "Please check your delivery details.";
    }
    if (message.includes("products are unavailable") || message.includes("product is unavailable")) {
      return "One or more products are unavailable.";
    }
    if (
      message.includes("cart is invalid") ||
      message.includes("invalid item") ||
      message.includes("maximum quantity")
    ) {
      return "Your cart contains an invalid item.";
    }
    return "We could not place your order. Please try again.";
  }

  function showCheckoutMessage(modal, type, message) {
    const success = $("[data-checkout-success]", modal);
    const error = $("[data-checkout-error]", modal);
    if (!success || !error) return;
    success.hidden = true;
    error.hidden = true;
    const target = type === "success" ? success : error;
    target.textContent = message;
    target.hidden = false;
  }

  function resetCheckoutMessage(modal) {
    const success = $("[data-checkout-success]", modal);
    const error = $("[data-checkout-error]", modal);
    if (success) {
      success.textContent = "";
      success.hidden = true;
    }
    if (error) {
      error.textContent = "";
      error.hidden = true;
    }
  }

  function formatCheckoutMoney(value) {
    return `$${money(value)}`;
  }

  function updateCheckoutSummary(modal) {
    const total = $("[data-checkout-total]", modal);
    if (total) total.textContent = formatCheckoutMoney(getCartTotal());
  }

  function setCheckoutStep(modal, step) {
    const form = $("[data-checkout-form]", modal);
    const title = $("#checkout-title", modal);
    const views = {
      details: $("[data-checkout-details]", modal),
      confirmation: $("[data-checkout-confirmation]", modal),
      success: $("[data-checkout-success-panel]", modal),
    };
    Object.values(views).forEach((view) => {
      if (view) view.hidden = true;
    });
    if (views[step]) views[step].hidden = false;
    if (form) form.dataset.step = step;
    if (title) {
      title.textContent = step === "confirmation"
        ? "Confirm Cash on Delivery"
        : step === "success"
          ? "Order Confirmed"
          : "Checkout";
    }
  }

  function renderCheckoutConfirmation(modal) {
    const form = $("[data-checkout-form]", modal);
    const items = $("[data-cod-confirmation-items]", modal);
    if (!form || !items) return false;

    const formData = new FormData(form);
    const checkoutCart = normalizeCartItems(cart);
    if (!checkoutCart.length) return false;

    items.innerHTML = checkoutCart
      .map((item) => `
        <article class="checkout-confirmation-item">
          <img src="${escapeHTML(item.image || "assets/hero-football-boot.avif")}" alt="${escapeHTML(item.name)}" loading="lazy" decoding="async" />
          <div>
            <strong>${escapeHTML(item.name)}</strong>
            <span>${escapeHTML(item.category)}</span>
            <small>Quantity: ${Number(item.qty || 1)}</small>
          </div>
          <b>${formatCheckoutMoney(Number(item.price || 0) * Number(item.qty || 1))}</b>
        </article>
      `)
      .join("");

    const address = [
      String(formData.get("address") || "").trim(),
      String(formData.get("city") || "").trim(),
      String(formData.get("state") || "").trim(),
      String(formData.get("pin_code") || "").trim(),
    ].filter(Boolean).join(", ");
    const phone = $("[data-cod-confirmation-phone]", modal);
    const addressNode = $("[data-cod-confirmation-address]", modal);
    const total = $("[data-cod-confirmation-total]", modal);
    const payMessage = $("[data-cod-payment-message]", modal);
    if (phone) phone.textContent = String(formData.get("customer_phone") || "").trim();
    if (addressNode) addressNode.textContent = address;
    if (total) total.textContent = formatCheckoutMoney(getCartTotal());
    if (payMessage) {
      payMessage.textContent = `You will pay ${formatCheckoutMoney(getCartTotal())} when the order is delivered.`;
    }
    return true;
  }

  function createCheckoutModal() {
    if ($(".checkout-modal")) return;
    const modal = document.createElement("div");
    modal.className = "checkout-modal";
    modal.innerHTML = `
      <div class="checkout-modal__box" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
        <div class="drawer-head">
          <div>
            <p class="eyebrow lime">Secure Order</p>
            <h3 id="checkout-title">Checkout</h3>
          </div>
          <button class="close-btn" type="button" data-close-checkout aria-label="Close checkout">×</button>
        </div>
        <form class="checkout-form" data-checkout-form novalidate>
          <section data-checkout-details>
            <div class="checkout-grid">
              <label class="form-field" for="checkout-name">
                <span>Full Name</span>
                <input id="checkout-name" name="customer_name" type="text" autocomplete="name" required />
              </label>
              <label class="form-field" for="checkout-email">
                <span>Email</span>
                <input id="checkout-email" name="customer_email" type="email" autocomplete="email" readonly required />
              </label>
              <label class="form-field" for="checkout-phone">
                <span>Phone Number</span>
                <input id="checkout-phone" name="customer_phone" type="tel" autocomplete="tel" required />
              </label>
              <label class="form-field" for="checkout-city">
                <span>City</span>
                <input id="checkout-city" name="city" type="text" autocomplete="address-level2" required />
              </label>
              <label class="form-field" for="checkout-state">
                <span>State</span>
                <input id="checkout-state" name="state" type="text" autocomplete="address-level1" required />
              </label>
              <label class="form-field" for="checkout-pin">
                <span>PIN Code</span>
                <input id="checkout-pin" name="pin_code" type="text" inputmode="numeric" autocomplete="postal-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required />
              </label>
              <label class="form-field form-field--full" for="checkout-address">
                <span>Delivery Address</span>
                <textarea id="checkout-address" name="address" autocomplete="street-address" required></textarea>
              </label>
              <label class="form-field form-field--full" for="checkout-note">
                <span>Optional Note</span>
                <textarea id="checkout-note" name="note"></textarea>
              </label>
            </div>
            <section class="checkout-payment-section" aria-labelledby="checkout-payment-title">
              <p class="checkout-section-label" id="checkout-payment-title">Payment Method</p>
              <div class="checkout-payment-option" data-cod-payment-option>
                <span class="checkout-payment-mark" aria-hidden="true">✓</span>
                <div>
                  <strong>Cash on Delivery</strong>
                  <p>Pay in cash when your order is delivered.</p>
                </div>
              </div>
            </section>
            <div class="checkout-summary">
              <div class="cart-total"><span>Order Total</span><span data-checkout-total>$0.00</span></div>
            </div>
            <button class="login-submit checkout-submit" type="submit" data-review-order>Review Cash on Delivery Order</button>
          </section>
          <section class="checkout-confirmation" data-checkout-confirmation hidden>
            <p class="checkout-section-label">Final Confirmation</p>
            <div class="checkout-confirmation-items" data-cod-confirmation-items></div>
            <div class="checkout-confirmation-grid">
              <div>
                <span>Delivery Address</span>
                <p data-cod-confirmation-address></p>
              </div>
              <div>
                <span>Phone Number</span>
                <p data-cod-confirmation-phone></p>
              </div>
              <div>
                <span>Payment Method</span>
                <p>Cash on Delivery</p>
              </div>
              <div>
                <span>Total Amount</span>
                <p class="checkout-confirmation-total" data-cod-confirmation-total></p>
              </div>
            </div>
            <p class="checkout-cod-message" data-cod-payment-message></p>
            <label class="checkout-confirm-checkbox">
              <input type="checkbox" data-cod-confirm-checkbox />
              <span>I confirm my delivery details and agree to pay the order amount on delivery.</span>
            </label>
            <div class="checkout-confirmation-actions">
              <button class="checkout-back-button" type="button" data-back-to-checkout>Back</button>
              <button class="login-submit checkout-submit" type="submit" data-place-order disabled>Confirm Cash on Delivery Order</button>
            </div>
          </section>
          <section class="checkout-success-panel" data-checkout-success-panel hidden>
            <span class="checkout-success-icon" aria-hidden="true">✓</span>
            <h4>Cash on Delivery order placed successfully.</h4>
            <dl>
              <div><dt>Order ID</dt><dd data-cod-success-order-id></dd></div>
              <div><dt>Total</dt><dd data-cod-success-total></dd></div>
              <div><dt>Payment Method</dt><dd data-cod-success-payment-method></dd></div>
              <div><dt>Payment Status</dt><dd data-cod-success-payment-status></dd></div>
            </dl>
            <p>Please keep the order amount ready when your order is delivered.</p>
            <p class="checkout-success-cart-note" data-cod-success-cart-note hidden></p>
          </section>
          <p class="auth-message auth-error" data-checkout-error role="alert" hidden></p>
          <p class="auth-message auth-success" data-checkout-success role="status" hidden></p>
        </form>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target.matches("[data-close-checkout]")) closeCheckout();
    });

    const form = $("[data-checkout-form]", modal);
    form?.addEventListener("submit", handleCheckoutSubmit);
    $("[data-back-to-checkout]", modal)?.addEventListener("click", () => {
      resetCheckoutMessage(modal);
      setCheckoutStep(modal, "details");
      window.setTimeout(() => $("#checkout-name", modal)?.focus(), 40);
    });
    $("[data-cod-confirm-checkbox]", modal)?.addEventListener("change", (event) => {
      const submitButton = $("[data-place-order]", modal);
      if (submitButton) submitButton.disabled = !event.currentTarget.checked;
    });
  }

  function prefillCheckoutForm(modal) {
    const metadata = authUser?.user_metadata || {};
    const fields = {
      customer_name: metadata.full_name || "",
      customer_email: authUser?.email || "",
      customer_phone: metadata.phone || "",
    };
    Object.entries(fields).forEach(([name, value]) => {
      const field = $(`[name="${name}"]`, modal);
      if (!field) return;
      if (name === "customer_email") {
        field.value = value;
        field.readOnly = true;
      } else if (!field.value) {
        field.value = value;
      }
    });
  }

  async function openCheckout() {
    if (VARIANT_CART_V2_ENABLED) {
      showToast("Variant checkout is not enabled yet");
      return;
    }
    if (VARIANT_UI_ENABLED) {
      showToast("Variant cart not enabled yet");
      return;
    }
    if (!cart.length) {
      showToast("Your cart is empty");
      return;
    }

    await waitForAuthReady();
    if (!authUser) {
      closeCart();
      showToast("Please login to place your order");
      await openLogin();
      return;
    }

    if (!supabaseClient) {
      showToast("Checkout is unavailable right now");
      return;
    }

    createCheckoutModal();
    const modal = $(".checkout-modal");
    if (!modal) return;
    const form = $("[data-checkout-form]", modal);
    if (form) {
      form.reset();
      form.dataset.checkoutToken = crypto.randomUUID();
      form.dataset.submitting = "false";
    }
    resetCheckoutMessage(modal);
    setCheckoutStep(modal, "details");
    prefillCheckoutForm(modal);
    updateCheckoutSummary(modal);
    closeCart();
    modal.classList.add("is-open");
    document.body.classList.add("no-scroll");
    window.setTimeout(() => $("#checkout-name", modal)?.focus(), 60);
  }

  function closeCheckout() {
    const modal = $(".checkout-modal");
    if (!modal) return;
    modal.classList.remove("is-open");
    if (!$([".cart-drawer.is-open", ".wishlist-drawer.is-open", ".login-modal.is-open", ".search-modal.is-open"].join(","))) {
      document.body.classList.remove("no-scroll");
    }
  }

  async function handleCheckoutSubmit(event) {
    event?.preventDefault?.();
    if (VARIANT_CART_V2_ENABLED) {
      const blockedModal = event?.currentTarget?.closest?.(".checkout-modal") || $(".checkout-modal");
      if (blockedModal) {
        showCheckoutMessage(blockedModal, "error", "Variant checkout is not enabled yet");
      } else {
        showToast("Variant checkout is not enabled yet");
      }
      return false;
    }

    const form = event?.currentTarget;
    if (!form) return false;
    const modal = form.closest(".checkout-modal");
    if (!modal) return;

    resetCheckoutMessage(modal);
    if (form.dataset.step !== "confirmation") {
      if (!form.checkValidity()) {
        showCheckoutMessage(modal, "error", "Please complete all required checkout fields.");
        form.reportValidity();
        return;
      }
      if (!cart.length || !renderCheckoutConfirmation(modal)) {
        showCheckoutMessage(modal, "error", "Your cart is empty.");
        return;
      }
      const confirmationCheckbox = $("[data-cod-confirm-checkbox]", modal);
      const submitButton = $("[data-place-order]", modal);
      if (confirmationCheckbox) confirmationCheckbox.checked = false;
      if (submitButton) submitButton.disabled = true;
      setCheckoutStep(modal, "confirmation");
      window.setTimeout(() => confirmationCheckbox?.focus(), 40);
      return;
    }

    if (form.dataset.submitting === "true") return;

    const submitButton = $("[data-place-order]", form);
    const confirmationCheckbox = $("[data-cod-confirm-checkbox]", form);
    if (!confirmationCheckbox?.checked) {
      showCheckoutMessage(modal, "error", "Please confirm the Cash on Delivery order.");
      return;
    }

    form.dataset.submitting = "true";
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Placing Order...";
    }

    const releaseSubmission = () => {
      form.dataset.submitting = "false";
      if (submitButton) {
        submitButton.disabled = !confirmationCheckbox?.checked;
        submitButton.textContent = "Confirm Cash on Delivery Order";
      }
    };

    await waitForAuthReady();
    if (!authUser) {
      showCheckoutMessage(modal, "error", "Please log in to continue.");
      releaseSubmission();
      return;
    }
    if (!cart.length) {
      showCheckoutMessage(modal, "error", "Your cart is empty.");
      releaseSubmission();
      return;
    }
    if (!supabaseClient) {
      showCheckoutMessage(modal, "error", "Checkout is unavailable right now.");
      releaseSubmission();
      return;
    }

    const formData = new FormData(form);
    const checkoutUserId = authUser.id;
    const checkoutCart = normalizeCartItems(cart);
    const checkoutToken = form.dataset.checkoutToken || crypto.randomUUID();
    form.dataset.checkoutToken = checkoutToken;
    const rpcPayload = {
      p_customer_name: String(formData.get("customer_name") || "").trim(),
      p_customer_phone: String(formData.get("customer_phone") || "").trim(),
      p_address: String(formData.get("address") || "").trim(),
      p_city: String(formData.get("city") || "").trim(),
      p_state: String(formData.get("state") || "").trim(),
      p_pin_code: String(formData.get("pin_code") || "").trim(),
      p_note: String(formData.get("note") || "").trim() || null,
      p_items: checkoutCart.map((item) => ({
        product_id: item.id,
        quantity: Number(item.qty || 1),
      })),
      p_checkout_token: checkoutToken,
    };

    try {
      const { data, error } = await supabaseClient.rpc("place_order", rpcPayload);
      if (error) throw error;

      const order = Array.isArray(data) ? data[0] : data;
      if (
        !order?.order_id ||
        !Number.isFinite(Number(order.total_amount)) ||
        order.payment_method !== "COD" ||
        !PAYMENT_STATUSES.includes(order.payment_status)
      ) {
        throw new Error("The order response was incomplete.");
      }

      let cartClearFailed = false;
      if (authUser?.id === checkoutUserId) {
        const { error: clearError } = await supabaseClient.rpc("clear_cart");
        if (clearError) {
          cartClearFailed = true;
          console.error("Order succeeded but cloud cart clearing failed", clearError);
        } else if (authUser?.id === checkoutUserId) {
          cart = [];
          updateCartCount();
          renderCartItems();
          const reloaded = await loadCloudCart(checkoutUserId, { showError: false });
          if (!reloaded && authUser?.id === checkoutUserId) {
            console.error("Order succeeded and cloud cart cleared, but cart reload failed");
          }
        } else {
          console.info("Cloud cart cleared after checkout; visible collections belong to a different owner.");
        }
      } else {
        cartClearFailed = true;
        console.error("Order succeeded, but the active account changed before cart clearing.");
      }
      const total = $("[data-checkout-total]", modal);
      if (total) total.textContent = formatCheckoutMoney(order.total_amount);
      delete form.dataset.checkoutToken;
      const successValues = {
        "[data-cod-success-order-id]": order.order_id,
        "[data-cod-success-total]": formatCheckoutMoney(order.total_amount),
        "[data-cod-success-payment-method]": getOrderPaymentMethod(order.payment_method),
        "[data-cod-success-payment-status]": getOrderPaymentStatus(order.payment_status),
      };
      Object.entries(successValues).forEach(([selector, value]) => {
        const target = $(selector, modal);
        if (target) target.textContent = value;
      });
      const cartNote = $("[data-cod-success-cart-note]", modal);
      if (cartNote) {
        cartNote.hidden = !cartClearFailed;
        cartNote.textContent = cartClearFailed
          ? "Your order was placed, but your cart could not be cleared automatically."
          : "";
      }
      setCheckoutStep(modal, "success");
      showToast("Cash on Delivery order placed successfully");
    } catch (error) {
      console.error("Checkout place_order RPC failed", {
        error,
        items: rpcPayload.p_items,
      });
      showCheckoutMessage(modal, "error", getCheckoutErrorMessage(error));
      releaseSubmission();
    }
  }

  function createCartDrawer() {
    if ($(".cart-drawer")) return;

    const drawer = document.createElement("aside");
    drawer.className = "cart-drawer";
    drawer.innerHTML = `
      <div class="cart-drawer__content" role="dialog" aria-modal="true" aria-label="Shopping cart">
        <div class="drawer-head">
          <h3>Your Cart</h3>
          <button class="close-btn" type="button" data-close-cart aria-label="Close cart">×</button>
        </div>
        <div class="cart-items"></div>
        <div class="cart-footer"></div>
      </div>
    `;
    document.body.appendChild(drawer);

    drawer.addEventListener("click", (event) => {
      if (event.target === drawer || event.target.matches("[data-close-cart]")) closeCart();
      const variantQtyButton = event.target.closest("[data-variant-cart-change]");
      if (variantQtyButton) {
        changeVariantCartQuantity(
          variantQtyButton.dataset.productVariantId,
          Number(variantQtyButton.dataset.variantCartChange),
          variantQtyButton.dataset.variantCartSource
        );
        return;
      }
      const legacyRemoveButton = event.target.closest("[data-remove-legacy-cart]");
      if (legacyRemoveButton) {
        const line = legacyVariantCart.find((item) => item.source === legacyRemoveButton.dataset.legacySource
          && item.productId === legacyRemoveButton.dataset.productId);
        if (line) removeLegacyVariantLine(line);
        return;
      }
      const resolveButton = event.target.closest("[data-resolve-legacy-cart]");
      if (resolveButton) {
        const line = legacyVariantCart.find((item) => item.source === resolveButton.dataset.legacySource
          && item.productId === resolveButton.dataset.productId);
        const selector = resolveButton.closest(".variant-legacy-item")?.querySelector("[data-legacy-variant-select]");
        if (!selector?.value) {
          showToast("Please select a size.");
          return;
        }
        resolveButton.disabled = true;
        void resolveLegacyVariantLine(line, selector.value).finally(() => {
          if (resolveButton.isConnected) resolveButton.disabled = false;
        });
        return;
      }
      const qtyButton = event.target.closest("[data-cart-change]");
      if (qtyButton) changeCartQuantity(qtyButton.dataset.id, Number(qtyButton.dataset.cartChange));
      if (event.target.matches("[data-clear-cart]")) {
        clearCurrentCart();
      }
      if (event.target.matches("[data-checkout]")) {
        openCheckout();
      }
    });
  }

  function openCart() {
    createCartDrawer();
    renderCartItems();
    $(".cart-drawer")?.classList.add("is-open");
    document.body.classList.add("no-scroll");
  }

  function closeCart() {
    $(".cart-drawer")?.classList.remove("is-open");
    document.body.classList.remove("no-scroll");
  }

  function renderCartItems() {
    const itemsContainer = $(".cart-items");
    const footer = $(".cart-footer");
    if (!itemsContainer || !footer) return;

    if (VARIANT_CART_V2_ENABLED) {
      renderVariantCartItems(itemsContainer, footer);
      return;
    }

    if (!cart.length) {
      itemsContainer.innerHTML = `<div class="empty-message">Your cart is empty. Add premium football gear from Top Picks.</div>`;
      footer.innerHTML = "";
      return;
    }

    itemsContainer.innerHTML = cart
      .map(
        (item) => `
          <article class="cart-item">
            <div>
              <h4>${item.name}</h4>
              <p>${item.category} · ${money(item.price)}</p>
            </div>
            <div class="cart-controls">
              <button type="button" data-id="${item.id}" data-cart-change="-1" aria-label="Decrease ${item.name}">−</button>
              <strong>${item.qty}</strong>
              <button type="button" data-id="${item.id}" data-cart-change="1" aria-label="Increase ${item.name}">+</button>
            </div>
          </article>
        `
      )
      .join("");

    const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
    footer.innerHTML = `
      <div class="cart-total"><span>Total</span><span>${money(total)}</span></div>
      <button class="cart-checkout" type="button" data-checkout>Checkout</button>
      <button class="clear-cart-btn" type="button" data-clear-cart>Clear Cart</button>
    `;
  }

  function getLegacyLineVariants(line) {
    return (variantsByProductId.get(line.productId) || [])
      .filter((variant) => variant.variantIsActive && variant.purchasableQuantity > 0);
  }

  function renderVariantResolvedLine(item) {
    const unavailable = isVariantLineUnavailable(item);
    const pendingMerge = item.source === "pending-guest-v2";
    const statusClass = String(item.availabilityState || "Unavailable").toLowerCase().replace(/[^a-z]+/g, "-");
    return `
      <article class="cart-item variant-cart-item${pendingMerge ? " variant-cart-item--pending" : ""}"
        data-variant-cart-line="${escapeHTML(item.productVariantId)}"
        data-variant-cart-source="${escapeHTML(item.source || "authenticated-v2")}">
        <div class="variant-cart-item__details">
          <h4>${escapeHTML(item.name)}</h4>
          <p>${escapeHTML(item.category)} · ${money(item.price)}</p>
          <p class="variant-cart-item__selection">Size: <strong>${escapeHTML(item.variantLabel)}</strong></p>
          <span class="variant-cart-state variant-cart-state--${statusClass}">${escapeHTML(item.availabilityState)}</span>
          ${pendingMerge ? '<span class="variant-cart-sync-state" role="status">Waiting for synchronization</span>' : ""}
        </div>
        <div class="cart-controls">
          <button type="button" data-product-variant-id="${escapeHTML(item.productVariantId)}" data-variant-cart-source="${escapeHTML(item.source || "authenticated-v2")}" data-variant-cart-change="-1" aria-label="Decrease ${escapeHTML(item.name)} ${escapeHTML(item.variantLabel)}">−</button>
          <strong>${item.quantity}</strong>
          <button type="button" data-product-variant-id="${escapeHTML(item.productVariantId)}" data-variant-cart-source="${escapeHTML(item.source || "authenticated-v2")}" data-variant-cart-change="1" aria-label="Increase ${escapeHTML(item.name)} ${escapeHTML(item.variantLabel)}" ${unavailable || item.quantity >= MAX_CART_QUANTITY ? "disabled" : ""}>+</button>
        </div>
      </article>
    `;
  }

  function renderVariantLegacyLine(line) {
    const variants = getLegacyLineVariants(line);
    const automatic = line.resolutionStatus === "Automatic" && line.automaticVariantId;
    const noActiveVariants = line.resolutionStatus === "No active variants"
      || (variantLoadStateByProductId.get(line.productId) !== "loading" && variants.length === 0);
    const options = variants.map((variant) => `
      <option value="${escapeHTML(variant.variantId)}">${escapeHTML(variant.variantLabel)}</option>
    `).join("");
    const resolution = automatic
      ? `<p class="variant-legacy-item__status" role="status">Resolving selected option...</p>`
      : noActiveVariants
        ? `<p class="variant-legacy-item__status">Currently unavailable</p>`
        : `
          <label class="variant-legacy-item__selector">
            <span>Size selection required</span>
            <select data-legacy-variant-select aria-label="Select size for ${escapeHTML(line.name)}">
              <option value="">Select size</option>
              ${options}
            </select>
          </label>
          <button class="variant-legacy-item__resolve" type="button"
            data-resolve-legacy-cart data-legacy-source="${escapeHTML(line.source)}"
            data-product-id="${escapeHTML(line.productId)}">Use Selected Size</button>
        `;
    return `
      <article class="cart-item variant-legacy-item" data-legacy-cart-line="${escapeHTML(line.productId)}">
        <div>
          <h4>${escapeHTML(line.name)}</h4>
          <p>${escapeHTML(line.category)} · ${money(line.price)} · Qty ${line.quantity}</p>
          ${resolution}
        </div>
        <button class="variant-legacy-item__remove" type="button"
          data-remove-legacy-cart data-legacy-source="${escapeHTML(line.source)}"
          data-product-id="${escapeHTML(line.productId)}"
          aria-label="Remove ${escapeHTML(line.name)} from cart">Remove</button>
      </article>
    `;
  }

  function renderVariantCartItems(itemsContainer, footer) {
    const allLines = [...variantCart, ...pendingGuestMergeCart, ...legacyVariantCart];
    if (!allLines.length) {
      itemsContainer.innerHTML = `<div class="empty-message">Your cart is empty. Add premium football gear from Top Picks.</div>`;
      footer.innerHTML = "";
      return;
    }

    itemsContainer.innerHTML = `
      <div class="variant-cart-status" role="status" aria-live="polite">Variant cart preview</div>
      ${variantCart.map(renderVariantResolvedLine).join("")}
      ${pendingGuestMergeCart.map(renderVariantResolvedLine).join("")}
      ${legacyVariantCart.map(renderVariantLegacyLine).join("")}
    `;
    const total = allLines.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
    footer.innerHTML = `
      <div class="cart-total"><span>Informational Total</span><span>${money(total)}</span></div>
      <p class="variant-checkout-message" role="status">Variant checkout is not enabled yet</p>
      <button class="cart-checkout" type="button" data-checkout disabled>Checkout</button>
      <button class="clear-cart-btn" type="button" data-clear-cart>Clear Cart</button>
    `;
  }



  function createWishlistDrawer() {
    if ($(".wishlist-drawer")) return;

    const drawer = document.createElement("aside");
    drawer.className = "wishlist-drawer";
    drawer.innerHTML = `
      <div class="wishlist-drawer__content" role="dialog" aria-modal="true" aria-label="Wishlist">
        <div class="drawer-head">
          <h3>Wishlist</h3>
          <button class="close-btn" type="button" data-close-wishlist aria-label="Close wishlist">×</button>
        </div>
        <div class="wishlist-items"></div>
        <div class="wishlist-footer"></div>
      </div>
    `;
    document.body.appendChild(drawer);

    drawer.addEventListener("click", (event) => {
      if (event.target === drawer || event.target.matches("[data-close-wishlist]")) closeWishlist();

      const removeButton = event.target.closest("[data-wishlist-remove]");
      if (removeButton) {
        removeWishlistItem(removeButton.dataset.wishlistRemove);
      }

      const addButton = event.target.closest("[data-wishlist-add-cart]");
      if (addButton) {
        const item = wishlist.find((product) => product.id === addButton.dataset.wishlistAddCart);
        if (item) addToCart(item);
      }
    });
  }

  function openWishlist() {
    createWishlistDrawer();
    renderWishlistItems();
    $(".wishlist-drawer")?.classList.add("is-open");
    document.body.classList.add("no-scroll");
  }

  function closeWishlist() {
    $(".wishlist-drawer")?.classList.remove("is-open");
    document.body.classList.remove("no-scroll");
  }

  function renderWishlistItems() {
    const itemsContainer = $(".wishlist-items");
    const footer = $(".wishlist-footer");
    if (!itemsContainer || !footer) return;

    if (!wishlist.length) {
      itemsContainer.innerHTML = `<div class="empty-message">Your wishlist is empty.</div>`;
      footer.innerHTML = `
        <a class="cart-checkout wishlist-view-all" href="wishlist.html">View All Wishlist</a>
      `;
      return;
    }

    itemsContainer.innerHTML = wishlist
      .map(
        (item) => `
          <article class="wishlist-item">
            <img src="${escapeHTML(item.image || "assets/hero-football-boot.avif")}" alt="${escapeHTML(item.name)}" loading="lazy" decoding="async" />
            <div>
              <h4>${escapeHTML(item.name)}</h4>
              <p>${escapeHTML(item.category)} · ${money(item.price)}</p>
              <div class="wishlist-item-actions">
                <button type="button" data-wishlist-add-cart="${escapeHTML(item.id)}">Add to Cart</button>
                <button type="button" data-wishlist-remove="${escapeHTML(item.id)}">Remove</button>
              </div>
            </div>
          </article>
        `
      )
      .join("");

    footer.innerHTML = `
      <a class="cart-checkout wishlist-view-all" href="wishlist.html">View All Wishlist</a>
    `;
  }

  async function mutateAuthenticatedWishlist(userId, productId, shouldSave) {
    const rpcName = shouldSave ? "set_wishlist_item" : "remove_wishlist_item";
    const { error } = await supabaseClient.rpc(rpcName, { p_product_id: productId });
    if (error) throw error;
    if (authUser?.id !== userId) return false;
    return loadCloudWishlist(userId, { showError: false });
  }

  async function toggleWishlist(product) {
    if (!hasProductIdentity(product)) return;
    await waitForAuthReady();
    const saved = isWishlisted(product.id);

    if (!authUser?.id) {
      wishlist = saved ? wishlist.filter((item) => item.id !== product.id) : [...wishlist, product];
      saveGuestWishlist();
      showToast(saved ? "Removed from wishlist" : "Added to wishlist");
      return;
    }

    const userId = authUser.id;
    return enqueueWishlistMutation(async () => {
      const currentlySaved = isWishlisted(product.id);
      try {
        const reloaded = await mutateAuthenticatedWishlist(userId, product.id, !currentlySaved);
        if (!reloaded && authUser?.id === userId) {
          showSyncError("Wishlist", new Error("Wishlist changed but could not be reloaded."));
          return;
        }
        if (authUser?.id === userId) {
          showToast(currentlySaved ? "Removed from wishlist" : "Added to wishlist");
        }
      } catch (error) {
        if (authUser?.id === userId) showSyncError("Wishlist", error);
        else console.error("Wishlist mutation failed after account change", error);
      }
    });
  }

  async function removeWishlistItem(id) {
    await waitForAuthReady();
    const item = wishlist.find((product) => product.id === id);
    if (!item) return;

    if (!authUser?.id) {
      wishlist = wishlist.filter((product) => product.id !== id);
      saveGuestWishlist();
      showToast("Removed from wishlist");
      return;
    }

    const userId = authUser.id;
    return enqueueWishlistMutation(async () => {
      try {
        const reloaded = await mutateAuthenticatedWishlist(userId, id, false);
        if (!reloaded && authUser?.id === userId) {
          showSyncError("Wishlist", new Error("Wishlist changed but could not be reloaded."));
          return;
        }
        if (authUser?.id === userId) showToast("Removed from wishlist");
      } catch (error) {
        if (authUser?.id === userId) showSyncError("Wishlist", error);
        else console.error("Wishlist removal failed after account change", error);
      }
    });
  }

  function renderWishlistPage() {
    const grid = $("[data-wishlist-page-grid]");
    const empty = $("[data-wishlist-empty]");
    const count = $("[data-wishlist-page-count]");
    if (!grid) return;

    if (count) count.textContent = String(wishlist.length);

    if (!wishlist.length) {
      grid.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }

    if (empty) empty.hidden = true;
    grid.innerHTML = wishlist
      .map(
        (item) => `
          <article class="product-card catalog-card wishlist-product-card" data-product-id="${escapeHTML(item.id)}" data-wishlist-id="${escapeHTML(item.id)}">
            <button class="wish is-active" type="button" data-wishlist-remove="${escapeHTML(item.id)}" aria-label="Remove ${escapeHTML(item.name)} from wishlist" aria-pressed="true">♥</button>
            <div class="product-image">
              <img class="wishlist-product-img" src="${escapeHTML(item.image || "assets/hero-football-boot.avif")}" alt="${escapeHTML(item.name)}" loading="lazy" decoding="async" />
            </div>
            <h3>${escapeHTML(item.name)}</h3>
            <p>${escapeHTML(item.category)}</p>
            <strong>${money(item.price)}</strong>
            <div class="color-dots" aria-hidden="true"><span></span><span></span><span></span></div>
            <button class="wishlist-page-remove" type="button" data-wishlist-remove="${escapeHTML(item.id)}">Remove from Wishlist</button>
            <button class="js-add-cart" type="button" data-wishlist-add-cart="${escapeHTML(item.id)}">Add to Cart</button>
          </article>
        `
      )
      .join("");
    hydrateVariantCards(grid);
  }

  function bindWishlistPageActions() {
    const pageSection = $("[data-wishlist-page]");
    if (!pageSection || pageSection.dataset.wishlistBound === "true") return;
    pageSection.dataset.wishlistBound = "true";

    pageSection.addEventListener("click", (event) => {
      const removeButton = event.target.closest("[data-wishlist-remove]");
      if (removeButton) {
        removeWishlistItem(removeButton.dataset.wishlistRemove);
        return;
      }

      const addButton = event.target.closest("[data-wishlist-add-cart]");
      if (addButton) {
        const item = wishlist.find((product) => product.id === addButton.dataset.wishlistAddCart);
        if (item) addToCart(item);
      }
    });
  }


  function initWishlist() {
    $$(".wish").forEach((button) => {
      if (button.dataset.wishlistBound === "true") return;
      const card = button.closest(".product-card");
      const id = card?.dataset.productId || card?.dataset.wishlistId || button.dataset.wishlistRemove;
      if (!id) {
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        return;
      }

      button.dataset.wishlistBound = "true";
      button.dataset.wishlistId = id;
      button.setAttribute("aria-pressed", String(isWishlisted(id)));

      button.addEventListener("click", () => {
        const product = productLookup.get(id) || getProductFromCard(card);
        toggleWishlist(product);
      });
    });

    updateWishlistUI();
  }

  function createFilters() {
    const sectionHeading = $(".products-section .section-heading");
    const productGrid = $(".product-grid");
    const existingFilterWrap = $(".filter-wrap");
    if (existingFilterWrap) {
      bindFilterWrap(existingFilterWrap);
      return;
    }
    if (!sectionHeading || !productGrid) return;

    const categories = ["All", ...new Set(productCards.map((card) => card.dataset.filter || card.dataset.category).filter(Boolean))];
    const filterWrap = document.createElement("div");
    filterWrap.className = "filter-wrap";
    filterWrap.innerHTML = categories
      .map((category) => `<button class="filter-btn ${category === "All" ? "is-active" : ""}" type="button" data-category="${category}">${category}</button>`)
      .join("");
    sectionHeading.insertAdjacentElement("afterend", filterWrap);

    bindFilterWrap(filterWrap);
  }

  function bindFilterWrap(filterWrap) {
    if (filterWrap.dataset.filterBound === "true") return;
    filterWrap.dataset.filterBound = "true";

    filterWrap.addEventListener("click", (event) => {
      const button = event.target.closest(".filter-btn");
      if (!button) return;
      activeCategory = button.dataset.category;
      $$(".filter-btn", filterWrap).forEach((btn) => btn.classList.remove("is-active"));
      button.classList.add("is-active");
      applyProductFilters();
    });
  }

  function applyProductFilters() {
    let visibleCount = 0;
    productCards.forEach((card) => {
      const name = card.dataset.name.toLowerCase();
      const category = card.dataset.category;
      const filter = card.dataset.filter || category;
      const matchesCategory = activeCategory === "All" || category === activeCategory || filter === activeCategory;
      const matchesSearch =
        !searchTerm ||
        name.includes(searchTerm) ||
        category.toLowerCase().includes(searchTerm) ||
        filter.toLowerCase().includes(searchTerm);
      const show = matchesCategory && matchesSearch;
      card.style.display = show ? "" : "none";
      if (show) visibleCount += 1;
    });

    let message = $(".no-product-message");
    const productGrid = $(".product-grid");
    if (!message && productGrid) {
      message = document.createElement("div");
      message.className = "no-product-message";
      message.textContent = "No products found. Try another search or category.";
      productGrid.insertAdjacentElement("afterend", message);
    }
    if (message) message.style.display = visibleCount ? "none" : "block";
  }

  function bindProductSortControls() {
    $$("[data-product-sort]").forEach((select) => {
      if (select.dataset.sortBound === "true") return;
      select.dataset.sortBound = "true";

      select.addEventListener("change", () => {
        const grid = $(".product-grid");
        if (!grid) return;

        const sortedCards = [...productCards];
        if (select.value === "price-low") {
          sortedCards.sort((a, b) => Number(a.dataset.price) - Number(b.dataset.price));
        } else if (select.value === "price-high") {
          sortedCards.sort((a, b) => Number(b.dataset.price) - Number(a.dataset.price));
        } else {
          sortedCards.sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
        }

        sortedCards.forEach((card) => grid.appendChild(card));
        applyProductFilters();
      });
    });
  }

  function createSearchModal() {
    if ($(".search-modal")) return;

    const modal = document.createElement("div");
    modal.className = "search-modal";
    modal.innerHTML = `
      <div class="search-modal__box" role="dialog" aria-modal="true" aria-label="Search products">
        <div class="modal-head">
          <h3>Search Gear</h3>
          <button class="close-btn" type="button" data-close-search aria-label="Close search">×</button>
        </div>
        <input type="search" placeholder="Search shoes, jersey, t-shirt, football..." data-product-search />
        <button class="search-clear" type="button" data-clear-search>Clear Search</button>
        <p class="search-note">Search works instantly on the product grid.</p>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target.matches("[data-close-search]")) closeSearch();
      if (event.target.matches("[data-clear-search]")) {
        searchTerm = "";
        $$("[data-product-search]").forEach((input) => {
          input.value = "";
        });
        applyProductFilters();
      }
    });
  }

  function bindProductSearchInputs() {
    $$("[data-product-search]").forEach((input) => {
      if (input.dataset.searchBound === "true") return;
      input.dataset.searchBound = "true";

      input.addEventListener("input", (event) => {
        searchTerm = event.target.value.trim().toLowerCase();
        $$("[data-product-search]").forEach((field) => {
          if (field !== event.target) field.value = event.target.value;
        });
        applyProductFilters();
        $("#products")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function openSearch() {
    createSearchModal();
    const modal = $(".search-modal");
    modal?.classList.add("is-open");
    document.body.classList.add("no-scroll");
    window.setTimeout(() => $("[data-product-search]", modal)?.focus(), 60);
  }

  function closeSearch() {
    $(".search-modal")?.classList.remove("is-open");
    document.body.classList.remove("no-scroll");
  }

  const getAuthEmail = () => authUser?.email || "";

  function getAuthName() {
    return authUser?.user_metadata?.full_name || getAuthEmail() || "Player";
  }

  function getFriendlyAuthError(error) {
    const message = error?.message || "Authentication request failed. Please try again.";
    const normalized = message.toLowerCase();

    if (normalized.includes("invalid login")) return "Invalid login credentials.";
    if (normalized.includes("email not confirmed") || normalized.includes("confirm your email")) {
      return "Please confirm your email before logging in.";
    }
    if (normalized.includes("already") && (normalized.includes("registered") || normalized.includes("exists"))) {
      return "Account already exists.";
    }
    if (normalized.includes("password")) return message;

    return message;
  }

  function resetAuthFeedback(modal) {
    $$("[data-auth-message]", modal).forEach((message) => {
      message.hidden = true;
      message.textContent = "";
    });
  }

  function showAuthMessage(modal, targetName, type, message) {
    const target = $(`[data-${targetName}-${type}]`, modal);
    if (!target) return;
    resetAuthFeedback(modal);
    target.textContent = message;
    target.hidden = false;
  }

  function updateAuthUI() {
    accountButton?.classList.toggle("is-authenticated", Boolean(authUser));
    accountButton?.setAttribute("title", authUser ? `Logged in as ${getAuthEmail()}` : "Account");

    const modal = $(".login-modal");
    if (!modal) return;

    const accountName = $("[data-account-name]", modal);
    const accountEmail = $("[data-account-email]", modal);
    const myOrdersLink = $("[data-my-orders-link]", modal);

    if (accountName) accountName.textContent = getAuthName();
    if (accountEmail) accountEmail.textContent = getAuthEmail();
    if (myOrdersLink) myOrdersLink.hidden = !authUser;
  }

  async function initSupabaseAuth() {
    if (!supabaseClient) {
      authUser = null;
      if (VARIANT_CART_V2_ENABLED) {
        collectionOwnerId = GUEST_STORAGE_ID;
        loadGuestWishlistOnly({ migrateLegacy: true });
        loadGuestVariantCollections();
      } else loadGuestCollections({ migrateLegacy: true });
      authReady = true;
      updateAuthUI();
      return;
    }

    authReady = false;

    try {
      supabaseClient.auth.onAuthStateChange((event, session) => {
        void (async () => {
          const generation = ++authStateGeneration;
          authReady = true;
          authUser = session?.user || null;
          invalidateAdminAccessForAuthChange();
          resetCustomerOrdersForAuthChange();
          await synchronizeCollectionOwner(authUser, { migrate: true });
          if (generation !== authStateGeneration) return;
          updateAuthUI();
          refreshAdminPageAccess();
          refreshMyOrdersPageAccess();
        })();
      });

      const sessionRequestGeneration = authStateGeneration;
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      if (sessionRequestGeneration !== authStateGeneration) return;
      const initialGeneration = ++authStateGeneration;
      authUser = data?.session?.user || null;

      await synchronizeCollectionOwner(authUser, { migrate: true });
      if (initialGeneration !== authStateGeneration) return;
    } catch (error) {
      console.warn("Supabase auth session check failed", error);
      authUser = null;
      if (VARIANT_CART_V2_ENABLED) {
        collectionOwnerId = GUEST_STORAGE_ID;
        loadGuestWishlistOnly({ migrateLegacy: true });
        loadGuestVariantCollections();
      } else loadGuestCollections({ migrateLegacy: true });
    } finally {
      authReady = true;
      updateAuthUI();
      refreshAdminPageAccess();
      refreshMyOrdersPageAccess();
    }
  }

  async function waitForAuthReady() {
    if (authReady) return;

    try {
      await authSessionPromise;
    } catch (error) {
      console.warn("Supabase auth readiness failed", error);
    }
  }

  function setAuthMode(mode) {
    const modal = $(".login-modal");
    if (!modal) return;

    const isRegister = mode === "register";
    const isAccount = mode === "account";
    const title = $("[data-auth-title]", modal);
    const loginForm = $("[data-login-form]", modal);
    const registerForm = $("[data-register-form]", modal);
    const accountPanel = $("[data-account-panel]", modal);

    if (title) title.textContent = isRegister ? "Register" : isAccount ? "Account" : "Login";
    if (loginForm) loginForm.hidden = isRegister || isAccount;
    if (registerForm) registerForm.hidden = !isRegister;
    if (accountPanel) accountPanel.hidden = !isAccount;
    updateAuthUI();
  }

  function createLoginModal() {
    if ($(".login-modal")) return;

    const modal = document.createElement("div");
    modal.className = "login-modal";
    modal.innerHTML = `
      <div class="login-modal__box" role="dialog" aria-modal="true" aria-label="Account access">
        <div class="modal-head">
          <h3 data-auth-title>Login</h3>
          <button class="close-btn" type="button" data-close-login aria-label="Close login">×</button>
        </div>
        <form class="login-form" data-login-form>
          <div class="form-field">
            <label for="login-email">Email</label>
            <input id="login-email" type="email" placeholder="you@example.com" autocomplete="email" required />
          </div>
          <div class="form-field">
            <label for="login-password">Password</label>
            <input id="login-password" type="password" placeholder="Enter password" autocomplete="current-password" required />
          </div>
          <p class="auth-message auth-error" data-login-error data-auth-message role="alert" hidden></p>
          <p class="auth-message auth-success" data-login-success data-auth-message role="status" aria-live="polite" hidden></p>
          <button class="login-submit" type="submit">Login</button>
          <p class="auth-switch">New here? <button class="auth-link" type="button" data-show-register>Create an account</button></p>
          <p class="login-note">Secure login powered by Supabase Auth.</p>
        </form>
        <form class="register-form" data-register-form hidden>
          <div class="form-field">
            <label for="register-name">Full Name</label>
            <input id="register-name" name="full-name" type="text" placeholder="Your full name" autocomplete="name" required />
          </div>
          <div class="form-field">
            <label for="register-email">Email Address</label>
            <input id="register-email" name="email" type="email" placeholder="you@example.com" autocomplete="email" required />
          </div>
          <div class="form-field">
            <label for="register-phone">Phone Number</label>
            <input id="register-phone" name="phone" type="tel" placeholder="+91 98765 43210" autocomplete="tel" required />
          </div>
          <div class="form-field">
            <label for="register-password">Password</label>
            <input id="register-password" name="password" type="password" placeholder="Create password" autocomplete="new-password" required />
          </div>
          <div class="form-field">
            <label for="register-confirm-password">Confirm Password</label>
            <input id="register-confirm-password" name="confirm-password" type="password" placeholder="Confirm password" autocomplete="new-password" required />
          </div>
          <p class="auth-message auth-error" data-register-error data-auth-message role="alert" hidden></p>
          <p class="auth-message auth-success" data-register-success data-auth-message role="status" aria-live="polite" hidden></p>
          <button class="login-submit" type="submit">Create Account</button>
          <p class="auth-switch">Already have an account? <button class="auth-link" type="button" data-show-login>Login</button></p>
          <p class="login-note">Your account is created with Supabase Auth. Never share your password.</p>
        </form>
        <section class="account-panel" data-account-panel hidden>
          <p class="eyebrow lime">Signed In</p>
          <h4 data-account-name>Player</h4>
          <p class="login-note">Logged in as: <strong data-account-email></strong></p>
          <p class="auth-message auth-error" data-account-error data-auth-message role="alert" hidden></p>
          <a class="account-orders-link" href="my-orders.html" data-my-orders-link hidden>My Orders</a>
          <button class="login-submit" type="button" data-logout>Logout</button>
        </section>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target.matches("[data-close-login]")) closeLogin();

      if (event.target.closest("[data-show-register]")) {
        event.preventDefault();
        resetAuthFeedback(modal);
        setAuthMode("register");
        window.setTimeout(() => $("#register-name", modal)?.focus(), 60);
      }

      if (event.target.closest("[data-show-login]")) {
        event.preventDefault();
        resetAuthFeedback(modal);
        setAuthMode("login");
        window.setTimeout(() => $("#login-email", modal)?.focus(), 60);
      }

      if (event.target.closest("[data-logout]")) {
        event.preventDefault();
        handleLogout(modal);
      }
    });

    $(".login-form", modal)?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const email = $("#login-email", modal)?.value.trim();
      const password = $("#login-password", modal)?.value;

      resetAuthFeedback(modal);

      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      if (!supabaseClient) {
        showAuthMessage(modal, "login", "error", "Supabase authentication could not load. Please check your connection and try again.");
        return;
      }

      try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;

        authUser = data?.user || data?.session?.user || null;
        resetCustomerOrdersForAuthChange();
        await synchronizeCollectionOwner(authUser, { migrate: true });
        updateAuthUI();
        refreshMyOrdersPageAccess();
        showToast("Logged in successfully");
        closeLogin();
      } catch (error) {
        showAuthMessage(modal, "login", "error", getFriendlyAuthError(error));
      }
    });

    $(".register-form", modal)?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const fullName = $("#register-name", modal)?.value.trim();
      const email = $("#register-email", modal)?.value.trim();
      const phone = $("#register-phone", modal)?.value.trim();
      const password = $("#register-password", modal)?.value;
      const confirmPassword = $("#register-confirm-password", modal)?.value;
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      resetAuthFeedback(modal);

      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      if (!fullName || !email || !phone || !password || !confirmPassword) {
        form.reportValidity();
        return;
      }

      if (!emailPattern.test(email)) {
        showAuthMessage(modal, "register", "error", "Please enter a valid email address.");
        return;
      }

      if (password !== confirmPassword) {
        showAuthMessage(modal, "register", "error", "Passwords do not match.");
        return;
      }

      if (!supabaseClient) {
        showAuthMessage(modal, "register", "error", "Supabase authentication could not load. Please check your connection and try again.");
        return;
      }

      try {
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullName,
              phone,
            },
          },
        });

        if (error) throw error;

        authUser = data?.session?.user || null;
        resetCustomerOrdersForAuthChange();
        await synchronizeCollectionOwner(authUser, { migrate: true });
        updateAuthUI();
        refreshMyOrdersPageAccess();

        if (data?.session) {
          showAuthMessage(modal, "register", "success", "Account created successfully. You are now logged in.");
          showToast("Account created successfully");
        } else {
          showAuthMessage(modal, "register", "success", "Account created successfully. Please check your email to confirm your account.");
        }
      } catch (error) {
        showAuthMessage(modal, "register", "error", getFriendlyAuthError(error));
      }
    });
  }

  async function handleLogout(modal = $(".login-modal")) {
    resetAuthFeedback(modal || document);

    if (!supabaseClient) {
      showAuthMessage(modal, "account", "error", "Supabase authentication could not load. Please check your connection and try again.");
      return;
    }

    try {
      const { error } = await supabaseClient.auth.signOut();
      if (error) throw error;

      authUser = null;
      resetCustomerOrdersForAuthChange();
      await synchronizeCollectionOwner(null, { migrate: true });
      updateAuthUI();
      refreshMyOrdersPageAccess();
      closeLogin();
      showToast("Logged out successfully");
    } catch (error) {
      showAuthMessage(modal, "account", "error", getFriendlyAuthError(error));
    }
  }

  async function openLogin() {
    await waitForAuthReady();
    createLoginModal();
    const modal = $(".login-modal");
    if (!modal) return;

    resetAuthFeedback(modal);
    setAuthMode(authUser ? "account" : "login");
    modal.classList.add("is-open");
    document.body.classList.add("no-scroll");
    window.setTimeout(() => (authUser ? $("[data-logout]", modal) : $("#login-email", modal))?.focus(), 60);
  }

  function closeLogin() {
    const modal = $(".login-modal");
    if (!modal) return;

    modal.classList.remove("is-open");
    document.body.classList.remove("no-scroll");
    resetAuthFeedback(modal);

    window.setTimeout(() => {
      if (!modal.classList.contains("is-open")) setAuthMode(authUser ? "account" : "login");
    }, 260);
  }

  function setMobileDrawerState(isOpen) {
    if (!mobileDrawer || !drawerOverlay || !menuToggle) return;

    mobileDrawer.classList.toggle("open", isOpen);
    drawerOverlay.classList.toggle("show", isOpen);
    mobileDrawer.setAttribute("aria-hidden", String(!isOpen));
    menuToggle.setAttribute("aria-expanded", String(isOpen));
    menuToggle.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
    document.body.classList.toggle("no-scroll", isOpen);
  }

  function openMobileDrawer() {
    setMobileDrawerState(true);
  }

  function closeMobileDrawer() {
    setMobileDrawerState(false);
  }

  function createMobileMenu() {
    const headerActions = $(".header-actions", header || document);
    if (!headerActions) return;

    if (!menuToggle) {
      menuToggle = document.createElement("button");
      menuToggle.className = "menu-toggle";
      menuToggle.type = "button";
      menuToggle.setAttribute("aria-label", "Open menu");
      menuToggle.setAttribute("aria-controls", "mobile-drawer");
      menuToggle.setAttribute("aria-expanded", "false");
      menuToggle.innerHTML = "<span></span>";
      headerActions.appendChild(menuToggle);
    }

    if (!drawerOverlay) {
      drawerOverlay = document.createElement("div");
      drawerOverlay.className = "drawer-overlay";
      drawerOverlay.dataset.drawerOverlay = "";
      document.body.appendChild(drawerOverlay);
    }

    if (!mobileDrawer) {
      mobileDrawer = document.createElement("aside");
      mobileDrawer.id = "mobile-drawer";
      mobileDrawer.className = "mobile-drawer";
      mobileDrawer.setAttribute("aria-hidden", "true");
      mobileDrawer.innerHTML = `
        <div class="drawer-head">
          <h3>Menu</h3>
          <button class="close-btn" type="button" data-close-menu aria-label="Close menu">×</button>
        </div>
        <div class="drawer-actions" aria-label="Drawer actions">
          <button type="button" data-drawer-search>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.8 18a7.2 7.2 0 1 1 5.06-12.32A7.2 7.2 0 0 1 10.8 18Zm0-2a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4Zm5.7.1 4.1 4.1-1.4 1.4-4.1-4.1 1.4-1.4Z"/></svg>
            <span>Search</span>
          </button>
          <button type="button" data-drawer-account>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12.2a4.8 4.8 0 1 1 0-9.6 4.8 4.8 0 0 1 0 9.6Zm0-2a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6ZM3.7 21.6v-1.4c0-3.7 3.6-6.2 8.3-6.2s8.3 2.5 8.3 6.2v1.4h-2v-1.4c0-2.4-2.5-4.2-6.3-4.2s-6.3 1.8-6.3 4.2v1.4h-2Z"/></svg>
            <span>Account</span>
          </button>
        </div>
        <nav class="mobile-drawer-nav" aria-label="Mobile navigation">
          ${mainNav?.innerHTML || `
            <a href="#">Home</a>
            <a href="products.html">Store</a>
            <a href="football-shoes.html">Football Shoes</a>
            <a href="jerseys.html">Jerseys</a>
            <a href="t-shirts.html">T-Shirts</a>
            <a href="footballs.html">Footballs</a>
            <a href="accessories.html">Accessories</a>
          `}
        </nav>
      `;
      document.body.appendChild(mobileDrawer);
    }

    menuToggle.addEventListener("click", () => {
      if (mobileDrawer.classList.contains("open")) {
        closeMobileDrawer();
      } else {
        openMobileDrawer();
      }
    });

    drawerOverlay.addEventListener("click", closeMobileDrawer);

    mobileDrawer.addEventListener("click", (event) => {
      if (event.target.closest("[data-drawer-search]")) {
        closeMobileDrawer();
        openSearch();
        return;
      }

      if (event.target.closest("[data-drawer-account]")) {
        closeMobileDrawer();
        openLogin();
        return;
      }

      if (event.target.matches("[data-close-menu]") || event.target.closest("a")) {
        closeMobileDrawer();
      }
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 900) closeMobileDrawer();
    });
  }

  const heroSlides = [
    {
      eyebrow: "Built for players",
      title: "Engineered<br>For <span>Glory</span>",
      text: "Premium quality. Elite performance.<br>Gear that fuels your passion for the game.",
    },
    {
      eyebrow: "New season drop",
      title: "Own The<br><span>Pitch</span>",
      text: "High-grip boots, match jerseys, and training essentials for serious players.",
    },
    {
      eyebrow: "Limited collection",
      title: "Speed Meets<br><span>Control</span>",
      text: "Shop premium football gear built for comfort, accuracy, and match-day confidence.",
    },
  ];

  function showSlide(index) {
    currentSlide = (index + heroSlides.length) % heroSlides.length;
    const slide = heroSlides[currentSlide];
    const eyebrow = $(".hero-copy .eyebrow");
    const title = $("#hero-title");
    const text = $(".hero-text");
    const indicatorFirst = $(".slider-indicator span:first-child");
    const indicatorLast = $(".slider-indicator span:last-of-type");

    if (eyebrow) eyebrow.textContent = slide.eyebrow;
    if (title) title.innerHTML = slide.title;
    if (text) text.innerHTML = slide.text;
    if (indicatorFirst) indicatorFirst.textContent = String(currentSlide + 1).padStart(2, "0");
    if (indicatorLast) indicatorLast.textContent = String(heroSlides.length).padStart(2, "0");
  }

  function initCarousel() {
    const heroArt = $(".hero-art");
    if (!heroArt || $(".slider-actions")) return;

    const actions = document.createElement("div");
    actions.className = "slider-actions";
    actions.innerHTML = `
      <button type="button" data-slide-prev aria-label="Previous slide">←</button>
      <button type="button" data-slide-next aria-label="Next slide">→</button>
    `;
    heroArt.appendChild(actions);

    const next = () => showSlide(currentSlide + 1);
    $("[data-slide-next]", actions)?.addEventListener("click", next);
    $("[data-slide-prev]", actions)?.addEventListener("click", () => showSlide(currentSlide - 1));
    $(".slider-indicator button")?.addEventListener("click", next);

    showSlide(0);
    window.setInterval(next, 5500);
  }

  function bindHeaderActions() {
    cartButton?.addEventListener("click", openCart);
    wishlistButton?.addEventListener("click", openWishlist);
    searchButton?.addEventListener("click", openSearch);
    accountButton?.addEventListener("click", openLogin);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeCart();
        closeWishlist();
        closeCheckout();
        closeSearch();
        closeLogin();
        closeAdminInventoryAdjustment();
        closeCustomerOrderDetails();
        closeCustomerCancellation();
        closeCookiePreferences();
        closeMobileDrawer();
      }
    });
  }


  function bindContactForm() {
    const form = $('[data-contact-form]');
    if (!form || form.dataset.contactBound === 'true') return;
    const success = $('[data-contact-success]', form);
    const cvInput = $('[data-cv-upload]', form);
    const cvError = $('[data-cv-error]', form);
    const allowedCvExtensions = ['pdf', 'jpg', 'jpeg'];
    const allowedCvTypes = ['application/pdf', 'image/jpeg'];
    const invalidCvMessage = 'Invalid format. Please upload your CV in PDF, JPG, or JPEG format only.';
    form.dataset.contactBound = 'true';

    const validateCvUpload = () => {
      if (!cvInput) return true;
      const file = cvInput.files?.[0];

      if (!file) {
        if (cvInput.dataset.cvInvalid === 'true') {
          cvInput.setCustomValidity(invalidCvMessage);
          if (cvError) cvError.hidden = false;
          return false;
        }
        if (cvError) cvError.hidden = true;
        cvInput.setCustomValidity('');
        return true;
      }

      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      const typeIsValid = !file.type || allowedCvTypes.includes(file.type);
      const extensionIsValid = allowedCvExtensions.includes(extension);
      const isValid = extensionIsValid && typeIsValid;

      if (!isValid) {
        cvInput.value = '';
        cvInput.dataset.cvInvalid = 'true';
        cvInput.setCustomValidity(invalidCvMessage);
        if (cvError) cvError.hidden = false;
        return false;
      }

      delete cvInput.dataset.cvInvalid;
      cvInput.setCustomValidity('');
      if (cvError) cvError.hidden = true;
      return true;
    };

    cvInput?.addEventListener('change', () => {
      delete cvInput.dataset.cvInvalid;
      validateCvUpload();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!validateCvUpload() || !form.checkValidity()) {
        form.reportValidity();
        return;
      }
      if (success) success.hidden = false;
      form.reset();
      if (cvInput) delete cvInput.dataset.cvInvalid;
      validateCvUpload();
    });
  }

  function bindCareerSelects() {
    $$('[data-career-select]').forEach((field) => {
      if (field.dataset.careerSelectBound === 'true') return;

      const trigger = $('[data-career-select-trigger]', field);
      const list = $('[data-career-select-list]', field);
      const value = $('[data-career-select-value]', field);
      const select = $('[data-career-select-input]', field);
      const options = $$('[data-career-option]', field);

      if (!trigger || !list || !value || !select || !options.length) return;

      const close = () => {
        list.hidden = true;
        field.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
      };

      const open = () => {
        list.hidden = false;
        field.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
      };

      const setValue = (option) => {
        const nextValue = option?.dataset.careerOption || '';
        select.value = nextValue;
        value.textContent = nextValue || 'Select a role';
        options.forEach((button) => {
          button.setAttribute('aria-selected', button === option ? 'true' : 'false');
        });
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };

      field.dataset.careerSelectBound = 'true';

      trigger.addEventListener('click', () => {
        if (list.hidden) open();
        else close();
      });

      trigger.addEventListener('keydown', (event) => {
        if (['Enter', ' ', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          open();
          const activeOption = options.find((button) => button.getAttribute('aria-selected') === 'true') || options[0];
          activeOption.focus();
        }
      });

      options.forEach((option, index) => {
        option.addEventListener('click', () => {
          setValue(option);
          close();
          trigger.focus();
        });

        option.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
            trigger.focus();
          }

          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            option.click();
          }

          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            const nextIndex = (index + direction + options.length) % options.length;
            options[nextIndex].focus();
          }
        });
      });

      document.addEventListener('click', (event) => {
        if (!field.contains(event.target)) close();
      });

      field.closest('form')?.addEventListener('reset', () => {
        window.setTimeout(() => {
          setValue(null);
          close();
        }, 0);
      });
    });
  }

  function boot() {
    injectInteractionStyles();
    collectProducts();
    hydrateVariantCards(document);
    createWishlistHeaderButton();
    createCartDrawer();
    createWishlistDrawer();
    createSearchModal();
    createCookieConsentUI();
    bindProductSearchInputs();
    createLoginModal();
    createMobileMenu();
    createFilters();
    bindProductSortControls();
    bindCareerSelects();
    bindContactForm();
    bindWishlistPageActions();
    authSessionPromise = initSupabaseAuth();
    initAdminPage();
    initMyOrdersPage();
    initWishlist();
    initCarousel();
    bindHeaderActions();
    updateCartCount();
    renderCartItems();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
