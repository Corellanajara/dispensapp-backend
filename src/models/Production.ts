import mongoose, { Schema, Document, Types } from 'mongoose';

export type ProductionStatus = 'en_proceso' | 'completado' | 'cancelado';

export interface IRawMaterial {
  nombre: string;
  cantidad: number;
  unidad: string;
  lote?: string;
}

export interface IWaste {
  tipo: 'proceso' | 'calidad' | 'almacenamiento' | 'otro';
  cantidad: number;
  motivo: string;
  fecha: Date;
}

export interface IProduction extends Document {
  codigoProduccion: string;
  productoFinal: Types.ObjectId;
  lote: string;
  materiasPrimas: IRawMaterial[];
  cantidadInicial: number;
  cantidadProducida: number;
  mermas: IWaste[];
  totalMermas: number;
  estado: ProductionStatus;
  fechaInicio: Date;
  fechaFin?: Date;
  responsable: Types.ObjectId;
  observaciones?: string;
  createdAt: Date;
  updatedAt: Date;
}

const rawMaterialSchema = new Schema<IRawMaterial>(
  {
    nombre: { type: String, required: true },
    cantidad: { type: Number, required: true, min: 0 },
    unidad: { type: String, required: true },
    lote: { type: String },
  },
  { _id: false }
);

const wasteSchema = new Schema<IWaste>(
  {
    tipo: {
      type: String,
      enum: ['proceso', 'calidad', 'almacenamiento', 'otro'],
      required: true,
    },
    cantidad: { type: Number, required: true, min: 0 },
    motivo: { type: String, required: true },
    fecha: { type: Date, default: Date.now },
  },
  { _id: true }
);

const productionSchema = new Schema<IProduction>(
  {
    codigoProduccion: {
      type: String,
      required: true,
      unique: true,
    },
    productoFinal: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    lote: {
      type: String,
      required: true,
    },
    materiasPrimas: {
      type: [rawMaterialSchema],
      required: true,
    },
    cantidadInicial: {
      type: Number,
      required: true,
      min: 0,
    },
    cantidadProducida: {
      type: Number,
      default: 0,
      min: 0,
    },
    mermas: [wasteSchema],
    totalMermas: {
      type: Number,
      default: 0,
      min: 0,
    },
    estado: {
      type: String,
      enum: ['en_proceso', 'completado', 'cancelado'],
      default: 'en_proceso',
    },
    fechaInicio: {
      type: Date,
      required: true,
    },
    fechaFin: { type: Date },
    responsable: {
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

// codigoProduccion index already created by unique: true
productionSchema.index({ lote: 1 });
productionSchema.index({ estado: 1 });
productionSchema.index({ responsable: 1 });

export const Production = mongoose.model<IProduction>('Production', productionSchema);
