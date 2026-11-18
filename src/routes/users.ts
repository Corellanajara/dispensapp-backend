import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { User, USER_ROLES } from '../models/User';
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
          .populate('sucursales', 'nombre codigo')
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
      // Solo estos campos. La contraseña y el bloqueo no se tocan por aquí.
      const updateData: Record<string, unknown> = {};
      for (const k of ['nombre', 'apellido', 'telefono', 'role', 'sucursales', 'sucursalActiva', 'activo']) {
        if (req.body[k] !== undefined) updateData[k] = req.body[k];
      }
      if (req.body.responsableFirma !== undefined) updateData.responsableFirma = req.body.responsableFirma === true;
      if (updateData.role !== undefined && !USER_ROLES.includes(updateData.role as never)) {
        res.status(400).json({ message: 'Rol inválido.' });
        return;
      }
      if (updateData.role === 'paciente') {
        res.status(400).json({ message: 'No se puede convertir un usuario interno en paciente.' });
        return;
      }
      if (String(req.params.id) === String(req.user!._id) && updateData.role && updateData.role !== 'admin') {
        res.status(400).json({ message: 'No puedes quitarte el rol de administrador a ti mismo.' });
        return;
      }
      // Solo administradores y operadores pueden validar y contrafirmar documentos de pacientes.
      const actual = await User.findById(req.params.id).select('role');
      if (!actual) {
        res.status(404).json({ message: 'Usuario no encontrado.' });
        return;
      }
      const rolFinal = (updateData.role as string | undefined) ?? actual.role;
      if (!['admin', 'operador'].includes(rolFinal)) {
        if (updateData.responsableFirma === true) {
          res.status(400).json({ message: 'Solo un administrador u operador puede ser responsable de firma.' });
          return;
        }
        updateData.responsableFirma = false;
      }
      const user = await User.findByIdAndUpdate(req.params.id, updateData, {
        new: true,
        runValidators: true,
      }).populate('sucursales', 'nombre codigo');
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

      if (String(user._id) === String(req.user!._id)) {
        res.status(400).json({ message: 'No puedes desactivar tu propia cuenta.' });
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

// PATCH /api/users/:id/desbloquear — quita el bloqueo por intentos fallidos
router.patch(
  '/:id/desbloquear',
  authenticate,
  authorize('admin'),
  auditLog('desbloquear', 'usuario'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const user = await User.findByIdAndUpdate(
        req.params.id,
        { intentosFallidos: 0, $unset: { bloqueadoHasta: 1 } },
        { new: true }
      );
      if (!user) {
        res.status(404).json({ message: 'Usuario no encontrado.' });
        return;
      }
      res.json(user);
    } catch (error) {
      console.error('Unlock user error:', error);
      res.status(500).json({ message: 'Error al desbloquear usuario.' });
    }
  }
);

export default router;
