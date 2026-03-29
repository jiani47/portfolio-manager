/**
 * CLI entry point — dispatches commands to TypeScript modules.
 * Called via: tsx src/cli/index.ts <command> [args...]
 * Outputs JSON to stdout, errors to stderr.
 */
import Database from 'better-sqlite3';

const DB_PATH = process.env.PM_DB ||
  `${process.env.HOME}/Library/Application Support/portfolio-manager/portfolio.db`;

function openDb(): Database.Database {
  return new Database(DB_PATH, { readonly: true });
}

type CommandFn = (args: string[], db: Database.Database) => unknown;

const COMMANDS: Record<string, () => Promise<{ run: CommandFn }>> = {
  drift: () => import('./commands/drift'),
  size: () => import('./commands/size'),
  valuation: () => import('./commands/valuation'),
  confluence: () => import('./commands/confluence'),
  screen: () => import('./commands/screen'),
  'trade-stats': () => import('./commands/trade-stats'),
  scorecard: () => import('./commands/scorecard'),
  'levels-refresh': () => import('./commands/levels-refresh'),
  attribution: () => import('./commands/attribution'),
};

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  if (!command || command === '--help') {
    console.error(`Usage: tsx src/cli/index.ts <command> [args...]`);
    console.error(`Commands: ${Object.keys(COMMANDS).join(', ')}`);
    process.exit(1);
  }

  const loader = COMMANDS[command];
  if (!loader) {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }

  const db = openDb();
  try {
    const mod = await loader();
    const result = mod.run(args, db);
    console.log(JSON.stringify(result));
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
