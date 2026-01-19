export { BrokerageParser } from './parser-interface';
export { parserRegistry } from './parser-registry';
export { schwabParser } from './schwab-parser';

// Register all parsers
import { parserRegistry } from './parser-registry';
import { schwabParser } from './schwab-parser';

parserRegistry.register(schwabParser);
