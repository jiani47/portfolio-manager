import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import PriceChart from './PriceChart';

interface Props {
  symbol: string;
  name?: string;
  onClose: () => void;
  onLevelsChanged?: () => void;
}

export default function ChartModal({ symbol, name, onClose, onLevelsChanged }: Props) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div
        className="relative bg-white rounded-lg shadow-xl flex flex-col"
        style={{ width: '85vw', height: '75vh', maxWidth: '1400px', maxHeight: '900px' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div>
            <span className="text-lg font-bold text-gray-900">{symbol}</span>
            {name && <span className="text-sm text-gray-500 ml-2">{name}</span>}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none px-2"
          >
            ×
          </button>
        </div>

        {/* Chart */}
        <div className="flex-1 p-4 min-h-0">
          <PriceChart symbol={symbol} onLevelsChanged={onLevelsChanged} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
