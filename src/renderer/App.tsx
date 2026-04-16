import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Holdings from './pages/Holdings';
import TaxLots from './pages/TaxLots';
import Orders from './pages/Orders';
import DailyRitual from './pages/DailyRitual';
import Settings from './pages/Settings';
import Watchlists from './pages/Watchlists';
import Monitors from './pages/Monitors';
import ActiveManagement from './pages/ActiveManagement';
import Analytics from './pages/Analytics';
import PostMortems from './pages/PostMortems';
import EarningsReviews from './pages/EarningsReviews';
import BrokerPL from './pages/BrokerPL';
import PortfolioHistory from './pages/PortfolioHistory';
import EmsBaskets from './pages/EmsBaskets';
import Transactions from './pages/Transactions';
import ThesisReview from './pages/ThesisReview';

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/holdings" element={<Holdings />} />
        <Route path="/tax-lots" element={<TaxLots />} />
        <Route path="/daily-ritual" element={<DailyRitual />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/watchlists" element={<Watchlists />} />
        <Route path="/monitors" element={<Monitors />} />
        <Route path="/active-management" element={<ActiveManagement />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/post-mortems" element={<PostMortems />} />
        <Route path="/earnings-reviews" element={<EarningsReviews />} />
        <Route path="/thesis-review" element={<ThesisReview />} />
        <Route path="/broker-pl" element={<BrokerPL />} />
        <Route path="/portfolio-history" element={<PortfolioHistory />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/ems" element={<EmsBaskets />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Layout>
  );
}

export default App;
