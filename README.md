# Portfolio Manager

A desktop application for personal portfolio management, built with Electron, React, and TypeScript.

## Features

- **Multi-Account Support**: Track holdings across multiple brokerage accounts (Brokerage, IRA, Roth IRA, 401k, etc.)
- **Holdings Management**: View and manage positions with cost basis tracking and unrealized gain/loss calculations
- **Transaction Tracking**: Record buys, sells, dividends, transfers, and other transaction types
- **Tax Lot Management**: Track individual tax lots with acquisition dates, holding periods, and capital gains status
- **Excel Import**: Import transactions, positions, and tax lots from Excel/CSV files
- **AI-Powered Insights**: Get intelligent analysis of your portfolio using OpenAI or Anthropic APIs
- **Local Database**: All data stored locally in SQLite for privacy and speed
- **Cloud Backup**: Optional backup to Google Drive, Dropbox, S3, or OneDrive

## Technology Stack

- **Electron**: Cross-platform desktop application framework
- **React 18**: UI framework with TypeScript
- **SQLite** (better-sqlite3): Local database storage
- **Tailwind CSS**: Utility-first CSS framework
- **Recharts**: Data visualization
- **xlsx**: Excel file parsing

## Getting Started

### Prerequisites

- Node.js 18 or higher
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Package the application
npm run package
```

### Development

The application runs in two processes:
- **Main Process**: Electron main process handling database, file operations, and system integration
- **Renderer Process**: React application for the UI

During development:
- The main process compiles TypeScript and runs Electron
- The renderer process runs Vite dev server with hot reload

## Project Structure

```
portfolio-manager/
├── src/
│   ├── main/               # Electron main process
│   │   ├── main.ts         # Entry point
│   │   ├── preload.ts      # Preload script for IPC
│   │   ├── database.ts     # SQLite database operations
│   │   ├── backup-service.ts # Backup functionality
│   │   ├── ai-service.ts   # AI insights integration
│   │   └── ipc-handlers.ts # IPC communication handlers
│   ├── renderer/           # React application
│   │   ├── components/     # Reusable UI components
│   │   ├── pages/          # Page components
│   │   ├── hooks/          # React hooks
│   │   └── index.css       # Global styles
│   └── shared/             # Shared types and utilities
│       └── types.ts        # TypeScript type definitions
├── package.json
├── tsconfig.json           # TypeScript config for renderer
├── tsconfig.main.json      # TypeScript config for main process
├── vite.config.ts          # Vite configuration
└── tailwind.config.js      # Tailwind CSS configuration
```

## Data Import

The application supports importing data from Excel files (.xlsx, .xls) and CSV files.

### Transaction Import
Required columns: Date, Symbol, Quantity, Price
Optional columns: Type, Amount, Fees, Notes

### Position Import
Required columns: Symbol, Quantity, Cost Basis
Optional columns: Current Price

### Tax Lot Import
Required columns: Symbol, Quantity, Cost Basis, Acquisition Date

## AI Insights

Configure an AI provider in Settings to get intelligent portfolio analysis:

1. **OpenAI**: Uses GPT-4 for analysis
2. **Anthropic**: Uses Claude for analysis

Without an AI provider configured, the app provides basic rule-based insights for:
- Concentrated positions
- Tax loss harvesting opportunities
- Long-term capital gains status
- Trading activity patterns

## Backup

### Local Backup
Backups are stored in the application's user data directory.

### Cloud Backup (Coming Soon)
Configure cloud storage providers for automatic backup:
- Google Drive
- Dropbox
- Amazon S3
- OneDrive

## Security

- All data is stored locally on your device
- No data is sent to external servers (except to configured AI providers)
- API keys are stored locally in encrypted storage
- Database can be backed up and restored at any time

## License

MIT
