import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { requireStaff } from '../middleware/staff.js';
import * as staffSvc from '../services/staff.service.js';
import * as stock from '../services/stock.service.js';
import * as dispensations from '../services/dispensations.service.js';
import * as inventories from '../services/inventories.service.js';

const router = Router();
const GERENTE = 'ROLE_GERENTE';
const anyStaff = requireStaff();
const managerOnly = requireStaff(GERENTE);

const uuid = z.string().uuid();
const optText = (max) => z.string().trim().max(max).nullish().transform((v) => (v === undefined ? undefined : v || null));

// ---------- Autenticação ----------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas tentativas. Tente novamente dentro de 15 minutos.' },
});

router.post('/auth/login', loginLimiter,
  validate(z.object({ email: z.string().trim().email('Email inválido.'), password: z.string().min(1) })),
  asyncHandler(async (req, res) => res.json(await staffSvc.login(req.body.email, req.body.password))));

router.get('/me', anyStaff, asyncHandler(async (req, res) => {
  res.json({ data: await staffSvc.me(req.staff.id) });
}));

router.post('/auth/change-password', anyStaff,
  validate(z.object({ current_password: z.string().min(1), new_password: z.string().min(8, 'A senha deve ter pelo menos 8 caracteres.').max(100) })),
  asyncHandler(async (req, res) => {
    await staffSvc.changePassword(req.staff.id, req.body.current_password, req.body.new_password);
    res.status(204).end();
  }));

// ---------- Catálogo (ambos os perfis; o técnico não recebe quantidades) ----------
router.get('/catalog', anyStaff, asyncHandler(async (req, res) => {
  res.json({ data: await stock.catalog(req.staff) });
}));

router.get('/products/lookup', anyStaff,
  validate(z.object({ code: z.string().trim().min(1).max(64) }), 'query'),
  asyncHandler(async (req, res) => res.json({ data: await stock.lookup(req.staff, req.validatedQuery.code) })));

router.get('/recommendations', anyStaff,
  validate(z.object({
    product_ids: z.string().transform((s) => s.split(',').filter(Boolean)).pipe(z.array(uuid).min(1).max(30)),
  }), 'query'),
  asyncHandler(async (req, res) => res.json({ data: await stock.recommendations(req.staff, req.validatedQuery.product_ids) })));

// ---------- Dispensação (técnico e gerente) ----------
const dispensationBody = z.object({
  client_uuid: uuid,
  offline: z.boolean().optional(),
  items: z.array(z.object({ product_id: uuid, quantity: z.number().int().min(1).max(10000) })).min(1).max(100),
});
router.post('/dispensations', anyStaff, validate(dispensationBody), asyncHandler(async (req, res) => {
  const result = await dispensations.create(req.staff, req.body);
  res.status(result.duplicate ? 200 : 201).json({ data: result });
}));

// ---------- Gestão de produtos e stock (gerente) ----------
const productBase = z.object({
  name: z.string().trim().min(2, 'Indique o nome do produto.').max(200),
  sku: optText(40),
  barcode: optText(64),
  category: optText(80),
  price: z.coerce.number().min(0).max(1_000_000_000),
  min_stock: z.coerce.number().int().min(0).max(100000),
  requires_prescription: z.boolean(),
});
const createProduct = productBase.partial({ price: true, min_stock: true, requires_prescription: true })
  .extend({ initial_stock: z.coerce.number().int().min(0).max(1_000_000).optional() });
const updateProduct = productBase.partial().extend({ active: z.boolean().optional() });

router.post('/products', managerOnly, validate(createProduct), asyncHandler(async (req, res) => {
  res.status(201).json({ data: await stock.createProduct(req.staff, req.body) });
}));
router.put('/products/:id', managerOnly, validate(updateProduct), asyncHandler(async (req, res) => {
  res.json({ data: await stock.updateProduct(req.staff, req.params.id, req.body) });
}));
router.delete('/products/:id', managerOnly, asyncHandler(async (req, res) => {
  await stock.removeProduct(req.staff, req.params.id);
  res.status(204).end();
}));

const movementBody = z.object({
  type: z.enum(['ENTRADA', 'SAIDA']),
  quantity: z.coerce.number().int().min(1, 'A quantidade deve ser pelo menos 1.').max(1_000_000),
  reason: z.string().trim().max(300).optional(),
});
router.post('/products/:id/movements', managerOnly, validate(movementBody), asyncHandler(async (req, res) => {
  res.status(201).json({ data: await stock.manualMovement(req.staff, req.params.id, req.body) });
}));

router.get('/movements', managerOnly,
  validate(z.object({ product_id: uuid.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), 'query'),
  asyncHandler(async (req, res) => {
    const { product_id: productId, limit } = req.validatedQuery;
    res.json({ data: await stock.listMovements(req.staff, { productId, limit }) });
  }));

router.get('/manager/dashboard', managerOnly, asyncHandler(async (req, res) => {
  res.json({ data: await stock.managerDashboard(req.staff) });
}));

// ---------- Inventários ----------
router.get('/inventories', anyStaff, asyncHandler(async (req, res) => {
  res.json({ data: await inventories.list(req.staff) });
}));
router.get('/inventories/active', anyStaff, asyncHandler(async (req, res) => {
  res.json({ data: await inventories.listActive(req.staff) });
}));
router.post('/inventories', managerOnly,
  validate(z.object({ title: z.string().trim().min(3, 'Indique um título.').max(120), scheduled_for: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.') })),
  asyncHandler(async (req, res) => res.status(201).json({ data: await inventories.create(req.staff, req.body) })));

router.post('/inventories/:id/start', managerOnly, asyncHandler(async (req, res) => {
  await inventories.start(req.staff, req.params.id);
  res.status(204).end();
}));
router.post('/inventories/:id/finish', managerOnly, asyncHandler(async (req, res) => {
  await inventories.finish(req.staff, req.params.id);
  res.status(204).end();
}));
router.post('/inventories/:id/count', anyStaff,
  validate(z.object({ product_id: uuid, counted_qty: z.number().int().min(0).max(1_000_000) })),
  asyncHandler(async (req, res) => {
    await inventories.count(req.staff, req.params.id, req.body);
    res.status(204).end();
  }));
router.get('/inventories/:id/reconciliation', managerOnly, asyncHandler(async (req, res) => {
  res.json({ data: await inventories.reconciliation(req.staff, req.params.id) });
}));
router.post('/inventories/:id/items/:itemId/approve', managerOnly, asyncHandler(async (req, res) => {
  await inventories.resolveItem(req.staff, req.params.id, req.params.itemId, true);
  res.status(204).end();
}));
router.post('/inventories/:id/items/:itemId/reject', managerOnly, asyncHandler(async (req, res) => {
  await inventories.resolveItem(req.staff, req.params.id, req.params.itemId, false);
  res.status(204).end();
}));
router.post('/inventories/:id/approve-all', managerOnly, asyncHandler(async (req, res) => {
  res.json({ data: await inventories.approveAll(req.staff, req.params.id) });
}));
router.post('/inventories/:id/close', managerOnly, asyncHandler(async (req, res) => {
  await inventories.close(req.staff, req.params.id);
  res.status(204).end();
}));

// ---------- Equipa ----------
router.get('/team', managerOnly, asyncHandler(async (req, res) => {
  res.json({ data: await staffSvc.listTeam(req.staff.pharmacyId) });
}));
router.patch('/team/:id', managerOnly, validate(z.object({ active: z.boolean() })), asyncHandler(async (req, res) => {
  await staffSvc.setTechnicianActive(req.staff.pharmacyId, req.params.id, req.body.active);
  res.status(204).end();
}));

export default router;
