import PriceTracker from '@/components/PriceTracker'

export default function Home() {
  return (
    <main className="min-h-screen p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold text-white mb-2 text-center">
          Crypto Price Streamer
        </h1>
        <p className="text-gray-400 text-center mb-8">
          Real-time cryptocurrency prices from TradingView
        </p>
        <PriceTracker />
      </div>
    </main>
  )
}
