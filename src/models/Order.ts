import mongoose, { Schema, Document, Types } from 'mongoose';
import { documentSignatureSchema } from './shared';

export type OrderStatus =
  | 'pendiente_revision'
  | 'aprobado'
  | 'en_preparacion'
  | 'listo_retiro'
  | 'en_despacho'
  | 'entregado'
  | 'cancelado';

export type DeliveryType = 'retiro' | 'despacho';

export type PaymentStatus =
  | 'pendiente'
  | 'procesando'
  | 'aprobado'
  | 'rechazado'
  | 'cancelado'
  | 'error';

export type SignatureStatus =
  | 'pendiente'
  | 'enviado'
  | 'firmado'
  | 'rechazado'
  | 'expirado'
  | 'error';

// ─── Sub-documentos ────────────────────────────────────────

/** Lote y fila de stock desde donde se descontó un ítem (trazabilidad paciente → lote). */
export interface IOrderItemAllocation {
  stock: Types.ObjectId;
  lote: string;
  cantidad: number;
  ubicacion?: Types.ObjectId;
  cosecha?: Types.ObjectId;
}

export interface IOrderItem {
  producto: Types.ObjectId;
  nombre: string;
  cantidad: number;
  /** Solo se usa si PAGOS_HABILITADOS=true. Si no, queda en 0. */
  precioUnitario: number;
  subtotal: number;
  lotes: IOrderItemAllocation[];
}

export interface IPaymentAttempt {
  transactionId: string;
  provider: string;
  monto: number;
  metodo: 'debito' | 'credito' | 'flow';
  cuotas?: number;
  estado: PaymentStatus;
  ultimosDigitos?: string;
  codigoAutorizacion?: string;
  mensaje?: string;
  fecha: Date;
  raw?: Record<string, unknown>;
  flowToken?: string;
  flowOrderNumber?: number;
  redirectUrl?: string;
}

export interface IOrderPayment {
  estado: PaymentStatus;
  montoTotal: number;
  montoPagado: number;
  intentos: IPaymentAttempt[];
}

export interface IOrderDocumentSignature {
  signatureId: string;
  provider: string;
  estado: SignatureStatus;
  signingUrl?: string;
  firmadoPor?: string;
  rutFirmante?: string;
  fechaFirma?: Date;
  archivoFirmado?: string;
}

export interface IOrderDocument {
  tipo: string;
  nombre: string;
  archivo: string;
  fechaSubida: Date;
  subidoPor?: Types.ObjectId;
  firma?: IOrderDocumentSignature;
}

// ─── Documento principal ───────────────────────────────────

export interface IOrder extends Document {
  numeroPedido: string;
  sucursal: Types.ObjectId;
  paciente: Types.ObjectId;
  items: IOrderItem[];
  total: number;
  estado: OrderStatus;
  /** Texto descriptivo de la receta (nombre del documento). */
  recetaMedica: string;
  /** Documento de receta del paciente vigente al crear la nota. */
  receta?: Types.ObjectId;
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
  pago?: IOrderPayment;
  documentos: IOrderDocument[];
  historialEstados: {
    estado: string;
    fecha: Date;
    usuario?: Types.ObjectId;
    observacion?: string;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schemas ───────────────────────────────────────────────

const allocationSchema = new Schema<IOrderItemAllocation>(
  {
    stock: { type: Schema.Types.ObjectId, ref: 'SucursalStock', required: true },
    lote: { type: String, required: true },
    cantidad: { type: Number, required: true, min: 0 },
    ubicacion: { type: Schema.Types.ObjectId, ref: 'Ubicacion' },
    cosecha: { type: Schema.Types.ObjectId, ref: 'Cosecha' },
  },
  { _id: false }
);

const orderItemSchema = new Schema<IOrderItem>(
  {
    producto: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    nombre: { type: String, required: true },
    cantidad: { type: Number, required: true, min: 1 },
    precioUnitario: { type: Number, default: 0, min: 0 },
    subtotal: { type: Number, default: 0, min: 0 },
    lotes: { type: [allocationSchema], default: [] },
  },
  { _id: false }
);

const paymentAttemptSchema = new Schema(
  {
    transactionId: { type: String, required: true },
    provider: { type: String, required: true },
    monto: { type: Number, required: true },
    metodo: { type: String, enum: ['debito', 'credito', 'flow'], required: true },
    cuotas: { type: Number },
    estado: {
      type: String,
      enum: ['pendiente', 'procesando', 'aprobado', 'rechazado', 'cancelado', 'error'],
      required: true,
    },
    ultimosDigitos: { type: String },
    codigoAutorizacion: { type: String },
    mensaje: { type: String },
    fecha: { type: Date, default: Date.now },
    raw: { type: Schema.Types.Mixed },
    flowToken: { type: String },
    flowOrderNumber: { type: Number },
    redirectUrl: { type: String },
  },
  { _id: true }
);

const orderPaymentSchema = new Schema(
  {
    estado: {
      type: String,
      enum: ['pendiente', 'procesando', 'aprobado', 'rechazado', 'cancelado', 'error'],
      default: 'pendiente',
    },
    montoTotal: { type: Number, required: true },
    montoPagado: { type: Number, default: 0 },
    intentos: [paymentAttemptSchema],
  },
  { _id: false }
);

const orderDocumentSchema = new Schema(
  {
    tipo: { type: String, required: true },
    nombre: { type: String, required: true },
    archivo: { type: String, required: true },
    fechaSubida: { type: Date, default: Date.now },
    subidoPor: { type: Schema.Types.ObjectId, ref: 'User' },
    firma: documentSignatureSchema,
  },
  { _id: true }
);

const orderSchema = new Schema<IOrder>(
  {
    numeroPedido: {
      type: String,
      required: true,
      unique: true,
    },
    sucursal: {
      type: Schema.Types.ObjectId,
      ref: 'Sucursal',
      required: true,
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
    receta: {
      type: Schema.Types.ObjectId,
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
    pago: orderPaymentSchema,
    documentos: [orderDocumentSchema],
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
orderSchema.index({ sucursal: 1, estado: 1, createdAt: -1 });
orderSchema.index({ paciente: 1 });
orderSchema.index({ estado: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ 'items.lotes.lote': 1 });

export const Order = mongoose.model<IOrder>('Order', orderSchema);
