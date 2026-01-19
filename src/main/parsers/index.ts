export { BrokerageParser, TransactionParser } from './parser-interface';
export { parserRegistry, transactionParserRegistry } from './parser-registry';
export { schwabParser } from './schwab-parser';
export { schwabRealizedGainsParser } from './schwab-realized-gains-parser';

// Register all parsers
import { parserRegistry, transactionParserRegistry } from './parser-registry';
import { schwabParser } from './schwab-parser';
import { schwabRealizedGainsParser } from './schwab-realized-gains-parser';

parserRegistry.register(schwabParser);
transactionParserRegistry.register(schwabRealizedGainsParser);
