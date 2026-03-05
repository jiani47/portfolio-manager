# Schwab API Setup

## Get Credentials

1. Register an app at [developer.schwab.com](https://developer.schwab.com)
2. Note your **Client ID** and **Client Secret**
3. Set the callback/redirect URL to `https://127.0.0.1:5556/callback`

## Configure in App

1. Go to **Settings** (sidebar)
2. Scroll to **Brokerage Connection**
3. Enter your Client ID, Client Secret, and Callback URL
4. Click **Save Settings**
5. Click **Connect to Schwab** — a browser window opens for OAuth authorization
6. Log in and authorize the app in the browser

## Usage

- **Settings > Sync Positions / Sync Transactions** — pull data from Schwab into the local database
- **Orders** page (sidebar) — place, view, and cancel equity orders via the Schwab Trader API
