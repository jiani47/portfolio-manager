import type { EarningsEvent } from '../../shared/types';

interface EarningsBadgeProps {
  symbol: string;
  earningsEvent?: EarningsEvent;
  onClick: () => void;
}

export default function EarningsBadge({ symbol, earningsEvent, onClick }: EarningsBadgeProps) {
  if (!earningsEvent) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const earningsDate = new Date(earningsEvent.date);
  earningsDate.setHours(0, 0, 0, 0);
  const daysUntil = Math.ceil((earningsDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  // Only show if earnings within next 30 days
  if (daysUntil < 0 || daysUntil > 30) return null;

  // Color coding based on urgency
  let bgColor = 'bg-blue-50';
  let textColor = 'text-blue-700';
  let borderColor = 'border-blue-200';

  if (daysUntil < 7) {
    bgColor = 'bg-red-50';
    textColor = 'text-red-700';
    borderColor = 'border-red-200';
  } else if (daysUntil < 14) {
    bgColor = 'bg-yellow-50';
    textColor = 'text-yellow-700';
    borderColor = 'border-yellow-200';
  }

  const timeLabel = earningsEvent.time === 'bmo' ? 'Before Market' :
                    earningsEvent.time === 'amc' ? 'After Market' :
                    earningsEvent.time === 'dmh' ? 'During Market' : '';

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${bgColor} ${textColor} ${borderColor} text-xs font-medium hover:opacity-80 transition-opacity`}
      title={`Earnings: ${earningsEvent.date}${timeLabel ? ` (${timeLabel})` : ''}`}
    >
      <span>📅</span>
      <span>{daysUntil}d</span>
    </button>
  );
}
