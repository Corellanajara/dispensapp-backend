import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Lugar físico dentro de un dispensario.
 * - sala_cultivo: donde están los espacios de cultivo cedidos.
 * - bodega: almacenamiento (cosecha, producto terminado).
 * - dispensario: punto de entrega al paciente. Solo el stock aquí (o sin ubicación) se puede dispensar.
 */
export type UbicacionTipo = 'sala_cultivo' | 'bodega' | 'dispensario';

export const UBICACION_TIPOS: UbicacionTipo[] = ['sala_cultivo', 'bodega', 'dispensario'];

export interface IUbicacion extends Document {
  sucursal: Types.ObjectId;
  nombre: string;
  codigo: string;
  tipo: UbicacionTipo;
  /** Ubicación contenedora (ej. un estante dentro de una bodega). Opcional. */
  padre?: Types.ObjectId;
  descripcion?: string;
  activo: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ubicacionSchema = new Schema<IUbicacion>(
  {
    sucursal: { type: Schema.Types.ObjectId, ref: 'Sucursal', required: true },
    nombre: { type: String, required: true, trim: true },
    codigo: { type: String, required: true, uppercase: true, trim: true },
    tipo: { type: String, enum: UBICACION_TIPOS, required: true },
    padre: { type: Schema.Types.ObjectId, ref: 'Ubicacion' },
    descripcion: { type: String },
    activo: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ubicacionSchema.index({ sucursal: 1, codigo: 1 }, { unique: true });
ubicacionSchema.index({ sucursal: 1, tipo: 1, activo: 1 });

export const Ubicacion = mongoose.model<IUbicacion>('Ubicacion', ubicacionSchema);
