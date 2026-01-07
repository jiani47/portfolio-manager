import * as fs from 'fs';
import * as path from 'path';
import { BackupConfig, BackupResult, BackupInfo } from '../shared/types';

export class BackupService {
  private dbPath: string;
  private backupDir: string;
  private config: BackupConfig | null = null;

  constructor(dbPath: string, userDataPath: string) {
    this.dbPath = dbPath;
    this.backupDir = path.join(userDataPath, 'backups');

    // Ensure backup directory exists
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  configure(config: BackupConfig): void {
    this.config = config;
  }

  async createBackup(): Promise<BackupResult> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `portfolio-backup-${timestamp}.db`;
    const backupPath = path.join(this.backupDir, backupFilename);

    try {
      // Copy the database file
      fs.copyFileSync(this.dbPath, backupPath);

      const stats = fs.statSync(backupPath);

      // If cloud backup is configured, upload to cloud
      if (this.config?.provider && this.config.provider !== 'local') {
        await this.uploadToCloud(backupPath);
      }

      return {
        success: true,
        path: backupPath,
        timestamp: new Date().toISOString(),
        size: stats.size,
      };
    } catch (error) {
      console.error('Backup error:', error);
      return {
        success: false,
        path: '',
        timestamp: new Date().toISOString(),
        size: 0,
      };
    }
  }

  async restoreBackup(backupPath: string): Promise<boolean> {
    try {
      // Validate the backup file exists
      if (!fs.existsSync(backupPath)) {
        throw new Error('Backup file not found');
      }

      // Create a backup of current database before restoring
      const tempBackup = this.dbPath + '.temp';
      fs.copyFileSync(this.dbPath, tempBackup);

      try {
        // Restore the backup
        fs.copyFileSync(backupPath, this.dbPath);
        // Remove temp backup on success
        fs.unlinkSync(tempBackup);
        return true;
      } catch (restoreError) {
        // Restore the temp backup if restore failed
        fs.copyFileSync(tempBackup, this.dbPath);
        fs.unlinkSync(tempBackup);
        throw restoreError;
      }
    } catch (error) {
      console.error('Restore error:', error);
      return false;
    }
  }

  listBackups(): BackupInfo[] {
    try {
      const files = fs.readdirSync(this.backupDir);
      return files
        .filter(f => f.startsWith('portfolio-backup-') && f.endsWith('.db'))
        .map(f => {
          const filePath = path.join(this.backupDir, f);
          const stats = fs.statSync(filePath);
          return {
            path: filePath,
            timestamp: stats.mtime.toISOString(),
            size: stats.size,
          };
        })
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    } catch (error) {
      console.error('List backups error:', error);
      return [];
    }
  }

  private async uploadToCloud(localPath: string): Promise<void> {
    if (!this.config) return;

    switch (this.config.provider) {
      case 'google_drive':
        await this.uploadToGoogleDrive(localPath);
        break;
      case 'dropbox':
        await this.uploadToDropbox(localPath);
        break;
      case 's3':
        await this.uploadToS3(localPath);
        break;
      case 'onedrive':
        await this.uploadToOneDrive(localPath);
        break;
    }
  }

  private async uploadToGoogleDrive(localPath: string): Promise<void> {
    // Google Drive integration
    // Requires OAuth2 credentials to be configured
    // This is a placeholder - actual implementation would use Google Drive API
    console.log('Google Drive upload not yet implemented:', localPath);

    // Example implementation would:
    // 1. Initialize Google Drive API client with credentials
    // 2. Create or find the backup folder
    // 3. Upload the file
    // 4. Return the file ID for reference
  }

  private async uploadToDropbox(localPath: string): Promise<void> {
    // Dropbox integration
    // Requires access token to be configured
    console.log('Dropbox upload not yet implemented:', localPath);

    // Example implementation would:
    // 1. Initialize Dropbox API client with access token
    // 2. Upload file to configured path
    // 3. Handle chunked upload for large files
  }

  private async uploadToS3(localPath: string): Promise<void> {
    // AWS S3 integration
    // Requires AWS credentials (access key, secret key, bucket, region)
    console.log('S3 upload not yet implemented:', localPath);

    // Example implementation would:
    // 1. Initialize AWS S3 client with credentials
    // 2. Upload file to configured bucket/path
    // 3. Use multipart upload for large files
  }

  private async uploadToOneDrive(localPath: string): Promise<void> {
    // OneDrive integration
    // Requires Microsoft Graph API credentials
    console.log('OneDrive upload not yet implemented:', localPath);

    // Example implementation would:
    // 1. Initialize Microsoft Graph client with credentials
    // 2. Upload file to configured folder
    // 3. Handle resumable upload for large files
  }

  getBackupDir(): string {
    return this.backupDir;
  }
}
