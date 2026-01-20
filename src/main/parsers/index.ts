export { BrokerageParser, TransactionParser } from './parser-interface';
export { parserRegistry, transactionParserRegistry, lotDetailsParserRegistry } from './parser-registry';
export { schwabParser } from './schwab-parser';
export { schwabRealizedGainsParser } from './schwab-realized-gains-parser';
export { schwabLotDetailsParser, LotDetailsParser } from './schwab-lot-details-parser';

// Register all parsers
import { parserRegistry, transactionParserRegistry, lotDetailsParserRegistry } from './parser-registry';
import { schwabParser } from './schwab-parser';
import { schwabRealizedGainsParser } from './schwab-realized-gains-parser';
import { schwabLotDetailsParser } from './schwab-lot-details-parser';

parserRegistry.register(schwabParser);
transactionParserRegistry.register(schwabRealizedGainsParser);
lotDetailsParserRegistry.register(schwabLotDetailsParser);
