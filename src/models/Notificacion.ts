import mongoose, { Schema, Document, Types } from 'mongoose';

/** Aviso dentro de la app para un usuario (paciente o personal). */
export interface INotificacion extends Document {
  destinatario: Types.ObjectId;
  /** Evento que la originó, ej. "registro_revision". */
  tipo: string;
  titulo: string;
  mensaje: string;
  /** Ruta del frontend a la que lleva el aviso, ej. "/portal/perfil". */
  enlace?: string;
  paciente?: Types.ObjectId;
  leida: boolean;
  fechaLectura?: Date;
  createdAt: Date;
}

const notificacionSchema = new Schema<INotificacion>(
  {
    destinatario: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tipo: { type: String, required: true },
    titulo: { type: String, required: true },
    mensaje: { type: String, required: true },
    enlace: { type: String },
    paciente: { type: Schema.Types.ObjectId, ref: 'Patient' },
    leida: { type: Boolean, default: false },
    fechaLectura: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificacionSchema.index({ destinatario: 1, createdAt: -1 });
notificacionSchema.index({ destinatario: 1, leida: 1 });
// Los avisos se borran solos a los 180 días.
notificacionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export const Notificacion = mongoose.model<INotificacion>('Notificacion', notificacionSchema);
