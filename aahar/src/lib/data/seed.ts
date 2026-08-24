import type { AppState } from '@/lib/types'

// Realistic sample data for a mid-size cattle-feed mill in Rajasthan. Nothing
// here is computed — balances, stock and cash are derived from these facts in
// lib/select.ts, so the numbers on every screen always reconcile.

export const seed: AppState = {
  business: {
    name: 'Balaji Feeds & Minerals',
    hindi: 'बालाजी पशु आहार',
    gstin: '08ABCDE1234F1Z5',
    phone: '+91 94140 55123',
    address: 'Plot 12, Industrial Area, Ranoli Road',
    city: 'Sikar',
    state: 'Rajasthan',
    whatsappConnected: false,
    reminders: {
      enabled: true,
      onDispatch: true,
      onDueDate: true,
      overdueEveryDays: 3,
      quietHours: '9:00 PM – 8:00 AM',
      maxPerInvoicePerDay: 1,
    },
  },

  currentUserId: 'u-owner',
  users: [
    { id: 'u-owner', name: 'Ramesh Agarwal', phone: '+91 94140 55123', role: 'owner', active: true },
    { id: 'u-acc', name: 'Suresh (Munim)', phone: '+91 98290 11234', role: 'accountant', active: true },
    { id: 'u-sales', name: 'Vikas Sharma', phone: '+91 90015 66780', role: 'sales', active: true },
    { id: 'u-store', name: 'Manoj Kumar', phone: '+91 96360 22119', role: 'store', active: true },
    { id: 'u-prod', name: 'Raju (Plant)', phone: '+91 97723 90014', role: 'production', active: true },
    { id: 'u-disp', name: 'Pappu Yadav', phone: '+91 99280 74510', role: 'dispatch', active: true },
    { id: 'u-view', name: 'Anita (Family)', phone: '+91 94131 00092', role: 'viewer', active: false },
  ],

  parties: [
    { id: 'c-abc', kind: 'customer', name: 'ABC Traders', phone: '+91 94140 12345', city: 'Sikar', gstin: '08AAACA1111A1Z2', openingBalance: 20000, creditLimit: 200000, creditDays: 4, since: '2023-06-11', notes: 'Reliable, pays on time. Prefers Premium feed.' },
    { id: 'c-bhagwati', kind: 'customer', name: 'Maa Bhagwati Dairy', phone: '+91 98290 44551', city: 'Ringus', creditLimit: 150000, creditDays: 7, openingBalance: 0, since: '2024-01-20' },
    { id: 'c-krishna', kind: 'customer', name: 'Shree Krishna Pashu Aahar', phone: '+91 90247 88123', city: 'Jaipur', gstin: '08AAKCS9911K1Z8', openingBalance: 35000, creditLimit: 400000, creditDays: 15, since: '2022-11-03', notes: 'Large sub-dealer. Buys in truckloads.' },
    { id: 'c-balaji', kind: 'customer', name: 'Balaji Dudh Bhandar', phone: '+91 96020 33210', city: 'Chomu', creditLimit: 80000, creditDays: 3, openingBalance: 0, since: '2024-05-14' },
    { id: 'c-gopal', kind: 'customer', name: 'New Gopal Traders', phone: '+91 93520 77410', city: 'Neem Ka Thana', creditLimit: 120000, creditDays: 10, openingBalance: 62000, since: '2023-09-27', notes: 'Watch credit — slow payer.' },
    { id: 'c-rajputana', kind: 'customer', name: 'Rajputana Cattle Feed', phone: '+91 94610 55098', city: 'Fatehpur', creditLimit: 250000, creditDays: 7, openingBalance: 0, since: '2023-02-08' },
    { id: 'c-verma', kind: 'customer', name: 'Verma Dairy Farm', phone: '+91 99500 21876', city: 'Jhunjhunu', creditLimit: 50000, creditDays: 0, openingBalance: 0, since: '2025-03-19', notes: 'Cash buyer.' },

    { id: 's-agro', kind: 'supplier', name: 'Rajasthan Agro Mandi', phone: '+91 94140 90001', city: 'Sikar', openingBalance: 0, creditDays: 15, since: '2022-04-01', notes: 'Maize & wheat bran.' },
    { id: 's-solvent', kind: 'supplier', name: 'Shree Ram Solvent Ltd', phone: '+91 79760 30022', city: 'Jaipur', gstin: '08AAECS5522R1Z1', openingBalance: 148000, creditDays: 21, since: '2022-04-01', notes: 'Soybean meal, DORB.' },
    { id: 's-mineral', kind: 'supplier', name: 'Ganesh Mineral Works', phone: '+91 90013 45678', city: 'Behror', openingBalance: 0, creditDays: 30, since: '2023-07-15' },
    { id: 's-bardana', kind: 'supplier', name: 'Krishna Bardana Store', phone: '+91 96490 11220', city: 'Sikar', openingBalance: 12500, creditDays: 7, since: '2024-02-10', notes: 'Packaging bags.' },
  ],

  products: [
    // Finished goods — sold in 50 kg bags.
    { id: 'p-premium', type: 'finished', name: 'Premium Cattle Feed', hindi: 'प्रीमियम पशु आहार', unit: 'bag', packKg: 50, rate: 1250, hsn: '2309', openingStock: 460, reorderLevel: 150 },
    { id: 'p-standard', type: 'finished', name: 'Standard Cattle Feed', hindi: 'मानक पशु आहार', unit: 'bag', packKg: 50, rate: 1050, hsn: '2309', openingStock: 540, reorderLevel: 200 },
    { id: 'p-buffalo', type: 'finished', name: 'Buffalo Special Feed', hindi: 'भैंस विशेष आहार', unit: 'bag', packKg: 50, rate: 1150, hsn: '2309', openingStock: 210, reorderLevel: 120 },
    { id: 'p-calf', type: 'finished', name: 'Calf Starter', hindi: 'बछड़ा स्टार्टर', unit: 'bag', packKg: 50, rate: 1520, hsn: '2309', openingStock: 60, reorderLevel: 80 },

    // Raw materials — tracked in kg.
    { id: 'r-maize', type: 'raw', name: 'Maize', hindi: 'मक्का', unit: 'kg', packKg: 1, rate: 24, openingStock: 42000, reorderLevel: 15000 },
    { id: 'r-bran', type: 'raw', name: 'Wheat Bran (Choker)', hindi: 'गेहूं चोकर', unit: 'kg', packKg: 1, rate: 18, openingStock: 26000, reorderLevel: 12000 },
    { id: 'r-dorb', type: 'raw', name: 'De-oiled Rice Bran', hindi: 'चावल की भूसी', unit: 'kg', packKg: 1, rate: 16, openingStock: 9500, reorderLevel: 10000 },
    { id: 'r-soy', type: 'raw', name: 'Soybean Meal', hindi: 'सोया खली', unit: 'kg', packKg: 1, rate: 42, openingStock: 14000, reorderLevel: 8000 },
    { id: 'r-mineral', type: 'raw', name: 'Mineral Mixture', hindi: 'मिनरल मिक्स', unit: 'kg', packKg: 1, rate: 65, openingStock: 3200, reorderLevel: 2000 },
    { id: 'r-molasses', type: 'raw', name: 'Molasses', hindi: 'शीरा', unit: 'kg', packKg: 1, rate: 14, openingStock: 5600, reorderLevel: 3000 },
    { id: 'r-salt', type: 'raw', name: 'Mineral Salt', hindi: 'नमक', unit: 'kg', packKg: 1, rate: 9, openingStock: 4100, reorderLevel: 1500 },
  ],

  sales: [
    { id: 'sl-1', no: 'INV-1018', partyId: 'c-krishna', date: '2026-08-08', creditDays: 15, lines: [{ productId: 'p-premium', qty: 240, unit: 'bag', rate: 1250 }, { productId: 'p-standard', qty: 120, unit: 'bag', rate: 1050 }], paidNow: 0, status: 'delivered', vehicle: 'RJ13 GA 4521', driver: 'Mahesh', createdBy: 'u-sales' },
    { id: 'sl-2', no: 'INV-1019', partyId: 'c-gopal', date: '2026-08-10', creditDays: 10, lines: [{ productId: 'p-standard', qty: 80, unit: 'bag', rate: 1050 }], paidNow: 0, status: 'delivered', createdBy: 'u-sales' },
    { id: 'sl-3', no: 'INV-1020', partyId: 'c-rajputana', date: '2026-08-14', creditDays: 7, lines: [{ productId: 'p-buffalo', qty: 100, unit: 'bag', rate: 1150 }], paidNow: 0, status: 'delivered', vehicle: 'RJ23 GC 1180', driver: 'Salim', createdBy: 'u-sales' },
    { id: 'sl-4', no: 'INV-1021', partyId: 'c-bhagwati', date: '2026-08-18', creditDays: 7, lines: [{ productId: 'p-premium', qty: 40, unit: 'bag', rate: 1250 }], paidNow: 0, status: 'delivered', createdBy: 'u-owner' },
    { id: 'sl-5', no: 'INV-1022', partyId: 'c-balaji', date: '2026-08-22', creditDays: 3, lines: [{ productId: 'p-standard', qty: 30, unit: 'bag', rate: 1050 }], paidNow: 10000, paidMode: 'upi', status: 'delivered', createdBy: 'u-sales' },
    { id: 'sl-6', no: 'INV-1023', partyId: 'c-gopal', date: '2026-08-23', creditDays: 10, lines: [{ productId: 'p-buffalo', qty: 60, unit: 'bag', rate: 1150 }], paidNow: 0, status: 'delivered', createdBy: 'u-sales' },
    { id: 'sl-7', no: 'INV-1024', partyId: 'c-abc', date: '2026-08-24', creditDays: 4, lines: [{ productId: 'p-premium', qty: 64, unit: 'bag', rate: 1250 }], paidNow: 0, status: 'dispatched', vehicle: 'RJ13 GA 4521', driver: 'Mahesh', driverPhone: '+91 90247 33110', transportCost: 2200, createdBy: 'u-sales' },
    { id: 'sl-8', no: 'INV-1025', partyId: 'c-verma', date: '2026-08-25', creditDays: 0, lines: [{ productId: 'p-standard', qty: 20, unit: 'bag', rate: 1050 }], paidNow: 21000, paidMode: 'cash', status: 'delivered', createdBy: 'u-owner' },
    { id: 'sl-9', no: 'INV-1026', partyId: 'c-krishna', date: '2026-08-26', creditDays: 15, lines: [{ productId: 'p-premium', qty: 180, unit: 'bag', rate: 1250 }, { productId: 'p-calf', qty: 40, unit: 'bag', rate: 1520 }], paidNow: 0, status: 'dispatched', vehicle: 'RJ14 GG 7788', driver: 'Iqbal', driverPhone: '+91 99280 55471', transportCost: 4800, createdBy: 'u-sales' },
    { id: 'sl-10', no: 'INV-1027', partyId: 'c-rajputana', date: '2026-08-27', creditDays: 7, lines: [{ productId: 'p-standard', qty: 120, unit: 'bag', rate: 1050 }], paidNow: 0, status: 'pending', createdBy: 'u-sales' },
    { id: 'sl-11', no: 'INV-1028', partyId: 'c-balaji', date: '2026-08-28', creditDays: 3, lines: [{ productId: 'p-buffalo', qty: 24, unit: 'bag', rate: 1150 }], paidNow: 0, status: 'pending', createdBy: 'u-owner' },
  ],

  payments: [
    { id: 'pm-1', partyId: 'c-krishna', direction: 'in', amount: 150000, mode: 'bank', date: '2026-08-12', ref: 'NEFT 8891', createdBy: 'u-acc' },
    { id: 'pm-2', partyId: 'c-abc', direction: 'in', amount: 50000, mode: 'upi', date: '2026-08-26', ref: 'UPI 4471', note: 'Part payment against opening + INV-1024', createdBy: 'u-acc' },
    { id: 'pm-3', partyId: 'c-rajputana', direction: 'in', amount: 60000, mode: 'cheque', date: '2026-08-24', ref: 'HDFC 002214', createdBy: 'u-acc' },
    { id: 'pm-4', partyId: 'c-bhagwati', direction: 'in', amount: 30000, mode: 'upi', date: '2026-08-28', ref: 'UPI 9902', createdBy: 'u-owner' },
    { id: 'pm-5', partyId: 's-solvent', direction: 'out', amount: 200000, mode: 'bank', date: '2026-08-20', ref: 'RTGS 55120', createdBy: 'u-acc' },
    { id: 'pm-6', partyId: 'c-gopal', direction: 'in', amount: 40000, mode: 'cash', date: '2026-08-28', createdBy: 'u-acc' },
  ],

  purchases: [
    { id: 'pu-1', no: 'PUR-511', partyId: 's-agro', date: '2026-08-05', creditDays: 15, lines: [{ productId: 'r-maize', qty: 30000, unit: 'kg', rate: 24 }], paidNow: 0, createdBy: 'u-store' },
    { id: 'pu-2', no: 'PUR-512', partyId: 's-solvent', date: '2026-08-09', creditDays: 21, lines: [{ productId: 'r-soy', qty: 12000, unit: 'kg', rate: 42 }, { productId: 'r-dorb', qty: 8000, unit: 'kg', rate: 16 }], paidNow: 0, createdBy: 'u-store' },
    { id: 'pu-3', no: 'PUR-513', partyId: 's-mineral', date: '2026-08-16', creditDays: 30, lines: [{ productId: 'r-mineral', qty: 2500, unit: 'kg', rate: 65 }], paidNow: 0, createdBy: 'u-store' },
    { id: 'pu-4', no: 'PUR-514', partyId: 's-agro', date: '2026-08-23', creditDays: 15, lines: [{ productId: 'r-bran', qty: 15000, unit: 'kg', rate: 18 }], paidNow: 50000, paidMode: 'bank', createdBy: 'u-store' },
  ],

  expenses: [
    { id: 'ex-1', category: 'Diesel / Fuel', amount: 8400, date: '2026-08-24', mode: 'cash', note: 'Truck RJ13 GA 4521', enteredBy: 'u-disp' },
    { id: 'ex-2', category: 'Labour', amount: 6200, date: '2026-08-28', mode: 'cash', note: 'Loading — 8 workers', enteredBy: 'u-store' },
    { id: 'ex-3', category: 'Electricity', amount: 31500, date: '2026-08-22', mode: 'bank', note: 'JVVNL Aug bill', enteredBy: 'u-acc' },
    { id: 'ex-4', category: 'Packaging', amount: 14000, date: '2026-08-19', mode: 'cash', note: 'Bardana — 2000 bags', enteredBy: 'u-store' },
    { id: 'ex-5', category: 'Maintenance', amount: 4700, date: '2026-08-28', mode: 'cash', note: 'Pellet mill die repair', enteredBy: 'u-store' },
    { id: 'ex-6', category: 'Office', amount: 1800, date: '2026-08-27', mode: 'upi', note: 'Stationery, printer ink', enteredBy: 'u-acc' },
  ],

  boms: [
    {
      productId: 'p-premium',
      lines: [
        { productId: 'r-maize', kgPerTon: 400 },
        { productId: 'r-bran', kgPerTon: 220 },
        { productId: 'r-dorb', kgPerTon: 130 },
        { productId: 'r-soy', kgPerTon: 140 },
        { productId: 'r-mineral', kgPerTon: 55 },
        { productId: 'r-molasses', kgPerTon: 45 },
        { productId: 'r-salt', kgPerTon: 10 },
      ],
    },
    {
      productId: 'p-standard',
      lines: [
        { productId: 'r-maize', kgPerTon: 300 },
        { productId: 'r-bran', kgPerTon: 330 },
        { productId: 'r-dorb', kgPerTon: 200 },
        { productId: 'r-soy', kgPerTon: 100 },
        { productId: 'r-mineral', kgPerTon: 45 },
        { productId: 'r-molasses', kgPerTon: 15 },
        { productId: 'r-salt', kgPerTon: 10 },
      ],
    },
  ],

  batches: [
    { id: 'bt-1', batchNo: 'B-2608-01', productId: 'p-premium', date: '2026-08-26', outputBags: 200, wastageKg: 60, consumption: [
      { productId: 'r-maize', kg: 4020 }, { productId: 'r-bran', kg: 2210 }, { productId: 'r-dorb', kg: 1305 }, { productId: 'r-soy', kg: 1400 }, { productId: 'r-mineral', kg: 552 }, { productId: 'r-molasses', kg: 450 }, { productId: 'r-salt', kg: 100 },
    ], note: 'Moisture 11.2% — OK', createdBy: 'u-prod' },
    { id: 'bt-2', batchNo: 'B-2708-01', productId: 'p-standard', date: '2026-08-27', outputBags: 300, wastageKg: 90, consumption: [
      { productId: 'r-maize', kg: 4500 }, { productId: 'r-bran', kg: 4950 }, { productId: 'r-dorb', kg: 3000 }, { productId: 'r-soy', kg: 1500 }, { productId: 'r-mineral', kg: 675 }, { productId: 'r-molasses', kg: 225 }, { productId: 'r-salt', kg: 150 },
    ], createdBy: 'u-prod' },
  ],

  audit: [
    { id: 'au-1', at: '2026-08-26T18:32:00', userId: 'u-acc', entity: 'Payment', entityId: 'pm-2', action: 'edit', field: 'amount', oldValue: '₹55,000', newValue: '₹50,000', reason: 'Counted cash again — customer paid 50k, not 55k' },
    { id: 'au-2', at: '2026-08-24T11:05:00', userId: 'u-sales', entity: 'Sale', entityId: 'sl-7', action: 'create', reason: 'New sale INV-1024 to ABC Traders' },
    { id: 'au-3', at: '2026-08-28T09:14:00', userId: 'u-owner', entity: 'Product', entityId: 'p-premium', action: 'edit', field: 'rate', oldValue: '₹1,220', newValue: '₹1,250', reason: 'Maize price rose — revised list rate' },
  ],
}
