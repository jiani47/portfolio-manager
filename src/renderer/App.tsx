import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Accounts from './pages/Accounts';
import Holdings from './pages/Holdings';
import Transactions from './pages/Transactions';
import TaxLots from './pages/TaxLots';
import TradingRules from './pages/TradingRules';
import DecisionLogs from './pages/DecisionLogs';
import Insights from './pages/Insights';
import Settings from './pages/Settings';
import Import from './pages/Import';

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
        <Route path="/insights" element={<Insights />} />
        <Route path="/import" element={<Import />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Layout>
  );
}

export default App;
