import { Request } from 'express';
import { Types } from 'mongoose';
import { AuditLog } from '../models/AuditLog';

const SENSITIVE_KEYS = ['password', 'newpassword', 'currentpassword', 'token', 'secret'];

/** Copia del body sin contraseñas ni tokens, para guardar en auditoría. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.includes(k.toLowerCase()) ? '[oculto]' : redact(v);
    }
    return out;
  }
  return value;
}

interface AuditEntry {
  req?: Request;
  usuario?: Types.ObjectId | string;
  email?: string;
  sucursal?: Types.ObjectId | string;
  accion: string;
  entidad: string;
  entidadId?: Types.ObjectId | string;
  resultado?: 'exito' | 'fallo';
  detalles?: Record<string, unknown>;
}

/**
 * Registra un evento de auditoría. Nunca lanza error: si falla, solo lo deja en consola.
 */
export async function registrarAuditoria(entry: AuditEntry): Promise<void> {
  try {
    await AuditLog.create({
      usuario: entry.usuario,
      email: entry.email,
      sucursal: entry.sucursal,
      accion: entry.accion,
      entidad: entry.entidad,
      entidadId:
        entry.entidadId && Types.ObjectId.isValid(String(entry.entidadId)) ? entry.entidadId : undefined,
      resultado: entry.resultado || 'exito',
      detalles: entry.detalles,
      ip: entry.req?.ip,
      userAgent: entry.req?.get('user-agent')?.slice(0, 300),
    });
  } catch (err) {
    console.error('Error creating audit log:', err);
  }
}
