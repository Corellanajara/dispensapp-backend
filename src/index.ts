import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { connectDB } from './config/database';
import { env } from './config/env';
import { DOCUMENT_TYPE_LABELS } from './config/documentos';
import { cargarConfiguracion, configFirma, documentosRequeridos } from './services/configuracion';
import { getProvider } from './services/signature';
import { PUBLIC_DIR, estadoAlmacenamiento } from './services/storage';
import { iniciarRevisionVigencias } from './services/vigencia';

// Route imports
import authRoutes from './routes/auth';
import patientRoutes from './routes/patients';
import productRoutes from './routes/products';
import orderRoutes from './routes/orders';
import inventoryRoutes from './routes/inventory';
import productionRoutes from './routes/production';
import financeRoutes from './routes/finance';
import userRoutes from './routes/users';
import reportRoutes from './routes/reports';
import auditRoutes from './routes/audit';
import paymentRoutes from './routes/payments';
import signatureRoutes from './routes/signatures';
import sucursalRoutes from './routes/sucursales';
import ubicacionRoutes from './routes/ubicaciones';
import cultivoRoutes from './routes/cultivo';
import transferenciaRoutes from './routes/transferencias';
import fileRoutes, { legacyProductImage } from './routes/files';

const app = express();

// IP real del cliente detrás del proxy (Railway). Necesario para auditoría y límites por IP.
app.set('trust proxy', env.TRUST_PROXY);

if (env.NODE_ENV === 'production' && env.JWT_SECRET === 'dispensarios-secret-key-change-in-production') {
  console.error('ADVERTENCIA: JWT_SECRET usa el valor por defecto. Configúralo en las variables de entorno.');
}

// Middleware
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors({
    origin: (origin, cb) => {
      // Sin origin = llamadas servidor a servidor (webhooks, health checks)
      if (!origin || env.CORS_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error('Origen no permitido por CORS'));
    },
  })
);
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
// Express 5 deja req.body undefined si no viene cuerpo; las rutas esperan un objeto.
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Límites de solicitudes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.' },
});
const registroLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Demasiados registros desde esta red. Intenta más tarde.' },
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Demasiadas solicitudes. Intenta en un momento.' },
});

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/register-patient', registroLimiter);
app.use('/api', apiLimiter);

// Archivos: solo las imágenes de productos son públicas. Los documentos se descargan con enlace temporal.
app.use('/uploads/public', express.static(PUBLIC_DIR, { index: false, dotfiles: 'deny' }));
app.get('/uploads/:archivo', legacyProductImage);
app.use('/api/files', fileRoutes);

// Configuración pública que necesita el frontend
app.get('/api/config', (_req, res) => {
  res.json({
    pagosHabilitados: env.PAGOS_HABILITADOS,
    diasAvisoReceta: env.DIAS_AVISO_RECETA,
    documentosRequeridos: documentosRequeridos(),
    tiposDocumento: DOCUMENT_TYPE_LABELS,
    firma: (() => {
      const cfg = configFirma();
      const info = getProvider().info();
      return {
        habilitada: cfg.habilitada,
        tiposConFirma: cfg.habilitada ? cfg.tiposConFirma : [],
        proveedor: info.name,
        ambiente: info.ambiente ?? null,
        requiereCertificado: info.requiereCertificado,
        validezLegal: info.validezLegal,
      };
    })(),
  });
});

// Cobros: apagados por defecto (PAGOS_HABILITADOS=false)
const pagosGate = (req: Request, res: Response, next: NextFunction): void => {
  if (!env.PAGOS_HABILITADOS) {
    res.status(403).json({ message: 'Los pagos están deshabilitados. Las notas de dispensación no tienen cobro.' });
    return;
  }
  if (req.path === '/callback' && (!env.FLOW_WEBHOOK_SECRET || req.header('X-Webhook-Secret') !== env.FLOW_WEBHOOK_SECRET)) {
    res.status(401).json({ message: 'Callback no autorizado.' });
    return;
  }
  next();
};

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/users', userRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/payments', pagosGate, paymentRoutes);
app.use('/api/signatures', signatureRoutes);
app.use('/api/sucursales', sucursalRoutes);
app.use('/api/ubicaciones', ubicacionRoutes);
app.use('/api/cultivo', cultivoRoutes);
app.use('/api/transferencias', transferenciaRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  const almacenamiento = estadoAlmacenamiento();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    almacenamiento: { tipo: almacenamiento.tipo, persistente: almacenamiento.persistente },
  });
});

// Errores no controlados (ej. multer, CORS)
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err.message?.startsWith('Tipo de archivo no permitido') || err.name === 'MulterError') {
    res.status(400).json({ message: err.message });
    return;
  }
  if (err.message === 'Origen no permitido por CORS') {
    res.status(403).json({ message: err.message });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Error interno del servidor.' });
});

// Start server
const startServer = async () => {
  await connectDB();
  await cargarConfiguracion();
  iniciarRevisionVigencias();
  app.listen(env.PORT, () => {
    console.log(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
    console.log(`Pagos: ${env.PAGOS_HABILITADOS ? 'habilitados' : 'deshabilitados'} | CORS: ${env.CORS_ORIGINS.join(', ')}`);
    const almacenamiento = estadoAlmacenamiento();
    if (almacenamiento.persistente) console.log(`Archivos: ${almacenamiento.detalle}`);
    else console.error(`ADVERTENCIA archivos: ${almacenamiento.detalle}`);
    const firma = getProvider().info();
    console.log(
      `Firma: ${configFirma().habilitada ? 'activa' : 'desactivada'} | proveedor ${firma.name}` +
        (firma.ambiente ? ` (${firma.ambiente})` : '') +
        (firma.configurado ? '' : ` | faltan: ${firma.faltantes.join(', ')}`)
    );
  });
};

startServer().catch(console.error);

export default app;
