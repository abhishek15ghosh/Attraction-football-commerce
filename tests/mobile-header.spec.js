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

test.beforeEach(async ({ page }) => {
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
});

test("mobile header and drawer interactions work on Chromium iPhone 12 Pro viewport", async ({ page }) => {
  const viewport = page.viewportSize();
  const logo = page.locator(".brand");
  const searchButton = page.locator('.header-actions button[aria-label="Search"]');
  const accountButton = page.locator('.header-actions button[aria-label="Account"]');
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
  await expect(cartButton).toBeVisible();
  await expect(menuButton).toBeVisible();

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

test("sub-380 mobile header keeps only logo cart and menu, with search and account in drawer", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");

  const logo = page.locator(".brand");
  const searchButton = page.locator('.header-actions button[aria-label="Search"]');
  const accountButton = page.locator('.header-actions button[aria-label="Account"]');
  const cartButton = page.locator(".cart-button");
  const menuButton = page.locator(".menu-toggle");
  const drawer = page.locator("#mobile-drawer");
  const overlay = page.locator(".drawer-overlay");
  const drawerSearch = drawer.locator("[data-drawer-search]");
  const drawerAccount = drawer.locator("[data-drawer-account]");

  await expect(logo).toBeVisible();
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

    expect(footerMetrics.links.length).toBeGreaterThanOrEqual(20);
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
    "assets/store-accessory-gloves.png",
    "assets/store-accessory-shin-guards.png",
    "assets/store-accessory-boot-bag.png",
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
