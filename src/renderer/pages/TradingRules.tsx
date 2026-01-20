import { useEffect, useState, useMemo } from 'react';
import { useTradingRules, useSecurities } from '../hooks/useApi';
import type { TradingRule, RuleType, ConditionType, ConditionOperator, ActionType, Security } from '../../shared/types';

const RULE_TYPES: { value: RuleType; label: string; color: string }[] = [
  { value: 'add', label: 'Add', color: 'text-green-700 bg-green-100' },
  { value: 'trim', label: 'Trim', color: 'text-yellow-700 bg-yellow-100' },
  { value: 'exit', label: 'Exit', color: 'text-red-700 bg-red-100' },
  { value: 'hold', label: 'Hold', color: 'text-blue-700 bg-blue-100' },
];

const CONDITION_TYPES: { value: ConditionType; label: string; unit: string }[] = [
  { value: 'price_drop_pct', label: 'Price Drop', unit: '%' },
  { value: 'position_size_pct', label: 'Position Size', unit: '% of portfolio' },
  { value: 'loss_pct', label: 'Loss', unit: '%' },
  { value: 'holding_period_days', label: 'Holding Period', unit: 'days' },
];

const CONDITION_OPERATORS: { value: ConditionOperator; label: string; symbol: string }[] = [
  { value: 'gte', label: 'Greater than or equal', symbol: '>=' },
  { value: 'gt', label: 'Greater than', symbol: '>' },
  { value: 'lte', label: 'Less than or equal', symbol: '<=' },
  { value: 'lt', label: 'Less than', symbol: '<' },
  { value: 'eq', label: 'Equal to', symbol: '=' },
];

const ACTION_TYPES: { value: ActionType; label: string }[] = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
  { value: 'alert', label: 'Alert Only' },
];

type FormData = {
  name: string;
  description: string;
  securityId: string;
  ruleType: RuleType;
  conditionType: ConditionType;
  conditionOperator: ConditionOperator;
  conditionValue: string;
  actionType: ActionType;
  actionValue: string;
  priority: string;
};

const initialFormData: FormData = {
  name: '',
  description: '',
  securityId: '',
  ruleType: 'add',
  conditionType: 'price_drop_pct',
  conditionOperator: 'gte',
  conditionValue: '',
  actionType: 'alert',
  actionValue: '',
  priority: '0',
};

export default function TradingRules() {
  const { rules, loading, error, fetchRules, createRule, updateRule, deleteRule, toggleRule } = useTradingRules();
  const { securities, fetchSecurities } = useSecurities();
  const [showModal, setShowModal] = useState(false);
  const [editingRule, setEditingRule] = useState<TradingRule | null>(null);
  const [filterRuleType, setFilterRuleType] = useState<RuleType | ''>('');
  const [filterEnabled, setFilterEnabled] = useState<boolean | ''>('');
  const [formData, setFormData] = useState<FormData>(initialFormData);

  useEffect(() => {
    fetchRules();
    fetchSecurities();
  }, [fetchRules, fetchSecurities]);

  const securityMap = useMemo(() => new Map(securities.map(s => [s.id, s])), [securities]);

  const filteredRules = useMemo(() => {
    let filtered = rules;
    if (filterRuleType) {
      filtered = filtered.filter(r => r.ruleType === filterRuleType);
    }
    if (filterEnabled !== '') {
      filtered = filtered.filter(r => r.isEnabled === filterEnabled);
    }
    return filtered;
  }, [rules, filterRuleType, filterEnabled]);

  const handleOpenModal = (rule?: TradingRule) => {
    if (rule) {
      setEditingRule(rule);
      setFormData({
        name: rule.name,
        description: rule.description || '',
        securityId: rule.securityId || '',
        ruleType: rule.ruleType,
        conditionType: rule.conditionType,
        conditionOperator: rule.conditionOperator,
        conditionValue: rule.conditionValue.toString(),
        actionType: rule.actionType,
        actionValue: rule.actionValue?.toString() || '',
        priority: rule.priority.toString(),
      });
    } else {
      setEditingRule(null);
      setFormData(initialFormData);
    }
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingRule(null);
    setFormData(initialFormData);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const ruleData = {
        name: formData.name,
        description: formData.description || undefined,
        securityId: formData.securityId || undefined,
        ruleType: formData.ruleType,
        conditionType: formData.conditionType,
        conditionOperator: formData.conditionOperator,
        conditionValue: parseFloat(formData.conditionValue),
        actionType: formData.actionType,
        actionValue: formData.actionValue ? parseFloat(formData.actionValue) : undefined,
        isEnabled: true,
        priority: parseInt(formData.priority, 10),
      };

      if (editingRule) {
        await updateRule(editingRule.id, ruleData);
      } else {
        await createRule(ruleData);
      }
      handleCloseModal();
    } catch (err) {
      console.error('Failed to save rule:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this rule?')) {
      try {
        await deleteRule(id);
      } catch (err) {
        console.error('Failed to delete rule:', err);
      }
    }
  };

  const handleToggle = async (rule: TradingRule) => {
    try {
      await toggleRule(rule.id, !rule.isEnabled);
    } catch (err) {
      console.error('Failed to toggle rule:', err);
    }
  };

  const formatCondition = (rule: TradingRule) => {
    const conditionType = CONDITION_TYPES.find(c => c.value === rule.conditionType);
    const operator = CONDITION_OPERATORS.find(o => o.value === rule.conditionOperator);
    return `${conditionType?.label || rule.conditionType} ${operator?.symbol || rule.conditionOperator} ${rule.conditionValue}${conditionType?.unit || ''}`;
  };

  const formatAction = (rule: TradingRule) => {
    const actionType = ACTION_TYPES.find(a => a.value === rule.actionType);
    if (rule.actionValue) {
      return `${actionType?.label || rule.actionType} ${rule.actionValue}%`;
    }
    return actionType?.label || rule.actionType;
  };

  const getRuleTypeStyle = (ruleType: RuleType) => {
    const type = RULE_TYPES.find(t => t.value === ruleType);
    return type?.color || 'text-gray-700 bg-gray-100';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Trading Rules</h1>
          <p className="text-sm text-gray-500 mt-1">Define conditions for adding, trimming, or exiting positions</p>
        </div>
        <div className="flex gap-3">
          <select
            className="select w-32"
            value={filterRuleType}
            onChange={(e) => setFilterRuleType(e.target.value as RuleType | '')}
          >
            <option value="">All Types</option>
            {RULE_TYPES.map(type => (
              <option key={type.value} value={type.value}>{type.label}</option>
            ))}
          </select>
          <select
            className="select w-32"
            value={filterEnabled === '' ? '' : filterEnabled.toString()}
            onChange={(e) => setFilterEnabled(e.target.value === '' ? '' : e.target.value === 'true')}
          >
            <option value="">All Status</option>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
          <button onClick={() => handleOpenModal()} className="btn-primary">
            Add Rule
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">Loading...</div>
        </div>
      ) : filteredRules.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500">No trading rules defined.</p>
          <p className="text-sm text-gray-400 mt-1">Create rules to automate your trading decisions.</p>
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="table-header">Name</th>
                <th className="table-header">Type</th>
                <th className="table-header">Security</th>
                <th className="table-header">Condition</th>
                <th className="table-header">Action</th>
                <th className="table-header text-center">Enabled</th>
                <th className="table-header text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredRules.map((rule) => {
                const security = rule.securityId ? securityMap.get(rule.securityId) : null;
                return (
                  <tr key={rule.id} className={`hover:bg-gray-50 ${!rule.isEnabled ? 'opacity-50' : ''}`}>
                    <td className="table-cell">
                      <div className="font-medium text-gray-900">{rule.name}</div>
                      {rule.description && (
                        <div className="text-xs text-gray-500 mt-0.5">{rule.description}</div>
                      )}
                    </td>
                    <td className="table-cell">
                      <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${getRuleTypeStyle(rule.ruleType)}`}>
                        {RULE_TYPES.find(t => t.value === rule.ruleType)?.label || rule.ruleType}
                      </span>
                    </td>
                    <td className="table-cell text-gray-500">
                      {security ? security.symbol : 'All Securities'}
                    </td>
                    <td className="table-cell text-gray-700">
                      {formatCondition(rule)}
                    </td>
                    <td className="table-cell text-gray-700">
                      {formatAction(rule)}
                    </td>
                    <td className="table-cell text-center">
                      <button
                        onClick={() => handleToggle(rule)}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                          rule.isEnabled ? 'bg-primary-600' : 'bg-gray-200'
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                            rule.isEnabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </td>
                    <td className="table-cell text-right">
                      <button onClick={() => handleOpenModal(rule)} className="text-primary-600 hover:text-primary-700 mr-3">
                        Edit
                      </button>
                      <button onClick={() => handleDelete(rule.id)} className="text-red-600 hover:text-red-700">
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              {editingRule ? 'Edit Rule' : 'Create Rule'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">Name</label>
                <input
                  type="text"
                  className="input"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., Add on 10% dip"
                  required
                />
              </div>

              <div>
                <label className="label">Description (optional)</label>
                <textarea
                  className="input"
                  rows={2}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Describe when and why this rule should trigger"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Rule Type</label>
                  <select
                    className="select"
                    value={formData.ruleType}
                    onChange={(e) => setFormData({ ...formData, ruleType: e.target.value as RuleType })}
                  >
                    {RULE_TYPES.map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Security (optional)</label>
                  <select
                    className="select"
                    value={formData.securityId}
                    onChange={(e) => setFormData({ ...formData, securityId: e.target.value })}
                  >
                    <option value="">All Securities (Global)</option>
                    {securities.filter(s => s.type !== 'cash').map(security => (
                      <option key={security.id} value={security.id}>{security.symbol}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="p-4 bg-gray-50 rounded-lg space-y-3">
                <div className="text-sm font-medium text-gray-700">Condition</div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="label text-xs">Type</label>
                    <select
                      className="select text-sm"
                      value={formData.conditionType}
                      onChange={(e) => setFormData({ ...formData, conditionType: e.target.value as ConditionType })}
                    >
                      {CONDITION_TYPES.map(type => (
                        <option key={type.value} value={type.value}>{type.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label text-xs">Operator</label>
                    <select
                      className="select text-sm"
                      value={formData.conditionOperator}
                      onChange={(e) => setFormData({ ...formData, conditionOperator: e.target.value as ConditionOperator })}
                    >
                      {CONDITION_OPERATORS.map(op => (
                        <option key={op.value} value={op.value}>{op.symbol} {op.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label text-xs">
                      Value ({CONDITION_TYPES.find(c => c.value === formData.conditionType)?.unit || ''})
                    </label>
                    <input
                      type="number"
                      step="any"
                      className="input text-sm"
                      value={formData.conditionValue}
                      onChange={(e) => setFormData({ ...formData, conditionValue: e.target.value })}
                      required
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Action</label>
                  <select
                    className="select"
                    value={formData.actionType}
                    onChange={(e) => setFormData({ ...formData, actionType: e.target.value as ActionType })}
                  >
                    {ACTION_TYPES.map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Action Value (% of position, optional)</label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    max="100"
                    className="input"
                    value={formData.actionValue}
                    onChange={(e) => setFormData({ ...formData, actionValue: e.target.value })}
                    placeholder="e.g., 25 for 25%"
                  />
                </div>
              </div>

              <div>
                <label className="label">Priority (higher = evaluated first)</label>
                <input
                  type="number"
                  className="input w-24"
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                />
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <button type="button" onClick={handleCloseModal} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  {editingRule ? 'Save Changes' : 'Create Rule'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
