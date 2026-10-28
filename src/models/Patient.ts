import mongoose, { Schema, Document, Types } from 'mongoose';
import { DOCUMENT_TYPES, DocumentType } from '../config/documentos';
import { documentSignatureSchema, IDocumentSignature, signerCertificateSchema, ISignerCertificate } from './shared';

export type PatientStatus = 'pendiente' | 'aprobado' | 'rechazado' | 'suspendido';
export type SuspensionReason = 'receta_vencida' | 'manual';

export interface IDocument {
  _id: Types.ObjectId;
  tipo: DocumentType;
  nombre: string;
  archivo: string;
  fechaSubida: Date;
  subidoPor?: Types.ObjectId;
  fechaVencimiento?: Date;
  estado: 'pendiente' | 'aprobado' | 'rechazado';
  observaciones?: string;
  revisadoPor?: Types.ObjectId;
  fechaRevision?: Date;
  firma?: IDocumentSignature;
}

export interface IPatientStatusChange {
  estado: PatientStatus;
  fecha: Date;
  /** Vacío cuando el cambio lo hizo el sistema (ej. receta vencida). */
  usuario?: Types.ObjectId;
  motivo?: string;
}

export interface IPatient extends Document {
  usuario: Types.ObjectId;
  /** Dispensario al que pertenece. Vacío solo en fichas antiguas, pendientes de asignar. */
  sucursal?: Types.ObjectId;
  rut: string;
  nombre: string;
  apellido: string;
  fechaNacimiento: Date;
  direccion: {
    calle: string;
    numero: string;
    comuna: string;
    ciudad: string;
    region: string;
    codigoPostal?: string;
  };
  telefono: string;
  email: string;
  medicoTratante: {
    nombre: string;
    especialidad?: string;
    telefono?: string;
    email?: string;
  };
  documentos: Types.DocumentArray<IDocument & Types.Subdocument>;
  /** Certificado de firma electrónica avanzada del paciente (si el proveedor lo exige). */
  certificadoFirma?: ISignerCertificate;
  estado: PatientStatus;
  motivoSuspension?: SuspensionReason;
  activadoPor?: Types.ObjectId;
  fechaActivacion?: Date;
  historialEstados: IPatientStatusChange[];
  /** Unidades de producto que puede retirar en 30 días. 0 = sin límite. */
  limiteMensualUnidades: number;
  /** @deprecated Límite en pesos del modelo de venta. Ya no se usa. */
  limiteCompra?: number;
  observaciones?: string;
  createdAt: Date;
  updatedAt: Date;
}

const documentSchema = new Schema<IDocument>(
  {
    tipo: {
      type: String,
      enum: DOCUMENT_TYPES,
      required: true,
    },
    nombre: { type: String, required: true },
    archivo: { type: String, required: true },
    fechaSubida: { type: Date, default: Date.now },
    subidoPor: { type: Schema.Types.ObjectId, ref: 'User' },
    fechaVencimiento: { type: Date },
    estado: {
      type: String,
      enum: ['pendiente', 'aprobado', 'rechazado'],
      default: 'pendiente',
    },
    observaciones: { type: String },
    revisadoPor: { type: Schema.Types.ObjectId, ref: 'User' },
    fechaRevision: { type: Date },
    firma: documentSignatureSchema,
  },
  { _id: true }
);

const statusChangeSchema = new Schema<IPatientStatusChange>(
  {
    estado: { type: String, required: true },
    fecha: { type: Date, default: Date.now },
    usuario: { type: Schema.Types.ObjectId, ref: 'User' },
    motivo: { type: String },
  },
  { _id: false }
);

const patientSchema = new Schema<IPatient>(
  {
    usuario: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    sucursal: {
      type: Schema.Types.ObjectId,
      ref: 'Sucursal',
    },
    rut: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    nombre: {
      type: String,
      required: true,
      trim: true,
    },
    apellido: {
      type: String,
      required: true,
      trim: true,
    },
    fechaNacimiento: {
      type: Date,
      required: true,
    },
    direccion: {
      calle: { type: String, required: true },
      numero: { type: String, required: true },
      comuna: { type: String, required: true },
      ciudad: { type: String, required: true },
      region: { type: String, required: true },
      codigoPostal: { type: String },
    },
    telefono: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
    },
    medicoTratante: {
      nombre: { type: String, required: true },
      especialidad: { type: String },
      telefono: { type: String },
      email: { type: String },
    },
    documentos: [documentSchema],
    certificadoFirma: signerCertificateSchema,
    estado: {
      type: String,
      enum: ['pendiente', 'aprobado', 'rechazado', 'suspendido'],
      default: 'pendiente',
    },
    motivoSuspension: {
      type: String,
      enum: ['receta_vencida', 'manual'],
    },
    activadoPor: { type: Schema.Types.ObjectId, ref: 'User' },
    fechaActivacion: { type: Date },
    historialEstados: [statusChangeSchema],
    limiteMensualUnidades: {
      type: Number,
      default: 0,
      min: 0,
    },
    limiteCompra: { type: Number },
    observaciones: { type: String },
  },
  {
    timestamps: true,
  }
);

// rut index already created by unique: true
patientSchema.index({ estado: 1 });
patientSchema.index({ sucursal: 1, estado: 1 });
patientSchema.index({ 'medicoTratante.nombre': 1 });
patientSchema.index({ 'documentos.tipo': 1, 'documentos.fechaVencimiento': 1 });
patientSchema.index({ 'documentos.firma.signatureId': 1 });
patientSchema.index({ 'certificadoFirma.token': 1 }, { sparse: true });

export const Patient = mongoose.model<IPatient>('Patient', patientSchema);
