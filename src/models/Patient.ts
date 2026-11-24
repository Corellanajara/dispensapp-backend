import mongoose, { Schema, Document, Types } from 'mongoose';
import { DOCUMENT_TYPES, DocumentType } from '../config/documentos';
import type { ProductType } from './Product';
import { documentSignatureSchema, IDocumentSignature, signerCertificateSchema, ISignerCertificate } from './shared';

export type PatientStatus = 'pendiente' | 'aprobado' | 'rechazado' | 'suspendido';
export type SuspensionReason = 'receta_vencida' | 'manual';

/**
 * Etapa del registro del paciente:
 * 1. documentos: debe subir la receta médica y el certificado de antecedentes.
 * 2. revision: los subió y el dispensario los revisa.
 * 3. firma / validacion: firma el reglamento y el contrato; el dispensario los valida y contrafirma.
 * activacion: todo listo, falta que un administrador lo active (firma electrónica apagada o falta dispensario).
 * activo, suspendido, rechazado: siguen el estado del paciente.
 */
export type EtapaRegistro =
  | 'documentos'
  | 'revision'
  | 'firma'
  | 'validacion'
  | 'activacion'
  | 'activo'
  | 'suspendido'
  | 'rechazado';

export const ETAPAS_REGISTRO: EtapaRegistro[] = [
  'documentos',
  'revision',
  'firma',
  'validacion',
  'activacion',
  'activo',
  'suspendido',
  'rechazado',
];

/** Lo que autoriza la receta: lo registra el administrador al aprobarla. */
export interface IItemPrescripcion {
  _id?: Types.ObjectId;
  /** Tipo de producto autorizado (flor, aceite…). */
  tipoProducto: ProductType;
  /** Producto puntual, si la receta lo indica. Vacío = cualquier producto de ese tipo. */
  producto?: Types.ObjectId;
  /** Nombre del producto al registrarlo (para leerlo sin buscar el producto). */
  nombreProducto?: string;
  /** Lo que dice la receta, ej. "Aceite CBD 10%, 3 gotas cada 12 h". */
  descripcion?: string;
  /** Unidades que puede retirar cada 30 días. Vacío o 0 = sin tope propio (aplica el límite general). */
  cantidadMensual?: number;
}

export interface IPrescripcion {
  items: IItemPrescripcion[];
  /** Indicaciones generales de la receta (dosis, duración del tratamiento…). */
  indicaciones?: string;
  registradoPor?: Types.ObjectId;
  fecha?: Date;
}

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
  /**
   * Segunda firma: la del responsable del dispensario, sobre el PDF ya firmado por el paciente.
   * solicitadoPor = el responsable que contrafirma.
   */
  contrafirma?: IDocumentSignature;
  /** Documento generado por la plataforma desde una plantilla (reglamento, contrato). */
  generado?: { plantillaVersion: number; fecha: Date };
  /** Dónde va la estampa del paciente (la del responsable va al lado). Vacío = la configuración general. */
  posicionFirma?: { pagina: number; x: number; y: number };
  /** Solo recetas: lo que autoriza dispensar. */
  prescripcion?: IPrescripcion;
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
  /** Última etapa del registro calculada al guardar (para avisar los cambios de etapa). */
  etapaRegistro?: EtapaRegistro;
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

const itemPrescripcionSchema = new Schema<IItemPrescripcion>(
  {
    tipoProducto: {
      type: String,
      enum: ['flor', 'aceite', 'crema', 'capsula', 'tintura', 'comestible', 'otro'],
      required: true,
    },
    producto: { type: Schema.Types.ObjectId, ref: 'Product' },
    nombreProducto: { type: String },
    descripcion: { type: String, trim: true, maxlength: 300 },
    cantidadMensual: { type: Number, min: 0 },
  },
  { _id: true }
);

const prescripcionSchema = new Schema<IPrescripcion>(
  {
    items: { type: [itemPrescripcionSchema], default: [] },
    indicaciones: { type: String, trim: true, maxlength: 1000 },
    registradoPor: { type: Schema.Types.ObjectId, ref: 'User' },
    fecha: { type: Date },
  },
  { _id: false }
);

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
    contrafirma: documentSignatureSchema,
    generado: {
      type: new Schema({ plantillaVersion: Number, fecha: Date }, { _id: false }),
      default: undefined,
    },
    posicionFirma: {
      type: new Schema({ pagina: Number, x: Number, y: Number }, { _id: false }),
      default: undefined,
    },
    prescripcion: { type: prescripcionSchema, default: undefined },
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
    etapaRegistro: { type: String, enum: ETAPAS_REGISTRO },
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

/**
 * Ganchos al guardar un paciente. Los registra services/etapas.ts (avisos de cambio de etapa y
 * activación automática); se dejan como referencia para no importar servicios desde el modelo.
 */
export const ganchosPaciente: {
  alCargar?: (patient: IPatient) => void;
  antesDeGuardar?: (patient: IPatient) => void;
  despuesDeGuardar?: (patient: IPatient) => void;
} = {};

patientSchema.post('init', function (doc) {
  ganchosPaciente.alCargar?.(doc as IPatient);
});
patientSchema.pre('save', function () {
  ganchosPaciente.antesDeGuardar?.(this as IPatient);
});
patientSchema.post('save', function (doc) {
  ganchosPaciente.despuesDeGuardar?.(doc as IPatient);
});

export const Patient = mongoose.model<IPatient>('Patient', patientSchema);
