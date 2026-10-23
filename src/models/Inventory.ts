import mongoose, { Schema, Document, Types } from 'mongoose';

export type MovementType =
  | 'produccion'
  | 'cosecha'
  | 'ingreso'
  | 'ajuste'
  | 'merma'
  | 'dispensacion'
  | 'transferencia_salida'
  | 'transferencia_entrada'
  | 'transferencia_anulada'
  // Tipos antiguos, se conservan para el historial existente.
  | 'venta'
  | 'transferencia';

export const MOVEMENT_TYPES: MovementType[] = [
  'produccion',
  'cosecha',
  'ingreso',
  'ajuste',
  'merma',
  'dispensacion',
  'transferencia_salida',
  'transferencia_entrada',
  'transferencia_anulada',
  'venta',
  'transferencia',
];

export type MovementReference = 'orden' | 'produccion' | 'ajuste' | 'cosecha' | 'transferencia';

export interface IInventoryMovement extends Document {
  sucursal: Types.ObjectId;
  producto: Types.ObjectId;
  tipo: MovementType;
  cantidad: number;
  cantidadAnterior: number;
  cantidadNueva: number;
  lote: string;
  ubicacion?: Types.ObjectId;
  /** Fila de stock afectada. */
  stock?: Types.ObjectId;
  motivo: string;
  referencia?: {
    tipo: MovementReference;
    id: Types.ObjectId;
  };
  usuario: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const inventoryMovementSchema = new Schema<IInventoryMovement>(
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
    tipo: {
      type: String,
      enum: MOVEMENT_TYPES,
      required: true,
    },
    cantidad: {
      type: Number,
      required: true,
    },
    cantidadAnterior: {
      type: Number,
      required: true,
    },
    cantidadNueva: {
      type: Number,
      required: true,
    },
    lote: {
      type: String,
      required: true,
    },
    ubicacion: {
      type: Schema.Types.ObjectId,
      ref: 'Ubicacion',
    },
    stock: {
      type: Schema.Types.ObjectId,
      ref: 'SucursalStock',
    },
    motivo: {
      type: String,
      required: true,
    },
    referencia: {
      tipo: {
        type: String,
        enum: ['orden', 'produccion', 'ajuste', 'cosecha', 'transferencia'],
      },
      id: {
        type: Schema.Types.ObjectId,
      },
    },
    usuario: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

inventoryMovementSchema.index({ sucursal: 1, producto: 1, createdAt: -1 });
inventoryMovementSchema.index({ producto: 1 });
inventoryMovementSchema.index({ tipo: 1 });
inventoryMovementSchema.index({ lote: 1 });
inventoryMovementSchema.index({ createdAt: -1 });
inventoryMovementSchema.index({ 'referencia.tipo': 1, 'referencia.id': 1 });

export const InventoryMovement = mongoose.model<IInventoryMovement>(
  'InventoryMovement',
  inventoryMovementSchema
);
