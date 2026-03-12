import { useEffect, useState, useCallback } from 'react';
import { useSchwab, useAccounts, usePreTradeCheck } from '../hooks/useApi';
import type { SchwabOrderRequest, SchwabOrder } from '../../shared/types';

type OrderFormData = {
  accountNumber: string;
  symbol: string;
  instruction: 'BUY' | 'SELL';
  quantity: string;
  orderType: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  price: string;
  stopPrice: string;
  duration: 'DAY' | 'GTC' | 'FILL_OR_KILL';
};

const initialFormData: OrderFormData = {
  accountNumber: '',
  symbol: '',
  instruction: 'BUY',
  quantity: '',
  orderType: 'MARKET',
  price: '',
  stopPrice: '',
  duration: 'DAY',
};

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'WORKING', label: 'Working' },
  { value: 'FILLED', label: 'Filled' },
  { value: 'CANCELED', label: 'Canceled' },
];

function getStatusBadge(status: string) {
  switch (status) {
    case 'FILLED':
      return 'bg-green-100 text-green-700';
    case 'WORKING':
    case 'QUEUED':
      return 'bg-blue-100 text-blue-700';
    case 'CANCELED':
    case 'EXPIRED':
      return 'bg-gray-100 text-gray-600';
    case 'REJECTED':
      return 'bg-red-100 text-red-700';
    case 'PENDING_ACTIVATION':
      return 'bg-yellow-100 text-yellow-700';
    default:
      return 'bg-gray-100 text-gray-600';
  }
}

function isCancelable(status: string) {
  return ['WORKING', 'QUEUED', 'PENDING_ACTIVATION'].includes(status);
}

export default function Orders() {
  const { orders, loading, error, fetchStatus, fetchOrders, placeOrder, cancelOrder } = useSchwab();
  const { accounts, fetchAccounts } = useAccounts();
  const [form, setForm] = useState<OrderFormData>(initialFormData);
  const [statusFilter, setStatusFilter] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const { checkResult, loading: checkLoading, evaluate, record, reset } = usePreTradeCheck();
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());

  const schwabAccounts = accounts.filter(a => a.broker === 'Schwab');

  useEffect(() => {
    fetchAccounts();
    fetchStatus();
    fetchOrders();
  }, [fetchAccounts, fetchStatus, fetchOrders]);

  const handleFilterChange = useCallback((filter: string) => {
    setStatusFilter(filter);
    fetchOrders(filter || undefined);
  }, [fetchOrders]);

  const handleFormChange = (field: keyof OrderFormData, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const showsPrice = form.orderType === 'LIMIT' || form.orderType === 'STOP_LIMIT';
  const showsStopPrice = form.orderType === 'STOP' || form.orderType === 'STOP_LIMIT';

  const isFormValid = () => {
    if (!form.accountNumber || !form.symbol.trim() || !form.quantity || Number(form.quantity) <= 0) return false;
    if (showsPrice && (!form.price || Number(form.price) <= 0)) return false;
    if (showsStopPrice && (!form.stopPrice || Number(form.stopPrice) <= 0)) return false;
    return true;
  };

  const handleReview = async () => {
    if (!isFormValid()) return;
    setAcknowledged(new Set());
    await evaluate({
      symbol: form.symbol.toUpperCase().trim(),
      instruction: form.instruction,
      quantity: Number(form.quantity),
      accountNumber: form.accountNumber,
      price: showsPrice ? Number(form.price) : showsStopPrice ? Number(form.stopPrice) : undefined,
    });
  };

  const handleChecklistProceed = async () => {
    if (!checkResult) return;
    const failedOrWarn = checkResult.items.filter(i => i.status !== 'pass');
    const overrides = failedOrWarn.map(i => i.id);
    const account = schwabAccounts.find(a => a.accountNumber === form.accountNumber);
    await record({
      orderSymbol: form.symbol.toUpperCase().trim(),
      orderSide: form.instruction,
      orderQty: Number(form.quantity),
      accountId: account?.id || form.accountNumber,
      book: checkResult.book,
      items: checkResult.items,
      overrides,
      passed: true,
    });
    reset();
    setShowConfirm(true);
  };

  const handleChecklistCancel = async () => {
    if (checkResult) {
      const account = schwabAccounts.find(a => a.accountNumber === form.accountNumber);
      await record({
        orderSymbol: form.symbol.toUpperCase().trim(),
        orderSide: form.instruction,
        orderQty: Number(form.quantity),
        accountId: account?.id || form.accountNumber,
        book: checkResult.book,
        items: checkResult.items,
        overrides: [],
        passed: false,
      });
    }
    reset();
  };

  const toggleAck = (id: string) => {
    setAcknowledged(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allAcknowledged = checkResult
    ? checkResult.items.every(i => i.status === 'pass' || acknowledged.has(i.id))
    : false;

  const handleConfirm = async () => {
    setSubmitting(true);
    setMessage(null);

    const order: SchwabOrderRequest = {
      accountNumber: form.accountNumber,
      symbol: form.symbol.toUpperCase().trim(),
      instruction: form.instruction,
      quantity: Number(form.quantity),
      orderType: form.orderType,
      duration: form.duration,
    };

    if (showsPrice) order.price = Number(form.price);
    if (showsStopPrice) order.stopPrice = Number(form.stopPrice);

    const result = await placeOrder(order);
    setSubmitting(false);
    setShowConfirm(false);

    if (result.success) {
      setMessage({ type: 'success', text: result.message + (result.orderId ? ` (ID: ${result.orderId})` : '') });
      setForm(initialFormData);
      fetchOrders(statusFilter || undefined);
    } else {
      setMessage({ type: 'error', text: result.message });
    }
  };

  const handleCancel = async (order: SchwabOrder) => {
    if (!confirm(`Cancel order ${order.orderId} for ${order.quantity} ${order.symbol}?`)) return;
    const result = await cancelOrder(order.accountNumber, order.orderId);
    if (result.success) {
      setMessage({ type: 'success', text: 'Order canceled' });
      fetchOrders(statusFilter || undefined);
    } else {
      setMessage({ type: 'error', text: result.message });
    }
  };

  const formatTime = (iso: string) => {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const formatPrice = (price?: number) => {
    if (price == null) return '-';
    return `$${price.toFixed(2)}`;
  };

  const getAccountLabel = (accountNumber: string) => {
    const acct = schwabAccounts.find(a => a.accountNumber === accountNumber);
    return acct ? acct.name : accountNumber;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
          <p className="text-sm text-gray-500 mt-1">Place and manage Schwab orders</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">{error}</div>
      )}

      {message && (
        <div className={`border rounded-lg p-4 text-sm ${message.type === 'success' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
          {message.text}
        </div>
      )}

      {/* Place Order Form */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Place Order</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Account */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Account</label>
            <select
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              value={form.accountNumber}
              onChange={e => handleFormChange('accountNumber', e.target.value)}
            >
              <option value="">Select account...</option>
              {schwabAccounts.map(a => (
                <option key={a.accountNumber} value={a.accountNumber!}>{a.name} ({a.accountNumber?.slice(-4)})</option>
              ))}
            </select>
          </div>

          {/* Symbol */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Symbol</label>
            <input
              type="text"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm uppercase"
              placeholder="AAPL"
              value={form.symbol}
              onChange={e => handleFormChange('symbol', e.target.value)}
            />
          </div>

          {/* Buy/Sell */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Side</label>
            <div className="flex gap-1">
              <button
                className={`flex-1 px-3 py-2 text-sm font-medium rounded-md border ${form.instruction === 'BUY' ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
                onClick={() => handleFormChange('instruction', 'BUY')}
              >
                Buy
              </button>
              <button
                className={`flex-1 px-3 py-2 text-sm font-medium rounded-md border ${form.instruction === 'SELL' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
                onClick={() => handleFormChange('instruction', 'SELL')}
              >
                Sell
              </button>
            </div>
          </div>

          {/* Quantity */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
            <input
              type="number"
              min="1"
              step="1"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="100"
              value={form.quantity}
              onChange={e => handleFormChange('quantity', e.target.value)}
            />
          </div>

          {/* Order Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Order Type</label>
            <select
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              value={form.orderType}
              onChange={e => handleFormChange('orderType', e.target.value)}
            >
              <option value="MARKET">Market</option>
              <option value="LIMIT">Limit</option>
              <option value="STOP">Stop</option>
              <option value="STOP_LIMIT">Stop Limit</option>
            </select>
          </div>

          {/* Price (Limit / Stop Limit) */}
          {showsPrice && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Limit Price</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                placeholder="150.00"
                value={form.price}
                onChange={e => handleFormChange('price', e.target.value)}
              />
            </div>
          )}

          {/* Stop Price (Stop / Stop Limit) */}
          {showsStopPrice && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Stop Price</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                placeholder="145.00"
                value={form.stopPrice}
                onChange={e => handleFormChange('stopPrice', e.target.value)}
              />
            </div>
          )}

          {/* Duration */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Duration</label>
            <select
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              value={form.duration}
              onChange={e => handleFormChange('duration', e.target.value)}
            >
              <option value="DAY">Day</option>
              <option value="GTC">GTC</option>
              <option value="FILL_OR_KILL">Fill or Kill</option>
            </select>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleReview}
            disabled={!isFormValid() || loading}
          >
            Review Order
          </button>
        </div>
      </div>

      {/* Pre-Trade Checklist */}
      {checkResult && !showConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 mx-4">
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Pre-Trade Checklist</h2>
            <p className="text-sm text-gray-500 mb-4">
              {checkResult.book} book — {form.instruction} {form.quantity} {form.symbol.toUpperCase()}
            </p>

            <div className="space-y-2 mb-6">
              {checkResult.items.map(item => (
                <div
                  key={item.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border ${
                    item.status === 'pass' ? 'bg-green-50 border-green-200' :
                    item.status === 'warn' ? 'bg-amber-50 border-amber-200' :
                    'bg-red-50 border-red-200'
                  }`}
                >
                  {item.status === 'pass' ? (
                    <span className="text-green-600 mt-0.5 flex-shrink-0">&#10003;</span>
                  ) : (
                    <input
                      type="checkbox"
                      checked={acknowledged.has(item.id)}
                      onChange={() => toggleAck(item.id)}
                      className="mt-1 flex-shrink-0 rounded border-gray-300"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${
                      item.status === 'pass' ? 'text-green-800' :
                      item.status === 'warn' ? 'text-amber-800' :
                      'text-red-800'
                    }`}>
                      {item.label}
                    </p>
                    {item.detail && (
                      <p className="text-xs text-gray-500 mt-0.5">{item.detail}</p>
                    )}
                    {item.type === 'manual' && item.status !== 'pass' && (
                      <p className="text-xs text-gray-400 mt-0.5 italic">Acknowledge to proceed</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={handleChecklistCancel}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleChecklistProceed}
                disabled={!allAcknowledged}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                Proceed to Order
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Dialog */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Confirm Order</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Account</span>
                <span className="font-medium">{getAccountLabel(form.accountNumber)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Action</span>
                <span className={`font-medium ${form.instruction === 'BUY' ? 'text-green-700' : 'text-red-700'}`}>
                  {form.instruction} {form.quantity} {form.symbol.toUpperCase()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Order Type</span>
                <span className="font-medium">{form.orderType.replace('_', ' ')}</span>
              </div>
              {showsPrice && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Limit Price</span>
                  <span className="font-medium">${Number(form.price).toFixed(2)}</span>
                </div>
              )}
              {showsStopPrice && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Stop Price</span>
                  <span className="font-medium">${Number(form.stopPrice).toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-500">Duration</span>
                <span className="font-medium">{form.duration === 'FILL_OR_KILL' ? 'Fill or Kill' : form.duration}</span>
              </div>
            </div>

            <div className="mt-6 flex gap-3 justify-end">
              <button
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                onClick={() => setShowConfirm(false)}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50"
                onClick={handleConfirm}
                disabled={submitting}
              >
                {submitting ? 'Placing...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Orders Table */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Order History</h2>
          <div className="flex items-center gap-3">
            <select
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              value={statusFilter}
              onChange={e => handleFilterChange(e.target.value)}
            >
              {STATUS_FILTERS.map(f => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
            <button
              className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
              onClick={() => fetchOrders(statusFilter || undefined)}
              disabled={loading}
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Time</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Account</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Symbol</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Side</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Qty</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Filled</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Type</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Price</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Duration</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Action</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-gray-400">
                    {loading ? 'Loading orders...' : 'No orders found'}
                  </td>
                </tr>
              ) : (
                orders.map(order => (
                  <tr key={order.orderId} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-600">{formatTime(order.enteredTime)}</td>
                    <td className="px-4 py-3">{getAccountLabel(order.accountNumber)}</td>
                    <td className="px-4 py-3 font-medium">{order.symbol}</td>
                    <td className="px-4 py-3">
                      <span className={order.instruction === 'BUY' ? 'text-green-700' : 'text-red-700'}>
                        {order.instruction}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">{order.quantity}</td>
                    <td className="px-4 py-3 text-right">{order.filledQuantity}</td>
                    <td className="px-4 py-3">{order.orderType.replace('_', ' ')}</td>
                    <td className="px-4 py-3 text-right">{formatPrice(order.price)}</td>
                    <td className="px-4 py-3">{order.duration}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${getStatusBadge(order.status)}`}>
                        {order.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {isCancelable(order.status) && (
                        <button
                          className="text-xs text-red-600 hover:text-red-800 font-medium"
                          onClick={() => handleCancel(order)}
                          disabled={loading}
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
