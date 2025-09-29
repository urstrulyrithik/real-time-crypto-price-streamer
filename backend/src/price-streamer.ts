// backend/src/price-streamer.ts
// ----------------------------------------------------------------------------
// Manages a single headed Chromium browser + one tab per *valid* tracked ticker.
// - FAST VALIDATION: opens a short-lived headed tab with a small time budget
//   (≈ 1–2 s) so invalid tickers are rejected almost immediately and your UI
//   shows "Invalid ticker" without a long delay.
// - Only after validation passes do we open a persistent streaming tab.
// - Auto-heal logic reopens tabs only after the first numeric price ("validated").
// ----------------------------------------------------------------------------

import { chromium, Browser, BrowserContext, Page } from "playwright";
import { EventEmitter } from "node:events";

export type PriceEvent = {
  symbol: string;
  price: string;
  change: string;
  changePercent: string;
  timestamp: bigint;
};

type PageState = {
  page: Page | null;
  lastPrice?: number;
  intentionalClose?: boolean; // set by removeTicker() to avoid auto-reopen
  validated?: boolean;        // flips true after first numeric price arrives
};

// -----------------------------------------------------------------------------
// Config: tighten validation timeouts to minimize delay
// -----------------------------------------------------------------------------

/**
 * Overall validation budget — we try to complete within this window.
 * You can tweak via env if needed.
 */
const VALIDATION_TOTAL_BUDGET_MS = Number(process.env.VALIDATION_TOTAL_BUDGET_MS ?? 1400);

/**
 * Navigation timeout for the short-lived validation tab; keep it small since we
 * only need initial DOM to show error markers/selectors.
 */
const VALIDATION_GOTO_TIMEOUT_MS = Number(process.env.VALIDATION_GOTO_TIMEOUT_MS ?? 2000);

/**
 * Quick wait for obvious invalid markers (404 / not found banners).
 */
const INVALID_MARKER_WAIT_MS = Number(process.env.INVALID_MARKER_WAIT_MS ?? 250);

/**
 * Sprint wait for a price selector (DOM might settle just after DOMContentLoaded).
 */
const SELECTOR_SPRINT_WAIT_MS = Number(process.env.SELECTOR_SPRINT_WAIT_MS ?? 700);

// -----------------------------------------------------------------------------
// TradingView selectors & helpers
// -----------------------------------------------------------------------------

// Candidate selectors TradingView commonly uses for live price text
const SELECTORS = [
  ".tv-symbol-price-quote__value",
  ".js-symbol-last",
  "[data-name='legend-last']",
  ".tv-chart-view__symbol-last",
  ".js-symbol-last-quote",
];

// Consent/cookie button texts to auto-dismiss if shown
const CONSENT_TEXTS = ["Accept", "I Agree", "I agree", "Allow all", "Got it", "OK", "Continue", "Agree"];

// Heuristic markers seen on TradingView "not found"/invalid symbol pages
const INVALID_MARKERS = [
  ".tv-404",
  ".tv-not-found",
  ".tv-symbol-header__error",
  '[data-name="symbol-error"]',
  ".error-404",
];

// Basic sanity check for ticker strings (letters/numbers, optional USD/USDT suffix)
const BASIC_TICKER_RE = /^[A-Z0-9]{3,15}(USDT|USD)?$/i;

// Policy: if user enters bare "BTC", normalize to "BTCUSDT"
function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  return /USDT$|USD$/.test(s) ? s : `${s}USDT`;
}

// Build TradingView URL for the standardized BINANCE exchange
function tvUrl(symbol: string): string {
  return `https://www.tradingview.com/symbols/${symbol}/?exchange=BINANCE`;
}

// Small helper to burn time from a budget
function elapsed(start: number) {
  return Date.now() - start;
}

// -----------------------------------------------------------------------------
export class PriceStreamer extends EventEmitter {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages = new Map<string, PageState>();
  private starting = false;
  private restarting = false;

  constructor() {
    super();
  }

  /**
   * Launch headed browser & one context (window); new tickers become new tabs.
   * Headed mode is required by the assessment.
   */
  async start() {
    if (this.browser || this.starting) return;
    this.starting = true;

    console.log("🧰 [streamer] Launching headed Chromium…");
    this.browser = await chromium.launch({ headless: false });
    this.context = await this.browser.newContext();
    console.log("✅ [streamer] Browser & context ready.");

    // If window (context) closes, recreate and restore tabs
    this.context.on("close", async () => {
      console.warn("⚠️ [streamer] Context closed. Recreating & restoring tabs…");
      await this.recreateContextAndRestore();
    });

    // If browser closes, relaunch & restore
    this.browser.on("disconnected", async () => {
      console.warn("⚠️ [streamer] Browser disconnected. Relaunching & restoring…");
      await this.relaunchAndRestore();
    });

    this.starting = false;
  }

  /** Graceful shutdown */
  async stop() {
    console.log("🛑 [streamer] Stopping streamer (closing tabs, context, browser)…");
    for (const [symbol, state] of this.pages) {
      try {
        state.intentionalClose = true;
        await state.page?.close();
        console.log(`🔻 [streamer] Closed tab for ${symbol}`);
      } catch (e) {
        console.warn(`⚠️ [streamer] Error closing tab for ${symbol}:`, e);
      }
    }
    this.pages.clear();

    if (this.context) {
      await this.context.close();
      this.context = null;
      console.log("🧹 [streamer] Context closed.");
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.log("🧹 [streamer] Browser closed.");
    }
  }

  /** Query if a ticker is already tracked */
  hasTicker(symbol: string) {
    return this.pages.has(symbol.toUpperCase());
  }

  // -----------------------------------------------------------------------------
  // Public API: add/remove tickers
  // -----------------------------------------------------------------------------

  /**
   * Add a ticker for streaming with FAST VALIDATION:
   * - Uses a short-lived headed tab with a tiny time budget (~1–2 s).
   * - If invalid, returns { ok:false, reason } immediately (no persistent tab).
   * - If valid, opens a persistent streaming tab and returns { ok:true }.
   */
  async addTicker(symbolRaw: string): Promise<{ ok: boolean; reason?: string }> {
    const normalized = normalizeSymbol(symbolRaw);
    const symbol = normalized.toUpperCase();
    console.log("➕ [streamer] addTicker:", { input: symbolRaw, normalized: symbol });

    if (!this.browser || !this.context) await this.start();
    if (!this.browser || !this.context) return { ok: false, reason: "Browser not started" };

    // Fast sanity guard to avoid obvious junk
    if (!BASIC_TICKER_RE.test(symbol)) {
      console.warn("⛔ [streamer] Rejecting ticker (basic format failed):", symbol);
      return { ok: false, reason: "Invalid ticker" };
    }

    // If already tracked and tab alive, short-circuit success
    const existing = this.pages.get(symbol);
    if (existing?.page) {
      console.log("ℹ️ [streamer] Symbol already tracked; reusing tab:", symbol);
      return { ok: true };
    }

    // FAST VALIDATION (short-lived headed tab with tight timeouts)
    const { ok, reason } = await this.validateTickerFast(symbol);
    if (!ok) {
      console.warn("⛔ [streamer] Validation failed (fast); not opening persistent tab:", { symbol, reason });
      return { ok: false, reason: reason ?? "Invalid ticker" };
    }

    // Register and open persistent streaming tab
    if (!existing) {
      this.pages.set(symbol, { page: null, lastPrice: undefined, intentionalClose: false, validated: false });
      console.log("🆕 [streamer] Tracking new symbol (validated):", symbol);
    } else {
      existing.intentionalClose = false;
      existing.validated = false;
      console.log("♻️ [streamer] Symbol tracked but tab missing; reopening (validated):", symbol);
    }

    await this.openTabForSymbol(symbol);
    return { ok: true };
  }

  /** Stop tracking; close tab and prevent auto-reopen */
  async removeTicker(symbolRaw: string) {
    const symbol = symbolRaw.toUpperCase();
    console.log("➖ [streamer] removeTicker:", symbol);

    const state = this.pages.get(symbol);
    if (!state) {
      console.log("ℹ️ [streamer] removeTicker ignored; not tracked:", symbol);
      return;
    }

    try {
      state.intentionalClose = true;
      if (state.page) await state.page.close();
      console.log("✅ [streamer] Stopped & closed tab:", symbol);
    } catch (e) {
      console.warn("⚠️ [streamer] Error closing tab:", symbol, e);
    }
    this.pages.delete(symbol);
  }

  // -----------------------------------------------------------------------------
  // FAST VALIDATION (headed, short-lived page; tight time budget)
  // -----------------------------------------------------------------------------

  /**
   * validateTickerFast:
   * - Open headed page, navigate with small timeout.
   * - QUICK: check invalid markers (≈ 200–300 ms).
   * - SPRINT: try to find a price selector (immediate $, then short wait).
   * - JSON-LD fallback (no extra waits).
   * - Close page and return quickly; no persistent tab created here.
   */
  private async validateTickerFast(symbol: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.context) return { ok: false, reason: "Browser not started" };

    const url = tvUrl(symbol);
    const t0 = Date.now();
    console.log("🔎 [streamer] FAST validate:", { symbol, url });

    const page = await this.context.newPage(); // headed short-lived validation tab
    try {
      // Tight goto timeout to avoid long delays
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: VALIDATION_GOTO_TIMEOUT_MS });

      // QUICK: look for explicit invalid markers (immediate + tiny wait)
      for (const sel of INVALID_MARKERS) {
        if (await page.$(sel)) {
          console.warn("❌ [streamer] Invalid marker present:", { symbol, sel });
          return { ok: false, reason: "Invalid ticker" };
        }
      }
      // Small wait to allow an error banner to render if it’s about to
      try {
        await page.waitForSelector(INVALID_MARKERS.join(","), { timeout: Math.max(0, INVALID_MARKER_WAIT_MS) });
        console.warn("❌ [streamer] Invalid marker appeared shortly after load:", symbol);
        return { ok: false, reason: "Invalid ticker" };
      } catch {
        // no invalid marker within the tiny window → continue
      }

      // SPRINT: try to detect a price selector immediately
      for (const sel of SELECTORS) {
        if (await page.$(sel)) {
          console.log("✅ [streamer] FAST validate success (selector present):", { symbol, sel, ms: elapsed(t0) });
          return { ok: true };
        }
      }

      // Optional tiny sprint wait for selector to appear (bounded)
      const remaining = VALIDATION_TOTAL_BUDGET_MS - elapsed(t0);
      const sprint = Math.min(Math.max(0, remaining), SELECTOR_SPRINT_WAIT_MS);
      if (sprint > 0) {
        try {
          await page.waitForSelector(SELECTORS.join(","), { timeout: sprint });
          console.log("✅ [streamer] FAST validate success (selector sprint):", { symbol, ms: elapsed(t0) });
          return { ok: true };
        } catch {
          // fall through to JSON-LD
        }
      }

      // JSON-LD fallback with no extra waits
      const jd = await page.evaluate(() => {
        try {
          const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
          for (const s of scripts) {
            const txt = s.textContent || "";
            if (!txt) continue;
            try {
              const json = JSON.parse(txt);
              const objs = Array.isArray(json) ? json : [json];
              for (const obj of objs) {
                const p = obj?.offers?.price ?? obj?.price ?? obj?.currentPrice ?? null;
                if (typeof p === "string" || typeof p === "number") return String(p);
              }
            } catch {}
          }
        } catch {}
        return null;
      });
      if (jd) {
        console.log("✅ [streamer] FAST validate success (JSON-LD):", { symbol, ms: elapsed(t0) });
        return { ok: true };
      }

      console.warn("❌ [streamer] FAST validate: no selectors/JSON-LD within budget:", { symbol, ms: elapsed(t0) });
      return { ok: false, reason: "Invalid ticker" };
    } catch (e) {
      console.warn("❌ [streamer] FAST validate navigation error:", { symbol, error: String(e) });
      return { ok: false, reason: "Invalid ticker" };
    } finally {
      await page.close().catch(() => {});
      console.log("🧹 [streamer] Closed validation tab:", symbol);
    }
  }

  // -----------------------------------------------------------------------------
  // Restore flows (browser/context) — only for validated tabs
  // -----------------------------------------------------------------------------

  private async relaunchAndRestore() {
    if (this.restarting) return;
    this.restarting = true;

    const symbols = Array.from(this.pages.keys());
    for (const st of this.pages.values()) st.page = null;

    try {
      console.log("🔄 [streamer] Relaunching browser & context…");
      this.browser = await chromium.launch({ headless: false });
      this.context = await this.browser.newContext();

      this.context.on("close", async () => {
        console.warn("⚠️ [streamer] Context closed again; recreating & restoring…");
        await this.recreateContextAndRestore();
      });

      this.browser.on("disconnected", async () => {
        console.warn("⚠️ [streamer] Browser disconnected again; relaunching & restoring…");
        await this.relaunchAndRestore();
      });
    } catch (e) {
      console.error("❌ [streamer] Failed to relaunch browser/context:", e);
      this.restarting = false;
      return;
    }

    for (const sym of symbols) {
      const st = this.pages.get(sym);
      if (!st || st.intentionalClose) continue;
      try {
        await this.openTabForSymbol(sym, /*retry*/ true);
        console.log("✅ [streamer] Restored tab:", sym);
      } catch (e) {
        console.error(`❌ [streamer] Failed to restore ${sym}:`, e);
      }
    }

    this.restarting = false;
  }

  private async recreateContextAndRestore() {
    if (!this.browser) return;
    if (this.restarting) return;
    this.restarting = true;

    const symbols = Array.from(this.pages.keys());
    for (const st of this.pages.values()) st.page = null;

    try {
      console.log("🪟 [streamer] Recreating context (window)…");
      this.context = await this.browser.newContext();

      this.context.on("close", async () => {
        console.warn("⚠️ [streamer] Context closed again; recreating & restoring…");
        await this.recreateContextAndRestore();
      });
    } catch (e) {
      console.error("❌ [streamer] Failed to recreate context:", e);
      this.restarting = false;
      return;
    }

    for (const sym of symbols) {
      const st = this.pages.get(sym);
      if (!st || st.intentionalClose) continue;
      try {
        await this.openTabForSymbol(sym, /*retry*/ true);
        console.log("✅ [streamer] Restored tab:", sym);
      } catch (e) {
        console.error(`❌ [streamer] Failed to restore ${sym}:`, e);
      }
    }

    this.restarting = false;
  }

  // -----------------------------------------------------------------------------
  // Persistent streaming tab (only for validated symbols)
  // -----------------------------------------------------------------------------

  private async openTabForSymbol(symbol: string, retry = false) {
    const url = tvUrl(symbol);

    if (!this.context) throw new Error("Context (window) not available");
    const state = this.pages.get(symbol);
    if (!state) throw new Error(`State for ${symbol} not initialized`);

    console.log(`🌐 [streamer] Opening tab for ${symbol}: ${url}`);
    const page = await this.context.newPage(); // new tab in the same window

    // Mirror page console to backend for debug visibility
    page.on("console", (msg) => {
      console.log(`🪟 [${symbol}] PAGE ${msg.type().toUpperCase()}: ${msg.text()}`);
    });

    // If the tab is closed unexpectedly, reopen it *only if* this was a validated stream
    page.on("close", async () => {
      const st = this.pages.get(symbol);
      if (!st) return;

      if (st.intentionalClose) {
        console.log(`✅ [${symbol}] Tab closed intentionally (removeTicker).`);
        return;
      }
      if (!st.validated) {
        console.log(`ℹ️ [${symbol}] Tab closed before validation; will not auto-reopen.`);
        return;
      }

      console.warn(`⚠️ [${symbol}] Tab closed unexpectedly. Reopening…`);
      st.page = null;
      await this.retryOpen(symbol);
    });

    // Bridge function for page → Node price updates
    await page.exposeFunction("__reportPrice", (text: string) => {
      const cleaned = text.replace(/[^\d.,-]/g, "");
      const cur = Number.parseFloat(cleaned.replace(/,/g, ""));
      if (Number.isNaN(cur)) return;

      const st = this.pages.get(symbol);
      if (!st) return;

      const prev = st.lastPrice ?? cur;
      st.lastPrice = cur;

      const diff = cur - prev;
      const pct = prev !== 0 ? (diff / prev) * 100 : 0;

      // First numeric price → mark as validated so auto-heal is enabled
      if (!st.validated) st.validated = true;

      const evt: PriceEvent = {
        symbol,
        price: cleaned || text,
        change: (diff >= 0 ? "+" : "") + diff.toFixed(2),
        changePercent: (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%",
        timestamp: BigInt(Date.now()),
      };

      // Emit to all server-stream subscribers
      this.emit("price", evt);
    });

    // CSP-safe init script: auto-dismiss consent, attach MutationObserver + polling
    const initScript = `
      (function() {
        const selectors = ${JSON.stringify(SELECTORS)};
        const consentTexts = ${JSON.stringify(CONSENT_TEXTS)};
        const invalidMarkers = ${JSON.stringify(INVALID_MARKERS)};

        function tryDismissConsent() {
          try {
            const btns = Array.from(document.querySelectorAll('button, [role="button"], .button, .btn'));
            for (const b of btns) {
              const t = (b.textContent || "").trim();
              if (!t) continue;
              for (const want of consentTexts) {
                if (t === want || t.toLowerCase().includes(want.toLowerCase())) {
                  b.click();
                  return true;
                }
              }
            }
          } catch {}
          return false;
        }

        function findPriceEl() {
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) return el;
          }
          return null;
        }

        function hasInvalidMarker() {
          try {
            for (const sel of invalidMarkers) {
              if (document.querySelector(sel)) return true;
            }
          } catch {}
          return false;
        }

        function extractJsonLdPrice() {
          try {
            const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
            for (const s of scripts) {
              const txt = s.textContent || "";
              if (!txt) continue;
              try {
                const json = JSON.parse(txt);
                const objs = Array.isArray(json) ? json : [json];
                for (const obj of objs) {
                  const p = obj?.offers?.price ?? obj?.price ?? obj?.currentPrice ?? null;
                  if (typeof p === "string" || typeof p === "number") {
                    return String(p);
                  }
                }
              } catch {}
            }
          } catch {}
          return null;
        }

        function numericOrNull(text) {
          if (!text) return null;
          const cleaned = text.replace(/[^\\d.,-]/g, "").replace(/,/g, "");
          return cleaned && !isNaN(parseFloat(cleaned)) ? cleaned : null;
        }

        function sendIfNumeric(str) {
          const n = numericOrNull(str);
          if (n && (window).__reportPrice) {
            (window).__reportPrice(n);
            return true;
          }
          return false;
        }

        function start() {
          tryDismissConsent();

          // If page clearly indicates invalid symbol, do nothing.
          if (hasInvalidMarker()) {
            return;
          }

          let el = findPriceEl();
          const pushFromEl = () => {
            if (!el) return false;
            const text = (el.textContent || "").trim();
            return sendIfNumeric(text);
          };

          // Initial attempt via selector or JSON-LD fallback
          if (!pushFromEl()) {
            const jd = extractJsonLdPrice();
            if (jd) sendIfNumeric(jd);
          }

          // Observe element if present
          if (el) {
            const mo = new MutationObserver(() => { pushFromEl(); });
            mo.observe(el, { childList: true, subtree: true, characterData: true });
          }

          // Polling fallback to survive DOM changes
          setInterval(() => {
            if (!el) el = findPriceEl();
            if (!pushFromEl()) {
              const jd = extractJsonLdPrice();
              if (jd) sendIfNumeric(jd);
            }
          }, 1000);
        }

        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", start, { once: true });
        } else {
          start();
        }
      })();
    `;
    await page.addInitScript({ content: initScript });

    // Optional: tab title helps visually
    try {
      const title = `TV: ${symbol}`;
      await page.addInitScript({ content: `document.title = ${JSON.stringify(title)};` });
    } catch (e) {
      console.warn(`⚠️ [${symbol}] Could not set tab title:`, e);
    }

    // Navigate and store page
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Post-navigation guard: if page shows an invalid marker, close without auto-reopen
    const invalid = await this.pageHasInvalidMarker(page);
    if (invalid) {
      console.warn(`⛔ [${symbol}] Invalid page detected post-navigation; closing without reopen.`);
      state.intentionalClose = true; // ensures 'close' handler doesn't reopen
      try { await page.close(); } catch {}
      this.pages.delete(symbol);      // remove from registry
      return;
    }

    state.page = page;
    console.log(`✅ [streamer] Price observer set (tab) for ${symbol}`);
  }

  /** Retry loop to reopen a tab after unexpected close — only for validated tabs */
  private async retryOpen(symbol: string) {
    const st = this.pages.get(symbol);
    if (!st || st.intentionalClose || !st.validated) return;

    const delays = [500, 1000, 2000, 4000];
    for (let i = 0; i < delays.length; i++) {
      try {
        await this.openTabForSymbol(symbol, true);
        console.log(`🔁 [streamer] Reopened tab for ${symbol} after unexpected close.`);
        return;
      } catch (e) {
        console.warn(`⚠️ [streamer] Reopen attempt ${i + 1} for ${symbol} failed:`, e);
        await new Promise((r) => setTimeout(r, delays[i]));
      }
    }
    console.error(`❌ [streamer] Failed to reopen tab for ${symbol} after multiple attempts.`);
  }

  /** Utility: check invalid markers on an already-navigated page */
  private async pageHasInvalidMarker(page: Page): Promise<boolean> {
    try {
      for (const sel of INVALID_MARKERS) {
        const el = await page.$(sel);
        if (el) return true;
      }
    } catch {}
    return false;
  }
}
