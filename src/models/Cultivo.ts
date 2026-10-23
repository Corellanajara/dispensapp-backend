import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Espacio de cultivo cedido a un paciente dentro de una sala.
 * Cadena del PDF: Paciente → Espacio cedido (m²) → Flor indicada → Código QR → Ubicación.
 * Un QR por espacio (por validar: cardinalidad y datos del QR).
 */
export type EspacioEstado = 'activo' | 'cerrado';

export interface IEspacioCultivo extends Document {
  sucursal: Types.ObjectId;
  paciente: Types.ObjectId;
  ubicacion: Types.ObjectId;
  codigo: string;
  /** Token aleatorio que va dentro del QR. No revela datos del paciente. */
  codigoQR: string;
  metrosCuadrados: number;
  /** Tipo de flor o variedad indicada. */
  flor: string;
  estado: EspacioEstado;
  fechaInicio: Date;
  fechaCierre?: Date;
  observaciones?: string;
  creadoPor: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const espacioSchema = new Schema<IEspacioCultivo>(
  {
    sucursal: { type: Schema.Types.ObjectId, ref: 'Sucursal', required: true },
    paciente: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    ubicacion: { type: Schema.Types.ObjectId, ref: 'Ubicacion', required: true },
    codigo: { type: String, required: true, unique: true },
    codigoQR: { type: String, required: true, unique: true },
    metrosCuadrados: { type: Number, required: true, min: 0 },
    flor: { type: String, required: true, trim: true },
    estado: { type: String, enum: ['activo', 'cerrado'], default: 'activo' },
    fechaInicio: { type: Date, required: true, default: Date.now },
    fechaCierre: { type: Date },
    observaciones: { type: String },
    creadoPor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

espacioSchema.index({ sucursal: 1, estado: 1 });
espacioSchema.index({ paciente: 1 });
espacioSchema.index({ ubicacion: 1 });

export const EspacioCultivo = mongoose.model<IEspacioCultivo>('EspacioCultivo', espacioSchema);

/**
 * Cosecha de un espacio. Genera un lote que se puede ingresar a inventario,
 * para mantener la trazabilidad paciente → espacio → cosecha → lote → dispensación.
 */
export type CosechaEstado = 'registrada' | 'en_inventario';

export interface ICosecha extends Document {
  sucursal: Types.ObjectId;
  espacio: Types.ObjectId;
  paciente: Types.ObjectId;
  lote: string;
  fecha: Date;
  /** Peso en gramos. */
  pesoHumedo?: number;
  pesoSeco?: number;
  /** Producto (tipo flor) con el que se ingresó a inventario. */
  producto?: Types.ObjectId;
  /** Cantidad ingresada a inventario, en unidades del producto. */
  cantidadIngresada?: number;
  ubicacionDestino?: Types.ObjectId;
  estado: CosechaEstado;
  responsable: Types.ObjectId;
  observaciones?: string;
  createdAt: Date;
  updatedAt: Date;
}

const cosechaSchema = new Schema<ICosecha>(
  {
    sucursal: { type: Schema.Types.ObjectId, ref: 'Sucursal', required: true },
    espacio: { type: Schema.Types.ObjectId, ref: 'EspacioCultivo', required: true },
    paciente: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    lote: { type: String, required: true, unique: true },
    fecha: { type: Date, required: true, default: Date.now },
    pesoHumedo: { type: Number, min: 0 },
    pesoSeco: { type: Number, min: 0 },
    producto: { type: Schema.Types.ObjectId, ref: 'Product' },
    cantidadIngresada: { type: Number, min: 0 },
    ubicacionDestino: { type: Schema.Types.ObjectId, ref: 'Ubicacion' },
    estado: { type: String, enum: ['registrada', 'en_inventario'], default: 'registrada' },
    responsable: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    observaciones: { type: String },
  },
  { timestamps: true }
);

cosechaSchema.index({ sucursal: 1, fecha: -1 });
cosechaSchema.index({ espacio: 1 });
cosechaSchema.index({ paciente: 1 });

export const Cosecha = mongoose.model<ICosecha>('Cosecha', cosechaSchema);
