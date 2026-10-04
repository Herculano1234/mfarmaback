import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import * as auth from '../services/auth.service.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas tentativas. Tente novamente dentro de 15 minutos.' },
});

const loginSchema = z.object({
  email: z.string().trim().email('Email inválido.'),
  password: z.string().min(1, 'Indique a senha.'),
});

router.post('/login', loginLimiter, validate(loginSchema), asyncHandler(async (req, res) => {
  res.json(await auth.login(req.body.email, req.body.password));
}));

router.get('/me', requireAdmin, asyncHandler(async (req, res) => {
  res.json({ data: await auth.me(req.admin.id) });
}));

export default router;
