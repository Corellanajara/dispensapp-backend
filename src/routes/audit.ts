import { Router, Response } from 'express';
import { AuditLog } from '../models/AuditLog';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';

const router = Router();

// GET /api/audit
router.get(
  '/',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const {
        page = '1',
        limit = '50',
        usuario,
        entidad,
        desde,
        hasta,
      } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = {};
      if (usuario) filter.usuario = usuario;
      if (entidad) filter.entidad = entidad;
      if (desde || hasta) {
        filter.createdAt = {};
        if (desde) (filter.createdAt as Record<string, unknown>).$gte = new Date(desde);
        if (hasta) (filter.createdAt as Record<string, unknown>).$lte = new Date(hasta);
      }

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      const [logs, total] = await Promise.all([
        AuditLog.find(filter)
          .populate('usuario', 'nombre apellido email role')
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
