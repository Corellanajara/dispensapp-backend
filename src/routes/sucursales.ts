import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { Sucursal } from '../models/Sucursal';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';

const router = Router();

// GET /api/sucursales/publicas — lista mínima para el registro de pacientes (sin login)
router.get('/publicas', async (_req, res: Response): Promise<void> => {
  try {
    const sucursales = await Sucursal.find({ activo: true }).select('nombre codigo direccion.comuna direccion.ciudad').sort({ nombre: 1 });
    res.json(sucursales);
  } catch (error) {
    console.error('Get public sucursales error:', error);
    res.status(500).json({ message: 'Error al obtener dispensarios.' });
  }
});

// GET /api/sucursales
router.get(
  '/',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { activo } = req.query as Record<string, string>;
      const filter: Record<string, unknown> = {};
      if (activo !== undefined) filter.activo = activo === 'true';

      if (req.user!.role !== 'admin') {
        const ids = req.user!.sucursales || [];
        filter._id = { $in: ids };
      }

      const sucursales = await Sucursal.find(filter).sort({ nombre: 1 });
      res.json(sucursales);
    } catch (error) {
      console.error('Get sucursales error:', error);
      res.status(500).json({ message: 'Error al obtener sucursales.' });
    }
  }
);

// GET /api/sucursales/:id
router.get(
  '/:id',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      if (req.user!.role !== 'admin' && !(req.user!.sucursales || []).map(String).includes(String(req.params.id))) {
        res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
        return;
      }
      const sucursal = await Sucursal.findById(req.params.id);
      if (!sucursal) {
        res.status(404).json({ message: 'Sucursal no encontrada.' });
        return;
      }
      res.json(sucursal);
    } catch (error) {
      console.error('Get sucursal error:', error);
      res.status(500).json({ message: 'Error al obtener sucursal.' });
    }
  }
);

// POST /api/sucursales
router.post(
  '/',
  authenticate,
  authorize('admin'),
  auditLog('crear', 'sucursal'),
  [
    body('nombre').notEmpty().withMessage('Nombre es requerido'),
    body('codigo').notEmpty().withMessage('Código es requerido'),
    body('direccion.calle').notEmpty().withMessage('Calle es requerida'),
    body('direccion.numero').notEmpty().withMessage('Número es requerido'),
    body('direccion.comuna').notEmpty().withMessage('Comuna es requerida'),
    body('direccion.ciudad').notEmpty().withMessage('Ciudad es requerida'),
    body('direccion.region').notEmpty().withMessage('Región es requerida'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const existing = await Sucursal.findOne({ codigo: req.body.codigo.toUpperCase() });
      if (existing) {
        res.status(400).json({ message: 'Ya existe una sucursal con este código.' });
        return;
      }

      const sucursal = new Sucursal(req.body);
      await sucursal.save();
      res.status(201).json(sucursal);
    } catch (error) {
      console.error('Create sucursal error:', error);
      res.status(500).json({ message: 'Error al crear sucursal.' });
    }
  }
);

// PUT /api/sucursales/:id
router.put(
  '/:id',
  authenticate,
  authorize('admin'),
  auditLog('actualizar', 'sucursal'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const sucursal = await Sucursal.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
      });
      if (!sucursal) {
        res.status(404).json({ message: 'Sucursal no encontrada.' });
        return;
      }
      res.json(sucursal);
    } catch (error) {
      console.error('Update sucursal error:', error);
      res.status(500).json({ message: 'Error al actualizar sucursal.' });
    }
  }
);

// PATCH /api/sucursales/:id/toggle-active
router.patch(
  '/:id/toggle-active',
  authenticate,
  authorize('admin'),
  auditLog('toggle_activo', 'sucursal'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const sucursal = await Sucursal.findById(req.params.id);
      if (!sucursal) {
        res.status(404).json({ message: 'Sucursal no encontrada.' });
        return;
      }

      sucursal.activo = !sucursal.activo;
      await sucursal.save();
      res.json(sucursal);
    } catch (error) {
      console.error('Toggle sucursal active error:', error);
      res.status(500).json({ message: 'Error al cambiar estado de sucursal.' });
    }
  }
);

export default router;
