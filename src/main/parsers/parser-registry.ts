import { BrokerageParser, TransactionParser } from './parser-interface';
import { BrokerageParserInfo, TransactionParserInfo } from '../../shared/types';

class ParserRegistry {
  private parsers: Map<string, BrokerageParser> = new Map();

  register(parser: BrokerageParser): void {
    const info = parser.getInfo();
    this.parsers.set(info.id, parser);
  }

  getParser(id: string): BrokerageParser | undefined {
    return this.parsers.get(id);
  }

  listParsers(): BrokerageParserInfo[] {
    return Array.from(this.parsers.values()).map(p => p.getInfo());
  }
}

class TransactionParserRegistry {
  private parsers: Map<string, TransactionParser> = new Map();

  register(parser: TransactionParser): void {
    const info = parser.getInfo();
    this.parsers.set(info.id, parser);
  }

  getParser(id: string): TransactionParser | undefined {
    return this.parsers.get(id);
  }

  listParsers(): TransactionParserInfo[] {
    return Array.from(this.parsers.values()).map(p => p.getInfo());
  }
}

export const parserRegistry = new ParserRegistry();
export const transactionParserRegistry = new TransactionParserRegistry();
