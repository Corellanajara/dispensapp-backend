import mongoose, { Schema, Document, Types } from 'mongoose';

export type TransactionType = 'ingreso' | 'egreso';
export type ExpenseCategory =
  | 'produccion'
  | 'ventas'
  | 'administracion'
  | 'logistica'
  | 'marketing'
  | 'sueldos'
  | 'insumos'
  | 'proveedores'
  | 'otro';

export type IncomeSource = 'venta_productos' | 'pago_pedido' | 'otro';

export interface IFinanceTransaction extends Document {
  tipo: TransactionType;
  monto: number;
  descripcion: string;
  categoria: ExpenseCategory | IncomeSource;
  fecha: Date;
  referencia?: {
    tipo: 'orden' | 'produccion' | 'otro';
    id?: Types.ObjectId;
  };
  comprobante?: string;
  usuario: Types.ObjectId;
  observaciones?: string;
  createdAt: Date;
  updatedAt: Date;
}

const financeTransactionSchema = new Schema<IFinanceTransaction>(
  {
    tipo: {
      type: String,
      enum: ['ingreso', 'egreso'],
      required: true,
    },
    monto: {
      type: Number,
      required: true,
      min: 0,
    },
    descripcion: {
      type: String,
      required: true,
    },
    categoria: {
      type: String,
      enum: [
        'produccion',
        'ventas',
        'administracion',
        'logistica',
        'marketing',
        'sueldos',
        'insumos',
        'proveedores',
        'venta_productos',
        'pago_pedido',
        'otro',
      ],
      required: true,
    },
    fecha: {
      type: Date,
      required: true,
      default: Date.now,
    },
    referencia: {
      tipo: {
        type: String,
        enum: ['orden', 'produccion', 'otro'],
      },
      id: { type: Schema.Types.ObjectId },
    },
    comprobante: { type: String },
    usuario: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    observaciones: { type: String },
  },
  {
    timestamps: true,
  }
);

financeTransactionSchema.index({ tipo: 1 });
financeTransactionSchema.index({ categoria: 1 });
financeTransactionSchema.index({ fecha: -1 });

export const FinanceTransaction = mongoose.model<IFinanceTransaction>(
  'FinanceTransaction',
  financeTransactionSchema
);
