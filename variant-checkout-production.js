/*
 * Phase 2C production cutover flags.
 *
 * STAGED ONLY: no production HTML page loads this file during preparation.
 * After the Stage 1 database permission migration has passed verification,
 * load this file before script.js on every storefront page except admin.html.
 */
(() => {
  "use strict";

  // Preserve Playwright and emergency rollback overrides established before
  // page scripts execute. Otherwise activate all three prerequisites together.
  if (window.__ATTRACTION_FEATURES__ !== undefined) return;

  window.__ATTRACTION_FEATURES__ = Object.freeze({
    variantUi: true,
    variantCartV2: true,
    variantCheckoutV2: true,
  });
})();
