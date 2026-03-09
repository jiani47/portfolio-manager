import { useEffect, useState } from 'react';
import { useDailyRituals, useIntentChangeLogs } from '../hooks/useApi';
import type { DailyRitual as DailyRitualType, PositionIntentChangeLog } from '../../shared/types';

export default function DailyRitual() {
  const { rituals, loading, fetchRituals } = useDailyRituals();
  const { logs: changeLogs, fetchLogsByDate } = useIntentChangeLogs();
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [todayRitual, setTodayRitual] = useState<DailyRitualType | null>(null);

  const today = new Date().toISOString().split('T')[0];

  useEffect(() => {
    fetchRituals(30);
  }, [fetchRituals]);

  useEffect(() => {
    const found = rituals.find(r => r.date === today);
    setTodayRitual(found || null);
  }, [rituals, today]);

  const handleExpand = (date: string) => {
    if (expandedDate === date) {
      setExpandedDate(null);
    } else {
      setExpandedDate(date);
      fetchLogsByDate(date);
    }
  };

  const getRitualCompleteness = (ritual: DailyRitualType) => {
    const fields = [ritual.regimeRewarding, ritual.regimePunishing, ritual.regimeType, ritual.actionChosen, ritual.journal];
    const filled = fields.filter(Boolean).length;
    return { filled, total: fields.length };
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Daily PM Ritual</h1>
        <p className="text-sm text-gray-500 mt-1">
          Run the ritual in conversation with Claude Code. This page shows history.
        </p>
      </div>

      {/* Today's Status */}
      <div className={`rounded-lg border p-6 ${todayRitual ? 'bg-white border-gray-200' : 'bg-gray-50 border-dashed border-gray-300'}`}>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Today ({today})</h2>
        {todayRitual ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <StatusBadge filled={!!todayRitual.regimeType} label="Regime" />
              <StatusBadge filled={!!todayRitual.actionChosen} label="Action" />
              <StatusBadge filled={!!todayRitual.journal} label="Journal" />
            </div>
            {todayRitual.regimeType && (
              <div className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
                todayRitual.regimeType === 'sorting' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
              }`}>
                {todayRitual.regimeType === 'sorting' ? 'Sorting Day' : 'Trend Day'}
              </div>
            )}
            {todayRitual.regimeRewarding && (
              <p className="text-sm text-gray-700"><span className="font-medium">Rewarding:</span> {todayRitual.regimeRewarding}</p>
            )}
            {todayRitual.regimePunishing && (
              <p className="text-sm text-gray-700"><span className="font-medium">Punishing:</span> {todayRitual.regimePunishing}</p>
            )}
            {todayRitual.actionChosen && (
              <p className="text-sm text-gray-700"><span className="font-medium">Action:</span> {todayRitual.actionChosen}{todayRitual.actionDetail ? ` — ${todayRitual.actionDetail}` : ''}</p>
            )}
            {todayRitual.journal && (
              <p className="text-sm text-gray-700 italic">"{todayRitual.journal}"</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500">Not started. Run <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">pm-cli.sh ritual-today</code> in Claude Code to begin.</p>
        )}
      </div>

      {/* History */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">History</h2>
        {loading ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : rituals.length === 0 ? (
          <p className="text-sm text-gray-500">No ritual history yet.</p>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Regime</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Action</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Journal</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {rituals.map(ritual => {
                  const { filled, total } = getRitualCompleteness(ritual);
                  const isExpanded = expandedDate === ritual.date;
                  return (
                    <tr key={ritual.id} className="cursor-pointer hover:bg-gray-50" onClick={() => handleExpand(ritual.date)}>
                      <td className="px-4 py-3 text-sm text-gray-900 whitespace-nowrap">{ritual.date}</td>
                      <td className="px-4 py-3 text-sm whitespace-nowrap">
                        {ritual.regimeType && (
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                            ritual.regimeType === 'sorting' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
                          }`}>
                            {ritual.regimeType}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                        {ritual.actionChosen || '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 max-w-xs truncate">
                        {ritual.journal || '—'}
                      </td>
                      <td className="px-4 py-3 text-sm whitespace-nowrap">
                        <span className={`text-xs ${filled === total ? 'text-green-600' : 'text-gray-400'}`}>
                          {filled}/{total}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Expanded detail */}
            {expandedDate && (
              <ExpandedRitualDetail
                ritual={rituals.find(r => r.date === expandedDate)!}
                changeLogs={changeLogs}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ filled, label }: { filled: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${
      filled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
    }`}>
      {filled ? '✓' : '○'} {label}
    </span>
  );
}

function ExpandedRitualDetail({ ritual, changeLogs }: { ritual: DailyRitualType; changeLogs: PositionIntentChangeLog[] }) {
  return (
    <div className="border-t border-gray-200 bg-gray-50 p-4 space-y-3">
      <h3 className="font-medium text-gray-900">Detail — {ritual.date}</h3>
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="font-medium text-gray-500">Rewarding:</span>
          <p className="text-gray-900">{ritual.regimeRewarding || '—'}</p>
        </div>
        <div>
          <span className="font-medium text-gray-500">Punishing:</span>
          <p className="text-gray-900">{ritual.regimePunishing || '—'}</p>
        </div>
        {ritual.regimeNotes && (
          <div className="col-span-2">
            <span className="font-medium text-gray-500">Notes:</span>
            <p className="text-gray-900">{ritual.regimeNotes}</p>
          </div>
        )}
        <div>
          <span className="font-medium text-gray-500">Action:</span>
          <p className="text-gray-900">{ritual.actionChosen || '—'}{ritual.actionDetail ? ` — ${ritual.actionDetail}` : ''}</p>
        </div>
        <div>
          <span className="font-medium text-gray-500">Journal:</span>
          <p className="text-gray-900 italic">{ritual.journal || '—'}</p>
        </div>
      </div>

      {changeLogs.length > 0 && (
        <div>
          <h4 className="font-medium text-gray-700 mt-2 mb-1">Intent Changes</h4>
          <div className="space-y-1">
            {changeLogs.map(log => (
              <div key={log.id} className="text-xs text-gray-600 bg-white rounded px-2 py-1 border border-gray-100">
                <span className="font-medium">{log.fieldChanged}</span>: {log.oldValue || '(none)'} → {log.newValue || '(none)'}
                {log.reason && <span className="text-gray-400 ml-2">({log.reason})</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
