import mongoose, { Schema, Document, Types } from 'mongoose';
import { DOCUMENT_TYPES, DocumentType } from '../config/documentos';

/**
 * Estampa visible de la firma en el PDF (tipos de Signapis):
 * 1 = sello estándar con nombre, RUT y fecha · 2 = texto personalizado · 5 = sin estampa visible.
 */
export type TipoEstampa = 1 | 2 | 5;

export interface IConfigFirma {
  /** Interruptor general: si está apagado ningún documento exige ni ofrece firma. */
  habilitada: boolean;
  /** Tipos de documento del paciente que se firman electrónicamente. */
  tiposConFirma: DocumentType[];
  tipoEstampa: TipoEstampa;
  /** Texto de la estampa cuando tipoEstampa = 2 (máximo 120 caracteres). */
  textoEstampa?: string;
  /**
   * Agrega un QR de validación a la estampa. Ojo: Signapis deja público el documento
   * para cualquiera que tenga el QR, por eso viene apagado.
   */
  conQR: boolean;
  /** Dónde va la estampa (pixeles desde la esquina superior izquierda). Vacío = Signapis decide. */
  posicion?: { pagina: number; x: number; y: number } | null;
  /** Años de vigencia del certificado que se pide al paciente (1, 2 o 3). */
  vigenciaCertificadoAnios: 1 | 2 | 3;
}

export interface IConfiguracion extends Document {
  clave: string;
  firma: IConfigFirma;
  actualizadoPor?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export const CONFIG_FIRMA_POR_DEFECTO: IConfigFirma = {
  habilitada: true,
  tiposConFirma: ['reglamento_interno', 'mandato_contrato'],
  tipoEstampa: 1,
  textoEstampa: '',
  conQR: false,
  posicion: null,
  vigenciaCertificadoAnios: 1,
};

const configFirmaSchema = new Schema<IConfigFirma>(
  {
    habilitada: { type: Boolean, default: CONFIG_FIRMA_POR_DEFECTO.habilitada },
    tiposConFirma: {
      type: [{ type: String, enum: DOCUMENT_TYPES }],
      default: CONFIG_FIRMA_POR_DEFECTO.tiposConFirma,
    },
    tipoEstampa: { type: Number, enum: [1, 2, 5], default: 1 },
    textoEstampa: { type: String, maxlength: 120, default: '' },
    conQR: { type: Boolean, default: false },
    posicion: {
      type: new Schema(
        {
          pagina: { type: Number, min: 1, required: true },
          x: { type: Number, min: 0, required: true },
          y: { type: Number, min: 0, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    vigenciaCertificadoAnios: { type: Number, enum: [1, 2, 3], default: 1 },
  },
  { _id: false }
);

const configuracionSchema = new Schema<IConfiguracion>(
  {
    // Un solo documento con clave "general".
    clave: { type: String, required: true, unique: true, default: 'general' },
    firma: { type: configFirmaSchema, default: () => ({ ...CONFIG_FIRMA_POR_DEFECTO }) },
    actualizadoPor: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const Configuracion = mongoose.model<IConfiguracion>('Configuracion', configuracionSchema);
