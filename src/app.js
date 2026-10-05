import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { errorHandler, notFound } from './middleware/error.js';

export const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '100kb' }));

app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

// OBRIGATÓRIO PARA A VERCEL SERVERLESS
export default app;