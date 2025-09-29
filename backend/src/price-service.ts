// backend/src/price-service.ts
// -----------------------------------------------------------------------------
// ConnectRPC service implementation that exposes three RPCs:
// - AddTicker(symbol)    : validates with a short-lived Playwright page, then
//                          starts a persistent streaming tab only if valid
// - RemoveTicker(symbol) : stops streaming for that symbol (closes the tab)
// - StreamPrices()       : server-streams TickerUpdate events to each client
//
// This bridges the protobuf-es messages to our PriceStreamer. The key UX fix is
// returning { success:false, message:"Invalid ticker" } for invalid symbols
// BEFORE opening any persistent tab, so the frontend simply shows an error.
// -----------------------------------------------------------------------------

import { PriceStreamer, type PriceEvent } from "./price-streamer";

// Generated protobuf-es message classes (your file layout)
import {
  AddTickerRequest,
  AddTickerResponse,
  RemoveTickerRequest,
  RemoveTickerResponse,
  StreamPricesRequest,
  Ticker,
  TickerUpdate,
} from "./generated/proto/price_pb";

// Generated service descriptor (a value, not a type)
import { PriceService } from "./generated/proto/price_connect";

// Create a single shared streamer for the whole process
const streamer = new PriceStreamer();

/**
 * Helper: map our internal PriceEvent into a protobuf-es TickerUpdate.
 * Note: protobuf-es int64 fields accept bigint (recommended), string, or number.
 */
function toTickerUpdate(evt: PriceEvent): TickerUpdate {
  // Build a Ticker message instance
  const ticker = new Ticker({
    symbol: evt.symbol,
    price: evt.price,
    change: evt.change,
    changePercent: evt.changePercent,
    timestamp: typeof evt.timestamp === "bigint" ? evt.timestamp : BigInt(evt.timestamp),
  });

  // Wrap it in a TickerUpdate message (the RPC stream output type)
  return new TickerUpdate({ ticker });
}

/**
 * Implementation object for the PriceService RPC methods.
 * We attach it to the router in index.ts with:
 *   router.service(PriceService, priceServiceImpl)
 *
 * NOTE: We do not annotate this object as `PriceService` (a value), which avoids
 * “PriceService refers to a value, but is being used as a type” TS errors.
 */
const priceServiceImpl = {
  /**
   * AddTicker
   * - Rejects duplicates up front (friendly UX).
   * - Calls streamer.addTicker(symbol) → which validates in a short-lived tab.
   * - On invalid, returns { success:false, message:'Invalid ticker' } and opens
   *   no persistent tab.
   */
  async addTicker(req: AddTickerRequest): Promise<AddTickerResponse> {
    const symbol = (req.symbol ?? "").trim();
    console.log("🟢 [svc] AddTicker RPC:", symbol);

    if (streamer.hasTicker(symbol)) {
      return new AddTickerResponse({ success: false, message: "Ticker already being tracked" });
    }

    const { ok, reason } = await streamer.addTicker(symbol);
    if (!ok) {
      return new AddTickerResponse({ success: false, message: reason ?? "Invalid ticker" });
    }

    return new AddTickerResponse({ success: true, message: "" });
  },

  /**
   * RemoveTicker
   * - Closes the tab (if any) and removes the symbol from the registry.
   */
  async removeTicker(req: RemoveTickerRequest): Promise<RemoveTickerResponse> {
    const symbol = (req.symbol ?? "").trim();
    console.log("🟡 [svc] RemoveTicker RPC:", symbol);

    await streamer.removeTicker(symbol);
    // RemoveTickerResponse only has `success: bool`
    return new RemoveTickerResponse({ success: true });
  },

  /**
   * StreamPrices
   * - Server-streaming RPC: pushes every PriceEvent as a TickerUpdate to the
   *   connected client, with minimal latency.
   * - Uses a small queue + promise to bridge EventEmitter → async iterator.
   * - Cleans up the event listener when the client disconnects.
   */
  async *streamPrices(_req: StreamPricesRequest): AsyncIterable<TickerUpdate> {
    console.log("📡 [svc] streamPrices: client subscribed");

    // Ensure the headed browser is up (safe no-op if already running)
    await streamer.start();

    // Simple queue of outgoing messages
    const queue: TickerUpdate[] = [];

    // A promise we await when the queue is empty
    let notify: (() => void) | null = null;

    // Push helper: enqueue and wake any awaiting iterator
    const push = (msg: TickerUpdate) => {
      queue.push(msg);
      if (notify) {
        const n = notify;
        notify = null;
        n();
      }
    };

    // Event bridge from streamer → async iterator
    const onPrice = (evt: PriceEvent) => {
      push(toTickerUpdate(evt));
    };

    streamer.on("price", onPrice);

    try {
      // Main loop: yield messages as they arrive
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as TickerUpdate;
          continue;
        }
        // Wait for the next event
        await new Promise<void>((resolve) => (notify = resolve));
      }
    } finally {
      // Always remove listener to avoid leaks
      streamer.off("price", onPrice);
      console.log("👋 [svc] streamPrices: client unsubscribed");
    }
  },
};

// Re-export for index.ts to mount + control lifecycle
export { PriceService, priceServiceImpl, streamer };
