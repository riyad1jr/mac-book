export type Product = { id: string; name: string; sku?: string; brand: string; category: string; stock: number; threshold: number; costPrice: number; sellPrice: number; /** true once the owner typed a selling price (older values were invented as cost + 35%) */ sellPriceSet?: boolean; unit?: string; packQty?: number; lowStockThreshold?: number }
export type Purchase = { id: string; productId: string; productName: string; supplier: string; supplierId?: string; quantity: number; unitCost: number; date: string; time: string; reference: string; totalCost?: number; paid?: number; dueDate?: string; tz?: 'local'; /** 'base': quantity is in pieces/meters, not packs (bought loose) */ buyBy?: 'base' }
export type Sale = { id: string; productId?: string; productName: string; customer: string; quantity: number; total: number; paid: number; date: string; time: string; dueDate?: string; customerPhone?: string; paymentType?: string; unitPrice?: number; tz?: 'local' }
export type Customer = { id: string; name: string; phone: string; email?: string; createdAt?: string; creditBalance?: number }
export type Supplier = { id: string; name: string; contact: string; phone: string; email: string; lastDelivered: string }
export type Expense = { id: string; category: string; note: string; amount: number; date: string; time: string; tz?: 'local' }
export type LocalAccount = { name: string; email: string; password: string }
export type Section = 'Overview' | 'Sales' | 'Purchases' | 'Inventory' | 'Customers' | 'Suppliers' | 'Expenses' | 'Reports' | 'Graph' | 'Settings'
