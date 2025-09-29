'use client';

import { useState, useEffect, useRef } from 'react';

interface TickerCardProps {
  ticker: {
    symbol: string;
    price: string;
    change: string;
    changePercent: string;
    timestamp: bigint;
  };
  onRemove: (symbol: string) => void;
}

export default function TickerCard({ ticker, onRemove }: TickerCardProps) {
  const [isBlinking, setIsBlinking] = useState(false);
  const [pctChange, setPctChange] = useState({
    value: '0.00%',
    color: 'text-gray-400',
    bgColor: 'bg-gray-700/50',
  });

  const prevPriceRef = useRef<number | null>(null);
  const isInitialMount = useRef(true);

  useEffect(() => {
    const currentPrice = parseFloat(ticker.price.replace(/,/g, ''));
    const prevPrice = prevPriceRef.current;

    // On the very first render, just set the initial price and do nothing else.
    if (isInitialMount.current) {
      isInitialMount.current = false;
      prevPriceRef.current = currentPrice;
      return; // Exit the effect early for the first render
    }

    // On every subsequent render, always trigger the blink
    setIsBlinking(true);
    const timer = setTimeout(() => setIsBlinking(false), 600);

    // And also perform the calculation if the price is different
    if (prevPrice !== null && currentPrice !== prevPrice) {
      const change = ((currentPrice - prevPrice) / prevPrice) * 100;
      const isPositive = change >= 0;
      setPctChange({
        value: `${isPositive ? '+' : ''}${change.toFixed(2)}%`,
        color: isPositive ? 'text-green-400' : 'text-red-400',
        bgColor: isPositive ? 'bg-green-900/20' : 'bg-red-900/20',
      });
    }

    // Update the ref for the next render
    prevPriceRef.current = currentPrice;

    // Return the cleanup function for the timer at the very end
    return () => clearTimeout(timer);

  }, [ticker.timestamp]); // This effect is triggered by every refresh

  return (
    <div className={`bg-gray-800 rounded-lg p-4 relative hover:bg-gray-700 transition-colors ${isBlinking ? 'animate-blink' : ''}`}>
      <button
        onClick={() => onRemove(ticker.symbol)}
        className="absolute top-2 right-2 text-gray-500 hover:text-red-400 transition-opacity"
        title="Remove ticker"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      <div className="flex items-center justify-between pr-8">
        <div className="text-lg font-semibold text-white">
          {ticker.symbol}
        </div>

        <div className="text-xl font-bold text-white">
          ${ticker.price}
        </div>

        <div className={`px-3 py-1 rounded-md text-sm font-semibold ${pctChange.color} ${pctChange.bgColor}`}>
          {pctChange.value}
        </div>
      </div>
    </div>
  );
}