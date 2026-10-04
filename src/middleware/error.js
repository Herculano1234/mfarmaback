import { ZodError } from 'zod';
import { HttpError } from '../lib/httpError.js';

const CONSTRAINT_MESSAGES = {
  ux_pharmacies_nif: 'Já existe uma farmácia com este NIF.',
  ux_pharmacy_users_email: 'Este email já está a ser usado por outra conta.',
  ux_payments_pharmacy_month: 'Já existe uma cobrança desta farmácia para este mês.',
  ux_products_sku: 'Já existe um produto com este SKU.',
  ux_products_barcode: 'Já existe um produto com este código de barras.',
};

export function notFound(_req, res) {
  res.status(404).json({ error: 'Rota não encontrada.' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: 'Verifique os campos preenchidos.',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details, code: err.code });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido.' });
  }
  if (err.code === '23505') {
    return res.status(409).json({ error: CONSTRAINT_MESSAGES[err.constraint] ?? 'Já existe um registo com estes dados.' });
  }
  if (err.code === '23503') {
    return res.status(409).json({ error: 'Este registo está associado a outros dados.' });
  }
  if (err.code === '22P02') {
    return res.status(404).json({ error: 'Registo não encontrado.' });
  }
  console.error(err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}
