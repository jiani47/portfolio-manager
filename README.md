# Portfolio Manager

A desktop application for personal portfolio management, built with Electron, React, and TypeScript.

## Features

- **Multi-Account Support**: Track holdings across multiple brokerage accounts (Brokerage, IRA, Roth IRA, 401k, etc.)
- **Holdings Management**: View and manage positions with cost basis tracking, MTM pricing, and unrealized gain/loss calculations
- **Transaction Tracking**: Record buys, sells, dividends, transfers, and other transaction types
- **Tax Lot Management**: Track individual tax lots with acquisition dates, holding periods, and capital gains status
- **Brokerage Import**: Direct import from Schwab position exports, realized gains reports, and lot details
- **Market Data Integration**: Real-time and historical price data via Financial Modeling Prep (FMP) API
- **Security Tagging**: Categorize holdings as Core, Satellite, or Event/Macro positions
- **Trading Rules**: Define systematic rules for position management
- **Decision Logs**: Document investment decisions with background, rationale, and execution notes
- **AI-Powered Insights**: Get intelligent analysis of your portfolio using OpenAI or Anthropic APIs
- **Local Database**: All data stored locally in SQLite for privacy and speed

## Technology Stack

- **Electron**: Cross-platform desktop application framework
- **React 18**: UI framework with TypeScript
- **SQLite** (better-sqlite3): Local database storage with WAL mode
- **Tailwind CSS**: Utility-first CSS framework
- **Recharts**: Data visualization
- **xlsx**: Excel file parsing
- **Vite**: Fast build tooling

---

## Architecture

### Process Model

The application follows Electron's multi-process architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Main Process                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Database   │  │ FMP Service │  │ AI Service  │              │
│  │  (SQLite)   │  │  (Market    │  │  (OpenAI/   │              │
│  │             │  │   Data)     │  │  Anthropic) │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
│         └────────────────┼────────────────┘                      │
│                          │                                       │
│                   IPC Handlers                                   │
│                          │                                       │
└──────────────────────────┼───────────────────────────────────────┘
                           │ IPC (invoke/handle)
┌──────────────────────────┼───────────────────────────────────────┐
│                          │                                       │
│                   Preload Script                                 │
│              (contextBridge.exposeInMainWorld)                   │
│                          │                                       │
└──────────────────────────┼───────────────────────────────────────┘
                           │ window.electronAPI
┌──────────────────────────┼───────────────────────────────────────┐
│                    Renderer Process                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   Pages     │  │  Components │  │   Hooks     │              │
│  │  (Holdings, │  │  (Modals,   │  │  (useApi,   │              │
│  │   TaxLots)  │  │   Tables)   │  │  useFMP)    │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│                                                                  │
│                      React Application                           │
└──────────────────────────────────────────────────────────────────┘
```

### Main Process Components

| Component | File | Purpose |
|-----------|------|---------|
| Database | `src/main/database.ts` | SQLite operations, schema management |
| IPC Handlers | `src/main/ipc-handlers.ts` | Handle renderer requests via IPC |
| FMP Service | `src/main/fmp-service.ts` | Market data API integration |
| AI Service | `src/main/ai-service.ts` | Portfolio analysis via LLMs |
| Backup Service | `src/main/backup-service.ts` | Database backup/restore |
| Parsers | `src/main/parsers/` | Brokerage file import parsers |

### Renderer Process Components

| Component | File | Purpose |
|-----------|------|---------|
| Holdings | `src/renderer/pages/Holdings.tsx` | Portfolio positions view |
| Tax Lots | `src/renderer/pages/TaxLots.tsx` | Tax lot management |
| Transactions | `src/renderer/pages/Transactions.tsx` | Transaction history |
| useApi hooks | `src/renderer/hooks/useApi.ts` | IPC wrapper hooks |

---

## Data Model

### Entity Relationship Diagram

```
┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│  accounts   │       │ securities  │       │security_tags│
├─────────────┤       ├─────────────┤       ├─────────────┤
│ id (PK)     │       │ id (PK)     │       │ id (PK)     │
│ name        │       │ symbol (UQ) │       │ name (UQ)   │
│ broker      │       │ name        │       │ display_name│
│ account_num │       │ type        │       │ color       │
│ account_type│       │ currency    │       │ description │
│ currency    │       │ sector      │       │ is_system   │
└──────┬──────┘       │ industry    │       └──────┬──────┘
       │              │ market_cap  │              │
       │              └──────┬──────┘              │
       │                     │                     │
       │    ┌────────────────┼────────────────┐    │
       │    │                │                │    │
       ▼    ▼                ▼                ▼    ▼
┌─────────────┐       ┌─────────────┐   ┌──────────────────┐
│  positions  │       │ price_hist  │   │security_tag_asgn │
├─────────────┤       ├─────────────┤   ├──────────────────┤
│ id (PK)     │       │ id (PK)     │   │ id (PK)          │
│ account_id  │───┐   │ security_id │   │ security_id (FK) │
│ security_id │   │   │ date        │   │ tag_id (FK)      │
│ quantity    │   │   │ open_price  │   └──────────────────┘
│ cost_basis  │   │   │ high_price  │
│ current_prc │   │   │ low_price   │
│ market_value│   │   │ close_price │
│ unreal_gain │   │   │ volume      │
└─────────────┘   │   └─────────────┘
                  │
       ┌──────────┴──────────┐
       │                     │
       ▼                     ▼
┌─────────────┐       ┌─────────────┐
│transactions │       │  tax_lots   │
├─────────────┤       ├─────────────┤
│ id (PK)     │       │ id (PK)     │
│ account_id  │       │ account_id  │
│ security_id │       │ security_id │
│ type        │       │ txn_id (FK) │
│ date        │       │ acq_date    │
│ quantity    │       │ quantity    │
│ price       │       │ cost_basis  │
│ amount      │       │ cost_per_sh │
│ fees        │       │ remain_qty  │
│ wash_sale   │       │ is_open     │
│ disallow_lss│       │ closed_date │
└─────────────┘       │ realized_gn │
                      │ hold_period │
                      └─────────────┘

┌─────────────┐       ┌─────────────┐
│trading_rules│       │decision_logs│
├─────────────┤       ├─────────────┤
│ id (PK)     │       │ id (PK)     │
│ name        │       │ security_id │
│ security_id │       │ decision_dt │
│ rule_type   │       │ decision_typ│
│ cond_type   │       │ background  │
│ cond_oper   │       │ decision    │
│ cond_value  │       │ execution   │
│ action_type │       │ txn_ids     │
│ action_value│       └─────────────┘
│ is_enabled  │
│ priority    │
└─────────────┘
```

### Core Tables

| Table | Description |
|-------|-------------|
| `accounts` | Brokerage accounts (IRA, Roth, 401k, Brokerage) |
| `securities` | Stocks, ETFs, mutual funds, bonds, crypto, cash |
| `positions` | Current holdings with quantity, cost basis, MTM price |
| `transactions` | Buy/sell/dividend/transfer history |
| `tax_lots` | Individual tax lots with acquisition dates and gains |
| `price_history` | Historical OHLCV data from FMP |
| `security_tags` | Tagging categories (Core, Satellite, Event/Macro) |
| `security_tag_assignments` | Many-to-many tag assignments |
| `trading_rules` | Systematic trading rules |
| `decision_logs` | Investment decision documentation |

### Security Types

- `stock` - Individual stocks
- `etf` - Exchange-traded funds
- `mutual_fund` - Mutual funds
- `bond` - Fixed income
- `option` - Options contracts
- `crypto` - Cryptocurrency
- `cash` - Cash/money market
- `other` - Other securities

### Transaction Types

- `buy` - Purchase
- `sell` - Sale
- `dividend` - Dividend received
- `interest` - Interest income
- `transfer_in` - Transfer into account
- `transfer_out` - Transfer out of account
- `split` - Stock split
- `spinoff` - Corporate spinoff
- `fee` - Account fee

---

## Integrations

### Financial Modeling Prep (FMP) API

Market data integration for real-time and historical prices.

**Configuration**: Settings → Data Provider → FMP → Enter API Key

**Capabilities**:
- Real-time stock quotes
- 30-day historical OHLCV data
- Company profiles (sector, industry, market cap)
- Earnings calendar for portfolio holdings

**API Endpoints Used**:
| Endpoint | Purpose |
|----------|---------|
| `/stable/quote` | Real-time quotes (batch) |
| `/stable/profile` | Company profile data |
| `/stable/historical-price-eod/full` | Historical daily prices |
| `/stable/earnings-calendar` | Upcoming earnings dates |

**Mark-to-Market Flow**:
```
User clicks "Refresh Prices" or "Fetch Historical"
         │
         ▼
┌─────────────────────────────────────────┐
│ Get all non-cash positions              │
│ Build symbol → securityId map           │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ Fetch prices from FMP API               │
│ - Try real-time quotes first            │
│ - Fall back to historical if weekend    │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ Save to price_history table             │
│ Update positions:                       │
│   currentPrice = latest close           │
│   marketValue = qty × price             │
│   unrealizedGain = MV - costBasis       │
│   unrealizedGainPct = gain / costBasis  │
└─────────────────────────────────────────┘
```

### AI Providers

Portfolio analysis using large language models.

**Supported Providers**:
- **OpenAI** - GPT-4 for analysis
- **Anthropic** - Claude for analysis

**Configuration**: Settings → AI Provider → Select provider → Enter API Key

**Analysis Features**:
- Portfolio concentration analysis
- Tax optimization suggestions
- Risk assessment
- Performance attribution

### Schwab Import Parsers

Direct import from Charles Schwab brokerage exports.

| Parser | File Type | Purpose |
|--------|-----------|---------|
| `schwab-parser` | Positions CSV | Import current holdings |
| `schwab-realized-gains-parser` | Realized Gains CSV | Import closed tax lots |
| `schwab-lot-details-parser` | Lot Details CSV | Import open tax lots |

**Import Flow**:
```
Select CSV file(s) from Schwab
         │
         ▼
Parser identifies file format
         │
         ▼
Extract positions/lots with:
  - Symbol, quantity, cost basis
  - Acquisition dates
  - Holding periods (short/long)
  - Wash sale adjustments
         │
         ▼
Match to existing accounts by identifier
         │
         ▼
Create/update securities, positions, tax lots
```

---

## Project Structure

```
portfolio-manager/
├── src/
│   ├── main/                   # Electron main process
│   │   ├── main.ts             # Entry point, window management
│   │   ├── preload.ts          # Preload script for IPC bridge
│   │   ├── database.ts         # SQLite database operations
│   │   ├── ipc-handlers.ts     # IPC communication handlers
│   │   ├── fmp-service.ts      # FMP market data integration
│   │   ├── ai-service.ts       # AI insights integration
│   │   ├── backup-service.ts   # Backup functionality
│   │   └── parsers/            # Brokerage file parsers
│   │       ├── index.ts
│   │       ├── parser-interface.ts
│   │       ├── parser-registry.ts
│   │       ├── schwab-parser.ts
│   │       ├── schwab-realized-gains-parser.ts
│   │       └── schwab-lot-details-parser.ts
│   ├── renderer/               # React application
│   │   ├── App.tsx             # Root component with routing
│   │   ├── index.tsx           # React entry point
│   │   ├── index.css           # Global styles (Tailwind)
│   │   ├── components/         # Reusable UI components
│   │   │   ├── Layout.tsx
│   │   │   ├── BrokerageImportModal.tsx
│   │   │   └── ...
│   │   ├── pages/              # Page components
│   │   │   ├── Holdings.tsx
│   │   │   ├── TaxLots.tsx
│   │   │   ├── Transactions.tsx
│   │   │   ├── Settings.tsx
│   │   │   ├── Earnings.tsx
│   │   │   └── ...
│   │   └── hooks/              # React hooks
│   │       └── useApi.ts       # IPC wrapper hooks
│   └── shared/                 # Shared types
│       └── types.ts            # TypeScript type definitions
├── package.json
├── tsconfig.json               # TypeScript config for renderer
├── tsconfig.main.json          # TypeScript config for main process
├── vite.config.ts              # Vite configuration
└── tailwind.config.js          # Tailwind CSS configuration
```

---

## Getting Started

### Prerequisites

- Node.js 18 or higher
- pnpm (recommended) or npm

### Installation

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Build for production
pnpm build

# Package the application
pnpm package
```

### Development

During development:
- The main process compiles TypeScript and runs Electron
- The renderer process runs Vite dev server with hot reload

---

## Usage Guide

### Setting Up Market Data

1. Get a free API key from [Financial Modeling Prep](https://financialmodelingprep.com/)
2. Go to Settings → Data Provider
3. Select "FMP" and enter your API key
4. Click "Test Connection" to verify

### Importing Holdings from Schwab

1. Export "Positions" CSV from Schwab
2. Go to Holdings → Import from Brokerage
3. Select "Schwab Positions" parser
4. Choose your CSV file
5. Map to existing account or create new

### Importing Tax Lots

1. Export "Lot Details" CSV from Schwab (per symbol)
2. Go to Tax Lots → Import Lot Details
3. Select multiple CSV files
4. Review and confirm import

### Refreshing Prices

- **Refresh Prices**: Fetches today's quotes, falls back to historical
- **Fetch Historical**: Fetches 30 days of historical data for all holdings

### Tagging Securities

1. Go to Holdings
2. Click "Tag" on any position
3. Assign categories: Core, Satellite, Event/Macro
4. Filter holdings by tag using the dropdown

---

## Security

- All data is stored locally on your device
- No data is sent to external servers (except to configured API providers)
- API keys are stored locally in the Electron store
- Database can be backed up and restored at any time

---

## License

MIT
