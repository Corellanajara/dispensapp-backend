import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Traslado trazable de stock entre ubicaciones (ej. sala o bodega → dispensario).
 * Puede ser dentro del mismo dispensario o entre dispensarios.
 * Al enviar, el stock sale del origen y queda "en tránsito" hasta que el destino lo recibe.
 */
export type TransferenciaEstado = 'en_transito' | 'recibida' | 'anulada';

export interface ITransferenciaItem {
  producto: Types.ObjectId;
  nombre: string;
  lote: string;
  cantidad: number;
  /** Fila de stock de origen. */
  stockOrigen: Types.ObjectId;
  /** Fila de stock de destino (se completa al recibir). */
  stockDestino?: Types.ObjectId;
  cosecha?: Types.ObjectId;
  fechaVencimiento?: Date;
}

export interface ITransferencia extends Document {
  codigo: string;
  sucursalOrigen: Types.ObjectId;
  ubicacionOrigen?: Types.ObjectId;
  sucursalDestino: Types.ObjectId;
  ubicacionDestino?: Types.ObjectId;
  items: ITransferenciaItem[];
  estado: TransferenciaEstado;
  enviadoPor: Types.ObjectId;
  fechaEnvio: Date;
  recibidoPor?: Types.ObjectId;
  fechaRecepcion?: Date;
  anuladoPor?: Types.ObjectId;
  fechaAnulacion?: Date;
  observaciones?: string;
  createdAt: Date;
  updatedAt: Date;
}

const itemSchema = new Schema<ITransferenciaItem>(
  {
    producto: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    nombre: { type: String, required: true },
    lote: { type: String, required: true },
    cantidad: { type: Number, required: true, min: 0 },
    stockOrigen: { type: Schema.Types.ObjectId, ref: 'SucursalStock', required: true },
    stockDestino: { type: Schema.Types.ObjectId, ref: 'SucursalStock' },
    cosecha: { type: Schema.Types.ObjectId, ref: 'Cosecha' },
    fechaVencimiento: { type: Date },
  },
  { _id: false }
);

const transferenciaSchema = new Schema<ITransferencia>(
  {
    codigo: { type: String, required: true, unique: true },
    sucursalOrigen: { type: Schema.Types.ObjectId, ref: 'Sucursal', required: true },
    ubicacionOrigen: { type: Schema.Types.ObjectId, ref: 'Ubicacion' },
    sucursalDestino: { type: Schema.Types.ObjectId, ref: 'Sucursal', required: true },
    ubicacionDestino: { type: Schema.Types.ObjectId, ref: 'Ubicacion' },
    items: {
      type: [itemSchema],
      validate: {
        validator: (v: ITransferenciaItem[]) => v.length > 0,
        message: 'La transferencia debe tener al menos un ítem',
      },
    },
    estado: {
      type: String,
      enum: ['en_transito', 'recibida', 'anulada'],
      default: 'en_transito',
    },
    enviadoPor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fechaEnvio: { type: Date, default: Date.now },
    recibidoPor: { type: Schema.Types.ObjectId, ref: 'User' },
    fechaRecepcion: { type: Date },
    anuladoPor: { type: Schema.Types.ObjectId, ref: 'User' },
    fechaAnulacion: { type: Date },
    observaciones: { type: String },
  },
  { timestamps: true }
);

transferenciaSchema.index({ sucursalOrigen: 1, createdAt: -1 });
transferenciaSchema.index({ sucursalDestino: 1, estado: 1 });
transferenciaSchema.index({ 'items.lote': 1 });

export const Transferencia = mongoose.model<ITransferencia>('Transferencia', transferenciaSchema);
