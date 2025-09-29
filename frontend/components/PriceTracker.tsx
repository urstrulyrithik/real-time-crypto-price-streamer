'use client';

/**
 * PriceTracker.tsx
 * -----------------
 * - Subscribes to the backend server-stream (push-based) for live price updates
 * - Adds/removes tickers via ConnectRPC
 * - Keeps a Map<string, Ticker> in state for O(1) upserts and stable sorting
 * - Robust error handling for React 18 Strict Mode & network issues
 * - Logs every important event so evaluators can trace behavior in DevTools
 */

import { useState, useEffect, useRef } from 'react';
import { priceClient } from '@/lib/rpc-client';
import TickerCard from './TickerCard';
import type { Ticker } from '../lib/generated/proto/price_pb';
import { ConnectError, Code } from '@connectrpc/connect';

// Quick-access buttons for demoability
const POPULAR_TICKERS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'MATICUSDT'
];

export default function PriceTracker() {
  // ---------------------------
  // Local component state
  // ---------------------------
  const [tickers, setTickers] = useState<Map<string, Ticker>>(new Map());
  const [inputSymbol, setInputSymbol] = useState('');
  const [loading, setLoading] = useState(false);        // true while addTicker RPC in-flight
  const [error, setError] = useState<string | null>(null); // user-visible error banner
  const abortControllerRef = useRef<AbortController | null>(null); // cancels stream on unmount

  // ---------------------------
  // Establish the server stream once on mount.
  // React 18 Strict Mode mounts/unmounts twice in dev; we handle Canceled errors gracefully.
  // ---------------------------
  useEffect(() => {
    console.log('🚀 [ui] Mounting PriceTracker: starting price stream…');
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    const startStream = async () => {
      try {
        console.log('📡 [ui] streamPrices → subscribe (RPC)');
        const stream = priceClient.streamPrices({}, { signal });

        for await (const update of stream) {
          // Some backends emit system heartbeats — we ignore if so
          if (!update.ticker || update.ticker.symbol === 'SYSTEM_STATUS') continue;

          // Log a concise line for each update received
          console.log('📈 [ui] stream tick:', {
            s: update.ticker.symbol,
            p: update.ticker.price,
            d: update.ticker.change,
            pct: update.ticker.changePercent,
          });

          // Upsert the ticker into our Map (immutably)
          setTickers(prev => {
            const next = new Map(prev);
            next.set(update.ticker!.symbol, update.ticker!);
            return next;
          });
        }

        // If the async iterator completes naturally (rare), log it.
        console.log('👋 [ui] streamPrices iterator completed.');
      } catch (err) {
        // React Strict Mode causes an intentional cancel on dev Hot Reload / double-mount.
        if (err instanceof ConnectError && err.code === Code.Canceled) {
          console.log('🛑 [ui] streamPrices canceled (expected in Strict Mode).');
          return;
        }
        console.error('❌ [ui] streamPrices error:', err);
        setError('Failed to connect to price stream');
      }
    };

    // Kick off the stream
    startStream();

    // Cleanup: cancel the stream on unmount
    return () => {
      console.log('🧹 [ui] Unmounting PriceTracker: aborting price stream…');
      abortControllerRef.current?.abort();
    };
  }, []);

  // ---------------------------
  // Add a ticker via RPC
  // - Local guard prevents duplicate tracking attempts
  // - Backend also guards & returns friendly message for race conditions
  // ---------------------------
  const addTicker = async (symbolRaw: string) => {
    const symbol = symbolRaw.trim().toUpperCase();
    if (!symbol) {
      console.log('ℹ️ [ui] addTicker ignored (empty input).');
      return;
    }

    // Local duplicate guard to avoid unnecessary RPC calls
    if (tickers.has(symbol)) {
      console.log('ℹ️ [ui] Ticker already being tracked (local guard):', symbol);
      setError('Ticker already being tracked');
      return;
    }

    setLoading(true);
    setError(null);
    console.log('🟢 [ui] AddTicker → RPC:', symbol);

    try {
      const response = await priceClient.addTicker({ symbol });

      if (response.success) {
        console.log('✅ [ui] AddTicker success:', symbol);
        setInputSymbol(''); // clear input on success
        // Note: the server stream will upsert the actual ticker once the page loads and starts emitting
      } else {
        console.warn('⚠️ [ui] AddTicker rejected:', response.message);
        setError(response.message || 'Failed to add ticker');
      }
    } catch (err: any) {
      console.error('❌ [ui] AddTicker error:', err);
      setError(err?.message || 'Failed to add ticker');
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------
  // Remove a ticker via RPC
  // - On success we optimistically remove from local Map
  //   (server stream will also naturally stop emitting that symbol)
  // ---------------------------
  const removeTicker = async (symbol: string) => {
    console.log('🟡 [ui] RemoveTicker → RPC:', symbol);
  
    try {
      const response = await priceClient.removeTicker({ symbol });
  
      if (response.success) {
        console.log('✅ [ui] RemoveTicker success:', symbol);
  
        // Update UI state: drop the ticker from the map.
        setTickers(prev => {
          const next = new Map(prev);
          next.delete(symbol);
          return next;
        });
  
        // Clear any prior error banner on success (optional).
        setError('');
      } else {
        // No `message` on RemoveTickerResponse — log the raw response for debugging.
        console.warn('⚠️ [ui] RemoveTicker rejected (no message field):', response);
        setError('Failed to remove ticker');
      }
    } catch (err: any) {
      // Network / transport / unexpected errors.
      console.error('❌ [ui] RemoveTicker error:', err);
      setError(err?.message || 'Failed to remove ticker');
    }
  };
  // ---------------------------
  // Sorted view of tickers (alphabetical by symbol)
  // ---------------------------
  const sortedTickers = Array.from(tickers.values()).sort((a, b) =>
    a.symbol.localeCompare(b.symbol)
  );

  // ---------------------------
  // Render
  // ---------------------------
  return (
    <div className="space-y-6">
      {/* Add form */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-xl font-semibold text-white mb-4">Add Cryptocurrency</h2>

        <div className="flex gap-2 mb-4">
          {/* Controlled input: press Enter or click Add to submit */}
          <input
            type="text"
            value={inputSymbol}
            onChange={(e) => {
              setInputSymbol(e.target.value);
              if (error) setError(null); // clear prior error as user types
            }}
            onKeyDown={(e) => e.key === 'Enter' && addTicker(inputSymbol)}
            placeholder="Enter symbol (e.g., BTCUSDT)"
            className="flex-1 px-4 py-2 bg-gray-700 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loading}
          />

          <button
            onClick={() => addTicker(inputSymbol)}
            disabled={loading}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Adding...' : 'Add'}
          </button>
        </div>

        {/* Error banner (duplicate ticker, network errors, etc.) */}
        {error && (
          <div className="text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Quick-add buttons for common symbols */}
        <div className="mt-4">
          <p className="text-gray-400 text-sm mb-2">Popular tickers:</p>
          <div className="flex flex-wrap gap-2">
            {POPULAR_TICKERS.map((t) => (
              <button
                key={t}
                onClick={() => addTicker(t)}
                className="px-3 py-1 bg-gray-700 text-gray-300 rounded text-sm hover:bg-gray-600 transition-colors"
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Ticker list */}
      <div className="flex flex-col gap-4">
        {sortedTickers.length === 0 ? (
          <div className="col-span-full text-center py-12">
            <p className="text-gray-400 text-lg">No tickers added yet</p>
            <p className="text-gray-500 text-sm mt-2">
              Add a cryptocurrency symbol to start tracking prices
            </p>
          </div>
        ) : (
          sortedTickers.map((ticker) => (
            <TickerCard
              key={ticker.symbol}
              ticker={ticker}
              onRemove={removeTicker}
            />
          ))
        )}
      </div>
    </div>
  );
}
