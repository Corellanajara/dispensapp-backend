import mongoose, { Schema, Document, Types } from 'mongoose';
import {
  documentSignatureSchema,
  signerCertificateSchema,
  IDocumentSignature,
  ISignerCertificate,
} from './shared';

/**
 * Firma de prueba que hace el administrador desde Configuración → Firma electrónica.
 * Va separada de los pacientes: sirve para ver el flujo completo de Signapis y cómo queda el PDF.
 */
export interface IFirmaDemo extends Document {
  _id: Types.ObjectId;
  nombre: string;
  rut: string;
  email: string;
  telefono?: string;
  /** Referencia al PDF original en el almacenamiento. */
  archivo: string;
  nombreArchivo: string;
  firma?: IDocumentSignature;
  certificadoFirma?: ISignerCertificate;
  creadoPor: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const firmaDemoSchema = new Schema<IFirmaDemo>(
  {
    nombre: { type: String, required: true, trim: true },
    rut: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    telefono: { type: String, trim: true },
    archivo: { type: String, required: true },
    nombreArchivo: { type: String, required: true },
    firma: { type: documentSignatureSchema },
    certificadoFirma: { type: signerCertificateSchema },
    creadoPor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

firmaDemoSchema.index({ 'firma.signatureId': 1 });
firmaDemoSchema.index({ 'certificadoFirma.token': 1 });
firmaDemoSchema.index({ createdAt: -1 });

export const FirmaDemo = mongoose.model<IFirmaDemo>('FirmaDemo', firmaDemoSchema);
