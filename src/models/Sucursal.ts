import mongoose, { Schema, Document } from 'mongoose';

export interface ISucursal extends Document {
  nombre: string;
  codigo: string;
  direccion: {
    calle: string;
    numero: string;
    comuna: string;
    ciudad: string;
    region: string;
  };
  telefono?: string;
  email?: string;
  horarioAtencion?: string;
  activo: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const sucursalSchema = new Schema<ISucursal>(
  {
    nombre: {
      type: String,
      required: true,
      trim: true,
    },
    codigo: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    direccion: {
      calle: { type: String, required: true },
      numero: { type: String, required: true },
      comuna: { type: String, required: true },
      ciudad: { type: String, required: true },
      region: { type: String, required: true },
    },
    telefono: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
    },
    horarioAtencion: {
      type: String,
    },
    activo: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

sucursalSchema.index({ activo: 1 });

export const Sucursal = mongoose.model<ISucursal>('Sucursal', sucursalSchema);
