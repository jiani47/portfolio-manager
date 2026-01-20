import { IpcMain, dialog } from 'electron';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import Store from 'electron-store';
import { Database } from './database';
import { BackupService } from './backup-service';
import { AIService } from './ai-service';
import { parserRegistry, transactionParserRegistry, lotDetailsParserRegistry } from './parsers';
import { AppSettings, ExcelImportResult } from '../shared/types';

export function setupIpcHandlers(
  ipcMain: IpcMain,
  db: Database,
  backupService: BackupService,
  aiService: AIService,
  store: Store<{ settings: AppSettings }>
): void {
  // Account handlers
  ipcMain.handle('db:accounts:list', () => db.listAccounts());
  ipcMain.handle('db:accounts:create', (_, account) => db.createAccount(account));
  ipcMain.handle('db:accounts:update', (_, id, account) => db.updateAccount(id, account));
  ipcMain.handle('db:accounts:delete', (_, id) => db.deleteAccount(id));

  // Security handlers
  ipcMain.handle('db:securities:list', () => db.listSecurities());
  ipcMain.handle('db:securities:create', (_, security) => db.createSecurity(security));
  ipcMain.handle('db:securities:findBySymbol', (_, symbol) => db.findSecurityBySymbol(symbol));

  // Position handlers
  ipcMain.handle('db:positions:list', (_, accountId) => db.listPositions(accountId));
  ipcMain.handle('db:positions:create', (_, position) => db.createPosition(position));
  ipcMain.handle('db:positions:update', (_, id, position) => db.updatePosition(id, position));
  ipcMain.handle('db:positions:delete', (_, id) => db.deletePosition(id));

  // Transaction handlers
  ipcMain.handle('db:transactions:list', (_, filters) => db.listTransactions(filters));
  ipcMain.handle('db:transactions:create', (_, transaction) => db.createTransaction(transaction));
  ipcMain.handle('db:transactions:update', (_, id, transaction) => db.updateTransaction(id, transaction));
  ipcMain.handle('db:transactions:delete', (_, id) => db.deleteTransaction(id));
  ipcMain.handle('db:transactions:import', (_, transactions) => db.importTransactions(transactions));

  // Tax lot handlers
  ipcMain.handle('db:taxlots:list', (_, filters) => db.listTaxLots(filters));
  ipcMain.handle('db:taxlots:create', (_, taxLot) => db.createTaxLot(taxLot));
  ipcMain.handle('db:taxlots:update', (_, id, taxLot) => db.updateTaxLot(id, taxLot));
  ipcMain.handle('db:taxlots:delete', (_, id) => db.deleteTaxLot(id));
  ipcMain.handle('db:taxlots:deleteAll', (_, accountId) => db.deleteAllTaxLots(accountId));
  ipcMain.handle('db:taxlots:deleteBySymbol', (_, accountId, securityId) => db.deleteTaxLotsBySymbol(accountId, securityId));

  // Portfolio handlers
  ipcMain.handle('db:portfolio:summary', () => db.getPortfolioSummary());
  ipcMain.handle('db:portfolio:allocation', () => db.getAssetAllocation());

  // File import handler
  ipcMain.handle('file:import-excel', async (): Promise<ExcelImportResult | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Excel Files', extensions: ['xlsx', 'xls', 'csv'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    try {
      const filePath = result.filePaths[0];
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet);

      return {
        success: true,
        rowsImported: data.length,
        errors: [],
        data,
      };
    } catch (error) {
      return {
        success: false,
        rowsImported: 0,
        errors: [(error as Error).message],
        data: [],
      };
    }
  });

  // File export handler
  ipcMain.handle('file:export-data', async (_, data, filename) => {
    const result = await dialog.showSaveDialog({
      defaultPath: filename,
      filters: [
        { name: 'Excel Files', extensions: ['xlsx'] },
        { name: 'CSV Files', extensions: ['csv'] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return false;
    }

    try {
      const worksheet = XLSX.utils.json_to_sheet(data);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
      XLSX.writeFile(workbook, result.filePath);
      return true;
    } catch (error) {
      console.error('Export error:', error);
      return false;
    }
  });

  // Backup handlers
  ipcMain.handle('backup:create', async () => backupService.createBackup());
  ipcMain.handle('backup:restore', async (_, path) => backupService.restoreBackup(path));
  ipcMain.handle('backup:list', () => backupService.listBackups());
  ipcMain.handle('backup:configure', (_, config) => {
    const settings = store.get('settings');
    settings.backup = config;
    store.set('settings', settings);
    backupService.configure(config);
  });

  // Settings handlers
  ipcMain.handle('settings:get', () => store.get('settings'));
  ipcMain.handle('settings:update', (_, newSettings) => {
    const settings = store.get('settings');
    const updated = { ...settings, ...newSettings };
    store.set('settings', updated);

    // Update AI service if API settings changed
    if (newSettings.aiProvider || newSettings.aiApiKey) {
      aiService.configure(updated);
    }

    return updated;
  });

  // AI handlers
  ipcMain.handle('ai:generate-insights', async () => {
    const positions = db.listPositions();
    const transactions = db.listTransactions({ limit: 100 });
    const taxLots = db.listTaxLots();
    const securities = db.listSecurities();
    const accounts = db.listAccounts();

    return aiService.generateInsights({
      positions,
      transactions,
      taxLots,
      securities,
      accounts,
    });
  });

  ipcMain.handle('ai:analyze-portfolio', async () => {
    const positions = db.listPositions();
    const transactions = db.listTransactions({ limit: 100 });
    const summary = db.getPortfolioSummary();
    const allocation = db.getAssetAllocation();
    const securities = db.listSecurities();

    return aiService.analyzePortfolio({
      positions,
      transactions,
      summary,
      allocation,
      securities,
    });
  });

  // Brokerage import handlers
  ipcMain.handle('parsers:list', () => parserRegistry.listParsers());

  ipcMain.handle('file:select-brokerage-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'CSV Files', extensions: ['csv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle('file:select-brokerage-files', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'CSV Files', extensions: ['csv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }

    return result.filePaths;
  });

  ipcMain.handle('file:parse-brokerage', async (_, parserId: string, filePath: string) => {
    const parser = parserRegistry.getParser(parserId);
    if (!parser) {
      return {
        success: false,
        broker: parserId,
        accounts: [],
        errors: [`Parser not found: ${parserId}`],
      };
    }

    // Read file content for canParse check
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!parser.canParse(filePath, content)) {
      return {
        success: false,
        broker: parserId,
        accounts: [],
        errors: ['File format not recognized by this parser'],
      };
    }

    return parser.parse(filePath);
  });

  // Transaction import handlers
  ipcMain.handle('transaction-parsers:list', () => transactionParserRegistry.listParsers());

  ipcMain.handle('file:parse-transactions', async (_, parserId: string, filePath: string) => {
    const parser = transactionParserRegistry.getParser(parserId);
    if (!parser) {
      return {
        success: false,
        broker: parserId,
        accounts: [],
        errors: [`Transaction parser not found: ${parserId}`],
      };
    }

    // Read file content for canParse check
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!parser.canParse(filePath, content)) {
      return {
        success: false,
        broker: parserId,
        accounts: [],
        errors: ['File format not recognized by this parser'],
      };
    }

    return parser.parse(filePath);
  });

  // Lot details import handlers
  ipcMain.handle('lot-details-parsers:list', () => lotDetailsParserRegistry.listParsers());

  ipcMain.handle('file:parse-lot-details', async (_, parserId: string, filePath: string) => {
    const parser = lotDetailsParserRegistry.getParser(parserId);
    if (!parser) {
      return {
        success: false,
        broker: parserId,
        symbol: '',
        accountIdentifier: '',
        lots: [],
        errors: [`Lot details parser not found: ${parserId}`],
      };
    }

    // Read file content for canParse check
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!parser.canParse(filePath, content)) {
      return {
        success: false,
        broker: parserId,
        symbol: '',
        accountIdentifier: '',
        lots: [],
        errors: ['File format not recognized by this parser'],
      };
    }

    return parser.parse(filePath);
  });
}
