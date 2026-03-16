import dotenv from 'dotenv';
dotenv.config();

export const env = {
  PORT: parseInt(process.env.PORT || '5000', 10),
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/dispensarios',
  JWT_SECRET: process.env.JWT_SECRET || 'dispensarios-secret-key-change-in-production',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',
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
};
