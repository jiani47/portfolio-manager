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

  // Portfolio summary
  getPortfolioSummary(): PortfolioSummary {
    if (!this.db) throw new Error('Database not initialized');

    const positions = this.listPositions();
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

  getAssetAllocation(): AssetAllocation[] {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      SELECT s.type, SUM(p.market_value) as total_value
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      WHERE p.market_value > 0
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

  // Row mappers
  private mapRowToAccount = (row: unknown): Account => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      name: r.name as string,
      broker: r.broker as string,
      accountNumber: r.account_number as string | undefined,
      accountType: r.account_type as Account['accountType'],
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
}
