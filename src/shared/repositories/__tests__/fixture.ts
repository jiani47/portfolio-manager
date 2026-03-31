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

    CREATE TABLE rebalance_baskets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE entry_plans (
      id TEXT PRIMARY KEY,
      security_id TEXT NOT NULL,
      target_allocation_pct REAL,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      basket_id TEXT,
      side TEXT,
      invalidation_condition TEXT,
      invalidation_monitor_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (security_id) REFERENCES securities(id),
      FOREIGN KEY (basket_id) REFERENCES rebalance_baskets(id)
    );

    CREATE TABLE entry_plan_tranches (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      tranche_number INTEGER NOT NULL,
      trigger_price REAL NOT NULL DEFAULT 0,
      shares INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      monitor_id TEXT,
      filled_at TEXT,
      filled_price REAL,
      notes TEXT,
      trigger_type TEXT,
      trigger_date TEXT,
      limit_price REAL,
      brokerage_order_id TEXT,
      brokerage_order_status TEXT,
      filled_qty INTEGER,
      account_id TEXT,
      FOREIGN KEY (plan_id) REFERENCES entry_plans(id)
    );

    CREATE TABLE watchlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE watchlist_items (
      id TEXT PRIMARY KEY,
      watchlist_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      target_price REAL,
      thesis TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (watchlist_id) REFERENCES watchlists(id),
      UNIQUE(watchlist_id, symbol)
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

/**
 * Seed an EMS basket with buy tranches for NVDA (6 tranches) and sell tranches for SOFI (2 tranches).
 * Portfolio total: GOOG 150×280 + NVDA 80×150 + SOFI 500×12 + cash 15000 = $75,000
 * NVDA target 10% = $7,500 → 50 shares needed → need 0 more (has 80, over-target)
 *   BUT we set target to 15% for testing: $11,250 → 75 shares → need 0 (has 80)
 *   Actually let's make NVDA target_allocation_pct stay at 10% and set buy tranches.
 *   At 10%: target = 75000*0.10/150 = 50 shares, has 80 → over-allocated.
 *   To test buy resize: set NVDA to 20%: target = 75000*0.20/150 = 100, has 80, need 20.
 *   We'll seed 6 buy tranches of 10 each (60 total) — resize should reduce to 20 total.
 *
 * SOFI sell: target 8% = $6,000 → 500 shares at $12 = $6,000. At target. Set target to 4%:
 *   target = 75000*0.04/12 = 250 shares, has 500, need to sell 250.
 *   We'll seed 2 sell tranches of 100 each (200 total) — resize should increase to 250 total.
 */
export function seedBasket(db: Database.Database) {
  const now = '2026-03-27T00:00:00Z';

  // Override intents for basket testing
  db.exec(`UPDATE position_intents SET target_allocation_pct = 20.0 WHERE id = 'int-nvda'`);
  db.exec(`UPDATE position_intents SET target_allocation_pct = 4.0 WHERE id = 'int-sofi'`);

  db.exec(`
    INSERT INTO rebalance_baskets (id, name, status, created_at, updated_at) VALUES
    ('bsk-1', 'test-basket', 'active', '${now}', '${now}');
  `);

  // NVDA buy plan: 6 tranches × 10 shares = 60 total (should resize to 20)
  db.exec(`
    INSERT INTO entry_plans (id, security_id, target_allocation_pct, status, basket_id, side, created_at, updated_at) VALUES
    ('ep-nvda-buy', 'sec-nvda', 20.0, 'active', 'bsk-1', 'buy', '${now}', '${now}');
  `);
  for (let i = 1; i <= 6; i++) {
    db.exec(`
      INSERT INTO entry_plan_tranches (id, plan_id, tranche_number, trigger_price, shares, status, trigger_type, trigger_date)
      VALUES ('ept-nvda-${i}', 'ep-nvda-buy', ${i}, 0, 10, 'pending', 'date', '2026-04-0${i}')
    `);
  }

  // SOFI sell plan: 2 tranches × 100 shares = 200 total (should resize to 250)
  db.exec(`
    INSERT INTO entry_plans (id, security_id, target_allocation_pct, status, basket_id, side, created_at, updated_at) VALUES
    ('ep-sofi-sell', 'sec-sofi', 4.0, 'active', 'bsk-1', 'sell', '${now}', '${now}');
  `);
  for (let i = 1; i <= 2; i++) {
    db.exec(`
      INSERT INTO entry_plan_tranches (id, plan_id, tranche_number, trigger_price, shares, status, trigger_type, trigger_date)
      VALUES ('ept-sofi-${i}', 'ep-sofi-sell', ${i}, 0, 100, '${i === 1 ? 'pending' : 'pending'}', 'date', '2026-04-0${i}')
    `);
  }
}
