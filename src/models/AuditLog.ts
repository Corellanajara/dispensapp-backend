import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IAuditLog extends Document {
  sucursal?: Types.ObjectId;
  /** Usuario que hizo la acción. Vacío en acciones del sistema o en logins fallidos de emails desconocidos. */
  usuario?: Types.ObjectId;
  /** Email usado (solo en eventos de login). */
  email?: string;
  accion: string;
  entidad: string;
  entidadId?: Types.ObjectId;
  resultado: 'exito' | 'fallo';
  detalles?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    sucursal: {
      type: Schema.Types.ObjectId,
      ref: 'Sucursal',
    },
    usuario: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
    },
    accion: {
      type: String,
      required: true,
    },
    entidad: {
      type: String,
      required: true,
    },
    entidadId: {
      type: Schema.Types.ObjectId,
    },
    resultado: {
      type: String,
      enum: ['exito', 'fallo'],
      default: 'exito',
    },
    detalles: {
      type: Schema.Types.Mixed,
    },
    ip: {
      type: String,
    },
    userAgent: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

auditLogSchema.index({ sucursal: 1, createdAt: -1 });
auditLogSchema.index({ usuario: 1 });
auditLogSchema.index({ entidad: 1 });
auditLogSchema.index({ entidadId: 1, createdAt: -1 });
auditLogSchema.index({ accion: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
