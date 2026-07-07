/* Attraction Football Store Interactions
   Features: cart, filters, search, carousel, mobile menu, wishlist, Supabase auth.
   Add Supabase JS before this file, then add before </body>: <script src="script.js" defer></script>
*/

(() => {
  "use strict";

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

  const STORAGE_KEYS = {
    cart: "attraction_cart_v1",
    wishlist: "attraction_wishlist_v1",
  };

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
    } catch (error) {
      console.warn("Storage unavailable", error);
    }
  };

  let cart = readStorage(STORAGE_KEYS.cart, []);
  let wishlist = readStorage(STORAGE_KEYS.wishlist, []);
  let activeCategory = "All";
  let searchTerm = "";
  let currentSlide = 0;
  let authUser = null;

  const productCards = $$(".product-card");
  const cartButton = $(".cart-button");
  const cartCount = $(".cart-count");
  const searchButton = $('.header-actions button[aria-label="Search"]');
  const accountButton = $('.header-actions button[aria-label="Account"]');
  const header = $(".site-header");
  const mainNav = $(".main-nav");
  let menuToggle = $(".menu-toggle");
  let mobileDrawer = $(".mobile-drawer");
  let drawerOverlay = $(".drawer-overlay");

  const money = (number) => `$${Number(number).toFixed(2)}`;

  const slugify = (text) =>
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

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
      .login-modal,
      .search-modal {
        position: fixed;
        inset: 0;
        z-index: 999;
        pointer-events: none;
      }
      .mobile-panel::before,
      .cart-drawer::before,
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
      .login-modal.is-open,
      .search-modal.is-open {
        pointer-events: auto;
      }
      .mobile-panel.is-open::before,
      .cart-drawer.is-open::before,
      .login-modal.is-open::before,
      .search-modal.is-open::before {
        opacity: 1;
      }
      .mobile-panel__content,
      .cart-drawer__content {
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
      .cart-drawer.is-open .cart-drawer__content {
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
      .cart-item {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 14px;
        padding: 17px 0;
        border-bottom: 1px solid rgba(255,255,255,.1);
      }
      .cart-item h4 {
        margin: 0 0 7px;
        font-size: 14px;
        text-transform: uppercase;
      }
      .cart-item p {
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
      @media (max-width: 900px) {
        .menu-toggle { display: grid !important; }
      }
      @media (max-width: 560px) {
        .filter-wrap { margin-inline: 0; }
        .mobile-panel__content,
        .cart-drawer__content { padding: 22px; }
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
      }
    `;
    document.head.appendChild(style);
  }

  function collectProducts() {
    productCards.forEach((card, index) => {
      const name = $("h3", card)?.textContent.trim() || `Product ${index + 1}`;
      const category = $("p", card)?.textContent.trim() || "Product";
      const priceText = $("strong", card)?.textContent || "0";
      const price = Number(priceText.replace(/[^0-9.]/g, "")) || 0;
      const id = slugify(name);
      const filter = card.dataset.filter || category;

      card.dataset.id = id;
      card.dataset.index = String(index);
      card.dataset.name = name;
      card.dataset.category = category;
      card.dataset.filter = filter;
      card.dataset.price = String(price);

      if (!$(`.js-add-cart`, card)) {
        const button = document.createElement("button");
        button.className = "js-add-cart";
        button.type = "button";
        button.textContent = "Add to Cart";
        button.addEventListener("click", () => addToCart({ id, name, category, price }));
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

  function updateCartCount() {
    const count = cart.reduce((sum, item) => sum + item.qty, 0);
    if (cartCount) cartCount.textContent = String(count);
  }

  function addToCart(product) {
    const existing = cart.find((item) => item.id === product.id);
    if (existing) {
      existing.qty += 1;
    } else {
      cart.push({ ...product, qty: 1 });
    }
    writeStorage(STORAGE_KEYS.cart, cart);
    updateCartCount();
    renderCartItems();
    showToast(`${product.name} added to cart`);
  }

  function changeCartQuantity(id, change) {
    cart = cart
      .map((item) => (item.id === id ? { ...item, qty: item.qty + change } : item))
      .filter((item) => item.qty > 0);
    writeStorage(STORAGE_KEYS.cart, cart);
    updateCartCount();
    renderCartItems();
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
        cart = [];
        writeStorage(STORAGE_KEYS.cart, cart);
        updateCartCount();
        renderCartItems();
        showToast("Cart cleared");
      }
      if (event.target.matches("[data-checkout]")) {
        showToast("Checkout demo: connect payment gateway later");
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

  function initWishlist() {
    $$(".wish").forEach((button) => {
      const card = button.closest(".product-card");
      const id = card?.dataset.id;
      if (!id) return;

      const isSaved = wishlist.includes(id);
      button.classList.toggle("is-active", isSaved);
      button.textContent = isSaved ? "♥" : "♡";

      button.addEventListener("click", () => {
        const saved = wishlist.includes(id);
        wishlist = saved ? wishlist.filter((item) => item !== id) : [...wishlist, id];
        writeStorage(STORAGE_KEYS.wishlist, wishlist);
        button.classList.toggle("is-active", !saved);
        button.textContent = saved ? "♡" : "♥";
        showToast(saved ? "Removed from wishlist" : "Added to wishlist");
      });
    });
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

    if (accountName) accountName.textContent = getAuthName();
    if (accountEmail) accountEmail.textContent = getAuthEmail();
  }

  async function initSupabaseAuth() {
    if (!supabaseClient) {
      updateAuthUI();
      return;
    }

    try {
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      authUser = data?.session?.user || null;
      updateAuthUI();

      supabaseClient.auth.onAuthStateChange((_event, session) => {
        authUser = session?.user || null;
        updateAuthUI();
      });
    } catch (error) {
      console.warn("Supabase auth session check failed", error);
      authUser = null;
      updateAuthUI();
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
        updateAuthUI();
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
        updateAuthUI();

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
      updateAuthUI();
      closeLogin();
      showToast("Logged out successfully");
    } catch (error) {
      showAuthMessage(modal, "account", "error", getFriendlyAuthError(error));
    }
  }

  function openLogin() {
    createLoginModal();
    const modal = $(".login-modal");
    modal?.classList.add("is-open");
    document.body.classList.add("no-scroll");
    resetAuthFeedback(modal);
    setAuthMode(authUser ? "account" : "login");
    window.setTimeout(() => (authUser ? $("[data-logout]", modal) : $("#login-email", modal))?.focus(), 60);
  }

  function closeLogin() {
    const modal = $(".login-modal");
    modal?.classList.remove("is-open");
    document.body.classList.remove("no-scroll");
    if (modal) resetAuthFeedback(modal);
    setAuthMode("login");
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
    searchButton?.addEventListener("click", openSearch);
    accountButton?.addEventListener("click", openLogin);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeCart();
        closeSearch();
        closeLogin();
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
    createCartDrawer();
    createSearchModal();
    bindProductSearchInputs();
    createLoginModal();
    createMobileMenu();
    createFilters();
    bindProductSortControls();
    bindCareerSelects();
    bindContactForm();
    initSupabaseAuth();
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
