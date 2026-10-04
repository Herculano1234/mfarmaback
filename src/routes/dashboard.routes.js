import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getDashboard } from '../services/dashboard.service.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json({ data: await getDashboard() });
}));

export default router;
