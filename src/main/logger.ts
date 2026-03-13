const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = keyof typeof LEVELS;

// Parse from --log-level=debug or LOG_LEVEL=debug
function getLogLevel(): LogLevel {
  const args = process.argv.find(a => a.startsWith('--log-level='));
  if (args) {
    const val = args.split('=')[1] as LogLevel;
    if (val in LEVELS) return val;
  }
  const env = process.env.LOG_LEVEL as LogLevel | undefined;
  if (env && env in LEVELS) return env;
  return 'info';
}

const currentLevel = getLogLevel();

export const logger = {
  error: (...args: unknown[]) => console.error(...args),
  warn: (...args: unknown[]) => {
    if (LEVELS[currentLevel] >= LEVELS.warn) console.warn(...args);
  },
  info: (...args: unknown[]) => {
    if (LEVELS[currentLevel] >= LEVELS.info) console.log(...args);
  },
  debug: (...args: unknown[]) => {
    if (LEVELS[currentLevel] >= LEVELS.debug) console.log(...args);
  },
  level: currentLevel,
};
