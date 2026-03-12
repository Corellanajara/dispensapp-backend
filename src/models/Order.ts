import mongoose, { Schema, Document, Types } from 'mongoose';

export type OrderStatus =
  | 'pendiente_revision'
  | 'aprobado'
  | 'en_preparacion'
  | 'listo_retiro'
  | 'en_despacho'
  | 'entregado'
  | 'cancelado';

export type DeliveryType = 'retiro' | 'despacho';

export interface IOrderItem {
  producto: Types.ObjectId;
  nombre: string;
  cantidad: number;
  precioUnitario: number;
  subtotal: number;
}

export interface IOrder extends Document {
  numeroPedido: string;
  paciente: Types.ObjectId;
  items: IOrderItem[];
  total: number;
  estado: OrderStatus;
  recetaMedica: string;
  tipoEntrega: DeliveryType;
  direccionEntrega?: {
    calle: string;
    numero: string;
    comuna: string;
    ciudad: string;
    region: string;
  };
  fechaRetiroProgramado?: Date;
  fechaEntrega?: Date;
  observaciones?: string;
  aprobadoPor?: Types.ObjectId;
  preparadoPor?: Types.ObjectId;
  historialEstados: {
    estado: OrderStatus;
    fecha: Date;
    usuario?: Types.ObjectId;
    observacion?: string;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    producto: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    nombre: { type: String, required: true },
    cantidad: { type: Number, required: true, min: 1 },
    precioUnitario: { type: Number, required: true, min: 0 },
    subtotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const orderSchema = new Schema<IOrder>(
  {
    numeroPedido: {
      type: String,
      required: true,
      unique: true,
    },
    paciente: {
      type: Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
    },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (v: IOrderItem[]) => v.length > 0,
        message: 'El pedido debe tener al menos un producto',
      },
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    estado: {
      type: String,
      enum: [
        'pendiente_revision',
        'aprobado',
        'en_preparacion',
        'listo_retiro',
        'en_despacho',
        'entregado',
        'cancelado',
      ],
      default: 'pendiente_revision',
    },
    recetaMedica: {
      type: String,
      required: true,
    },
    tipoEntrega: {
      type: String,
      enum: ['retiro', 'despacho'],
      required: true,
    },
    direccionEntrega: {
      calle: String,
      numero: String,
      comuna: String,
      ciudad: String,
      region: String,
    },
    fechaRetiroProgramado: { type: Date },
    fechaEntrega: { type: Date },
    observaciones: { type: String },
    aprobadoPor: { type: Schema.Types.ObjectId, ref: 'User' },
    preparadoPor: { type: Schema.Types.ObjectId, ref: 'User' },
    historialEstados: [
      {
        estado: { type: String, required: true },
        fecha: { type: Date, default: Date.now },
        usuario: { type: Schema.Types.ObjectId, ref: 'User' },
        observacion: { type: String },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// numeroPedido index already created by unique: true
orderSchema.index({ paciente: 1 });
orderSchema.index({ estado: 1 });
orderSchema.index({ createdAt: -1 });

export const Order = mongoose.model<IOrder>('Order', orderSchema);
