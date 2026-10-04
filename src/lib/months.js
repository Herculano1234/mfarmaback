// 'YYYY-MM' -> 'YYYY-MM-01' (primeiro dia, formato DATE do PostgreSQL)
export const monthToDate = (month) => `${month}-01`;

export function currentMonth() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Luanda' }));
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
