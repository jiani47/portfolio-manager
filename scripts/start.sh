#!/bin/bash
# Start the Portfolio Manager Electron app in dev mode
# Launches Vite dev server + Electron concurrently

set -e

cd "$(dirname "$0")/.."

echo "Building main process..."
npm run build:main

echo "Starting dev server + Electron..."
npm run dev
