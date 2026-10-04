import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import * as pharmacies from '../services/pharmacies.service.js';
import * as users from '../services/pharmacyUsers.service.js';

const router = Router();

// ---------- Esquemas ----------
const text = (max) =>
  z.string().trim().max(max).nullish().transform((v) => (v === undefined ? undefined : v || null));

const emailOrEmpty = z
  .union([z.literal(''), z.string().trim().email('Email inválido.').max(160)])
  .nullish()
  .transform((v) => (v === undefined ? undefined : v || null));

const pharmacyBase = z.object({
  name: z.string().trim().min(2, 'Indique o nome da farmácia.').max(160),
  parent_id: z.string().uuid().nullish(),
  nif: text(20),
  license_number: text(60),
  province: text(60),
  municipality: text(80),
  address: text(255),
  phone: text(30),
  email: emailOrEmpty,
  monthly_fee: z.coerce.number().min(0, 'A mensalidade não pode ser negativa.').max(1_000_000_000),
});

const createPharmacy = pharmacyBase.extend({ monthly_fee: pharmacyBase.shape.monthly_fee.default(0) });
const updatePharmacy = pharmacyBase.partial();

const listQuery = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(['ACTIVA', 'INACTIVA']).optional(),
  parents_only: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const statusBody = z
  .object({
    status: z.enum(['ACTIVA', 'INACTIVA']),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.status === 'ACTIVA' || (v.reason && v.reason.length >= 3), {
    path: ['reason'],
    message: 'Indique o motivo da desactivação.',
  });

const createUser = z.object({
  name: z.string().trim().min(2, 'Indique o nome.').max(120),
  email: z.string().trim().email('Email inválido.').max(160),
  phone: text(30),
  role: z.enum(['ROLE_GERENTE', 'ROLE_TECNICO']),
  password: z.string().min(8, 'A senha deve ter pelo menos 8 caracteres.').max(100).optional(),
});
const updateUser = createUser.omit({ password: true }).partial().extend({ active: z.boolean().optional() });

// ---------- Farmácias ----------
router.get('/', validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const { rows, total } = await pharmacies.list(req.validatedQuery);
  const { page, limit } = req.validatedQuery;
  res.json({ data: rows, meta: { total, page, limit } });
}));

router.post('/', validate(createPharmacy), asyncHandler(async (req, res) => {
  res.status(201).json({ data: await pharmacies.create(req.body, req.admin.id) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json({ data: await pharmacies.getById(req.params.id) });
}));

router.put('/:id', validate(updatePharmacy), asyncHandler(async (req, res) => {
  res.json({ data: await pharmacies.update(req.params.id, req.body, req.admin.id) });
}));

router.patch('/:id/status', validate(statusBody), asyncHandler(async (req, res) => {
  const { status, reason } = req.body;
  res.json({ data: await pharmacies.setStatus(req.params.id, status, reason, req.admin.id) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await pharmacies.remove(req.params.id, req.admin.id);
  res.status(204).end();
}));

// ---------- Contas (gerentes e técnicos) ----------
router.get('/:id/users', asyncHandler(async (req, res) => {
  res.json({ data: await users.listByPharmacy(req.params.id) });
}));

router.post('/:id/users', validate(createUser), asyncHandler(async (req, res) => {
  const result = await users.create(req.params.id, req.body, req.admin.id);
  res.status(201).json({ data: result.user, temporary_password: result.temporary_password });
}));

router.put('/:id/users/:userId', validate(updateUser), asyncHandler(async (req, res) => {
  res.json({ data: await users.update(req.params.id, req.params.userId, req.body, req.admin.id) });
}));

router.post('/:id/users/:userId/reset-password', asyncHandler(async (req, res) => {
  res.json(await users.resetPassword(req.params.id, req.params.userId, req.admin.id));
}));

router.delete('/:id/users/:userId', asyncHandler(async (req, res) => {
  await users.remove(req.params.id, req.params.userId, req.admin.id);
  res.status(204).end();
}));

export default router;
