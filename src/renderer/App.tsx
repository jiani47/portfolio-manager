import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Accounts from './pages/Accounts';
import Holdings from './pages/Holdings';
import Transactions from './pages/Transactions';
import TaxLots from './pages/TaxLots';
import TradingRules from './pages/TradingRules';
import DecisionLogs from './pages/DecisionLogs';
import Orders from './pages/Orders';
import DailyRitual from './pages/DailyRitual';
import Settings from './pages/Settings';
import Import from './pages/Import';
import Watchlists from './pages/Watchlists';
import Monitors from './pages/Monitors';
import ActiveManagement from './pages/ActiveManagement';
import Analytics from './pages/Analytics';

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/holdings" element={<Holdings />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/tax-lots" element={<TaxLots />} />
        <Route path="/trading-rules" element={<TradingRules />} />
        <Route path="/decision-logs" element={<DecisionLogs />} />
        <Route path="/daily-ritual" element={<DailyRitual />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/watchlists" element={<Watchlists />} />
        <Route path="/monitors" element={<Monitors />} />
        <Route path="/active-management" element={<ActiveManagement />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/import" element={<Import />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Layout>
  );
}

export default App;
