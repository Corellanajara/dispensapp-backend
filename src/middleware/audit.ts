import { Response, NextFunction } from 'express';
import { AuditLog } from '../models/AuditLog';
import { AuthRequest } from './auth';

export const auditLog = (accion: string, entidad: string) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const originalJson = res.json.bind(res);

    res.json = function (body: unknown) {
      if (res.statusCode >= 200 && res.statusCode < 300 && req.user) {
        AuditLog.create({
          usuario: req.user._id,
          accion,
          entidad,
          entidadId: (req.params.id as string) || ((body as Record<string, unknown>)?._id as unknown as string) || undefined,
          detalles: {
            method: req.method,
            path: req.originalUrl,
            body: req.method !== 'GET' ? req.body : undefined,
          },
          ip: req.ip,
        }).catch((err: Error) => console.error('Error creating audit log:', err));
      }
      return originalJson(body);
    };

    next();
  };
};
