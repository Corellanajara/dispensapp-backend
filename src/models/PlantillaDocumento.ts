import mongoose, { Schema, Document, Types } from 'mongoose';
import { TIPOS_GENERADOS, TipoGenerado } from '../config/documentos';

/**
 * Texto del reglamento interno y del contrato que la plataforma genera para cada paciente.
 * Lo edita el administrador; cada vez que guarda sube la versión. Los documentos ya generados
 * conservan el texto con el que se crearon (queda la versión en el documento del paciente).
 */
export interface IPlantillaDocumento extends Document {
  tipo: TipoGenerado;
  titulo: string;
  contenido: string;
  version: number;
  actualizadoPor?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const plantillaSchema = new Schema<IPlantillaDocumento>(
  {
    tipo: { type: String, enum: TIPOS_GENERADOS, required: true, unique: true },
    titulo: { type: String, required: true, trim: true, maxlength: 200 },
    contenido: { type: String, required: true, maxlength: 60_000 },
    version: { type: Number, default: 1 },
    actualizadoPor: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const PlantillaDocumento = mongoose.model<IPlantillaDocumento>('PlantillaDocumento', plantillaSchema);
