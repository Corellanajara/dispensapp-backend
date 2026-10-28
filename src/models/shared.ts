import { Schema } from 'mongoose';

export type SignatureStatus =
  | 'pendiente'
  | 'enviado'
  | 'firmado'
  | 'rechazado'
  | 'expirado'
  | 'cancelado'
  | 'error';

export interface IDocumentSignature {
  signatureId: string;
  provider: string;
  estado: SignatureStatus;
  signingUrl?: string;
  firmadoPor?: string;
  rutFirmante?: string;
  fechaFirma?: Date;
  archivoFirmado?: string;
  solicitadoPor?: unknown;
  fechaSolicitud?: Date;
  /** Último mensaje del proveedor (ej. motivo de rechazo o error). */
  mensaje?: string;
  fechaActualizacion?: Date;
}

export const documentSignatureSchema = new Schema<IDocumentSignature>(
  {
    signatureId: { type: String, required: true },
    provider: { type: String, required: true },
    estado: {
      type: String,
      enum: ['pendiente', 'enviado', 'firmado', 'rechazado', 'expirado', 'cancelado', 'error'],
      default: 'pendiente',
    },
    signingUrl: { type: String },
    firmadoPor: { type: String },
    rutFirmante: { type: String },
    fechaFirma: { type: Date },
    archivoFirmado: { type: String },
    solicitadoPor: { type: Schema.Types.ObjectId, ref: 'User' },
    fechaSolicitud: { type: Date },
    mensaje: { type: String },
    fechaActualizacion: { type: Date },
  },
  { _id: false }
);

/**
 * Certificado de firma del paciente en el proveedor.
 * Signapis exige que cada firmante tenga un certificado propio, que obtiene una vez
 * validando su identidad (Clave Única, preguntas o transferencia).
 */
export type CertificateStatus = 'enrolando' | 'activo' | 'fallido';

export interface ISignerCertificate {
  proveedor: string;
  estado: CertificateStatus;
  /** Token de la solicitud de certificado (llega en las notificaciones del enrolamiento). */
  token?: string;
  /** Número de serie del certificado emitido. */
  numeroSerie?: string;
  /** Correo con el que quedó registrado en el proveedor. */
  email?: string;
  enrolamientoUrl?: string;
  mensaje?: string;
  fechaSolicitud?: Date;
  fechaEmision?: Date;
}

export const signerCertificateSchema = new Schema<ISignerCertificate>(
  {
    proveedor: { type: String, required: true },
    estado: { type: String, enum: ['enrolando', 'activo', 'fallido'], required: true },
    token: { type: String },
    numeroSerie: { type: String },
    email: { type: String },
    enrolamientoUrl: { type: String },
    mensaje: { type: String },
    fechaSolicitud: { type: Date },
    fechaEmision: { type: Date },
  },
  { _id: false }
);
