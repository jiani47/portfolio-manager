import BetterSqlite3 from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  Account,
  Security,
  Position,
  Transaction,
  TaxLot,
  TransactionFilters,
  TaxLotFilters,
  PortfolioSummary,
  AssetAllocation,
  SecurityTag,
  SecurityTagAssignment,
  TradingRule,
  DecisionLog,
  TradingRuleFilters,
  DecisionLogFilters,
  PriceHistory,
  PositionIntent,
  DailyRitual,
  PositionIntentChangeLog,
  Watchlist,
  WatchlistItem,
  Monitor,
  TaskRunRecord,
  PreTradeCheckRecord,
  ClosedTrade,
  PostMortem,
  EarningsReview,
  BrokerPLRecord,
  EntryPlan,
  EntryPlanTranche,
} from '../shared/types';

export class Database {
  private db: BetterSqlite3.Database | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  initialize(): void {
    this.db = new BetterSqlite3(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createTables();
  }

  private createTables(): void {
    if (!this.db) throw new Error('Database not initialized');

    // Accounts table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        broker TEXT NOT NULL,
        account_number TEXT,
        account_type TEXT NOT NULL DEFAULT 'brokerage',
        currency TEXT NOT NULL DEFAULT 'USD',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Securities table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS securities (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'stock',
        currency TEXT NOT NULL DEFAULT 'USD',
        exchange TEXT,
        created_at TEXT NOT NULL
      )
    `);

    // Positions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
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
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (security_id) REFERENCES securities(id),
        UNIQUE(account_id, security_id)
      )
    `);

    // Transactions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        security_id TEXT NOT NULL,
        type TEXT NOT NULL,
        date TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        amount REAL NOT NULL,
        fees REAL DEFAULT 0,
        notes TEXT,
        wash_sale INTEGER DEFAULT 0,
        disallowed_loss REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (security_id) REFERENCES securities(id)
      )
    `);

    // Migration: add wash_sale and disallowed_loss columns if they don't exist
    try {
      this.db.exec(`ALTER TABLE transactions ADD COLUMN wash_sale INTEGER DEFAULT 0`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE transactions ADD COLUMN disallowed_loss REAL`);
    } catch {
      // Column already exists
    }

    // Tax lots table - migrate to make transaction_id nullable
    // Check if we need to migrate the old schema
    const tableInfo = this.db.prepare("PRAGMA table_info(tax_lots)").all() as { name: string; notnull: number }[];
    const txnIdCol = tableInfo.find(col => col.name === 'transaction_id');

    if (txnIdCol && txnIdCol.notnull === 1) {
      // Old schema with NOT NULL - need to migrate
      this.db.exec(`
        CREATE TABLE tax_lots_new (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          security_id TEXT NOT NULL,
          transaction_id TEXT,
          acquisition_date TEXT NOT NULL,
          quantity REAL NOT NULL,
          cost_basis REAL NOT NULL,
          cost_per_share REAL NOT NULL,
          remaining_quantity REAL NOT NULL,
          is_open INTEGER NOT NULL DEFAULT 1,
          closed_date TEXT,
          closed_transaction_id TEXT,
          realized_gain REAL,
          holding_period TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
          FOREIGN KEY (security_id) REFERENCES securities(id),
          FOREIGN KEY (transaction_id) REFERENCES transactions(id)
        )
      `);
      this.db.exec(`INSERT INTO tax_lots_new SELECT * FROM tax_lots`);
      this.db.exec(`DROP TABLE tax_lots`);
      this.db.exec(`ALTER TABLE tax_lots_new RENAME TO tax_lots`);
    } else if (tableInfo.length === 0) {
      // Table doesn't exist - create it
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tax_lots (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          security_id TEXT NOT NULL,
          transaction_id TEXT,
          acquisition_date TEXT NOT NULL,
          quantity REAL NOT NULL,
          cost_basis REAL NOT NULL,
          cost_per_share REAL NOT NULL,
          remaining_quantity REAL NOT NULL,
          is_open INTEGER NOT NULL DEFAULT 1,
          closed_date TEXT,
          closed_transaction_id TEXT,
          realized_gain REAL,
          holding_period TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
          FOREIGN KEY (security_id) REFERENCES securities(id),
          FOREIGN KEY (transaction_id) REFERENCES transactions(id)
        )
      `);
    }

    // Create indexes for better query performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_positions_account ON positions(account_id);
      CREATE INDEX IF NOT EXISTS idx_positions_security ON positions(security_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_security ON transactions(security_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
      CREATE INDEX IF NOT EXISTS idx_tax_lots_account ON tax_lots(account_id);
      CREATE INDEX IF NOT EXISTS idx_tax_lots_security ON tax_lots(security_id);
      CREATE INDEX IF NOT EXISTS idx_tax_lots_open ON tax_lots(is_open);
    `);

    // Security tags table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS security_tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        color TEXT NOT NULL,
        description TEXT,
        is_system INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);

    // Security tag assignments junction table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS security_tag_assignments (
        id TEXT PRIMARY KEY,
        security_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (security_id) REFERENCES securities(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES security_tags(id) ON DELETE CASCADE,
        UNIQUE(security_id, tag_id)
      )
    `);

    // Seed default holdings tags if they don't exist
    const existingTags = this.db.prepare('SELECT COUNT(*) as count FROM security_tags').get() as { count: number };
    if (existingTags.count === 0) {
      const now = new Date().toISOString();
      this.db.exec(`
        INSERT INTO security_tags (id, name, display_name, color, description, is_system, created_at) VALUES
          ('tag-core', 'core', 'Core', 'blue', 'Highest conviction, long-term compounders', 1, '${now}'),
          ('tag-growth', 'growth', 'Growth', 'green', 'High growth positions, sized for upside', 1, '${now}'),
          ('tag-starter', 'starter', 'Starter', 'purple', 'Small tracking positions, building conviction', 1, '${now}'),
          ('tag-watchlist', 'watchlist', 'Watchlist', 'gray', 'Monitoring only, no active position', 1, '${now}')
      `);
    }

    // Migrate legacy tags to new tier-aligned tags
    try {
      const satellite = this.db.prepare("SELECT id FROM security_tags WHERE id = 'tag-satellite'").get();
      if (satellite) {
        this.db.exec(`
          UPDATE security_tags SET name = 'growth', display_name = 'Growth', color = 'green',
            description = 'High growth positions, sized for upside' WHERE id = 'tag-satellite';
          UPDATE security_tags SET id = 'tag-growth' WHERE id = 'tag-satellite';
        `);
      }
      const eventMacro = this.db.prepare("SELECT id FROM security_tags WHERE id = 'tag-event-macro'").get();
      if (eventMacro) {
        this.db.exec(`
          UPDATE security_tags SET name = 'starter', display_name = 'Starter', color = 'purple',
            description = 'Small tracking positions, building conviction' WHERE id = 'tag-event-macro';
          UPDATE security_tags SET id = 'tag-starter' WHERE id = 'tag-event-macro';
        `);
      }
      // Update core description
      this.db.exec(`
        UPDATE security_tags SET description = 'Highest conviction, long-term compounders'
        WHERE id = 'tag-core';
      `);
      // Add watchlist tag if missing
      const watchlist = this.db.prepare("SELECT id FROM security_tags WHERE id = 'tag-watchlist'").get();
      if (!watchlist) {
        const now = new Date().toISOString();
        this.db.exec(`
          INSERT INTO security_tags (id, name, display_name, color, description, is_system, created_at)
          VALUES ('tag-watchlist', 'watchlist', 'Watchlist', 'gray', 'Monitoring only, no active position', 1, '${now}')
        `);
      }
    } catch {
      // Migration already done or tags already in new format
    }

    // Trading rules table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trading_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        security_id TEXT,
        rule_type TEXT NOT NULL,
        condition_type TEXT NOT NULL,
        condition_operator TEXT NOT NULL,
        condition_value REAL NOT NULL,
        action_type TEXT NOT NULL,
        action_value REAL,
        is_enabled INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (security_id) REFERENCES securities(id)
      )
    `);

    // Decision logs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decision_logs (
        id TEXT PRIMARY KEY,
        security_id TEXT NOT NULL,
        decision_date TEXT NOT NULL,
        decision_type TEXT NOT NULL,
        background TEXT,
        decision TEXT NOT NULL,
        execution TEXT,
        transaction_ids TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (security_id) REFERENCES securities(id)
      )
    `);

    // Create indexes for new tables
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_security_tag_assignments_security ON security_tag_assignments(security_id);
      CREATE INDEX IF NOT EXISTS idx_security_tag_assignments_tag ON security_tag_assignments(tag_id);
      CREATE INDEX IF NOT EXISTS idx_trading_rules_security ON trading_rules(security_id);
      CREATE INDEX IF NOT EXISTS idx_trading_rules_enabled ON trading_rules(is_enabled);
      CREATE INDEX IF NOT EXISTS idx_decision_logs_security ON decision_logs(security_id);
      CREATE INDEX IF NOT EXISTS idx_decision_logs_date ON decision_logs(decision_date);
    `);

    // Price history table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS price_history (
        id TEXT PRIMARY KEY,
        security_id TEXT NOT NULL,
        date TEXT NOT NULL,
        open_price REAL,
        high_price REAL,
        low_price REAL,
        close_price REAL NOT NULL,
        volume INTEGER,
        fetched_at TEXT NOT NULL,
        FOREIGN KEY (security_id) REFERENCES securities(id) ON DELETE CASCADE,
        UNIQUE(security_id, date)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_price_history_security ON price_history(security_id);
      CREATE INDEX IF NOT EXISTS idx_price_history_date ON price_history(date);
    `);

    // Migration: add company profile columns to securities table
    const secCols = ['sector', 'industry', 'description', 'website', 'ceo', 'market_cap', 'profile_updated_at'];
    for (const col of secCols) {
      try {
        const type = col === 'market_cap' ? 'REAL' : 'TEXT';
        this.db.exec(`ALTER TABLE securities ADD COLUMN ${col} ${type}`);
      } catch {
        // Column already exists
      }
    }

    // Migration: add book column to accounts
    try {
      this.db.exec(`ALTER TABLE accounts ADD COLUMN book TEXT`);
    } catch {
      // Column already exists
    }

    // Migration: add cash_balance column to accounts
    try {
      this.db.exec(`ALTER TABLE accounts ADD COLUMN cash_balance REAL DEFAULT 0`);
    } catch {
      // Column already exists
    }

    // Position intents table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS position_intents (
        id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL UNIQUE,
        tier TEXT,
        thesis TEXT,
        invalidation TEXT,
        entry_style TEXT,
        target_hold_period TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_position_intents_position ON position_intents(position_id);
    `);

    // Daily rituals table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_rituals (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL UNIQUE,
        regime_rewarding TEXT,
        regime_punishing TEXT,
        regime_type TEXT,
        regime_notes TEXT,
        action_chosen TEXT,
        action_detail TEXT,
        journal TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Position intent change logs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS position_intent_change_logs (
        id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        ritual_date TEXT,
        field_changed TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_intent_change_logs_position ON position_intent_change_logs(position_id);
      CREATE INDEX IF NOT EXISTS idx_intent_change_logs_date ON position_intent_change_logs(ritual_date);
    `);

    // Watchlists tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watchlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS watchlist_items (
        id TEXT PRIMARY KEY,
        watchlist_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        security_id TEXT,
        notes TEXT,
        target_entry_price REAL,
        target_exit_price REAL,
        thesis_snippet TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE,
        FOREIGN KEY (security_id) REFERENCES securities(id) ON DELETE SET NULL,
        UNIQUE(watchlist_id, symbol)
      );

      CREATE INDEX IF NOT EXISTS idx_watchlist_items_watchlist ON watchlist_items(watchlist_id);
      CREATE INDEX IF NOT EXISTS idx_watchlist_items_symbol ON watchlist_items(symbol);
    `);

    // Monitors table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitors (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        price_level REAL NOT NULL,
        label TEXT NOT NULL,
        action_type TEXT NOT NULL DEFAULT 'informational',
        status TEXT NOT NULL DEFAULT 'active',
        linked_position_id TEXT,
        linked_watchlist_item_id TEXT,
        triggered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (linked_position_id) REFERENCES positions(id) ON DELETE SET NULL,
        FOREIGN KEY (linked_watchlist_item_id) REFERENCES watchlist_items(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_monitors_symbol ON monitors(symbol);
      CREATE INDEX IF NOT EXISTS idx_monitors_status ON monitors(status);
    `);

    // Migration: add monitor_type, reminder_date, expires_at to monitors
    const monitorCols = [
      ['monitor_type', "TEXT NOT NULL DEFAULT 'price'"],
      ['reminder_date', 'TEXT'],
      ['expires_at', 'TEXT'],
    ];
    for (const [col, type] of monitorCols) {
      try {
        this.db.exec(`ALTER TABLE monitors ADD COLUMN ${col} ${type}`);
      } catch {
        // Column already exists
      }
    }

    // Portfolio snapshots table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        symbol TEXT NOT NULL,
        quantity REAL NOT NULL,
        cost_basis REAL NOT NULL,
        close_price REAL NOT NULL,
        market_value REAL NOT NULL,
        unrealized_gain REAL NOT NULL,
        day_change REAL,
        day_pnl REAL,
        created_at TEXT NOT NULL,
        UNIQUE(date, symbol)
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_date ON portfolio_snapshots(date);
      CREATE INDEX IF NOT EXISTS idx_snapshots_symbol ON portfolio_snapshots(symbol);
    `);

    // News table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS news (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        title TEXT NOT NULL,
        snippet TEXT,
        source TEXT,
        url TEXT,
        published_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        UNIQUE(symbol, title)
      );
      CREATE INDEX IF NOT EXISTS idx_news_symbol ON news(symbol);
      CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at);
    `);

    // Scheduler task runs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        result TEXT,
        error TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs_task ON scheduler_task_runs(task_id, started_at DESC);
    `);

    // Pre-trade checks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pre_trade_checks (
        id TEXT PRIMARY KEY,
        order_symbol TEXT NOT NULL,
        order_side TEXT NOT NULL,
        order_qty REAL NOT NULL,
        account_id TEXT NOT NULL,
        book TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        overrides TEXT NOT NULL DEFAULT '[]',
        passed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);

    // Post-mortems table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS post_mortems (
        id TEXT PRIMARY KEY,
        security_id TEXT NOT NULL,
        close_date TEXT NOT NULL,
        original_intent TEXT NOT NULL,
        tier TEXT,
        entry_thesis TEXT,
        what_happened TEXT NOT NULL,
        rule_adherence TEXT,
        error_type TEXT NOT NULL,
        thesis_quality TEXT NOT NULL DEFAULT 'good',
        execution_quality TEXT NOT NULL DEFAULT 'good',
        outcome TEXT NOT NULL DEFAULT 'loss',
        lesson_learned TEXT NOT NULL,
        realized_gain REAL DEFAULT 0,
        hold_days INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (security_id) REFERENCES securities(id)
      );
      CREATE INDEX IF NOT EXISTS idx_post_mortems_security ON post_mortems(security_id);
    `);

    // Migrate post_mortems: replace classification with thesis_quality, execution_quality, outcome
    try { this.db.exec('ALTER TABLE post_mortems ADD COLUMN thesis_quality TEXT NOT NULL DEFAULT \'good\''); } catch {}
    try { this.db.exec('ALTER TABLE post_mortems ADD COLUMN execution_quality TEXT NOT NULL DEFAULT \'good\''); } catch {}
    try { this.db.exec('ALTER TABLE post_mortems ADD COLUMN outcome TEXT NOT NULL DEFAULT \'loss\''); } catch {}

    // Earnings reviews table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS earnings_reviews (
        id TEXT PRIMARY KEY,
        security_id TEXT NOT NULL,
        quarter TEXT NOT NULL,
        earnings_date TEXT NOT NULL,
        revenue_expected REAL,
        revenue_actual REAL,
        eps_expected REAL,
        eps_actual REAL,
        revenue_growth_pct REAL,
        eps_growth_pct REAL,
        growth_trajectory TEXT,
        thesis_impact TEXT NOT NULL DEFAULT 'neutral',
        invalidation_triggered INTEGER NOT NULL DEFAULT 0,
        decision TEXT,
        decision_deadline TEXT,
        decision_notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (security_id) REFERENCES securities(id)
      );
      CREATE INDEX IF NOT EXISTS idx_earnings_reviews_security ON earnings_reviews(security_id);
      CREATE INDEX IF NOT EXISTS idx_earnings_reviews_date ON earnings_reviews(earnings_date);
    `);

    // Broker realized P&L table (imported from Schwab CSV)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS realized_pl_broker (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        account_name TEXT,
        open_date TEXT,
        close_date TEXT,
        quantity REAL,
        cost_basis REAL,
        proceeds REAL,
        gain_loss REAL,
        gain_loss_pct REAL,
        term TEXT,
        source_file TEXT,
        imported_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rpl_symbol ON realized_pl_broker(symbol);
      CREATE INDEX IF NOT EXISTS idx_rpl_close_date ON realized_pl_broker(close_date);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rpl_dedup ON realized_pl_broker(symbol, open_date, close_date, quantity, cost_basis, proceeds, account_name);
    `);

    // Migration: add target_allocation_pct to position_intents
    try { this.db.exec('ALTER TABLE position_intents ADD COLUMN target_allocation_pct REAL'); } catch {}

    // Entry plans tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entry_plans (
        id TEXT PRIMARY KEY,
        security_id TEXT NOT NULL,
        target_allocation_pct REAL,
        status TEXT NOT NULL DEFAULT 'active',
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (security_id) REFERENCES securities(id)
      );
      CREATE INDEX IF NOT EXISTS idx_entry_plans_security ON entry_plans(security_id);
      CREATE INDEX IF NOT EXISTS idx_entry_plans_status ON entry_plans(status);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entry_plan_tranches (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        tranche_number INTEGER NOT NULL,
        trigger_price REAL NOT NULL,
        shares INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        monitor_id TEXT,
        filled_at TEXT,
        filled_price REAL,
        notes TEXT,
        FOREIGN KEY (plan_id) REFERENCES entry_plans(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_entry_plan_tranches_plan ON entry_plan_tranches(plan_id);
    `);

    // Sync watchlist monitors on startup
    this.syncWatchlistMonitors();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  getPath(): string {
    return this.dbPath;
  }

  // Account operations
  listAccounts(): Account[] {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM accounts ORDER BY name');
    return stmt.all().map(this.mapRowToAccount);
  }

  createAccount(account: Omit<Account, 'id' | 'createdAt' | 'updatedAt'>): Account {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO accounts (id, name, broker, account_number, account_type, currency, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, account.name, account.broker, account.accountNumber || null, account.accountType, account.currency, now, now);
    return this.getAccountById(id)!;
  }

  getAccountById(id: string): Account | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM accounts WHERE id = ?');
    const row = stmt.get(id);
    return row ? this.mapRowToAccount(row) : null;
  }

  updateAccount(id: string, account: Partial<Account>): Account {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (account.name !== undefined) { fields.push('name = ?'); values.push(account.name); }
    if (account.broker !== undefined) { fields.push('broker = ?'); values.push(account.broker); }
    if (account.accountNumber !== undefined) { fields.push('account_number = ?'); values.push(account.accountNumber); }
    if (account.accountType !== undefined) { fields.push('account_type = ?'); values.push(account.accountType); }
    if (account.currency !== undefined) { fields.push('currency = ?'); values.push(account.currency); }
    if (account.book !== undefined) { fields.push('book = ?'); values.push(account.book || null); }
    if (account.cashBalance !== undefined) { fields.push('cash_balance = ?'); values.push(account.cashBalance); }

    values.push(id);
    const stmt = this.db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getAccountById(id)!;
  }

  deleteAccount(id: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('DELETE FROM accounts WHERE id = ?');
    stmt.run(id);
  }

  // Security operations
  listSecurities(): Security[] {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM securities ORDER BY symbol');
    return stmt.all().map(this.mapRowToSecurity);
  }

  createSecurity(security: Omit<Security, 'id' | 'createdAt'>): Security {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO securities (id, symbol, name, type, currency, exchange, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, security.symbol.toUpperCase(), security.name, security.type, security.currency, security.exchange || null, now);
    return this.getSecurityById(id)!;
  }

  getSecurityById(id: string): Security | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM securities WHERE id = ?');
    const row = stmt.get(id);
    return row ? this.mapRowToSecurity(row) : null;
  }

  findSecurityBySymbol(symbol: string): Security | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM securities WHERE symbol = ?');
    const row = stmt.get(symbol.toUpperCase());
    return row ? this.mapRowToSecurity(row) : null;
  }

  findSecurityById(id: string): Security | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM securities WHERE id = ?');
    const row = stmt.get(id);
    return row ? this.mapRowToSecurity(row) : null;
  }

  updateSecurityProfile(id: string, profile: {
    sector?: string;
    industry?: string;
    description?: string;
    website?: string;
    ceo?: string;
    marketCap?: number;
  }): Security {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const fields: string[] = ['profile_updated_at = ?'];
    const values: unknown[] = [now];

    if (profile.sector !== undefined) { fields.push('sector = ?'); values.push(profile.sector); }
    if (profile.industry !== undefined) { fields.push('industry = ?'); values.push(profile.industry); }
    if (profile.description !== undefined) { fields.push('description = ?'); values.push(profile.description); }
    if (profile.website !== undefined) { fields.push('website = ?'); values.push(profile.website); }
    if (profile.ceo !== undefined) { fields.push('ceo = ?'); values.push(profile.ceo); }
    if (profile.marketCap !== undefined) { fields.push('market_cap = ?'); values.push(profile.marketCap); }

    values.push(id);
    const stmt = this.db.prepare(`UPDATE securities SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getSecurityById(id)!;
  }

  // Price history operations
  getPriceHistory(securityId: string, startDate?: string, endDate?: string): PriceHistory[] {
    if (!this.db) throw new Error('Database not initialized');
    let sql = 'SELECT * FROM price_history WHERE security_id = ?';
    const params: unknown[] = [securityId];

    if (startDate) {
      sql += ' AND date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND date <= ?';
      params.push(endDate);
    }

    sql += ' ORDER BY date DESC';
    const stmt = this.db.prepare(sql);
    return stmt.all(...params).map(this.mapRowToPriceHistory);
  }

  getLatestPrice(securityId: string): PriceHistory | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM price_history WHERE security_id = ? ORDER BY date DESC LIMIT 1');
    const row = stmt.get(securityId);
    return row ? this.mapRowToPriceHistory(row) : null;
  }

  getPriceForDate(securityId: string, date: string): PriceHistory | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM price_history WHERE security_id = ? AND date = ?');
    const row = stmt.get(securityId, date);
    return row ? this.mapRowToPriceHistory(row) : null;
  }

  savePriceHistory(price: Omit<PriceHistory, 'id'>): PriceHistory {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO price_history (id, security_id, date, open_price, high_price, low_price, close_price, volume, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      price.securityId,
      price.date,
      price.openPrice || null,
      price.highPrice || null,
      price.lowPrice || null,
      price.closePrice,
      price.volume || null,
      price.fetchedAt
    );
    return { id, ...price };
  }

  savePriceHistoryBatch(prices: Omit<PriceHistory, 'id'>[]): number {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO price_history (id, security_id, date, open_price, high_price, low_price, close_price, volume, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((priceList: typeof prices) => {
      let count = 0;
      for (const price of priceList) {
        stmt.run(
          uuidv4(),
          price.securityId,
          price.date,
          price.openPrice || null,
          price.highPrice || null,
          price.lowPrice || null,
          price.closePrice,
          price.volume || null,
          price.fetchedAt
        );
        count++;
      }
      return count;
    });

    return insertMany(prices);
  }

  // Get latest price per security for bootstrapping streaming quotes from DB
  getLatestPrices(): Array<{ symbol: string; closePrice: number; openPrice: number | null; highPrice: number | null; lowPrice: number | null; volume: number | null; date: string; fetchedAt: string }> {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare(`
      SELECT s.symbol, ph.close_price, ph.open_price, ph.high_price, ph.low_price,
             ph.volume, ph.date, ph.fetched_at
      FROM price_history ph
      JOIN (
        SELECT security_id, MAX(date) as max_date
        FROM price_history GROUP BY security_id
      ) latest ON ph.security_id = latest.security_id AND ph.date = latest.max_date
      JOIN securities s ON ph.security_id = s.id
      WHERE s.type NOT IN ('cash', 'option')
    `);
    return stmt.all().map((r: any) => ({
      symbol: r.symbol,
      closePrice: r.close_price,
      openPrice: r.open_price,
      highPrice: r.high_price,
      lowPrice: r.low_price,
      volume: r.volume,
      date: r.date,
      fetchedAt: r.fetched_at,
    }));
  }

  private mapRowToPriceHistory = (row: unknown): PriceHistory => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      securityId: r.security_id as string,
      date: r.date as string,
      openPrice: r.open_price as number | undefined,
      highPrice: r.high_price as number | undefined,
      lowPrice: r.low_price as number | undefined,
      closePrice: r.close_price as number,
      volume: r.volume as number | undefined,
      fetchedAt: r.fetched_at as string,
    };
  };

  // Position operations
  listPositions(accountId?: string): Position[] {
    if (!this.db) throw new Error('Database not initialized');
    let sql = 'SELECT * FROM positions';
    const params: string[] = [];
    if (accountId) {
      sql += ' WHERE account_id = ?';
      params.push(accountId);
    }
    sql += ' ORDER BY market_value DESC';
    const stmt = this.db.prepare(sql);
    return (params.length ? stmt.all(...params) : stmt.all()).map(this.mapRowToPosition);
  }

  // List positions with MTM values calculated on-the-fly from price_history
  listPositionsWithMTM(accountId?: string): Position[] {
    if (!this.db) throw new Error('Database not initialized');

    // Use a subquery to get the latest price for each security
    let sql = `
      SELECT
        p.*,
        s.type as security_type,
        ph.close_price as latest_price,
        ph.date as price_date
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      LEFT JOIN (
        SELECT security_id, close_price, date
        FROM price_history ph1
        WHERE date = (
          SELECT MAX(date) FROM price_history ph2
          WHERE ph2.security_id = ph1.security_id
        )
      ) ph ON p.security_id = ph.security_id
    `;
    const params: string[] = [];
    if (accountId) {
      sql += ' WHERE p.account_id = ?';
      params.push(accountId);
    }
    sql += ' ORDER BY (p.quantity * COALESCE(ph.close_price, 0)) DESC';

    const stmt = this.db.prepare(sql);
    const rows = params.length ? stmt.all(...params) : stmt.all();

    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      const quantity = r.quantity as number;
      const costBasis = r.cost_basis as number;
      const latestPrice = r.latest_price as number | null;

      // Calculate MTM values if we have a price
      let currentPrice: number | undefined;
      let marketValue: number | undefined;
      let unrealizedGain: number | undefined;
      let unrealizedGainPercent: number | undefined;
      const securityType = r.security_type as string;

      if (securityType === 'cash') {
        // Cash positions: quantity IS the dollar value, no price lookup needed
        currentPrice = 1;
        marketValue = quantity;
        unrealizedGain = 0;
        unrealizedGainPercent = 0;
      } else if (latestPrice !== null && latestPrice > 0) {
        currentPrice = latestPrice;
        marketValue = quantity * latestPrice;
        unrealizedGain = marketValue - costBasis;
        unrealizedGainPercent = costBasis > 0 ? (unrealizedGain / costBasis) * 100 : 0;
      }

      return {
        id: r.id as string,
        accountId: r.account_id as string,
        securityId: r.security_id as string,
        quantity,
        costBasis,
        currentPrice,
        marketValue,
        unrealizedGain,
        unrealizedGainPercent,
        lastUpdated: r.last_updated as string,
      };
    });
  }

  createPosition(position: Omit<Position, 'id'>): Position {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const stmt = this.db.prepare(`
      INSERT INTO positions (id, account_id, security_id, quantity, cost_basis, current_price, market_value, unrealized_gain, unrealized_gain_percent, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      position.accountId,
      position.securityId,
      position.quantity,
      position.costBasis,
      position.currentPrice || null,
      position.marketValue || null,
      position.unrealizedGain || null,
      position.unrealizedGainPercent || null,
      position.lastUpdated
    );
    return this.getPositionById(id)!;
  }

  getPositionById(id: string): Position | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM positions WHERE id = ?');
    const row = stmt.get(id);
    return row ? this.mapRowToPosition(row) : null;
  }

  updatePosition(id: string, position: Partial<Position>): Position {
    if (!this.db) throw new Error('Database not initialized');
    const fields: string[] = [];
    const values: unknown[] = [];

    if (position.quantity !== undefined) { fields.push('quantity = ?'); values.push(position.quantity); }
    if (position.costBasis !== undefined) { fields.push('cost_basis = ?'); values.push(position.costBasis); }
    if (position.currentPrice !== undefined) { fields.push('current_price = ?'); values.push(position.currentPrice); }
    if (position.marketValue !== undefined) { fields.push('market_value = ?'); values.push(position.marketValue); }
    if (position.unrealizedGain !== undefined) { fields.push('unrealized_gain = ?'); values.push(position.unrealizedGain); }
    if (position.unrealizedGainPercent !== undefined) { fields.push('unrealized_gain_percent = ?'); values.push(position.unrealizedGainPercent); }
    fields.push('last_updated = ?');
    values.push(new Date().toISOString());

    values.push(id);
    const stmt = this.db.prepare(`UPDATE positions SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getPositionById(id)!;
  }

  deletePosition(id: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('DELETE FROM positions WHERE id = ?');
    stmt.run(id);
  }

  findPositionByAccountAndSecurity(accountId: string, securityId: string): Position | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM positions WHERE account_id = ? AND security_id = ?');
    const row = stmt.get(accountId, securityId);
    return row ? this.mapRowToPosition(row) : null;
  }

  // Transaction operations
  listTransactions(filters?: TransactionFilters): Transaction[] {
    if (!this.db) throw new Error('Database not initialized');
    let sql = 'SELECT * FROM transactions WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.accountId) {
      sql += ' AND account_id = ?';
      params.push(filters.accountId);
    }
    if (filters?.securityId) {
      sql += ' AND security_id = ?';
      params.push(filters.securityId);
    }
    if (filters?.type) {
      sql += ' AND type = ?';
      params.push(filters.type);
    }
    if (filters?.startDate) {
      sql += ' AND date >= ?';
      params.push(filters.startDate);
    }
    if (filters?.endDate) {
      sql += ' AND date <= ?';
      params.push(filters.endDate);
    }

    sql += ' ORDER BY date DESC';

    if (filters?.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(...params).map(this.mapRowToTransaction);
  }

  createTransaction(transaction: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>): Transaction {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO transactions (id, account_id, security_id, type, date, quantity, price, amount, fees, notes, wash_sale, disallowed_loss, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      transaction.accountId,
      transaction.securityId,
      transaction.type,
      transaction.date,
      transaction.quantity,
      transaction.price,
      transaction.amount,
      transaction.fees || 0,
      transaction.notes || null,
      transaction.washSale ? 1 : 0,
      transaction.disallowedLoss || null,
      now,
      now
    );
    return this.getTransactionById(id)!;
  }

  getTransactionById(id: string): Transaction | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM transactions WHERE id = ?');
    const row = stmt.get(id);
    return row ? this.mapRowToTransaction(row) : null;
  }

  updateTransaction(id: string, transaction: Partial<Transaction>): Transaction {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (transaction.type !== undefined) { fields.push('type = ?'); values.push(transaction.type); }
    if (transaction.date !== undefined) { fields.push('date = ?'); values.push(transaction.date); }
    if (transaction.quantity !== undefined) { fields.push('quantity = ?'); values.push(transaction.quantity); }
    if (transaction.price !== undefined) { fields.push('price = ?'); values.push(transaction.price); }
    if (transaction.amount !== undefined) { fields.push('amount = ?'); values.push(transaction.amount); }
    if (transaction.fees !== undefined) { fields.push('fees = ?'); values.push(transaction.fees); }
    if (transaction.notes !== undefined) { fields.push('notes = ?'); values.push(transaction.notes); }
    if (transaction.washSale !== undefined) { fields.push('wash_sale = ?'); values.push(transaction.washSale ? 1 : 0); }
    if (transaction.disallowedLoss !== undefined) { fields.push('disallowed_loss = ?'); values.push(transaction.disallowedLoss); }

    values.push(id);
    const stmt = this.db.prepare(`UPDATE transactions SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getTransactionById(id)!;
  }

  deleteTransaction(id: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('DELETE FROM transactions WHERE id = ?');
    stmt.run(id);
  }

  importTransactions(transactions: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>[]): number {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO transactions (id, account_id, security_id, type, date, quantity, price, amount, fees, notes, wash_sale, disallowed_loss, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((txns: typeof transactions) => {
      let count = 0;
      for (const txn of txns) {
        stmt.run(
          uuidv4(),
          txn.accountId,
          txn.securityId,
          txn.type,
          txn.date,
          txn.quantity,
          txn.price,
          txn.amount,
          txn.fees || 0,
          txn.notes || null,
          txn.washSale ? 1 : 0,
          txn.disallowedLoss || null,
          now,
          now
        );
        count++;
      }
      return count;
    });

    return insertMany(transactions);
  }

  // Tax lot operations
  listTaxLots(filters?: TaxLotFilters): TaxLot[] {
    if (!this.db) throw new Error('Database not initialized');
    let sql = 'SELECT * FROM tax_lots WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.accountId) {
      sql += ' AND account_id = ?';
      params.push(filters.accountId);
    }
    if (filters?.securityId) {
      sql += ' AND security_id = ?';
      params.push(filters.securityId);
    }
    if (filters?.isOpen !== undefined) {
      sql += ' AND is_open = ?';
      params.push(filters.isOpen ? 1 : 0);
    }

    sql += ' ORDER BY acquisition_date ASC';

    const stmt = this.db.prepare(sql);
    return stmt.all(...params).map(this.mapRowToTaxLot);
  }

  createTaxLot(taxLot: Omit<TaxLot, 'id' | 'createdAt' | 'updatedAt'>): TaxLot {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO tax_lots (id, account_id, security_id, transaction_id, acquisition_date, quantity, cost_basis, cost_per_share, remaining_quantity, is_open, closed_date, closed_transaction_id, realized_gain, holding_period, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      taxLot.accountId,
      taxLot.securityId,
      taxLot.transactionId,
      taxLot.acquisitionDate,
      taxLot.quantity,
      taxLot.costBasis,
      taxLot.costPerShare,
      taxLot.remainingQuantity,
      taxLot.isOpen ? 1 : 0,
      taxLot.closedDate || null,
      taxLot.closedTransactionId || null,
      taxLot.realizedGain || null,
      taxLot.holdingPeriod || null,
      now,
      now
    );
    return this.getTaxLotById(id)!;
  }

  getTaxLotById(id: string): TaxLot | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM tax_lots WHERE id = ?');
    const row = stmt.get(id);
    return row ? this.mapRowToTaxLot(row) : null;
  }

  updateTaxLot(id: string, taxLot: Partial<TaxLot>): TaxLot {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (taxLot.remainingQuantity !== undefined) { fields.push('remaining_quantity = ?'); values.push(taxLot.remainingQuantity); }
    if (taxLot.isOpen !== undefined) { fields.push('is_open = ?'); values.push(taxLot.isOpen ? 1 : 0); }
    if (taxLot.closedDate !== undefined) { fields.push('closed_date = ?'); values.push(taxLot.closedDate); }
    if (taxLot.closedTransactionId !== undefined) { fields.push('closed_transaction_id = ?'); values.push(taxLot.closedTransactionId); }
    if (taxLot.realizedGain !== undefined) { fields.push('realized_gain = ?'); values.push(taxLot.realizedGain); }
    if (taxLot.holdingPeriod !== undefined) { fields.push('holding_period = ?'); values.push(taxLot.holdingPeriod); }

    values.push(id);
    const stmt = this.db.prepare(`UPDATE tax_lots SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getTaxLotById(id)!;
  }

  deleteTaxLot(id: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('DELETE FROM tax_lots WHERE id = ?');
    stmt.run(id);
  }

  deleteAllTaxLots(accountId: string): number {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('DELETE FROM tax_lots WHERE account_id = ?');
    const result = stmt.run(accountId);
    return result.changes;
  }

  deleteTaxLotsBySymbol(accountId: string, securityId: string): number {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('DELETE FROM tax_lots WHERE account_id = ? AND security_id = ?');
    const result = stmt.run(accountId, securityId);
    return result.changes;
  }

  // Portfolio summary (uses calculated MTM values from price_history)
  getPortfolioSummary(): PortfolioSummary {
    if (!this.db) throw new Error('Database not initialized');

    const positions = this.listPositionsWithMTM();
    const accounts = this.listAccounts();

    const totalValue = positions.reduce((sum, p) => sum + (p.marketValue || 0), 0);
    const totalCostBasis = positions.reduce((sum, p) => sum + p.costBasis, 0);
    const totalUnrealizedGain = totalValue - totalCostBasis;
    const totalUnrealizedGainPercent = totalCostBasis > 0 ? (totalUnrealizedGain / totalCostBasis) * 100 : 0;

    return {
      totalValue,
      totalCostBasis,
      totalUnrealizedGain,
      totalUnrealizedGainPercent,
      dayChange: 0, // Would need price data to calculate
      dayChangePercent: 0,
      positionCount: positions.length,
      accountCount: accounts.length,
    };
  }

  // Get asset allocation with MTM values calculated from price_history
  getAssetAllocation(): AssetAllocation[] {
    if (!this.db) throw new Error('Database not initialized');

    // Join with latest prices from price_history to calculate market values
    const stmt = this.db.prepare(`
      SELECT s.type,
        SUM(CASE WHEN s.type = 'cash' THEN p.quantity
                 ELSE p.quantity * COALESCE(ph.close_price, 0) END) as total_value
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      LEFT JOIN (
        SELECT security_id, close_price
        FROM price_history ph1
        WHERE date = (
          SELECT MAX(date) FROM price_history ph2
          WHERE ph2.security_id = ph1.security_id
        )
      ) ph ON p.security_id = ph.security_id
      WHERE (s.type = 'cash' AND p.quantity > 0)
         OR (s.type != 'cash' AND (p.quantity * COALESCE(ph.close_price, 0)) > 0)
      GROUP BY s.type
      ORDER BY total_value DESC
    `);

    const results = stmt.all() as { type: string; total_value: number }[];
    const totalValue = results.reduce((sum, r) => sum + r.total_value, 0);

    return results.map(r => ({
      category: r.type,
      value: r.total_value,
      percentage: totalValue > 0 ? (r.total_value / totalValue) * 100 : 0,
      positions: [],
    }));
  }

  // Security tag operations
  listSecurityTags(): SecurityTag[] {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM security_tags ORDER BY is_system DESC, name');
    return stmt.all().map(this.mapRowToSecurityTag);
  }

  createSecurityTag(tag: Omit<SecurityTag, 'id' | 'createdAt'>): SecurityTag {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO security_tags (id, name, display_name, color, description, is_system, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, tag.name, tag.displayName, tag.color, tag.description || null, tag.isSystem ? 1 : 0, now);
    return this.getSecurityTagById(id)!;
  }

  getSecurityTagById(id: string): SecurityTag | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM security_tags WHERE id = ?');
    const row = stmt.get(id);
    return row ? this.mapRowToSecurityTag(row) : null;
  }

  updateSecurityTag(id: string, tag: Partial<SecurityTag>): SecurityTag {
    if (!this.db) throw new Error('Database not initialized');
    const fields: string[] = [];
    const values: unknown[] = [];

    if (tag.name !== undefined) { fields.push('name = ?'); values.push(tag.name); }
    if (tag.displayName !== undefined) { fields.push('display_name = ?'); values.push(tag.displayName); }
    if (tag.color !== undefined) { fields.push('color = ?'); values.push(tag.color); }
    if (tag.description !== undefined) { fields.push('description = ?'); values.push(tag.description); }

    if (fields.length === 0) return this.getSecurityTagById(id)!;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE security_tags SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getSecurityTagById(id)!;
  }

  deleteSecurityTag(id: string): void {
    if (!this.db) throw new Error('Database not initialized');
    // Don't allow deleting system tags
    const tag = this.getSecurityTagById(id);
    if (tag?.isSystem) {
      throw new Error('Cannot delete system tags');
    }
    const stmt = this.db.prepare('DELETE FROM security_tags WHERE id = ?');
    stmt.run(id);
  }

  // Security tag assignment operations
  listSecurityTagAssignments(securityId?: string): SecurityTagAssignment[] {
    if (!this.db) throw new Error('Database not initialized');
    let sql = 'SELECT * FROM security_tag_assignments';
    const params: string[] = [];
    if (securityId) {
      sql += ' WHERE security_id = ?';
      params.push(securityId);
    }
    const stmt = this.db.prepare(sql);
    return (params.length ? stmt.all(...params) : stmt.all()).map(this.mapRowToSecurityTagAssignment);
  }

  assignTagToSecurity(securityId: string, tagId: string): SecurityTagAssignment {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO security_tag_assignments (id, security_id, tag_id, created_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, securityId, tagId, now);
    // Return the assignment (either new or existing)
    const existing = this.db.prepare('SELECT * FROM security_tag_assignments WHERE security_id = ? AND tag_id = ?').get(securityId, tagId);
    return this.mapRowToSecurityTagAssignment(existing);
  }

  removeTagFromSecurity(securityId: string, tagId: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('DELETE FROM security_tag_assignments WHERE security_id = ? AND tag_id = ?');
    stmt.run(securityId, tagId);
  }

  getTagsForSecurity(securityId: string): SecurityTag[] {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare(`
      SELECT t.* FROM security_tags t
      JOIN security_tag_assignments a ON t.id = a.tag_id
      WHERE a.security_id = ?
      ORDER BY t.is_system DESC, t.name
    `);
    return stmt.all(securityId).map(this.mapRowToSecurityTag);
  }

  // Trading rule operations
  listTradingRules(filters?: TradingRuleFilters): TradingRule[] {
    if (!this.db) throw new Error('Database not initialized');
    let sql = 'SELECT * FROM trading_rules WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.securityId !== undefined) {
      if (filters.securityId === null) {
        sql += ' AND security_id IS NULL';
      } else {
        sql += ' AND security_id = ?';
        params.push(filters.securityId);
      }
    }
    if (filters?.ruleType) {
      sql += ' AND rule_type = ?';
      params.push(filters.ruleType);
    }
    if (filters?.isEnabled !== undefined) {
      sql += ' AND is_enabled = ?';
      params.push(filters.isEnabled ? 1 : 0);
    }

    sql += ' ORDER BY priority DESC, created_at DESC';

    const stmt = this.db.prepare(sql);
    return stmt.all(...params).map(this.mapRowToTradingRule);
  }

  createTradingRule(rule: Omit<TradingRule, 'id' | 'createdAt' | 'updatedAt'>): TradingRule {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO trading_rules (id, name, description, security_id, rule_type, condition_type, condition_operator, condition_value, action_type, action_value, is_enabled, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      rule.name,
      rule.description || null,
      rule.securityId || null,
      rule.ruleType,
      rule.conditionType,
      rule.conditionOperator,
      rule.conditionValue,
      rule.actionType,
      rule.actionValue || null,
      rule.isEnabled ? 1 : 0,
      rule.priority,
      now,
      now
    );
    return this.getTradingRuleById(id)!;
  }

  getTradingRuleById(id: string): TradingRule | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM trading_rules WHERE id = ?');
    const row = stmt.get(id);
    return row ? this.mapRowToTradingRule(row) : null;
  }

  updateTradingRule(id: string, rule: Partial<TradingRule>): TradingRule {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (rule.name !== undefined) { fields.push('name = ?'); values.push(rule.name); }
    if (rule.description !== undefined) { fields.push('description = ?'); values.push(rule.description); }
    if (rule.securityId !== undefined) { fields.push('security_id = ?'); values.push(rule.securityId); }
    if (rule.ruleType !== undefined) { fields.push('rule_type = ?'); values.push(rule.ruleType); }
    if (rule.conditionType !== undefined) { fields.push('condition_type = ?'); values.push(rule.conditionType); }
    if (rule.conditionOperator !== undefined) { fields.push('condition_operator = ?'); values.push(rule.conditionOperator); }
    if (rule.conditionValue !== undefined) { fields.push('condition_value = ?'); values.push(rule.conditionValue); }
    if (rule.actionType !== undefined) { fields.push('action_type = ?'); values.push(rule.actionType); }
    if (rule.actionValue !== undefined) { fields.push('action_value = ?'); values.push(rule.actionValue); }
    if (rule.isEnabled !== undefined) { fields.push('is_enabled = ?'); values.push(rule.isEnabled ? 1 : 0); }
    if (rule.priority !== undefined) { fields.push('priority = ?'); values.push(rule.priority); }

    values.push(id);
    const stmt = this.db.prepare(`UPDATE trading_rules SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getTradingRuleById(id)!;
  }

  deleteTradingRule(id: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('DELETE FROM trading_rules WHERE id = ?');
    stmt.run(id);
  }

  // Decision log operations
  listDecisionLogs(filters?: DecisionLogFilters): DecisionLog[] {
    if (!this.db) throw new Error('Database not initialized');
    let sql = 'SELECT * FROM decision_logs WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.securityId) {
      sql += ' AND security_id = ?';
      params.push(filters.securityId);
    }
    if (filters?.decisionType) {
      sql += ' AND decision_type = ?';
      params.push(filters.decisionType);
    }
    if (filters?.startDate) {
      sql += ' AND decision_date >= ?';
      params.push(filters.startDate);
    }
    if (filters?.endDate) {
      sql += ' AND decision_date <= ?';
      params.push(filters.endDate);
    }
    if (filters?.search) {
      sql += ' AND (decision LIKE ? OR background LIKE ? OR execution LIKE ?)';
      const searchTerm = `%${filters.search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    sql += ' ORDER BY decision_date DESC, created_at DESC';

    if (filters?.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(...params).map(this.mapRowToDecisionLog);
  }

  createDecisionLog(log: Omit<DecisionLog, 'id' | 'createdAt' | 'updatedAt'>): DecisionLog {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO decision_logs (id, security_id, decision_date, decision_type, background, decision, execution, transaction_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      log.securityId,
      log.decisionDate,
      log.decisionType,
      log.background || null,
      log.decision,
      log.execution || null,
      JSON.stringify(log.transactionIds || []),
      now,
      now
    );
    return this.getDecisionLogById(id)!;
  }

  getDecisionLogById(id: string): DecisionLog | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM decision_logs WHERE id = ?');
    const row = stmt.get(id);
    return row ? this.mapRowToDecisionLog(row) : null;
  }

  updateDecisionLog(id: string, log: Partial<DecisionLog>): DecisionLog {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (log.securityId !== undefined) { fields.push('security_id = ?'); values.push(log.securityId); }
    if (log.decisionDate !== undefined) { fields.push('decision_date = ?'); values.push(log.decisionDate); }
    if (log.decisionType !== undefined) { fields.push('decision_type = ?'); values.push(log.decisionType); }
    if (log.background !== undefined) { fields.push('background = ?'); values.push(log.background); }
    if (log.decision !== undefined) { fields.push('decision = ?'); values.push(log.decision); }
    if (log.execution !== undefined) { fields.push('execution = ?'); values.push(log.execution); }
    if (log.transactionIds !== undefined) { fields.push('transaction_ids = ?'); values.push(JSON.stringify(log.transactionIds)); }

    values.push(id);
    const stmt = this.db.prepare(`UPDATE decision_logs SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getDecisionLogById(id)!;
  }

  deleteDecisionLog(id: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('DELETE FROM decision_logs WHERE id = ?');
    stmt.run(id);
  }

  // Position intent operations
  getPositionIntent(positionId: string): PositionIntent | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM position_intents WHERE position_id = ?');
    const row = stmt.get(positionId);
    return row ? this.mapRowToPositionIntent(row) : null;
  }

  upsertPositionIntent(positionId: string, data: Partial<PositionIntent>, ritualDate?: string, reason?: string): PositionIntent {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const existing = this.getPositionIntent(positionId);

    // Log changes if there's an existing intent
    if (existing) {
      const intentFields: { key: keyof PositionIntent; dbField: string }[] = [
        { key: 'tier', dbField: 'tier' },
        { key: 'thesis', dbField: 'thesis' },
        { key: 'invalidation', dbField: 'invalidation' },
        { key: 'entryStyle', dbField: 'entry_style' },
        { key: 'targetHoldPeriod', dbField: 'target_hold_period' },
        { key: 'targetAllocationPct', dbField: 'target_allocation_pct' },
      ];
      for (const { key, dbField } of intentFields) {
        if (data[key] !== undefined && data[key] !== existing[key]) {
          this.createIntentChangeLog({
            positionId,
            ritualDate,
            fieldChanged: dbField,
            oldValue: (existing[key] as string) || undefined,
            newValue: (data[key] as string) || undefined,
            reason,
          });
        }
      }
    }

    if (existing) {
      const fields: string[] = ['updated_at = ?'];
      const values: unknown[] = [now];

      if (data.tier !== undefined) { fields.push('tier = ?'); values.push(data.tier || null); }
      if (data.thesis !== undefined) { fields.push('thesis = ?'); values.push(data.thesis || null); }
      if (data.invalidation !== undefined) { fields.push('invalidation = ?'); values.push(data.invalidation || null); }
      if (data.entryStyle !== undefined) { fields.push('entry_style = ?'); values.push(data.entryStyle || null); }
      if (data.targetHoldPeriod !== undefined) { fields.push('target_hold_period = ?'); values.push(data.targetHoldPeriod || null); }
      if (data.targetAllocationPct !== undefined) { fields.push('target_allocation_pct = ?'); values.push(data.targetAllocationPct ?? null); }

      values.push(existing.id);
      const stmt = this.db.prepare(`UPDATE position_intents SET ${fields.join(', ')} WHERE id = ?`);
      stmt.run(...values);
      return this.getPositionIntent(positionId)!;
    } else {
      const id = uuidv4();
      const stmt = this.db.prepare(`
        INSERT INTO position_intents (id, position_id, tier, thesis, invalidation, entry_style, target_hold_period, target_allocation_pct, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        positionId,
        data.tier || null,
        data.thesis || null,
        data.invalidation || null,
        data.entryStyle || null,
        data.targetHoldPeriod || null,
        data.targetAllocationPct ?? null,
        now,
        now
      );
      return this.getPositionIntent(positionId)!;
    }
  }

  deletePositionIntent(positionId: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('DELETE FROM position_intents WHERE position_id = ?');
    stmt.run(positionId);
  }

  listPositionIntents(): PositionIntent[] {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM position_intents ORDER BY updated_at DESC');
    return stmt.all().map(this.mapRowToPositionIntent);
  }

  private mapRowToPositionIntent = (row: unknown): PositionIntent => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      positionId: r.position_id as string,
      tier: r.tier as string | undefined,
      thesis: r.thesis as string | undefined,
      invalidation: r.invalidation as string | undefined,
      entryStyle: r.entry_style as string | undefined,
      targetHoldPeriod: r.target_hold_period as string | undefined,
      targetAllocationPct: r.target_allocation_pct as number | undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  // Daily Ritual CRUD
  getDailyRitual(date: string): DailyRitual | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM daily_rituals WHERE date = ?');
    const row = stmt.get(date);
    return row ? this.mapRowToDailyRitual(row) : null;
  }

  upsertDailyRitual(date: string, data: Partial<DailyRitual>): DailyRitual {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const existing = this.getDailyRitual(date);

    if (existing) {
      const fields: string[] = ['updated_at = ?'];
      const values: unknown[] = [now];

      if (data.regimeRewarding !== undefined) { fields.push('regime_rewarding = ?'); values.push(data.regimeRewarding || null); }
      if (data.regimePunishing !== undefined) { fields.push('regime_punishing = ?'); values.push(data.regimePunishing || null); }
      if (data.regimeType !== undefined) { fields.push('regime_type = ?'); values.push(data.regimeType || null); }
      if (data.regimeNotes !== undefined) { fields.push('regime_notes = ?'); values.push(data.regimeNotes || null); }
      if (data.actionChosen !== undefined) { fields.push('action_chosen = ?'); values.push(data.actionChosen || null); }
      if (data.actionDetail !== undefined) { fields.push('action_detail = ?'); values.push(data.actionDetail || null); }
      if (data.journal !== undefined) { fields.push('journal = ?'); values.push(data.journal || null); }

      values.push(existing.id);
      const stmt = this.db.prepare(`UPDATE daily_rituals SET ${fields.join(', ')} WHERE id = ?`);
      stmt.run(...values);
      return this.getDailyRitual(date)!;
    } else {
      const id = uuidv4();
      const stmt = this.db.prepare(`
        INSERT INTO daily_rituals (id, date, regime_rewarding, regime_punishing, regime_type, regime_notes, action_chosen, action_detail, journal, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        date,
        data.regimeRewarding || null,
        data.regimePunishing || null,
        data.regimeType || null,
        data.regimeNotes || null,
        data.actionChosen || null,
        data.actionDetail || null,
        data.journal || null,
        now,
        now
      );
      return this.getDailyRitual(date)!;
    }
  }

  listDailyRituals(limit: number = 30): DailyRitual[] {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM daily_rituals ORDER BY date DESC LIMIT ?');
    return stmt.all(limit).map(this.mapRowToDailyRitual);
  }

  private mapRowToDailyRitual = (row: unknown): DailyRitual => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      date: r.date as string,
      regimeRewarding: r.regime_rewarding as string | undefined,
      regimePunishing: r.regime_punishing as string | undefined,
      regimeType: r.regime_type as DailyRitual['regimeType'],
      regimeNotes: r.regime_notes as string | undefined,
      actionChosen: r.action_chosen as DailyRitual['actionChosen'],
      actionDetail: r.action_detail as string | undefined,
      journal: r.journal as string | undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  // Intent Change Log CRUD
  createIntentChangeLog(data: Omit<PositionIntentChangeLog, 'id' | 'createdAt'>): PositionIntentChangeLog {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO position_intent_change_logs (id, position_id, ritual_date, field_changed, old_value, new_value, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, data.positionId, data.ritualDate || null, data.fieldChanged, data.oldValue || null, data.newValue || null, data.reason || null, now);
    return { id, ...data, createdAt: now };
  }

  listIntentChangeLogs(positionId?: string): PositionIntentChangeLog[] {
    if (!this.db) throw new Error('Database not initialized');
    if (positionId) {
      const stmt = this.db.prepare('SELECT * FROM position_intent_change_logs WHERE position_id = ? ORDER BY created_at DESC');
      return stmt.all(positionId).map(this.mapRowToIntentChangeLog);
    }
    const stmt = this.db.prepare('SELECT * FROM position_intent_change_logs ORDER BY created_at DESC');
    return stmt.all().map(this.mapRowToIntentChangeLog);
  }

  listIntentChangeLogsByDate(date: string): PositionIntentChangeLog[] {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT * FROM position_intent_change_logs WHERE ritual_date = ? ORDER BY created_at DESC');
    return stmt.all(date).map(this.mapRowToIntentChangeLog);
  }

  private mapRowToIntentChangeLog = (row: unknown): PositionIntentChangeLog => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      positionId: r.position_id as string,
      ritualDate: r.ritual_date as string | undefined,
      fieldChanged: r.field_changed as string,
      oldValue: r.old_value as string | undefined,
      newValue: r.new_value as string | undefined,
      reason: r.reason as string | undefined,
      createdAt: r.created_at as string,
    };
  };

  // Watchlist CRUD
  listWatchlists(): Watchlist[] {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare('SELECT * FROM watchlists ORDER BY name').all().map(this.mapRowToWatchlist);
  }

  getWatchlist(id: string): Watchlist | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare('SELECT * FROM watchlists WHERE id = ?').get(id);
    return row ? this.mapRowToWatchlist(row) : null;
  }

  getWatchlistByName(name: string): Watchlist | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare('SELECT * FROM watchlists WHERE name = ?').get(name);
    return row ? this.mapRowToWatchlist(row) : null;
  }

  createWatchlist(name: string, description?: string): Watchlist {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO watchlists (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, description || null, now, now);
    return this.getWatchlist(id)!;
  }

  updateWatchlist(id: string, data: Partial<Pick<Watchlist, 'name' | 'description'>>): Watchlist {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];
    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
    values.push(id);
    this.db.prepare(`UPDATE watchlists SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getWatchlist(id)!;
  }

  deleteWatchlist(id: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare('DELETE FROM watchlists WHERE id = ?').run(id);
  }

  // Watchlist Item CRUD
  listWatchlistItems(watchlistId?: string): WatchlistItem[] {
    if (!this.db) throw new Error('Database not initialized');
    const query = `
      SELECT wi.*,
        (SELECT ph.close_price FROM price_history ph
         JOIN securities s ON s.id = ph.security_id
         WHERE s.symbol = wi.symbol
         ORDER BY ph.date DESC LIMIT 1) as last_price
      FROM watchlist_items wi
      ${watchlistId ? 'WHERE wi.watchlist_id = ?' : ''}
      ORDER BY wi.symbol
    `;
    const rows = watchlistId
      ? this.db.prepare(query).all(watchlistId)
      : this.db.prepare(query).all();
    return rows.map(this.mapRowToWatchlistItem);
  }

  addWatchlistItem(watchlistId: string, data: {
    symbol: string;
    notes?: string;
    targetEntryPrice?: number;
    targetExitPrice?: number;
    thesisSnippet?: string;
  }): WatchlistItem {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    const symbol = data.symbol.toUpperCase();

    // Ensure security exists for this symbol
    let securityId: string | null = null;
    const existing = this.db.prepare('SELECT id FROM securities WHERE symbol = ?').get(symbol) as { id: string } | undefined;
    if (existing) {
      securityId = existing.id;
    } else {
      securityId = uuidv4();
      this.db.prepare(
        'INSERT INTO securities (id, symbol, name, type, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(securityId, symbol, symbol, 'stock', 'USD', now);
    }

    this.db.prepare(`
      INSERT INTO watchlist_items (id, watchlist_id, symbol, security_id, notes, target_entry_price, target_exit_price, thesis_snippet, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, watchlistId, symbol, securityId, data.notes || null,
      data.targetEntryPrice || null, data.targetExitPrice || null, data.thesisSnippet || null, now, now);
    const item = this.getWatchlistItem(id)!;
    this.syncWatchlistMonitors();
    return item;
  }

  getWatchlistItem(id: string): WatchlistItem | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare('SELECT * FROM watchlist_items WHERE id = ?').get(id);
    return row ? this.mapRowToWatchlistItem(row) : null;
  }

  updateWatchlistItem(id: string, data: Partial<Pick<WatchlistItem, 'notes' | 'targetEntryPrice' | 'targetExitPrice' | 'thesisSnippet'>>): WatchlistItem {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];
    if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }
    if (data.targetEntryPrice !== undefined) { fields.push('target_entry_price = ?'); values.push(data.targetEntryPrice); }
    if (data.targetExitPrice !== undefined) { fields.push('target_exit_price = ?'); values.push(data.targetExitPrice); }
    if (data.thesisSnippet !== undefined) { fields.push('thesis_snippet = ?'); values.push(data.thesisSnippet); }
    values.push(id);
    this.db.prepare(`UPDATE watchlist_items SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    const item = this.getWatchlistItem(id)!;
    this.syncWatchlistMonitors();
    return item;
  }

  removeWatchlistItem(id: string): void {
    if (!this.db) throw new Error('Database not initialized');
    // Delete any linked monitors first
    this.db.prepare('DELETE FROM monitors WHERE linked_watchlist_item_id = ?').run(id);
    this.db.prepare('DELETE FROM watchlist_items WHERE id = ?').run(id);
  }

  getWatchlistSymbols(): string[] {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare('SELECT DISTINCT symbol FROM watchlist_items ORDER BY symbol').all() as { symbol: string }[];
    return rows.map(r => r.symbol);
  }

  // Monitor CRUD methods
  listMonitors(status?: string): Monitor[] {
    if (!this.db) throw new Error('Database not initialized');
    if (status) {
      return this.db.prepare('SELECT * FROM monitors WHERE status = ? ORDER BY symbol, direction')
        .all(status).map(this.mapRowToMonitor);
    }
    return this.db.prepare('SELECT * FROM monitors ORDER BY symbol, direction')
      .all().map(this.mapRowToMonitor);
  }

  getMonitor(id: string): Monitor | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id);
    return row ? this.mapRowToMonitor(row) : null;
  }

  createMonitor(data: {
    symbol: string;
    direction: 'above' | 'below';
    priceLevel: number;
    label: string;
    actionType?: 'informational' | 'action_required';
    monitorType?: 'price' | 'earnings' | 'fundamental';
    linkedPositionId?: string;
    linkedWatchlistItemId?: string;
    reminderDate?: string;
    expiresAt?: string;
  }): Monitor {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO monitors (id, symbol, direction, price_level, label, action_type, monitor_type, status, linked_position_id, linked_watchlist_item_id, reminder_date, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
    `).run(id, data.symbol.toUpperCase(), data.direction, data.priceLevel, data.label,
      data.actionType || 'informational', data.monitorType || 'price',
      data.linkedPositionId || null, data.linkedWatchlistItemId || null,
      data.reminderDate || null, data.expiresAt || null, now, now);
    return this.getMonitor(id)!;
  }

  updateMonitorStatus(id: string, status: 'active' | 'triggered' | 'dismissed'): Monitor {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const triggeredAt = status === 'triggered' ? now : null;
    if (triggeredAt) {
      this.db.prepare('UPDATE monitors SET status = ?, triggered_at = ?, updated_at = ? WHERE id = ?')
        .run(status, triggeredAt, now, id);
    } else {
      this.db.prepare('UPDATE monitors SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, now, id);
    }
    return this.getMonitor(id)!;
  }

  deleteMonitor(id: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare('DELETE FROM monitors WHERE id = ?').run(id);
  }

  checkMonitors(symbol: string, price: number): Monitor[] {
    if (!this.db) throw new Error('Database not initialized');
    const active = this.db.prepare(
      "SELECT * FROM monitors WHERE symbol = ? AND status = 'active' AND (monitor_type = 'price' OR monitor_type IS NULL)"
    ).all(symbol.toUpperCase()).map(this.mapRowToMonitor);

    const triggered: Monitor[] = [];
    const now = new Date().toISOString();

    for (const m of active) {
      const fires = (m.direction === 'below' && price <= m.priceLevel) ||
                    (m.direction === 'above' && price >= m.priceLevel);
      if (fires) {
        this.db.prepare('UPDATE monitors SET status = ?, triggered_at = ?, updated_at = ? WHERE id = ?')
          .run('triggered', now, now, m.id);
        triggered.push({ ...m, status: 'triggered', triggeredAt: now });
      }
    }
    return triggered;
  }

  cleanExpiredMonitors(): number {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.prepare("DELETE FROM monitors WHERE expires_at IS NOT NULL AND expires_at < date('now')").run();
    return result.changes;
  }

  getDueReminderMonitors(): Monitor[] {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(
      "SELECT * FROM monitors WHERE monitor_type = 'fundamental' AND status = 'active' AND reminder_date IS NOT NULL AND reminder_date <= date('now') ORDER BY symbol"
    ).all().map(this.mapRowToMonitor);
  }

  getEarningsMonitors(): Monitor[] {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(
      "SELECT * FROM monitors WHERE monitor_type = 'earnings' AND status = 'active' ORDER BY expires_at, symbol"
    ).all().map(this.mapRowToMonitor);
  }

  syncWatchlistMonitors(): void {
    if (!this.db) throw new Error('Database not initialized');

    // Get all watchlist items with target entry prices
    const items = this.db.prepare(
      'SELECT * FROM watchlist_items WHERE target_entry_price IS NOT NULL'
    ).all().map(this.mapRowToWatchlistItem);

    // Get all existing watchlist-linked monitors
    const linkedMonitors = this.db.prepare(
      'SELECT * FROM monitors WHERE linked_watchlist_item_id IS NOT NULL'
    ).all().map(this.mapRowToMonitor);

    const linkedMap = new Map(linkedMonitors.map(m => [m.linkedWatchlistItemId!, m]));
    const itemIds = new Set(items.map(i => i.id));

    // Create/update monitors for watchlist items with targets
    for (const item of items) {
      const existing = linkedMap.get(item.id);
      if (!existing) {
        // Create new monitor
        this.createMonitor({
          symbol: item.symbol,
          direction: 'below',
          priceLevel: item.targetEntryPrice!,
          label: `Watchlist target: ${item.symbol} @ $${item.targetEntryPrice!.toFixed(2)}`,
          actionType: 'informational',
          monitorType: 'price',
          linkedWatchlistItemId: item.id,
        });
      } else if (existing.priceLevel !== item.targetEntryPrice) {
        // Update price level
        const now = new Date().toISOString();
        this.db!.prepare(
          'UPDATE monitors SET price_level = ?, label = ?, updated_at = ? WHERE id = ?'
        ).run(item.targetEntryPrice!, `Watchlist target: ${item.symbol} @ $${item.targetEntryPrice!.toFixed(2)}`, now, existing.id);
      }
    }

    // Delete orphaned monitors (linked item deleted or target cleared)
    for (const monitor of linkedMonitors) {
      if (!itemIds.has(monitor.linkedWatchlistItemId!)) {
        this.deleteMonitor(monitor.id);
      }
    }
  }

  syncEarningsMonitors(events: Array<{ symbol: string; date: string; time?: string }>): void {
    if (!this.db) throw new Error('Database not initialized');

    // Clean expired first
    this.cleanExpiredMonitors();

    // Get portfolio symbols
    const positions = this.listPositions();
    const securities = this.listSecurities();
    const secMap = new Map(securities.map(s => [s.id, s]));
    const portfolioSymbols = new Set(
      positions.filter(p => {
        const sec = secMap.get(p.securityId);
        return sec && sec.type !== 'cash';
      }).map(p => secMap.get(p.securityId)!.symbol)
    );

    // Get existing earnings monitors
    const existingEarnings = this.db.prepare(
      "SELECT * FROM monitors WHERE monitor_type = 'earnings' AND status = 'active'"
    ).all().map(this.mapRowToMonitor);
    const existingKeys = new Set(existingEarnings.map(m => `${m.symbol}:${m.label}`));

    for (const event of events) {
      const sym = event.symbol.toUpperCase();
      if (!portfolioSymbols.has(sym)) continue;

      const timeLabel = event.time === 'bmo' ? 'Before Open' : event.time === 'amc' ? 'After Close' : '';
      const label = `Earnings: ${sym} on ${event.date}${timeLabel ? ` (${timeLabel})` : ''}`;
      const key = `${sym}:${label}`;

      if (existingKeys.has(key)) continue;

      // Compute expires_at as day after earnings
      const earningsDate = new Date(event.date + 'T00:00:00');
      earningsDate.setDate(earningsDate.getDate() + 1);
      const expiresAt = earningsDate.toISOString().split('T')[0];

      this.createMonitor({
        symbol: sym,
        direction: 'below',
        priceLevel: 0,
        label,
        actionType: 'informational',
        monitorType: 'earnings',
        expiresAt,
      });
    }
  }

  // Analytics query methods

  getSnapshotDailyTotals(days: number = 90): Array<{ date: string; totalMv: number; totalCost: number }> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(`
      SELECT date, SUM(market_value) as total_mv, SUM(cost_basis) as total_cost
      FROM portfolio_snapshots
      GROUP BY date
      ORDER BY date DESC
      LIMIT ?
    `).all(days) as Array<{ date: string; total_mv: number; total_cost: number }>;
    return rows.reverse().map(r => ({ date: r.date, totalMv: r.total_mv, totalCost: r.total_cost }));
  }

  getPriceHistoryBySymbol(symbol: string, days: number = 90): PriceHistory[] {
    if (!this.db) throw new Error('Database not initialized');
    const sec = this.db.prepare('SELECT id FROM securities WHERE symbol = ?').get(symbol.toUpperCase()) as { id: string } | undefined;
    if (!sec) return [];
    return this.db.prepare(
      'SELECT * FROM price_history WHERE security_id = ? ORDER BY date DESC LIMIT ?'
    ).all(sec.id, days).map(this.mapRowToPriceHistory).reverse();
  }

  getPositionWeights(): Array<{ symbol: string; marketValue: number; weight: number }> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(`
      SELECT s.symbol, SUM(p.quantity * COALESCE(ph.close_price, 0)) as market_value
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      LEFT JOIN (
        SELECT security_id, close_price
        FROM price_history ph1
        WHERE date = (SELECT MAX(date) FROM price_history ph2 WHERE ph2.security_id = ph1.security_id)
      ) ph ON p.security_id = ph.security_id
      WHERE p.quantity > 0 AND s.type != 'cash'
      GROUP BY s.symbol
      ORDER BY market_value DESC
    `).all() as Array<{ symbol: string; market_value: number }>;
    const total = rows.reduce((sum, r) => sum + (r.market_value || 0), 0);
    return rows.map(r => ({
      symbol: r.symbol,
      marketValue: r.market_value || 0,
      weight: total > 0 ? (r.market_value || 0) / total : 0,
    }));
  }

  // Price Levels (Support/Resistance)

  getPriceLevels(symbol?: string): import('../shared/types').PriceLevel[] {
    if (!this.db) throw new Error('Database not initialized');
    // Ensure table exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS price_levels (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        level_type TEXT NOT NULL,
        price REAL NOT NULL,
        strength INTEGER DEFAULT 1,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(symbol, level_type, price)
      )
    `);
    const sql = symbol
      ? 'SELECT * FROM price_levels WHERE symbol = ? ORDER BY price ASC'
      : 'SELECT * FROM price_levels ORDER BY symbol, price ASC';
    const rows = symbol
      ? this.db.prepare(sql).all(symbol.toUpperCase()) as Record<string, unknown>[]
      : this.db.prepare(sql).all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      symbol: r.symbol as string,
      levelType: r.level_type as 'support' | 'resistance',
      price: r.price as number,
      strength: r.strength as number,
      source: r.source as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
  }

  createPriceLevel(symbol: string, levelType: 'support' | 'resistance', price: number, strength = 5, source = 'manual'): import('../shared/types').PriceLevel {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR REPLACE INTO price_levels (id, symbol, level_type, price, strength, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, symbol.toUpperCase(), levelType, price, strength, source, now, now);
    return { id, symbol: symbol.toUpperCase(), levelType, price, strength, source, createdAt: now, updatedAt: now };
  }

  updatePriceLevel(id: string, data: { price?: number; strength?: number; levelType?: 'support' | 'resistance' }): void {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];
    if (data.price !== undefined) { fields.push('price = ?'); values.push(data.price); }
    if (data.strength !== undefined) { fields.push('strength = ?'); values.push(data.strength); }
    if (data.levelType !== undefined) { fields.push('level_type = ?'); values.push(data.levelType); }
    values.push(id);
    this.db.prepare(`UPDATE price_levels SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  deletePriceLevel(id: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare('DELETE FROM price_levels WHERE id = ?').run(id);
  }

  refreshPriceLevels(symbols?: string[]): void {
    if (!this.db) throw new Error('Database not initialized');
    // Ensure table exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS price_levels (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        level_type TEXT NOT NULL,
        price REAL NOT NULL,
        strength INTEGER DEFAULT 1,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(symbol, level_type, price)
      )
    `);

    const targetSymbols = symbols || (this.db.prepare(`
      SELECT DISTINCT symbol FROM (
        SELECT s.symbol FROM positions p
        JOIN securities s ON p.security_id = s.id
        WHERE s.type != 'cash' AND s.symbol != ''
        UNION
        SELECT wi.symbol FROM watchlist_items wi
        WHERE wi.symbol != ''
      )
    `).all() as { symbol: string }[]).map(r => r.symbol);

    const now = new Date().toISOString();

    for (const symbol of targetSymbols) {
      const rows = this.db.prepare(`
        SELECT ph.date, ph.open_price, ph.high_price, ph.low_price, ph.close_price, ph.volume
        FROM price_history ph
        JOIN securities s ON ph.security_id = s.id
        WHERE s.symbol = ? AND ph.date >= date('now', '-6 months')
        ORDER BY ph.date ASC
      `).all(symbol) as { date: string; open_price: number | null; high_price: number | null; low_price: number | null; close_price: number | null; volume: number | null }[];

      if (rows.length < 15) continue;

      const opens = rows.map(r => r.open_price);
      const highs = rows.map(r => r.high_price);
      const lows = rows.map(r => r.low_price);
      const closes = rows.map(r => r.close_price);
      const volumes = rows.map(r => r.volume || 0);
      const currentPrice = closes[closes.length - 1];
      if (!currentPrice) continue;

      const totalDays = rows.length;
      const validVols = volumes.filter(v => v > 0);
      const avgVolume = validVols.length > 0 ? validVols.reduce((a, b) => a + b, 0) / validVols.length : 1;

      // Find swing highs/lows with metadata: [index, price, volume, rejection]
      type SwingPoint = [number, number, number, number];
      const swingHighs: SwingPoint[] = [];
      const swingLows: SwingPoint[] = [];
      const window = 5;

      for (let i = window; i < rows.length - window; i++) {
        const h = highs[i];
        if (h == null) continue;
        const neighborH = [];
        for (let j = i - window; j <= i + window; j++) {
          if (j !== i) neighborH.push(highs[j]);
        }
        if (neighborH.some(v => v == null)) continue;
        if (neighborH.every(v => h >= v!)) {
          const c = closes[i], o = opens[i];
          const rejection = (c != null && o != null && h > 0)
            ? (h - Math.max(c, o)) / h : 0;
          swingHighs.push([i, h, volumes[i], rejection]);
        }

        const l = lows[i];
        if (l == null) continue;
        const neighborL = [];
        for (let j = i - window; j <= i + window; j++) {
          if (j !== i) neighborL.push(lows[j]);
        }
        if (neighborL.some(v => v == null)) continue;
        if (neighborL.every(v => l <= v!)) {
          const c = closes[i], o = opens[i];
          const rejection = (c != null && o != null && l > 0)
            ? (Math.min(c, o) - l) / l : 0;
          swingLows.push([i, l, volumes[i], rejection]);
        }
      }

      // Cluster nearby levels within 2%
      const clusterWithMeta = (points: SwingPoint[], threshold = 0.02): [number, SwingPoint[]][] => {
        if (points.length === 0) return [];
        const sorted = [...points].sort((a, b) => a[1] - b[1]);
        const clusters: [number, SwingPoint[]][] = [];
        let current = [sorted[0]];
        for (let k = 1; k < sorted.length; k++) {
          if ((sorted[k][1] - current[0][1]) / current[0][1] <= threshold) {
            current.push(sorted[k]);
          } else {
            const avg = current.reduce((s, p) => s + p[1], 0) / current.length;
            clusters.push([Math.round(avg * 100) / 100, current]);
            current = [sorted[k]];
          }
        }
        const avg = current.reduce((s, p) => s + p[1], 0) / current.length;
        clusters.push([Math.round(avg * 100) / 100, current]);
        return clusters;
      };

      // Composite strength score (1-10)
      const scoreCluster = (points: SwingPoint[]): number => {
        const n = points.length;
        const touchScore = Math.min(1.0, 0.2 + (n - 1) * 0.27);
        const volVals = points.filter(p => p[2] > 0).map(p => p[2]);
        const volScore = (volVals.length > 0 && avgVolume > 0)
          ? Math.min(1.0, (volVals.reduce((a, b) => a + b, 0) / volVals.length) / (avgVolume * 2))
          : 0.3;
        const halfLife = 60;
        const recencyScore = Math.max(...points.map(p => Math.exp(-0.693 * (totalDays - 1 - p[0]) / halfLife)));
        const avgRej = points.reduce((s, p) => s + p[3], 0) / points.length;
        const rejScore = avgRej > 0 ? Math.min(1.0, avgRej / 0.03) : 0.1;
        const composite = touchScore * 0.30 + volScore * 0.25 + recencyScore * 0.25 + rejScore * 0.20;
        return Math.max(1, Math.min(10, Math.round(composite * 10)));
      };

      const resClusters = clusterWithMeta(swingHighs);
      const supClusters = clusterWithMeta(swingLows);

      let resistance = resClusters.filter(([p]) => p > currentPrice).map(([p, pts]) => ({ price: p, strength: scoreCluster(pts) }));
      let support = supClusters.filter(([p]) => p < currentPrice).map(([p, pts]) => ({ price: p, strength: scoreCluster(pts) }));

      resistance.sort((a, b) => a.price - b.price);
      support.sort((a, b) => b.price - a.price);
      resistance = resistance.slice(0, 5);
      support = support.slice(0, 5);

      // Clear and insert
      this.db.prepare("DELETE FROM price_levels WHERE symbol = ? AND source = 'swing'").run(symbol);
      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO price_levels (id, symbol, level_type, price, strength, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'swing', ?, ?)
      `);
      for (const r of resistance) {
        insert.run(uuidv4(), symbol, 'resistance', r.price, r.strength, now, now);
      }
      for (const s of support) {
        insert.run(uuidv4(), symbol, 'support', s.price, s.strength, now, now);
      }
    }
  }

  getTriggeredMonitors(): Monitor[] {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare('SELECT * FROM monitors WHERE status = ? ORDER BY triggered_at DESC')
      .all('triggered').map(this.mapRowToMonitor);
  }

  // Row mappers
  private mapRowToWatchlist = (row: unknown): Watchlist => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      name: r.name as string,
      description: r.description as string | undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  private mapRowToWatchlistItem = (row: unknown): WatchlistItem => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      watchlistId: r.watchlist_id as string,
      symbol: r.symbol as string,
      securityId: r.security_id as string | undefined,
      notes: r.notes as string | undefined,
      targetEntryPrice: r.target_entry_price as number | undefined,
      targetExitPrice: r.target_exit_price as number | undefined,
      thesisSnippet: r.thesis_snippet as string | undefined,
      lastPrice: r.last_price as number | undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  private mapRowToMonitor = (row: unknown): Monitor => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      symbol: r.symbol as string,
      direction: r.direction as 'above' | 'below',
      priceLevel: r.price_level as number,
      label: r.label as string,
      actionType: (r.action_type as string) as 'informational' | 'action_required',
      status: (r.status as string) as 'active' | 'triggered' | 'dismissed',
      linkedPositionId: r.linked_position_id as string | undefined,
      linkedWatchlistItemId: r.linked_watchlist_item_id as string | undefined,
      triggeredAt: r.triggered_at as string | undefined,
      monitorType: (r.monitor_type as string | undefined) as Monitor['monitorType'],
      reminderDate: r.reminder_date as string | undefined,
      expiresAt: r.expires_at as string | undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  private mapRowToAccount = (row: unknown): Account => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      name: r.name as string,
      broker: r.broker as string,
      accountNumber: r.account_number as string | undefined,
      accountType: r.account_type as Account['accountType'],
      book: r.book as Account['book'] | undefined,
      cashBalance: r.cash_balance as number | undefined,
      currency: r.currency as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  private mapRowToSecurity = (row: unknown): Security => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      symbol: r.symbol as string,
      name: r.name as string,
      type: r.type as Security['type'],
      currency: r.currency as string,
      exchange: r.exchange as string | undefined,
      sector: r.sector as string | undefined,
      industry: r.industry as string | undefined,
      description: r.description as string | undefined,
      website: r.website as string | undefined,
      ceo: r.ceo as string | undefined,
      marketCap: r.market_cap as number | undefined,
      profileUpdatedAt: r.profile_updated_at as string | undefined,
      createdAt: r.created_at as string,
    };
  };

  // === News ===

  getRecentNews(hours = 24): Array<{ symbol: string; title: string; snippet: string | null; source: string | null; url: string | null; publishedAt: string }> {
    if (!this.db) throw new Error('Database not initialized');
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      SELECT symbol, title, snippet, source, url, published_at
      FROM news
      WHERE published_at >= ?
      ORDER BY published_at DESC
    `).all(cutoff) as Array<{ symbol: string; title: string; snippet: string | null; source: string | null; url: string | null; published_at: string }>;
    return rows.map(r => ({
      symbol: r.symbol,
      title: r.title,
      snippet: r.snippet,
      source: r.source,
      url: r.url,
      publishedAt: r.published_at,
    }));
  }

  getNewsBySymbol(symbol: string, limit = 10): Array<{ symbol: string; title: string; snippet: string | null; source: string | null; url: string | null; publishedAt: string }> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(`
      SELECT symbol, title, snippet, source, url, published_at
      FROM news
      WHERE symbol = ?
      ORDER BY published_at DESC
      LIMIT ?
    `).all(symbol.toUpperCase(), limit) as Array<{ symbol: string; title: string; snippet: string | null; source: string | null; url: string | null; published_at: string }>;
    return rows.map(r => ({
      symbol: r.symbol,
      title: r.title,
      snippet: r.snippet,
      source: r.source,
      url: r.url,
      publishedAt: r.published_at,
    }));
  }

  // === Scheduler task run tracking ===

  recordTaskStart(taskId: string): string {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO scheduler_task_runs (id, task_id, started_at, status, created_at)
      VALUES (?, ?, ?, 'running', ?)
    `).run(id, taskId, now, now);
    return id;
  }

  recordTaskComplete(runId: string, status: 'success' | 'failure', result?: string, error?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const row = this.db.prepare('SELECT started_at FROM scheduler_task_runs WHERE id = ?').get(runId) as { started_at: string } | undefined;
    const durationMs = row ? Date.now() - new Date(row.started_at).getTime() : 0;
    this.db.prepare(`
      UPDATE scheduler_task_runs SET completed_at = ?, status = ?, result = ?, error = ?, duration_ms = ?
      WHERE id = ?
    `).run(now, status, result || null, error || null, durationMs, runId);
  }

  getLastTaskRun(taskId: string): TaskRunRecord | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(`
      SELECT * FROM scheduler_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1
    `).get(taskId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToTaskRun(row) : null;
  }

  getTaskRunHistory(taskId: string, limit = 10): TaskRunRecord[] {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(`
      SELECT * FROM scheduler_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?
    `).all(taskId, limit) as Record<string, unknown>[];
    return rows.map(this.mapRowToTaskRun);
  }

  didTaskRunToday(taskId: string): boolean {
    if (!this.db) throw new Error('Database not initialized');
    const today = new Date().toISOString().split('T')[0];
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM scheduler_task_runs
      WHERE task_id = ? AND status = 'success' AND started_at >= ?
    `).get(taskId, today + 'T00:00:00.000Z') as { cnt: number };
    return row.cnt > 0;
  }

  // === EOD Snapshot ===

  takeEodSnapshot(): { count: number; totalMV: number; totalPnL: number; dayPnL: number } {
    if (!this.db) throw new Error('Database not initialized');
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();

    // Check if already exists
    const existing = this.db.prepare('SELECT COUNT(*) as cnt FROM portfolio_snapshots WHERE date = ?').get(today) as { cnt: number };
    if (existing.cnt > 0) {
      // Return existing totals
      const totals = this.db.prepare(`
        SELECT COALESCE(SUM(market_value), 0) as mv, COALESCE(SUM(unrealized_gain), 0) as pnl, COALESCE(SUM(day_pnl), 0) as day_pnl
        FROM portfolio_snapshots WHERE date = ?
      `).get(today) as { mv: number; pnl: number; day_pnl: number };
      return { count: existing.cnt, totalMV: totals.mv, totalPnL: totals.pnl, dayPnL: totals.day_pnl };
    }

    // Get positions aggregated by symbol
    const positions = this.db.prepare(`
      SELECT s.symbol, s.type,
             SUM(p.quantity) as total_qty,
             SUM(p.cost_basis) as total_cost
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      GROUP BY s.symbol, s.type
      HAVING total_qty != 0
    `).all() as Array<{ symbol: string; type: string; total_qty: number; total_cost: number }>;

    let count = 0;
    const insert = this.db.prepare(`
      INSERT INTO portfolio_snapshots (id, date, symbol, quantity, cost_basis, close_price, market_value, unrealized_gain, day_change, day_pnl, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction(() => {
      for (const pos of positions) {
        let closePrice: number;
        let dayChange: number | null = null;
        let dayPnl: number | null = null;

        if (pos.type === 'cash') {
          closePrice = 1.0;
        } else {
          // Get latest close price
          const priceRow = this.db!.prepare(`
            SELECT ph.close_price FROM price_history ph
            JOIN securities s ON ph.security_id = s.id
            WHERE s.symbol = ?
            ORDER BY ph.date DESC LIMIT 1
          `).get(pos.symbol) as { close_price: number } | undefined;

          if (!priceRow) continue;
          closePrice = priceRow.close_price;

          // Get previous day's close
          const prevRow = this.db!.prepare(`
            SELECT ph.close_price FROM price_history ph
            JOIN securities s ON ph.security_id = s.id
            WHERE s.symbol = ? AND ph.date < (
              SELECT MAX(ph2.date) FROM price_history ph2
              JOIN securities s2 ON ph2.security_id = s2.id
              WHERE s2.symbol = ?
            )
            ORDER BY ph.date DESC LIMIT 1
          `).get(pos.symbol, pos.symbol) as { close_price: number } | undefined;

          if (prevRow) {
            dayChange = closePrice - prevRow.close_price;
            dayPnl = dayChange * pos.total_qty;
          }
        }

        const marketValue = pos.total_qty * closePrice;
        const unrealizedGain = marketValue - pos.total_cost;

        insert.run(
          uuidv4(), today, pos.symbol, pos.total_qty, pos.total_cost,
          closePrice, marketValue, unrealizedGain, dayChange, dayPnl, now
        );
        count++;
      }
    });

    insertMany();

    // Return totals
    const totals = this.db.prepare(`
      SELECT COALESCE(SUM(market_value), 0) as mv, COALESCE(SUM(unrealized_gain), 0) as pnl, COALESCE(SUM(day_pnl), 0) as day_pnl
      FROM portfolio_snapshots WHERE date = ?
    `).get(today) as { mv: number; pnl: number; day_pnl: number };

    return { count, totalMV: totals.mv, totalPnL: totals.pnl, dayPnL: totals.day_pnl };
  }

  private mapRowToTaskRun = (row: Record<string, unknown>): TaskRunRecord => {
    return {
      id: row.id as string,
      taskId: row.task_id as string,
      startedAt: row.started_at as string,
      completedAt: row.completed_at as string | undefined,
      status: row.status as TaskRunRecord['status'],
      result: row.result as string | undefined,
      error: row.error as string | undefined,
      durationMs: row.duration_ms as number | undefined,
    };
  };

  private mapRowToPosition = (row: unknown): Position => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      accountId: r.account_id as string,
      securityId: r.security_id as string,
      quantity: r.quantity as number,
      costBasis: r.cost_basis as number,
      currentPrice: r.current_price as number | undefined,
      marketValue: r.market_value as number | undefined,
      unrealizedGain: r.unrealized_gain as number | undefined,
      unrealizedGainPercent: r.unrealized_gain_percent as number | undefined,
      lastUpdated: r.last_updated as string,
    };
  };

  private mapRowToTransaction = (row: unknown): Transaction => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      accountId: r.account_id as string,
      securityId: r.security_id as string,
      type: r.type as Transaction['type'],
      date: r.date as string,
      quantity: r.quantity as number,
      price: r.price as number,
      amount: r.amount as number,
      fees: r.fees as number | undefined,
      notes: r.notes as string | undefined,
      washSale: r.wash_sale === 1 ? true : undefined,
      disallowedLoss: r.disallowed_loss as number | undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  private mapRowToTaxLot = (row: unknown): TaxLot => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      accountId: r.account_id as string,
      securityId: r.security_id as string,
      transactionId: r.transaction_id as string,
      acquisitionDate: r.acquisition_date as string,
      quantity: r.quantity as number,
      costBasis: r.cost_basis as number,
      costPerShare: r.cost_per_share as number,
      remainingQuantity: r.remaining_quantity as number,
      isOpen: Boolean(r.is_open),
      closedDate: r.closed_date as string | undefined,
      closedTransactionId: r.closed_transaction_id as string | undefined,
      realizedGain: r.realized_gain as number | undefined,
      holdingPeriod: r.holding_period as TaxLot['holdingPeriod'],
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  private mapRowToSecurityTag = (row: unknown): SecurityTag => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      name: r.name as string,
      displayName: r.display_name as string,
      color: r.color as string,
      description: r.description as string | undefined,
      isSystem: Boolean(r.is_system),
      createdAt: r.created_at as string,
    };
  };

  private mapRowToSecurityTagAssignment = (row: unknown): SecurityTagAssignment => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      securityId: r.security_id as string,
      tagId: r.tag_id as string,
      createdAt: r.created_at as string,
    };
  };

  private mapRowToTradingRule = (row: unknown): TradingRule => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      name: r.name as string,
      description: r.description as string | undefined,
      securityId: r.security_id as string | undefined,
      ruleType: r.rule_type as TradingRule['ruleType'],
      conditionType: r.condition_type as TradingRule['conditionType'],
      conditionOperator: r.condition_operator as TradingRule['conditionOperator'],
      conditionValue: r.condition_value as number,
      actionType: r.action_type as TradingRule['actionType'],
      actionValue: r.action_value as number | undefined,
      isEnabled: Boolean(r.is_enabled),
      priority: r.priority as number,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  private mapRowToDecisionLog = (row: unknown): DecisionLog => {
    const r = row as Record<string, unknown>;
    let transactionIds: string[] = [];
    try {
      if (r.transaction_ids) {
        transactionIds = JSON.parse(r.transaction_ids as string);
      }
    } catch {
      transactionIds = [];
    }
    return {
      id: r.id as string,
      securityId: r.security_id as string,
      decisionDate: r.decision_date as string,
      decisionType: r.decision_type as DecisionLog['decisionType'],
      background: r.background as string | undefined,
      decision: r.decision as string,
      execution: r.execution as string | undefined,
      transactionIds,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  // Pre-trade check operations
  recordPreTradeCheck(record: Omit<PreTradeCheckRecord, 'id'>): string {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO pre_trade_checks (id, order_symbol, order_side, order_qty, account_id, book, checks_json, overrides, passed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, record.orderSymbol, record.orderSide, record.orderQty, record.accountId, record.book, record.checksJson, record.overrides, record.passed ? 1 : 0, record.createdAt);
    return id;
  }

  // Transaction Analytics (Phase 9B)
  getClosedTrades(): ClosedTrade[] {
    if (!this.db) throw new Error('Database not initialized');

    // Include transfer_in (price=0) to detect stock splits
    const rows = this.db.prepare(`
      SELECT t.account_id, t.security_id, s.symbol, t.type, t.date, t.quantity, t.price
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE t.type IN ('buy', 'sell')
         OR (t.type = 'transfer_in' AND t.price = 0 AND t.quantity > 0)
      ORDER BY t.date ASC, t.type ASC
    `).all() as Array<{
      account_id: string; security_id: string; symbol: string;
      type: string; date: string; quantity: number; price: number;
    }>;

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.account_id}:${row.security_id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    const closedTrades: ClosedTrade[] = [];

    for (const txns of groups.values()) {
      const buyQueue: Array<{ date: string; price: number; remaining: number }> = [];

      for (const txn of txns) {
        if (txn.type === 'transfer_in' && txn.price === 0) {
          // Stock split: adjust all existing buy lots
          const existingQty = buyQueue.reduce((s, l) => s + l.remaining, 0);
          if (existingQty > 0) {
            const ratio = (existingQty + txn.quantity) / existingQty;
            // Only apply if ratio looks like a split (>= 1.5 and roughly a whole number)
            const roundedRatio = Math.round(ratio);
            if (roundedRatio >= 2 && Math.abs(ratio - roundedRatio) < 0.15) {
              for (const lot of buyQueue) {
                lot.price /= roundedRatio;
                lot.remaining *= roundedRatio;
              }
            }
          }
          continue;
        }
        if (txn.type === 'buy') {
          buyQueue.push({ date: txn.date, price: txn.price, remaining: txn.quantity });
        } else if (txn.type === 'sell') {
          let sellRemaining = txn.quantity;
          while (sellRemaining > 0 && buyQueue.length > 0) {
            const lot = buyQueue[0];
            const matched = Math.min(sellRemaining, lot.remaining);

            const costBasis = matched * lot.price;
            const proceeds = matched * txn.price;
            const realizedGain = proceeds - costBasis;
            const buyDate = new Date(lot.date);
            const sellDate = new Date(txn.date);
            const holdDays = Math.max(0, Math.round((sellDate.getTime() - buyDate.getTime()) / 86400000));

            closedTrades.push({
              symbol: txn.symbol,
              securityId: txn.security_id,
              accountId: txn.account_id,
              buyDate: lot.date,
              sellDate: txn.date,
              quantity: matched,
              buyPrice: lot.price,
              sellPrice: txn.price,
              costBasis,
              proceeds,
              realizedGain,
              realizedGainPct: costBasis > 0 ? (realizedGain / costBasis) * 100 : 0,
              holdDays,
              holdBucket: holdDays < 30 ? 'short' : holdDays < 90 ? 'medium' : 'long',
              isWin: realizedGain > 0,
            });

            lot.remaining -= matched;
            sellRemaining -= matched;
            if (lot.remaining <= 0) buyQueue.shift();
          }
        }
      }
    }

    return closedTrades;
  }

  // Pre-trade behavioral checks

  /** Returns the most recent sell date for a symbol across all accounts, or null */
  getLastSellDate(symbol: string): string | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(`
      SELECT MAX(t.date) as last_sell
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE s.symbol = ? AND t.type = 'sell'
    `).get(symbol) as { last_sell: string | null } | undefined;
    return row?.last_sell || null;
  }

  /** Returns the count of sell transactions for a symbol in the current calendar month */
  getSellCountThisMonth(symbol: string): number {
    if (!this.db) throw new Error('Database not initialized');
    const monthStart = new Date().toISOString().slice(0, 7) + '-01'; // YYYY-MM-01
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE s.symbol = ? AND t.type = 'sell' AND t.date >= ?
    `).get(symbol, monthStart) as { cnt: number };
    return row.cnt;
  }

  /** Returns the most recent buy date for a symbol (to detect rapid flips on sells) */
  getLastBuyDate(symbol: string): string | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(`
      SELECT MAX(t.date) as last_buy
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE s.symbol = ? AND t.type = 'buy'
    `).get(symbol) as { last_buy: string | null } | undefined;
    return row?.last_buy || null;
  }

  /** Returns the earliest buy date for a symbol (for hold duration checks) */
  getFirstBuyDate(symbol: string): string | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(`
      SELECT MIN(t.date) as first_buy
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE s.symbol = ? AND t.type IN ('buy', 'Buy')
    `).get(symbol) as { first_buy: string | null } | undefined;
    return row?.first_buy || null;
  }

  /** Returns the count of sell transactions for a symbol in the last N days (proxy for round-trips) */
  getRoundTripCount(symbol: string, days: number): number {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      WHERE s.symbol = ? AND t.type IN ('sell', 'Sell')
      AND t.date >= date('now', '-' || ? || ' days')
    `).get(symbol, days) as { cnt: number };
    return row.cnt;
  }

  // Post-mortem operations

  createPostMortem(data: {
    securityId: string;
    closeDate: string;
    originalIntent: string;
    tier?: string;
    entryThesis?: string;
    whatHappened: string;
    ruleAdherence?: string;
    errorType: string;
    thesisQuality: string;
    executionQuality: string;
    outcome: string;
    lessonLearned: string;
    realizedGain?: number;
    holdDays?: number;
  }): PostMortem {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO post_mortems (id, security_id, close_date, original_intent, tier, entry_thesis, what_happened, rule_adherence, error_type, thesis_quality, execution_quality, outcome, lesson_learned, realized_gain, hold_days, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.securityId, data.closeDate, data.originalIntent,
      data.tier || null, data.entryThesis || null, data.whatHappened,
      data.ruleAdherence || null, data.errorType, data.thesisQuality, data.executionQuality, data.outcome,
      data.lessonLearned, data.realizedGain ?? 0, data.holdDays ?? 0, now, now);
    return this.getPostMortem(id)!;
  }

  getPostMortem(id: string): PostMortem | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(`
      SELECT pm.*, s.symbol FROM post_mortems pm
      JOIN securities s ON pm.security_id = s.id
      WHERE pm.id = ?
    `).get(id);
    return row ? this.mapRowToPostMortem(row) : null;
  }

  listPostMortems(opts?: { symbol?: string; outcome?: string; limit?: number }): PostMortem[] {
    if (!this.db) throw new Error('Database not initialized');
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.symbol) {
      conditions.push('s.symbol = ?');
      params.push(opts.symbol.toUpperCase());
    }
    if (opts?.outcome) {
      conditions.push('pm.outcome = ?');
      params.push(opts.outcome);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = opts?.limit ? 'LIMIT ?' : '';
    if (opts?.limit) params.push(opts.limit);

    return this.db.prepare(`
      SELECT pm.*, s.symbol FROM post_mortems pm
      JOIN securities s ON pm.security_id = s.id
      ${where}
      ORDER BY pm.close_date DESC
      ${limitClause}
    `).all(...params).map(this.mapRowToPostMortem);
  }

  updatePostMortem(id: string, data: Partial<Omit<PostMortem, 'id' | 'symbol' | 'createdAt' | 'updatedAt'>>): PostMortem {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (data.securityId !== undefined) { fields.push('security_id = ?'); values.push(data.securityId); }
    if (data.closeDate !== undefined) { fields.push('close_date = ?'); values.push(data.closeDate); }
    if (data.originalIntent !== undefined) { fields.push('original_intent = ?'); values.push(data.originalIntent); }
    if (data.tier !== undefined) { fields.push('tier = ?'); values.push(data.tier); }
    if (data.entryThesis !== undefined) { fields.push('entry_thesis = ?'); values.push(data.entryThesis); }
    if (data.whatHappened !== undefined) { fields.push('what_happened = ?'); values.push(data.whatHappened); }
    if (data.ruleAdherence !== undefined) { fields.push('rule_adherence = ?'); values.push(data.ruleAdherence); }
    if (data.errorType !== undefined) { fields.push('error_type = ?'); values.push(data.errorType); }
    if (data.thesisQuality !== undefined) { fields.push('thesis_quality = ?'); values.push(data.thesisQuality); }
    if (data.executionQuality !== undefined) { fields.push('execution_quality = ?'); values.push(data.executionQuality); }
    if (data.outcome !== undefined) { fields.push('outcome = ?'); values.push(data.outcome); }
    if (data.lessonLearned !== undefined) { fields.push('lesson_learned = ?'); values.push(data.lessonLearned); }
    if (data.realizedGain !== undefined) { fields.push('realized_gain = ?'); values.push(data.realizedGain); }
    if (data.holdDays !== undefined) { fields.push('hold_days = ?'); values.push(data.holdDays); }

    values.push(id);
    this.db.prepare(`UPDATE post_mortems SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getPostMortem(id)!;
  }

  deletePostMortem(id: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare('DELETE FROM post_mortems WHERE id = ?').run(id);
  }

  private mapRowToPostMortem = (row: unknown): PostMortem => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      securityId: r.security_id as string,
      symbol: r.symbol as string,
      closeDate: r.close_date as string,
      originalIntent: r.original_intent as string,
      tier: r.tier as string,
      entryThesis: r.entry_thesis as string,
      whatHappened: r.what_happened as string,
      ruleAdherence: r.rule_adherence as string,
      errorType: r.error_type as string,
      thesisQuality: r.thesis_quality as string,
      executionQuality: r.execution_quality as string,
      outcome: r.outcome as string,
      lessonLearned: r.lesson_learned as string,
      realizedGain: r.realized_gain as number,
      holdDays: r.hold_days as number,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  // Earnings review operations

  createEarningsReview(data: {
    securityId: string;
    quarter: string;
    earningsDate: string;
    revenueExpected?: number | null;
    revenueActual?: number | null;
    epsExpected?: number | null;
    epsActual?: number | null;
    revenueGrowthPct?: number | null;
    epsGrowthPct?: number | null;
    growthTrajectory?: string | null;
    thesisImpact: string;
    invalidationTriggered?: boolean;
    decision?: string | null;
    decisionDeadline?: string | null;
    decisionNotes?: string | null;
  }): EarningsReview {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO earnings_reviews (id, security_id, quarter, earnings_date, revenue_expected, revenue_actual, eps_expected, eps_actual, revenue_growth_pct, eps_growth_pct, growth_trajectory, thesis_impact, invalidation_triggered, decision, decision_deadline, decision_notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.securityId, data.quarter, data.earningsDate,
      data.revenueExpected ?? null, data.revenueActual ?? null,
      data.epsExpected ?? null, data.epsActual ?? null,
      data.revenueGrowthPct ?? null, data.epsGrowthPct ?? null,
      data.growthTrajectory ?? null, data.thesisImpact,
      data.invalidationTriggered ? 1 : 0,
      data.decision ?? null, data.decisionDeadline ?? null,
      data.decisionNotes ?? null, now, now);
    return this.getEarningsReview(id)!;
  }

  getEarningsReview(id: string): EarningsReview | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(`
      SELECT er.*, s.symbol FROM earnings_reviews er
      JOIN securities s ON er.security_id = s.id
      WHERE er.id = ?
    `).get(id);
    return row ? this.mapRowToEarningsReview(row) : null;
  }

  listEarningsReviews(opts?: { symbol?: string; pending?: boolean; limit?: number }): EarningsReview[] {
    if (!this.db) throw new Error('Database not initialized');
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.symbol) {
      conditions.push('s.symbol = ?');
      params.push(opts.symbol.toUpperCase());
    }
    if (opts?.pending) {
      conditions.push('er.decision IS NULL');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = opts?.limit ? 'LIMIT ?' : '';
    if (opts?.limit) params.push(opts.limit);

    return this.db.prepare(`
      SELECT er.*, s.symbol FROM earnings_reviews er
      JOIN securities s ON er.security_id = s.id
      ${where}
      ORDER BY er.earnings_date DESC
      ${limitClause}
    `).all(...params).map(this.mapRowToEarningsReview);
  }

  updateEarningsReview(id: string, data: Partial<Omit<EarningsReview, 'id' | 'symbol' | 'createdAt' | 'updatedAt'>>): EarningsReview {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (data.securityId !== undefined) { fields.push('security_id = ?'); values.push(data.securityId); }
    if (data.quarter !== undefined) { fields.push('quarter = ?'); values.push(data.quarter); }
    if (data.earningsDate !== undefined) { fields.push('earnings_date = ?'); values.push(data.earningsDate); }
    if (data.revenueExpected !== undefined) { fields.push('revenue_expected = ?'); values.push(data.revenueExpected); }
    if (data.revenueActual !== undefined) { fields.push('revenue_actual = ?'); values.push(data.revenueActual); }
    if (data.epsExpected !== undefined) { fields.push('eps_expected = ?'); values.push(data.epsExpected); }
    if (data.epsActual !== undefined) { fields.push('eps_actual = ?'); values.push(data.epsActual); }
    if (data.revenueGrowthPct !== undefined) { fields.push('revenue_growth_pct = ?'); values.push(data.revenueGrowthPct); }
    if (data.epsGrowthPct !== undefined) { fields.push('eps_growth_pct = ?'); values.push(data.epsGrowthPct); }
    if (data.growthTrajectory !== undefined) { fields.push('growth_trajectory = ?'); values.push(data.growthTrajectory); }
    if (data.thesisImpact !== undefined) { fields.push('thesis_impact = ?'); values.push(data.thesisImpact); }
    if (data.invalidationTriggered !== undefined) { fields.push('invalidation_triggered = ?'); values.push(data.invalidationTriggered ? 1 : 0); }
    if (data.decision !== undefined) { fields.push('decision = ?'); values.push(data.decision); }
    if (data.decisionDeadline !== undefined) { fields.push('decision_deadline = ?'); values.push(data.decisionDeadline); }
    if (data.decisionNotes !== undefined) { fields.push('decision_notes = ?'); values.push(data.decisionNotes); }

    values.push(id);
    this.db.prepare(`UPDATE earnings_reviews SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getEarningsReview(id)!;
  }

  getPendingEarningsReviews(): EarningsReview[] {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(`
      SELECT er.*, s.symbol FROM earnings_reviews er
      JOIN securities s ON er.security_id = s.id
      WHERE er.decision IS NULL
      ORDER BY er.decision_deadline ASC
    `).all().map(this.mapRowToEarningsReview);
  }

  private mapRowToEarningsReview = (row: unknown): EarningsReview => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      securityId: r.security_id as string,
      symbol: r.symbol as string,
      quarter: r.quarter as string,
      earningsDate: r.earnings_date as string,
      revenueExpected: r.revenue_expected as number | null,
      revenueActual: r.revenue_actual as number | null,
      epsExpected: r.eps_expected as number | null,
      epsActual: r.eps_actual as number | null,
      revenueGrowthPct: r.revenue_growth_pct as number | null,
      epsGrowthPct: r.eps_growth_pct as number | null,
      growthTrajectory: r.growth_trajectory as string | null,
      thesisImpact: r.thesis_impact as string,
      invalidationTriggered: (r.invalidation_triggered as number) === 1,
      decision: r.decision as string | null,
      decisionDeadline: r.decision_deadline as string | null,
      decisionNotes: r.decision_notes as string | null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  // === Broker Realized P&L ===

  importBrokerPL(records: BrokerPLRecord[]): number {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO realized_pl_broker
        (id, symbol, account_name, open_date, close_date, quantity, cost_basis,
         proceeds, gain_loss, gain_loss_pct, term, source_file, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let imported = 0;
    const insertMany = this.db.transaction((recs: BrokerPLRecord[]) => {
      for (const r of recs) {
        const result = stmt.run(
          r.id, r.symbol, r.accountName, r.openDate, r.closeDate,
          r.quantity, r.costBasis, r.proceeds, r.gainLoss, r.gainLossPct,
          r.term, r.sourceFile, r.importedAt
        );
        if (result.changes > 0) imported++;
      }
    });
    insertMany(records);
    return imported;
  }

  getBrokerPLBySymbol(symbol: string): BrokerPLRecord[] {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(`
      SELECT * FROM realized_pl_broker WHERE symbol = ? ORDER BY close_date
    `).all(symbol).map(this.mapRowToBrokerPL);
  }

  getBrokerPLSummary(): Array<{ symbol: string; totalGainLoss: number; lotCount: number; lastCloseDate: string }> {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(`
      SELECT symbol, SUM(gain_loss) as total_gain_loss, COUNT(*) as lot_count,
             MAX(close_date) as last_close_date
      FROM realized_pl_broker
      GROUP BY symbol ORDER BY SUM(gain_loss)
    `).all().map((row: unknown) => {
      const r = row as Record<string, unknown>;
      return {
        symbol: r.symbol as string,
        totalGainLoss: r.total_gain_loss as number,
        lotCount: r.lot_count as number,
        lastCloseDate: r.last_close_date as string,
      };
    });
  }

  private mapRowToBrokerPL = (row: unknown): BrokerPLRecord => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      symbol: r.symbol as string,
      accountName: r.account_name as string | null,
      openDate: r.open_date as string | null,
      closeDate: r.close_date as string | null,
      quantity: r.quantity as number | null,
      costBasis: r.cost_basis as number | null,
      proceeds: r.proceeds as number | null,
      gainLoss: r.gain_loss as number | null,
      gainLossPct: r.gain_loss_pct as number | null,
      term: r.term as string | null,
      sourceFile: r.source_file as string | null,
      importedAt: r.imported_at as string,
    };
  };

  // Entry plan operations

  createEntryPlan(data: {
    securityId: string;
    targetAllocationPct?: number;
    notes?: string;
    tranches: Array<{
      trancheNumber: number;
      triggerPrice: number;
      shares: number;
      notes?: string;
    }>;
  }): EntryPlan {
    if (!this.db) throw new Error('Database not initialized');
    const planId = uuidv4();
    const now = new Date().toISOString();

    // Get symbol for monitor labels
    const security = this.db.prepare('SELECT symbol FROM securities WHERE id = ?').get(data.securityId) as { symbol: string } | undefined;
    const symbol = security?.symbol || 'UNKNOWN';

    this.db.prepare(`
      INSERT INTO entry_plans (id, security_id, target_allocation_pct, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)
    `).run(planId, data.securityId, data.targetAllocationPct ?? null, data.notes || null, now, now);

    for (const tranche of data.tranches) {
      const trancheId = uuidv4();

      // Auto-create monitor for the tranche
      const monitor = this.createMonitor({
        symbol,
        direction: 'below',
        priceLevel: tranche.triggerPrice,
        label: `Entry plan tranche ${tranche.trancheNumber}: buy ${tranche.shares} shares at $${tranche.triggerPrice.toFixed(2)}`,
        actionType: 'action_required',
      });

      this.db.prepare(`
        INSERT INTO entry_plan_tranches (id, plan_id, tranche_number, trigger_price, shares, status, monitor_id, notes)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(trancheId, planId, tranche.trancheNumber, tranche.triggerPrice, tranche.shares, monitor.id, tranche.notes || null);
    }

    return this.getEntryPlan(planId)!;
  }

  getEntryPlan(id: string): EntryPlan | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(`
      SELECT ep.*, s.symbol FROM entry_plans ep
      JOIN securities s ON ep.security_id = s.id
      WHERE ep.id = ?
    `).get(id);
    if (!row) return null;
    const plan = this.mapRowToEntryPlan(row);
    plan.tranches = this.db.prepare(
      'SELECT * FROM entry_plan_tranches WHERE plan_id = ? ORDER BY tranche_number'
    ).all(id).map(this.mapRowToEntryPlanTranche);
    return plan;
  }

  getEntryPlanBySymbol(symbol: string): EntryPlan | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(`
      SELECT ep.*, s.symbol FROM entry_plans ep
      JOIN securities s ON ep.security_id = s.id
      WHERE s.symbol = ? AND ep.status = 'active'
      ORDER BY ep.created_at DESC LIMIT 1
    `).get(symbol.toUpperCase());
    if (!row) return null;
    const plan = this.mapRowToEntryPlan(row);
    plan.tranches = this.db.prepare(
      'SELECT * FROM entry_plan_tranches WHERE plan_id = ? ORDER BY tranche_number'
    ).all(plan.id).map(this.mapRowToEntryPlanTranche);
    return plan;
  }

  listEntryPlans(opts?: { status?: string; symbol?: string }): EntryPlan[] {
    if (!this.db) throw new Error('Database not initialized');
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.status) {
      conditions.push('ep.status = ?');
      params.push(opts.status);
    }
    if (opts?.symbol) {
      conditions.push('s.symbol = ?');
      params.push(opts.symbol.toUpperCase());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const plans = this.db.prepare(`
      SELECT ep.*, s.symbol FROM entry_plans ep
      JOIN securities s ON ep.security_id = s.id
      ${where}
      ORDER BY ep.created_at DESC
    `).all(...params).map(this.mapRowToEntryPlan);

    // Attach tranches to each plan
    for (const plan of plans) {
      plan.tranches = this.db!.prepare(
        'SELECT * FROM entry_plan_tranches WHERE plan_id = ? ORDER BY tranche_number'
      ).all(plan.id).map(this.mapRowToEntryPlanTranche);
    }

    return plans;
  }

  updateEntryPlan(id: string, data: Partial<Pick<EntryPlan, 'targetAllocationPct' | 'status' | 'notes'>>): EntryPlan {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (data.targetAllocationPct !== undefined) { fields.push('target_allocation_pct = ?'); values.push(data.targetAllocationPct); }
    if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
    if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }

    values.push(id);
    this.db.prepare(`UPDATE entry_plans SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getEntryPlan(id)!;
  }

  updateTranche(id: string, data: Partial<Pick<EntryPlanTranche, 'status' | 'filledAt' | 'filledPrice' | 'notes'>>): EntryPlanTranche {
    if (!this.db) throw new Error('Database not initialized');
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
    if (data.filledAt !== undefined) { fields.push('filled_at = ?'); values.push(data.filledAt); }
    if (data.filledPrice !== undefined) { fields.push('filled_price = ?'); values.push(data.filledPrice); }
    if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }

    if (fields.length === 0) {
      const row = this.db.prepare('SELECT * FROM entry_plan_tranches WHERE id = ?').get(id);
      return this.mapRowToEntryPlanTranche(row);
    }

    values.push(id);
    this.db.prepare(`UPDATE entry_plan_tranches SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const row = this.db.prepare('SELECT * FROM entry_plan_tranches WHERE id = ?').get(id);
    return this.mapRowToEntryPlanTranche(row);
  }

  cancelEntryPlan(id: string): EntryPlan {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();

    // Cancel all pending tranches and dismiss their monitors
    const tranches = this.db.prepare(
      "SELECT * FROM entry_plan_tranches WHERE plan_id = ? AND status = 'pending'"
    ).all(id).map(this.mapRowToEntryPlanTranche);

    for (const tranche of tranches) {
      this.db.prepare("UPDATE entry_plan_tranches SET status = 'cancelled' WHERE id = ?").run(tranche.id);
      if (tranche.monitorId) {
        try {
          this.updateMonitorStatus(tranche.monitorId, 'dismissed');
        } catch {
          // Monitor may already be dismissed/deleted
        }
      }
    }

    // Cancel the plan
    this.db.prepare("UPDATE entry_plans SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, id);
    return this.getEntryPlan(id)!;
  }

  private mapRowToEntryPlan = (row: unknown): EntryPlan => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      securityId: r.security_id as string,
      symbol: r.symbol as string | undefined,
      targetAllocationPct: r.target_allocation_pct as number | null,
      status: r.status as string,
      notes: r.notes as string | null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  private mapRowToEntryPlanTranche = (row: unknown): EntryPlanTranche => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      planId: r.plan_id as string,
      trancheNumber: r.tranche_number as number,
      triggerPrice: r.trigger_price as number,
      shares: r.shares as number,
      status: r.status as string,
      monitorId: r.monitor_id as string | null,
      filledAt: r.filled_at as string | null,
      filledPrice: r.filled_price as number | null,
      notes: r.notes as string | null,
    };
  };

  getRawDb(): BetterSqlite3.Database {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }
}
