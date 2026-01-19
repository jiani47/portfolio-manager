import { BrokerageParser } from './parser-interface';
import { BrokerageParserInfo } from '../../shared/types';

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

export const parserRegistry = new ParserRegistry();
