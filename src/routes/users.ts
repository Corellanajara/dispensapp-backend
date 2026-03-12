import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { User } from '../models/User';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';

const router = Router();

// GET /api/users
router.get(
  '/',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { page = '1', limit = '20', role, search } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = {};
      if (role) filter.role = role;
      if (search) {
        filter.$or = [
          { nombre: { $regex: search, $options: 'i' } },
          { apellido: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
        ];
      }

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      const [users, total] = await Promise.all([
        User.find(filter)
          .select('-password')
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        User.countDocuments(filter),
      ]);

      res.json({
        data: users,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      console.error('Get users error:', error);
      res.status(500).json({ message: 'Error al obtener usuarios.' });
    }
  }
);

// PUT /api/users/:id
router.put(
  '/:id',
  authenticate,
  authorize('admin'),
  auditLog('actualizar', 'usuario'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { password, ...updateData } = req.body;
      const user = await User.findByIdAndUpdate(req.params.id, updateData, {
        new: true,
        runValidators: true,
      });
      if (!user) {
        res.status(404).json({ message: 'Usuario no encontrado.' });
        return;
      }
      res.json(user);
    } catch (error) {
      console.error('Update user error:', error);
      res.status(500).json({ message: 'Error al actualizar usuario.' });
    }
  }
);

// PATCH /api/users/:id/toggle-active
router.patch(
  '/:id/toggle-active',
  authenticate,
  authorize('admin'),
  auditLog('toggle_activo', 'usuario'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const user = await User.findById(req.params.id);
      if (!user) {
        res.status(404).json({ message: 'Usuario no encontrado.' });
        return;
      }

      user.activo = !user.activo;
      await user.save();
      res.json(user);
    } catch (error) {
      console.error('Toggle user active error:', error);
      res.status(500).json({ message: 'Error al cambiar estado del usuario.' });
    }
  }
);

export default router;
