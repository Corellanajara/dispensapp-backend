import mongoose, { Schema, Document, Types } from 'mongoose';

export type MovementType = 'produccion' | 'ingreso' | 'ajuste' | 'venta' | 'merma' | 'transferencia';

export interface IInventoryMovement extends Document {
  producto: Types.ObjectId;
  tipo: MovementType;
  cantidad: number;
  cantidadAnterior: number;
  cantidadNueva: number;
  lote: string;
  motivo: string;
  referencia?: {
    tipo: 'orden' | 'produccion' | 'ajuste';
    id: Types.ObjectId;
  };
  usuario: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const inventoryMovementSchema = new Schema<IInventoryMovement>(
  {
    producto: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    tipo: {
      type: String,
      enum: ['produccion', 'ingreso', 'ajuste', 'venta', 'merma', 'transferencia'],
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
    motivo: {
      type: String,
      required: true,
    },
    referencia: {
      tipo: {
        type: String,
        enum: ['orden', 'produccion', 'ajuste'],
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

inventoryMovementSchema.index({ producto: 1 });
inventoryMovementSchema.index({ tipo: 1 });
inventoryMovementSchema.index({ lote: 1 });
inventoryMovementSchema.index({ createdAt: -1 });

export const InventoryMovement = mongoose.model<IInventoryMovement>(
  'InventoryMovement',
  inventoryMovementSchema
);
