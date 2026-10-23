import { Schema } from 'mongoose';

export type SignatureStatus =
  | 'pendiente'
  | 'enviado'
  | 'firmado'
  | 'rechazado'
  | 'expirado'
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
}

export const documentSignatureSchema = new Schema<IDocumentSignature>(
  {
    signatureId: { type: String, required: true },
    provider: { type: String, required: true },
    estado: {
      type: String,
      enum: ['pendiente', 'enviado', 'firmado', 'rechazado', 'expirado', 'error'],
      default: 'pendiente',
    },
    signingUrl: { type: String },
    firmadoPor: { type: String },
    rutFirmante: { type: String },
    fechaFirma: { type: Date },
    archivoFirmado: { type: String },
    solicitadoPor: { type: Schema.Types.ObjectId, ref: 'User' },
    fechaSolicitud: { type: Date },
  },
  { _id: false }
);
