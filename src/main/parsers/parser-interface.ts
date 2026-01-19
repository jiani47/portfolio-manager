import { BrokerageParserInfo, BrokerageParseResult, TransactionParserInfo, TransactionParseResult } from '../../shared/types';

export interface BrokerageParser {
  getInfo(): BrokerageParserInfo;
  canParse(filePath: string, content: string): boolean;
  parse(filePath: string): Promise<BrokerageParseResult>;
}

export interface TransactionParser {
  getInfo(): TransactionParserInfo;
  canParse(filePath: string, content: string): boolean;
  parse(filePath: string): Promise<TransactionParseResult>;
}
