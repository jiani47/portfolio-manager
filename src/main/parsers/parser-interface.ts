import { BrokerageParserInfo, BrokerageParseResult } from '../../shared/types';

export interface BrokerageParser {
  getInfo(): BrokerageParserInfo;
  canParse(filePath: string, content: string): boolean;
  parse(filePath: string): Promise<BrokerageParseResult>;
}
