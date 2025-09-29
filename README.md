# Crypto Price Streamer (Next.js + Node.js + Playwright)

A full-stack app that streams **real-time cryptocurrency prices** from TradingView (BINANCE) to a Next.js UI via a Node.js backend. The backend automates a **headed** Chromium browser with Playwright and pushes updates to the frontend over **ConnectRPC** server-streaming.

---

## Objectives

- Stream live prices for user-selected crypto tickers with **low latency** (push, not polling).
- Allow users to **add/remove** tickers; display the list **alphabetically**.
- Run Playwright in **headed** mode so browser automation is visible.
- Handle invalid tickers gracefully with **fast validation** and clear error messages.

---

## Tech Stack

- **Frontend:** Next.js, React, TypeScript  
- **Backend:** Node.js, TypeScript, tsx (TS runner)  
- **Automation:** Playwright (headed Chromium)  
- **RPC:** ConnectRPC (server-streaming)  
- **Build/Package:** pnpm workspaces, buf (protobuf codegen)

---

## Architecture Overview

- **One Playwright window**, **one tab per tracked ticker** for reuse and clarity.  
- A CSP-safe script on each tab observes TradingView’s price element and reports updates over RPC.  
- The frontend subscribes to a **server stream**, rendering live updates and computing small deltas.

---

## Run Locally

> **Prereqs:** Node.js ≥ 18, pnpm ≥ 8. (*Nix files are optional — not required.*)

1) **Install dependencies (workspace):**
```bash
pnpm install --recursive
```

2) **Start everything with the run script (codegen + browsers + servers):**
```bash
./run.sh
# If permission denied:
chmod +x run.sh && ./run.sh
```

3) **Open the app:**

http://localhost:3000

---

**Defaults:**

- **Backend (ConnectRPC):** http://localhost:4000  
- **Frontend (Next.js):** http://localhost:3000  
- **Playwright:** Runs headed; you’ll see a Chromium window.

---

**To allow a different frontend origin temporarily:**
```bash
FRONTEND_ORIGIN=http://localhost:3000 ./run.sh
```

## Usage

- Add a ticker like `BTCUSDT`, `ETHUSDT`, or `SOLUSDT`.
- A new tab opens for that symbol; prices start streaming to the UI.
- **Remove** to stop tracking and close the tab for that symbol.
- Invalid inputs are rejected quickly and shown as **“Invalid ticker”** in the UI.

---

## Notes & Assumptions

- TradingView URLs use: `https://www.tradingview.com/symbols/{TICKER}/?exchange=BINANCE`
- Symbols are uppercase, no separators (e.g., `BTCUSDT`).
- Tabs/windows are auto-restored for **valid** streams if closed unexpectedly.
- Minimal UI per goal: functionality & logs over aesthetics.

## Troubleshooting

- CORS/Preflight: Backend reflects ConnectRPC’s custom headers; ensure you start it via ./run.sh.
- Playwright Browsers: If missing, ./run.sh will install them.
- Ports in use: Change with env vars in your local shell or adjust the run script.
