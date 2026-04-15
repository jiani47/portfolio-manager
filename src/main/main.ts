import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import { Database } from './database';
import { setupIpcHandlers } from './ipc-handlers';
import { BackupService } from './backup-service';
import { AIService } from './ai-service';
import { FMPService } from './fmp-service';
import { MassiveService } from './massive-service';
import { SchwabService } from './schwab-service';
import { SchwabStreamService } from './schwab-stream-service';
import { AnalyticsService } from './analytics-service';
import { SchedulerService } from './scheduler-service';
import { PreTradeValidator } from './pre-trade-validator';
import { TransactionAnalyticsService } from './transaction-analytics-service';
import Store from 'electron-store';
import { AppSettings } from '../shared/types';

const store = new Store<{ settings: AppSettings }>();

let mainWindow: BrowserWindow | null = null;
let database: Database | null = null;
let backupService: BackupService | null = null;
let aiService: AIService | null = null;
let fmpService: FMPService | null = null;
let massiveService: MassiveService | null = null;
let schwabService: SchwabService | null = null;
let streamService: SchwabStreamService | null = null;
let schedulerService: SchedulerService | null = null;

const defaultSettings: AppSettings = {
  theme: 'system',
  currency: 'USD',
  dateFormat: 'MM/dd/yyyy',
  backup: {
    provider: 'local',
    enabled: false,
    frequency: 'weekly',
  },
  aiProvider: 'none',
  dataProvider: 'none',
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: 'hiddenInset',
    show: false,
  });

  // Load the app
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function initializeApp() {
  // Initialize database
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'portfolio.db');
  database = new Database(dbPath);
  database.initialize();

  // Initialize settings
  if (!store.has('settings')) {
    store.set('settings', defaultSettings);
  }

  const settings = store.get('settings', defaultSettings);

  // Initialize backup service
  backupService = new BackupService(dbPath, userDataPath);

  // Initialize AI service
  aiService = new AIService(settings);

  // Initialize FMP service
  fmpService = new FMPService();
  fmpService.configure(settings);

  // Initialize Massive service
  massiveService = new MassiveService();
  await massiveService.configure(settings);

  // Initialize Schwab service
  schwabService = new SchwabService(store);
  schwabService.configure(settings);

  // Initialize streaming service
  streamService = new SchwabStreamService(schwabService, database, store, () => mainWindow);
  streamService.startMarketHoursScheduler();

  // Startup sync: refresh positions, transactions, and quotes immediately
  if (schwabService.isConnected()) {
    (async () => {
      try {
        console.log('Startup: syncing positions and quotes...');
        const result = await schwabService.syncPositions(database);
        if (result.success) {
          console.log(`Startup sync: ${result.positionsSynced} positions across ${result.accountsSynced} accounts`);
          // Notify renderer once window is ready
          setTimeout(() => {
            const win = mainWindow;
            if (win && !win.isDestroyed()) {
              win.webContents.send('positions:synced', {
                positionsSynced: result.positionsSynced,
                accountsSynced: result.accountsSynced,
              });
            }
          }, 3000);
        }
        // Sync recent transactions (last 7 days)
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        await schwabService.syncTransactions(database, weekAgo);
        console.log('Startup: transaction sync complete');
      } catch (err) {
        console.error('Startup sync error:', err);
      }
    })();
  }

  // Initialize analytics service
  const analyticsService = new AnalyticsService(database);

  // Initialize transaction analytics service
  const transactionAnalyticsService = new TransactionAnalyticsService(database);

  // Initialize pre-trade validator
  const preTradeValidator = new PreTradeValidator(database);

  // Initialize scheduler service
  schedulerService = new SchedulerService(database, fmpService, schwabService, store, () => mainWindow);
  schedulerService.start();

  // Setup IPC handlers
  setupIpcHandlers(ipcMain, database, backupService, aiService, fmpService, massiveService, schwabService, streamService, store, mainWindow, analyticsService, transactionAnalyticsService, schedulerService, preTradeValidator);
}

app.whenReady().then(async () => {
  await initializeApp();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  schedulerService?.destroy();
  streamService?.destroy();
  database?.close();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  dialog.showErrorBox('Error', `An unexpected error occurred: ${error.message}`);
});
