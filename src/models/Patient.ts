import mongoose, { Schema, Document, Types } from 'mongoose';

export type PatientStatus = 'pendiente' | 'aprobado' | 'rechazado' | 'suspendido';

export interface IDocument {
  tipo: 'receta_medica' | 'certificado_antecedentes' | 'cedula_identidad' | 'otro';
  nombre: string;
  archivo: string;
  fechaSubida: Date;
  fechaVencimiento?: Date;
  estado: 'pendiente' | 'aprobado' | 'rechazado';
  observaciones?: string;
}

export interface IPatient extends Document {
  usuario: Types.ObjectId;
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
  documentos: IDocument[];
  estado: PatientStatus;
  limiteCompra: number;
  observaciones?: string;
  createdAt: Date;
  updatedAt: Date;
}

const documentSchema = new Schema<IDocument>(
  {
    tipo: {
      type: String,
      enum: ['receta_medica', 'certificado_antecedentes', 'cedula_identidad', 'otro'],
      required: true,
    },
    nombre: { type: String, required: true },
    archivo: { type: String, required: true },
    fechaSubida: { type: Date, default: Date.now },
    fechaVencimiento: { type: Date },
    estado: {
      type: String,
      enum: ['pendiente', 'aprobado', 'rechazado'],
      default: 'pendiente',
    },
    observaciones: { type: String },
  },
  { _id: true }
);

const patientSchema = new Schema<IPatient>(
  {
    usuario: {
      type: Schema.Types.ObjectId,
      ref: 'User',
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
    estado: {
      type: String,
      enum: ['pendiente', 'aprobado', 'rechazado', 'suspendido'],
      default: 'pendiente',
    },
    limiteCompra: {
      type: Number,
      default: 0,
    },
    observaciones: { type: String },
  },
  {
    timestamps: true,
  }
);

// rut index already created by unique: true
patientSchema.index({ estado: 1 });
patientSchema.index({ 'medicoTratante.nombre': 1 });

export const Patient = mongoose.model<IPatient>('Patient', patientSchema);
