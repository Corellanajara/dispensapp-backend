import mongoose, { Schema, Document, Types } from 'mongoose';

export type StockStatus = 'disponible' | 'reservado' | 'agotado';

export interface ISucursalStock extends Document {
  sucursal: Types.ObjectId;
  producto: Types.ObjectId;
  cantidadDisponible: number;
  cantidadReservada: number;
  estado: StockStatus;
  precioLocal?: number;
  lote: string;
  /** Lugar físico. Vacío = stock general del dispensario (se puede dispensar). */
  ubicacion?: Types.ObjectId;
  /** Cosecha de origen, si el lote viene de cultivo. */
  cosecha?: Types.ObjectId;
  fechaProduccion?: Date;
  fechaVencimiento?: Date;
  activo: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const sucursalStockSchema = new Schema<ISucursalStock>(
  {
    sucursal: {
      type: Schema.Types.ObjectId,
      ref: 'Sucursal',
      required: true,
    },
    producto: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    cantidadDisponible: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    cantidadReservada: {
      type: Number,
      default: 0,
      min: 0,
    },
    estado: {
      type: String,
      enum: ['disponible', 'reservado', 'agotado'],
      default: 'disponible',
    },
    precioLocal: {
      type: Number,
      min: 0,
    },
    lote: {
      type: String,
      required: true,
    },
    ubicacion: {
      type: Schema.Types.ObjectId,
      ref: 'Ubicacion',
    },
    cosecha: {
      type: Schema.Types.ObjectId,
      ref: 'Cosecha',
    },
    fechaProduccion: { type: Date },
    fechaVencimiento: { type: Date },
    activo: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

sucursalStockSchema.index({ sucursal: 1, producto: 1 });
sucursalStockSchema.index({ sucursal: 1, estado: 1 });
sucursalStockSchema.index({ sucursal: 1, lote: 1 });
sucursalStockSchema.index({ producto: 1 });
sucursalStockSchema.index({ sucursal: 1, producto: 1, lote: 1, ubicacion: 1 });
sucursalStockSchema.index({ ubicacion: 1 });

export const SucursalStock = mongoose.model<ISucursalStock>(
  'SucursalStock',
  sucursalStockSchema
);
