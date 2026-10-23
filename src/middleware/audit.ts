import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { redact, registrarAuditoria } from '../services/audit';

/**
 * Registra en auditoría las respuestas exitosas de la ruta.
 * Guarda usuario, dispensario, IP, navegador, acción y el body sin contraseñas.
 */
export const auditLog = (accion: string, entidad: string) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const originalJson = res.json.bind(res);

    res.json = function (body: unknown) {
      if (res.statusCode >= 200 && res.statusCode < 300 && req.user) {
        const bodyId = (body as Record<string, unknown> | null)?._id;
        void registrarAuditoria({
          req,
          usuario: String(req.user._id),
          sucursal: req.sucursalId,
          accion,
          entidad,
          entidadId: (req.params.id as string) || (bodyId ? String(bodyId) : undefined),
          detalles: {
            method: req.method,
            path: req.originalUrl,
            body: req.method !== 'GET' ? redact(req.body) : undefined,
          },
        });
      }
      return originalJson(body);
    };

    next();
  };
};
