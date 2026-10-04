import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { currentMonth } from '../lib/months.js';
import * as finance from '../services/finance.service.js';

const router = Router();

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês inválido (use AAAA-MM).');

const monthQuery = z.object({
  month: month.default(() => currentMonth()),
  status: z.enum(['PENDENTE', 'PAGO']).optional(),
});

const generateBody = z.object({ month: month.default(() => currentMonth()) });

const payBody = z.object({
  method: z.enum(['TRANSFERENCIA', 'MULTICAIXA_EXPRESS', 'NUMERARIO', 'DEPOSITO']),
  reference: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(500).optional(),
  paid_at: z.string().datetime({ offset: true }).optional(),
});

router.get('/summary', validate(monthQuery, 'query'), asyncHandler(async (req, res) => {
  res.json({ data: await finance.summary(req.validatedQuery.month) });
}));

router.get('/payments', validate(monthQuery, 'query'), asyncHandler(async (req, res) => {
  const { month: m, status } = req.validatedQuery;
  res.json({ data: await finance.listPayments(m, status) });
}));

router.post('/generate', validate(generateBody), asyncHandler(async (req, res) => {
  res.status(201).json({ data: await finance.generateMonth(req.body.month, req.admin.id) });
}));

router.post('/payments/:id/pay', validate(payBody), asyncHandler(async (req, res) => {
  await finance.markPaid(req.params.id, req.body, req.admin.id);
  res.status(204).end();
}));

router.post('/payments/:id/revert', asyncHandler(async (req, res) => {
  await finance.revert(req.params.id, req.admin.id);
  res.status(204).end();
}));

export default router;
