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

    // Seed default security tags if they don't exist
    const existingTags = this.db.prepare('SELECT COUNT(*) as count FROM security_tags').get() as { count: number };
    if (existingTags.count === 0) {
      const now = new Date().toISOString();
      this.db.exec(`
        INSERT INTO security_tags (id, name, display_name, color, description, is_system, created_at) VALUES
          ('tag-core', 'core', 'Core', 'blue', 'Long-term, high conviction positions', 1, '${now}'),
          ('tag-satellite', 'satellite', 'Satellite', 'purple', 'Tactical positions for diversification', 1, '${now}'),
          ('tag-event-macro', 'event_macro', 'Event/Macro', 'orange', 'Event-driven or macro plays', 1, '${now}')
      `);
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

  upsertPositionIntent(positionId: string, data: Partial<PositionIntent>): PositionIntent {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    const existing = this.getPositionIntent(positionId);

    if (existing) {
      const fields: string[] = ['updated_at = ?'];
      const values: unknown[] = [now];

      if (data.tier !== undefined) { fields.push('tier = ?'); values.push(data.tier || null); }
      if (data.thesis !== undefined) { fields.push('thesis = ?'); values.push(data.thesis || null); }
      if (data.invalidation !== undefined) { fields.push('invalidation = ?'); values.push(data.invalidation || null); }
      if (data.entryStyle !== undefined) { fields.push('entry_style = ?'); values.push(data.entryStyle || null); }
      if (data.targetHoldPeriod !== undefined) { fields.push('target_hold_period = ?'); values.push(data.targetHoldPeriod || null); }

      values.push(existing.id);
      const stmt = this.db.prepare(`UPDATE position_intents SET ${fields.join(', ')} WHERE id = ?`);
      stmt.run(...values);
      return this.getPositionIntent(positionId)!;
    } else {
      const id = uuidv4();
      const stmt = this.db.prepare(`
        INSERT INTO position_intents (id, position_id, tier, thesis, invalidation, entry_style, target_hold_period, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        positionId,
        data.tier || null,
        data.thesis || null,
        data.invalidation || null,
        data.entryStyle || null,
        data.targetHoldPeriod || null,
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
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  };

  // Row mappers
  private mapRowToAccount = (row: unknown): Account => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      name: r.name as string,
      broker: r.broker as string,
      accountNumber: r.account_number as string | undefined,
      accountType: r.account_type as Account['accountType'],
      book: r.book as Account['book'] | undefined,
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
}
