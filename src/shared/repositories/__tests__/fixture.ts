/**
 * Test DB fixture: creates an in-memory SQLite database with schema
 * matching the portfolio-manager production schema, seeded with known data.
 */
import Database from 'better-sqlite3';

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE securities (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'stock',
      currency TEXT NOT NULL DEFAULT 'USD',
      exchange TEXT,
      sector TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      broker TEXT NOT NULL DEFAULT '',
      account_number TEXT,
      account_type TEXT NOT NULL DEFAULT 'brokerage',
      book TEXT,
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE positions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      security_id TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      cost_basis REAL NOT NULL DEFAULT 0,
      current_price REAL,
      market_value REAL,
      unrealized_gain REAL,
      unrealized_gain_percent REAL,
      last_updated TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (security_id) REFERENCES securities(id),
      UNIQUE(account_id, security_id)
    );

    CREATE TABLE position_intents (
      id TEXT PRIMARY KEY,
      position_id TEXT NOT NULL UNIQUE,
      tier TEXT,
      thesis TEXT,
      invalidation TEXT,
      entry_style TEXT,
      target_hold_period TEXT,
      target_allocation_pct REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (position_id) REFERENCES positions(id)
    );

    CREATE TABLE price_history (
      id TEXT PRIMARY KEY,
      security_id TEXT NOT NULL,
      date TEXT NOT NULL,
      open_price REAL,
      high_price REAL,
      low_price REAL,
      close_price REAL NOT NULL,
      volume INTEGER,
      fetched_at TEXT NOT NULL,
      FOREIGN KEY (security_id) REFERENCES securities(id),
      UNIQUE(security_id, date)
    );

    CREATE TABLE price_levels (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      level_type TEXT NOT NULL,
      price REAL NOT NULL,
      strength INTEGER NOT NULL DEFAULT 5,
      source TEXT NOT NULL DEFAULT 'swing',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE valuation_metrics (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      trailing_pe REAL,
      forward_pe REAL,
      peg REAL,
      forward_peg REAL,
      ps_ratio REAL,
      trailing_eps REAL,
      forward_eps REAL,
      forward_eps_fy_end TEXT,
      next_eps REAL,
      next_eps_fy_end TEXT,
      eps_growth_pct REAL,
      num_analysts INTEGER,
      fair_low REAL,
      fair_mid REAL,
      fair_high REAL,
      peg_rating TEXT,
      fetched_at TEXT NOT NULL,
      UNIQUE(symbol, date)
    );
  `);

  return db;
}

/** Seed with a standard portfolio for testing. */
export function seedPortfolio(db: Database.Database) {
  const now = '2026-03-27T00:00:00Z';

  // Accounts
  db.exec(`
    INSERT INTO accounts (id, name, broker, account_number, book, currency, created_at, updated_at) VALUES
    ('acct-1', 'Jia Brokerage', 'Schwab', '8819', 'investing', 'USD', '${now}', '${now}'),
    ('acct-2', 'Monica Brokerage', 'Schwab', '6196', 'investing', 'USD', '${now}', '${now}');
  `);

  // Securities
  db.exec(`
    INSERT INTO securities (id, symbol, name, type, sector, created_at) VALUES
    ('sec-goog', 'GOOG', 'Alphabet Inc', 'stock', 'Communication Services', '${now}'),
    ('sec-nvda', 'NVDA', 'NVIDIA Corp', 'stock', 'Technology', '${now}'),
    ('sec-sofi', 'SOFI', 'SoFi Technologies', 'stock', 'Financial Services', '${now}'),
    ('sec-cash', 'USD', 'US Dollar', 'cash', NULL, '${now}');
  `);

  // Positions (GOOG in both accounts, NVDA in acct-1, SOFI in acct-2, cash in both)
  db.exec(`
    INSERT INTO positions (id, account_id, security_id, quantity, cost_basis, last_updated) VALUES
    ('pos-goog-1', 'acct-1', 'sec-goog', 100, 15000, '${now}'),
    ('pos-goog-2', 'acct-2', 'sec-goog', 50, 7500, '${now}'),
    ('pos-nvda', 'acct-1', 'sec-nvda', 80, 8000, '${now}'),
    ('pos-sofi', 'acct-2', 'sec-sofi', 500, 5000, '${now}'),
    ('pos-cash-1', 'acct-1', 'sec-cash', 10000, 0, '${now}'),
    ('pos-cash-2', 'acct-2', 'sec-cash', 5000, 0, '${now}');
  `);

  // Intents
  db.exec(`
    INSERT INTO position_intents (id, position_id, tier, target_allocation_pct, created_at, updated_at) VALUES
    ('int-goog', 'pos-goog-1', 'Core', 15.0, '${now}', '${now}'),
    ('int-nvda', 'pos-nvda', 'Growth', 10.0, '${now}', '${now}'),
    ('int-sofi', 'pos-sofi', 'Growth', 8.0, '${now}', '${now}');
  `);

  // Latest prices (via price_history)
  db.exec(`
    INSERT INTO price_history (id, security_id, date, close_price, fetched_at) VALUES
    ('ph-goog', 'sec-goog', '2026-03-27', 280.00, '${now}'),
    ('ph-nvda', 'sec-nvda', '2026-03-27', 150.00, '${now}'),
    ('ph-sofi', 'sec-sofi', '2026-03-27', 12.00, '${now}');
  `);
}
