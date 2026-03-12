import mongoose, { Schema, Document } from 'mongoose';

export type ProductStatus = 'disponible' | 'reservado' | 'agotado';
export type ProductType = 'flor' | 'aceite' | 'crema' | 'capsula' | 'tintura' | 'comestible' | 'otro';

export interface IProduct extends Document {
  nombre: string;
  tipo: ProductType;
  descripcion?: string;
  concentracion?: string;
  presentacion?: string;
  usoTerapeutico?: string;
  precio: number;
  lote: string;
  fechaProduccion: Date;
  fechaVencimiento: Date;
  cantidadDisponible: number;
  cantidadReservada: number;
  estado: ProductStatus;
  imagen?: string;
  activo: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<IProduct>(
  {
    nombre: {
      type: String,
      required: true,
      trim: true,
    },
    tipo: {
      type: String,
      enum: ['flor', 'aceite', 'crema', 'capsula', 'tintura', 'comestible', 'otro'],
      required: true,
    },
    descripcion: { type: String },
    concentracion: { type: String },
    presentacion: { type: String },
    usoTerapeutico: { type: String },
    precio: {
      type: Number,
      required: true,
      min: 0,
    },
    lote: {
      type: String,
      required: true,
    },
    fechaProduccion: {
      type: Date,
      required: true,
    },
    fechaVencimiento: {
      type: Date,
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
    imagen: { type: String },
    activo: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

productSchema.index({ tipo: 1 });
productSchema.index({ lote: 1 });
productSchema.index({ estado: 1 });
productSchema.index({ nombre: 'text', descripcion: 'text' });

export const Product = mongoose.model<IProduct>('Product', productSchema);
