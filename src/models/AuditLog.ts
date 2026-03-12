import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IAuditLog extends Document {
  usuario: Types.ObjectId;
  accion: string;
  entidad: string;
  entidadId?: Types.ObjectId;
  detalles?: Record<string, unknown>;
  ip?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    usuario: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
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
    detalles: {
      type: Schema.Types.Mixed,
    },
    ip: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

auditLogSchema.index({ usuario: 1 });
auditLogSchema.index({ entidad: 1 });
auditLogSchema.index({ createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
