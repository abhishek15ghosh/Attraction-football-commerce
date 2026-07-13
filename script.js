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
  let wishlist = [];
  let productLookup = new Map();
  let activeCategory = "All";
  let searchTerm = "";
  let currentSlide = 0;
  let authUser = null;
  let authReady = !supabaseClient;
  let authSessionPromise = Promise.resolve();
  let collectionOwnerId = null;
  let collectionLoadVersion = 0;
  let collectionSyncOwnerId = null;
  let collectionSyncPromise = null;
  let cartMutationQueue = Promise.resolve();
  let wishlistMutationQueue = Promise.resolve();
  let customerOrders = [];
  let myOrdersLoadVersion = 0;
  let activeCancellationOrderId = null;
  let cancellationRequestSubmitting = false;

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

  const slugify = (text) =>
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

  const escapeHTML = (value = "") =>
    String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);

  const normalizePrice = (value) => Number(String(value || "0").replace(/[^0-9.]/g, "")) || 0;

  function getProductFromCard(card, index = 0) {
    const name = $("h3", card)?.textContent.trim() || `Product ${index + 1}`;
    const category = $("p", card)?.textContent.trim() || "Product";
    const price = normalizePrice($("strong", card)?.textContent || "0");
    const id = card.dataset.id || slugify(name);
    const image = $("img", card)?.getAttribute("src") || "";

    return { id, name, category, price, image };
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
      const id = rawItem.id || slugify(rawItem.name || "");
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

      const id = rawItem.id || slugify(rawItem.name || "");
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

  function loadGuestCollections({ migrateLegacy = true } = {}) {
    if (migrateLegacy) migrateLegacyStorageToGuest();
    collectionOwnerId = GUEST_STORAGE_ID;
    cart = normalizeCartItems(readStorage(getCartStorageKey(null), []));
    wishlist = normalizeWishlistItems(readStorage(getWishlistStorageKey(null), []));
    refreshCollectionUI();
  }

  async function activateCollectionOwner(user, { migrate = true } = {}) {
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

      card.dataset.id = product.id;
      card.dataset.index = String(index);
      card.dataset.name = product.name;
      card.dataset.category = product.category;
      card.dataset.filter = filter;
      card.dataset.price = String(product.price);
      card.dataset.image = product.image;
      productLookup.set(product.id, product);

      if (!$(`.js-add-cart`, card)) {
        const button = document.createElement("button");
        button.className = "js-add-cart";
        button.type = "button";
        button.textContent = "Add to Cart";
        button.addEventListener("click", () => addToCart(product));
        card.appendChild(button);
      }
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

  async function loadAdminOrders(page) {
    hideAdminFeedback(page);
    const container = $("[data-admin-orders]", page);
    if (container) container.innerHTML = `<div class="admin-empty">Loading orders...</div>`;
    const { data, error } = await supabaseClient
      .from("orders")
      .select("*, order_items(*)")
      .order("created_at", { ascending: false });
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
    if (!page || page.dataset.adminChecking === "true") return;
    page.dataset.adminChecking = "true";
    setAdminView(page, "loading");
    hideAdminFeedback(page);
    try {
      await waitForAuthReady();
      if (!supabaseClient) {
        setAdminView(page, "denied", "Supabase authentication is unavailable.");
        return;
      }
      if (!authUser) {
        setAdminView(page, "login", "Please login to view the admin dashboard.");
        return;
      }
      const { data: isAdmin, error } = await supabaseClient.rpc("is_admin");
      if (error) throw error;
      if (!isAdmin) {
        setAdminView(page, "denied", "Access denied");
        return;
      }
      setAdminView(page, "dashboard");
      await loadAdminOrders(page);
    } catch (error) {
      console.error("Admin access check failed", error);
      setAdminView(page, "denied", "Access denied");
      showAdminFeedback(page, "error", "Admin access could not be verified. Please try again.");
    } finally {
      page.dataset.adminChecking = "false";
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
      const saveButton = event.target.closest("[data-admin-status-save]");
      if (saveButton) updateAdminOrderStatus(page, saveButton);
      const paymentSaveButton = event.target.closest("[data-admin-payment-status-save]");
      if (paymentSaveButton) updateAdminOrderPaymentStatus(page, paymentSaveButton);
      const approveCancellationButton = event.target.closest("[data-admin-cancellation-approve]");
      if (approveCancellationButton) reviewAdminOrderCancellation(page, approveCancellationButton, "Approved");
      const rejectCancellationButton = event.target.closest("[data-admin-cancellation-reject]");
      if (rejectCancellationButton) reviewAdminOrderCancellation(page, rejectCancellationButton, "Rejected");
    });
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
    const count = cart.reduce((sum, item) => sum + item.qty, 0);
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
      const id = button.dataset.wishlistId || card?.dataset.id;
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

  async function addToCart(product) {
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
    event.preventDefault();
    const form = event.currentTarget;
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
          <article class="product-card catalog-card wishlist-product-card" data-wishlist-id="${escapeHTML(item.id)}">
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
      const id = card?.dataset.id || button.dataset.wishlistRemove;
      if (!id) return;

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
      loadGuestCollections({ migrateLegacy: true });
      authReady = true;
      updateAuthUI();
      return;
    }

    authReady = false;

    try {
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      authUser = data?.session?.user || null;
      await synchronizeCollectionOwner(authUser, { migrate: true });

      supabaseClient.auth.onAuthStateChange((event, session) => {
        void (async () => {
          authReady = true;
          authUser = session?.user || null;
          resetCustomerOrdersForAuthChange();
          await synchronizeCollectionOwner(authUser, { migrate: true });
          updateAuthUI();
          refreshAdminPageAccess();
          refreshMyOrdersPageAccess();
        })();
      });
    } catch (error) {
      console.warn("Supabase auth session check failed", error);
      authUser = null;
      loadGuestCollections({ migrateLegacy: true });
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
