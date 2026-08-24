import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { StoreProvider } from '@/lib/data/store'
import { Layout } from '@/components/Layout'
import { Dashboard } from '@/screens/Dashboard'
import { Sales } from '@/screens/Sales'
import { NewSale } from '@/screens/NewSale'
import { Customers } from '@/screens/Customers'
import { CustomerKhata } from '@/screens/CustomerKhata'
import { Payments } from '@/screens/Payments'
import { Purchases } from '@/screens/Purchases'
import { Inventory } from '@/screens/Inventory'
import { Production } from '@/screens/Production'
import { Dispatch } from '@/screens/Dispatch'
import { Rokad } from '@/screens/Rokad'
import { Expenses } from '@/screens/Expenses'
import { Reports } from '@/screens/Reports'
import { Reminders } from '@/screens/Reminders'
import { Settings } from '@/screens/Settings'
import { Users } from '@/screens/Users'
import { AuditLog } from '@/screens/AuditLog'
import { Parchi } from '@/screens/Parchi'

export function App() {
  return (
    <StoreProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/parchi/:id" element={<Parchi />} />
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/sales" element={<Sales />} />
            <Route path="/sales/new" element={<NewSale />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/customers/:id" element={<CustomerKhata />} />
            <Route path="/payments" element={<Payments />} />
            <Route path="/purchases" element={<Purchases />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/production" element={<Production />} />
            <Route path="/dispatch" element={<Dispatch />} />
            <Route path="/rokad" element={<Rokad />} />
            <Route path="/expenses" element={<Expenses />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/reminders" element={<Reminders />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/users" element={<Users />} />
            <Route path="/audit" element={<AuditLog />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </StoreProvider>
  )
}
