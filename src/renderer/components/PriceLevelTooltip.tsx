import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { PriceLevel } from '../../shared/types';

interface PriceLevelTooltipProps {
  children: React.ReactNode;
  symbol: string;
  currentPrice: number;
  levels: PriceLevel[];
}

const strengthColor = (s: number) =>
  s >= 8 ? 'text-green-700' : s >= 6 ? 'text-blue-700' : s >= 4 ? 'text-gray-600' : 'text-gray-400';

export default function PriceLevelTooltip({ children, symbol, currentPrice, levels }: PriceLevelTooltipProps) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);

  const symbolLevels = levels.filter(l => l.symbol === symbol);
  const resistance = symbolLevels
    .filter(l => l.levelType === 'resistance')
    .sort((a, b) => a.price - b.price);
  const support = symbolLevels
    .filter(l => l.levelType === 'support')
    .sort((a, b) => b.price - a.price);

  if (resistance.length === 0 && support.length === 0) {
    return <>{children}</>;
  }

  const nearestSupport = support[0];
  const nearestResistance = resistance[0];
  let rrText = '';
  let rrColor = 'text-gray-600';
  if (nearestSupport && nearestResistance) {
    const downside = currentPrice - nearestSupport.price;
    const upside = nearestResistance.price - currentPrice;
    const rr = downside > 0 ? upside / downside : Infinity;
    rrText = `R:R ${rr.toFixed(1)}x`;
    rrColor = rr >= 2 ? 'text-green-600' : rr < 1 ? 'text-red-600' : 'text-gray-600';
  }

  const handleEnter = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      // Position above the element if near bottom of viewport, otherwise below
      const tooltipHeight = 200; // approximate
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < tooltipHeight) {
        setPos({ top: rect.top + window.scrollY - tooltipHeight - 4, left: rect.right + window.scrollX });
      } else {
        setPos({ top: rect.bottom + window.scrollY + 4, left: rect.right + window.scrollX });
      }
    }
    setShow(true);
  };

  return (
    <>
      <span
        ref={triggerRef}
        className="cursor-help border-b border-dotted border-gray-300"
        onMouseEnter={handleEnter}
        onMouseLeave={() => setShow(false)}
      >
        {children}
      </span>
      {show && createPortal(
        <div
          className="fixed bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-left"
          style={{
            top: pos.top,
            left: pos.left,
            transform: 'translateX(-100%)',
            zIndex: 9999,
            width: 260,
          }}
          onMouseEnter={() => setShow(true)}
          onMouseLeave={() => setShow(false)}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-500 uppercase">S/R Levels</span>
            {rrText && (
              <span className={`text-xs font-medium ${rrColor}`}>{rrText}</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 mb-2">
            <div>
              <div className="text-[10px] font-medium text-red-400 uppercase mb-0.5">Resistance</div>
              {resistance.length > 0 ? resistance.map(l => (
                <div key={l.id} className="flex items-center justify-between text-xs py-0.5 gap-1">
                  <span className="text-red-600 font-mono">${l.price.toFixed(2)}</span>
                  <span className={`font-medium ${strengthColor(l.strength)}`}>{l.strength}/10</span>
                </div>
              )) : <span className="text-[10px] text-gray-300">--</span>}
            </div>
            <div>
              <div className="text-[10px] font-medium text-green-500 uppercase mb-0.5">Support</div>
              {support.length > 0 ? support.map(l => (
                <div key={l.id} className="flex items-center justify-between text-xs py-0.5 gap-1">
                  <span className="text-green-600 font-mono">${l.price.toFixed(2)}</span>
                  <span className={`font-medium ${strengthColor(l.strength)}`}>{l.strength}/10</span>
                </div>
              )) : <span className="text-[10px] text-gray-300">--</span>}
            </div>
          </div>

          <div className="flex items-center gap-1 py-1 border-t border-gray-100">
            <span className="text-xs font-medium text-gray-900">Current</span>
            <span className="text-xs font-mono text-gray-900 ml-auto">${currentPrice.toFixed(2)}</span>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
