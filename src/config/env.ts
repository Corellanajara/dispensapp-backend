import dotenv from 'dotenv';
dotenv.config();

export const env = {
  PORT: parseInt(process.env.PORT || '5000', 10),
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/dispensarios',
  JWT_SECRET: process.env.JWT_SECRET || 'dispensarios-secret-key-change-in-production',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  // Carpeta de archivos. En Railway, si el servicio tiene un volumen, se usa el volumen
  // (Railway define RAILWAY_VOLUME_MOUNT_PATH) para que los PDF no se borren en cada deploy.
  UPLOAD_DIR: process.env.UPLOAD_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './uploads',
  RAILWAY_VOLUME_MOUNT_PATH: process.env.RAILWAY_VOLUME_MOUNT_PATH || '',
  // Railway define estas variables en todos sus servicios.
  EN_RAILWAY: !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID),
  NODE_ENV: process.env.NODE_ENV || 'development',

  // S3 (opcional – si se configuran, las imágenes se suben al bucket)
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
  AWS_S3_BUCKET: process.env.AWS_S3_BUCKET || '',
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',

  // Proveedor POS (default 'mock' para desarrollo)
  POS_PAYMENT_PROVIDER: process.env.POS_PAYMENT_PROVIDER || 'mock',

  // Proveedor firma electrónica (default 'mock' para desarrollo)
  SIGNATURE_PROVIDER: process.env.SIGNATURE_PROVIDER || 'mock',

  // Signapis (firma electrónica avanzada). Ver docs: https://fear-docs.signapis.com
  // SIGNAPIS_AMBIENTE=pruebas usa el sandbox; produccion usa el ambiente real (otras credenciales).
  SIGNAPIS_AMBIENTE: (process.env.SIGNAPIS_AMBIENTE === 'produccion' ? 'produccion' : 'pruebas') as
    | 'pruebas'
    | 'produccion',
  SIGNAPIS_API_KEY: process.env.SIGNAPIS_API_KEY || '',
  SIGNAPIS_EMAIL: process.env.SIGNAPIS_EMAIL || '',
  SIGNAPIS_PASSWORD: process.env.SIGNAPIS_PASSWORD || '',
  // Solo si Signapis entrega otra URL. Por defecto se elige según SIGNAPIS_AMBIENTE.
  SIGNAPIS_BASE_URL: process.env.SIGNAPIS_BASE_URL || '',
  // URL pública del backend, para registrar el webhook en Signapis (ej. https://api.dispensapp.cl).
  BACKEND_PUBLIC_URL: (process.env.BACKEND_PUBLIC_URL || '').replace(/\/+$/, ''),

  // Flow.cl payment gateway
  FLOW_SERVICE_URL: process.env.FLOW_SERVICE_URL || 'http://localhost:3800',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',

  // Cobros al paciente. Apagado por defecto: en la reunión se indicó que no puede haber pagos.
  PAGOS_HABILITADOS: process.env.PAGOS_HABILITADOS === 'true',
  // Secreto compartido para webhooks (Flow y proveedor de firma). Sin él, los webhooks se rechazan.
  FLOW_WEBHOOK_SECRET: process.env.FLOW_WEBHOOK_SECRET || '',
  SIGNATURE_CALLBACK_SECRET: process.env.SIGNATURE_CALLBACK_SECRET || '',

  // Orígenes permitidos por CORS, separados por coma. Por defecto solo FRONTEND_URL.
  CORS_ORIGINS: (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  // Cantidad de proxies delante del backend (Railway = 1). Necesario para auditar la IP real.
  TRUST_PROXY: parseInt(process.env.TRUST_PROXY || '1', 10),

  // Protección de login
  LOGIN_MAX_INTENTOS: parseInt(process.env.LOGIN_MAX_INTENTOS || '5', 10),
  LOGIN_BLOQUEO_MINUTOS: parseInt(process.env.LOGIN_BLOQUEO_MINUTOS || '15', 10),

  // Vigencia de recetas: días de anticipación para avisar.
  DIAS_AVISO_RECETA: parseInt(process.env.DIAS_AVISO_RECETA || '30', 10),
  // Al aprobar una receta nueva, reactivar automáticamente al paciente suspendido por vencimiento.
  REACTIVAR_AL_RENOVAR_RECETA: process.env.REACTIVAR_AL_RENOVAR_RECETA !== 'false',
};
