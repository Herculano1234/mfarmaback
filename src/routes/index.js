import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import authRoutes from './auth.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import pharmaciesRoutes from './pharmacies.routes.js';
import financeRoutes from './finance.routes.js';
import appRoutes from './app.routes.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ status: 'ok' }));
router.use('/auth', authRoutes);

// API da app Moyo Farmácia (gerentes e técnicos). Tem a sua própria autenticação.
router.use('/app', appRoutes);

// Tudo abaixo exige sessão de administrador (dono da Moyo Farmácia).
router.use(requireAdmin);
router.use('/dashboard', dashboardRoutes);
router.use('/pharmacies', pharmaciesRoutes);
router.use('/finance', financeRoutes);

export default router;
