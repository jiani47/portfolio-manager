import { useState, useEffect, useRef, useCallback } from 'react';
import type { StreamingQuote, StreamingStatus } from '../../shared/types';

export function useStreamingQuotes(symbols: string[]) {
  const [quotes, setQuotes] = useState<Map<string, StreamingQuote>>(new Map());
  const [status, setStatus] = useState<StreamingStatus>('disconnected');
  const symbolsRef = useRef(symbols);

  // Keep symbols ref current
  symbolsRef.current = symbols;

  useEffect(() => {
    const removeQuoteListener = window.electronAPI.onStreamingQuote((quote: StreamingQuote) => {
      setQuotes(prev => {
        const next = new Map(prev);
        next.set(quote.symbol, quote);
        return next;
      });
    });

    const removeStatusListener = window.electronAPI.onStreamingStatus((newStatus: string) => {
      setStatus(newStatus as StreamingStatus);
    });

    // Get initial status and bootstrap quotes (covers race where main sent quotes before renderer mounted)
    window.electronAPI.streamingGetStatus().then(state => {
      setStatus(state.status);
    });
    window.electronAPI.streamingGetQuotes().then((initialQuotes: StreamingQuote[]) => {
      if (initialQuotes.length > 0) {
        setQuotes(prev => {
          const next = new Map(prev);
          for (const q of initialQuotes) {
            if (!next.has(q.symbol)) {
              next.set(q.symbol, q);
            }
          }
          return next;
        });
      }
    });

    return () => {
      removeQuoteListener();
      removeStatusListener();
    };
  }, []);

  // Update subscription when symbols change and stream is connected
  const prevSymbolsKey = useRef('');
  useEffect(() => {
    const key = symbols.sort().join(',');
    if (key === prevSymbolsKey.current) return;
    prevSymbolsKey.current = key;

    if (symbols.length > 0 && status === 'connected') {
      window.electronAPI.streamingUpdateSymbols(symbols);
    }
  }, [symbols, status]);

  return { quotes, status };
}
