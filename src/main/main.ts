import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import { Database } from './database';
import { setupIpcHandlers } from './ipc-handlers';
import { BackupService } from './backup-service';
import { AIService } from './ai-service';
import { FMPService } from './fmp-service';
import Store from 'electron-store';
import { AppSettings } from '../shared/types';

const store = new Store<{ settings: AppSettings }>();

let mainWindow: BrowserWindow | null = null;
let database: Database | null = null;
let backupService: BackupService | null = null;
let aiService: AIService | null = null;
let fmpService: FMPService | null = null;

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

  // Setup IPC handlers
  setupIpcHandlers(ipcMain, database, backupService, aiService, fmpService, store);
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
  database?.close();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  dialog.showErrorBox('Error', `An unexpected error occurred: ${error.message}`);
});
