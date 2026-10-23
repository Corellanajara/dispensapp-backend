import { Router, Response } from 'express';
import { AuditLog } from '../models/AuditLog';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { resolveSucursal, getSucursalFilter } from '../middleware/sucursal';

const router = Router();

// GET /api/audit
router.get(
  '/',
  authenticate,
  authorize('admin'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const {
        page = '1',
        limit = '50',
        usuario,
        entidad,
        entidadId,
        accion,
        resultado,
        desde,
        hasta,
      } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = { ...getSucursalFilter(req) };
      if (usuario) filter.usuario = usuario;
      if (entidad) filter.entidad = entidad;
      if (entidadId) filter.entidadId = entidadId;
      if (accion) filter.accion = accion;
      if (resultado) filter.resultado = resultado;
      if (desde || hasta) {
        filter.createdAt = {};
        if (desde) (filter.createdAt as Record<string, unknown>).$gte = new Date(desde);
        if (hasta) {
          const h = new Date(hasta);
          h.setUTCHours(23, 59, 59, 999);
          (filter.createdAt as Record<string, unknown>).$lte = h;
        }
      }

      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

      const [logs, total] = await Promise.all([
        AuditLog.find(filter)
          .populate('usuario', 'nombre apellido email role')
          .populate('sucursal', 'nombre codigo')
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        AuditLog.countDocuments(filter),
      ]);

      res.json({
        data: logs,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      console.error('Get audit logs error:', error);
      res.status(500).json({ message: 'Error al obtener logs de auditoría.' });
    }
  }
);

export default router;
