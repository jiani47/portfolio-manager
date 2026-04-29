import { useState, useEffect, useRef } from 'react';

interface SymbolAutocompleteProps {
  value: string;
  onChange: (symbol: string) => void;
  placeholder?: string;
  positions?: string[]; // Position symbols
  watchlist?: string[]; // Watchlist symbols
}

export default function SymbolAutocomplete({
  value,
  onChange,
  placeholder = 'Search symbol...',
  positions = [],
  watchlist = [],
}: SymbolAutocompleteProps) {
  const [inputValue, setInputValue] = useState(value);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter and group symbols
  const filteredSymbols = (() => {
    const query = inputValue.toUpperCase();
    if (!query) {
      // Show positions and watchlist when empty
      return {
        positions: positions.slice(0, 5),
        watchlist: watchlist.slice(0, 5),
        other: [] as string[],
      };
    }

    const matchedPositions = positions.filter(s => s.includes(query));
    const matchedWatchlist = watchlist.filter(s => s.includes(query) && !positions.includes(s));

    return {
      positions: matchedPositions,
      watchlist: matchedWatchlist,
      other: [], // Could add external search here
    };
  })();

  const allOptions = [
    ...filteredSymbols.positions.map(s => ({ symbol: s, type: 'position' as const })),
    ...filteredSymbols.watchlist.map(s => ({ symbol: s, type: 'watchlist' as const })),
    ...filteredSymbols.other.map(s => ({ symbol: s, type: 'other' as const })),
  ];

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Sync input value with prop
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setIsOpen(true);
    setHighlightedIndex(0);
  };

  const handleSelect = (symbol: string) => {
    setInputValue(symbol);
    onChange(symbol);
    setIsOpen(false);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen && e.key !== 'Escape') {
      setIsOpen(true);
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(prev => (prev + 1) % allOptions.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(prev => (prev - 1 + allOptions.length) % allOptions.length);
        break;
      case 'Enter':
        e.preventDefault();
        if (allOptions[highlightedIndex]) {
          handleSelect(allOptions[highlightedIndex].symbol);
        } else if (inputValue.trim()) {
          handleSelect(inputValue.trim().toUpperCase());
        }
        break;
      case 'Escape':
        setIsOpen(false);
        inputRef.current?.blur();
        break;
    }
  };

  const getTypeIcon = (type: 'position' | 'watchlist' | 'other') => {
    if (type === 'position') return '💼';
    if (type === 'watchlist') return '👁';
    return '🔍';
  };

  const getTypeLabel = (type: 'position' | 'watchlist' | 'other') => {
    if (type === 'position') return 'Position';
    if (type === 'watchlist') return 'Watchlist';
    return '';
  };

  return (
    <div ref={wrapperRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={handleInputChange}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
      />

      {isOpen && allOptions.length > 0 && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {allOptions.map((option, idx) => (
            <button
              key={`${option.type}-${option.symbol}`}
              onClick={() => handleSelect(option.symbol)}
              onMouseEnter={() => setHighlightedIndex(idx)}
              className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between hover:bg-gray-50 transition-colors ${
                idx === highlightedIndex ? 'bg-primary-50' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span>{getTypeIcon(option.type)}</span>
                <span className="font-mono font-semibold">{option.symbol}</span>
              </div>
              <span className="text-xs text-gray-500">{getTypeLabel(option.type)}</span>
            </button>
          ))}
        </div>
      )}

      {isOpen && inputValue && allOptions.length === 0 && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg">
          <button
            onClick={() => handleSelect(inputValue.trim().toUpperCase())}
            className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span>🔍</span>
              <span className="font-mono font-semibold">{inputValue.toUpperCase()}</span>
              <span className="text-xs text-gray-500">(Search any symbol)</span>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
