import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { Ubicacion, UBICACION_TIPOS } from '../models/Ubicacion';
import { SucursalStock } from '../models/SucursalStock';
import { EspacioCultivo } from '../models/Cultivo';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { resolveSucursal, getSucursalFilter, canAccessSucursal } from '../middleware/sucursal';
import { auditLog } from '../middleware/audit';

/** Salas de cultivo, bodegas y puntos de dispensación de cada sucursal. */
const router = Router();

// GET /api/ubicaciones
router.get(
  '/',
  authenticate,
  authorize('admin', 'operador', 'cultivo', 'produccion'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { tipo, activo } = req.query as Record<string, string>;
      const filter: Record<string, unknown> = { ...getSucursalFilter(req) };
      if (tipo) filter.tipo = tipo;
      if (activo !== undefined) filter.activo = activo === 'true';

      const ubicaciones = await Ubicacion.find(filter)
        .populate('sucursal', 'nombre codigo')
        .populate('padre', 'nombre codigo')
        .sort({ tipo: 1, nombre: 1 });
      res.json(ubicaciones);
    } catch (error) {
      console.error('Get ubicaciones error:', error);
      res.status(500).json({ message: 'Error al obtener ubicaciones.' });
    }
  }
);

// GET /api/ubicaciones/:id — con su stock y espacios de cultivo
router.get(
  '/:id',
  authenticate,
  authorize('admin', 'operador', 'cultivo', 'produccion'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
        res.status(400).json({ message: 'ID inválido.' });
        return;
      }
      const ubicacion = await Ubicacion.findById(req.params.id)
        .populate('sucursal', 'nombre codigo')
        .populate('padre', 'nombre codigo');
      if (!ubicacion) {
        res.status(404).json({ message: 'Ubicación no encontrada.' });
        return;
      }
      const sucursalId = (ubicacion.sucursal as unknown as { _id: mongoose.Types.ObjectId })._id;
      if (!canAccessSucursal(req.user, sucursalId)) {
        res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
        return;
      }

      const [stock, espacios] = await Promise.all([
        SucursalStock.find({ ubicacion: ubicacion._id, activo: true }).populate('producto', 'nombre tipo'),
        EspacioCultivo.find({ ubicacion: ubicacion._id, estado: 'activo' })
          .select('codigo flor metrosCuadrados paciente estado')
          .populate('paciente', 'nombre apellido rut'),
      ]);

      res.json({ ubicacion, stock, espacios });
    } catch (error) {
      console.error('Get ubicacion error:', error);
      res.status(500).json({ message: 'Error al obtener ubicación.' });
    }
  }
);

// POST /api/ubicaciones
router.post(
  '/',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal(),
  auditLog('crear', 'ubicacion'),
  [
    body('nombre').notEmpty().withMessage('Nombre es requerido'),
    body('codigo').notEmpty().withMessage('Código es requerido'),
    body('tipo').isIn(UBICACION_TIPOS).withMessage('Tipo inválido'),
    body('padre').optional({ values: 'falsy' }).isMongoId(),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }
    try {
      if (!req.sucursalId) {
        res.status(400).json({ message: 'Selecciona la sucursal de la ubicación.' });
        return;
      }
      if (req.body.padre && !(await Ubicacion.exists({ _id: req.body.padre, sucursal: req.sucursalId }))) {
        res.status(400).json({ message: 'La ubicación contenedora no pertenece a esta sucursal.' });
        return;
      }
      const codigo = String(req.body.codigo).toUpperCase().trim();
      if (await Ubicacion.exists({ sucursal: req.sucursalId, codigo })) {
        res.status(400).json({ message: 'Ya existe una ubicación con ese código en esta sucursal.' });
        return;
      }

      const ubicacion = await Ubicacion.create({
        sucursal: req.sucursalId,
        nombre: req.body.nombre,
        codigo,
        tipo: req.body.tipo,
        padre: req.body.padre || undefined,
        descripcion: req.body.descripcion,
      });
      res.status(201).json(ubicacion);
    } catch (error) {
      console.error('Create ubicacion error:', error);
      res.status(500).json({ message: 'Error al crear ubicación.' });
    }
  }
);

// PUT /api/ubicaciones/:id
router.put(
  '/:id',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('actualizar', 'ubicacion'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
        res.status(400).json({ message: 'ID inválido.' });
        return;
      }
      const ubicacion = await Ubicacion.findById(req.params.id);
      if (!ubicacion) {
        res.status(404).json({ message: 'Ubicación no encontrada.' });
        return;
      }
      if (!canAccessSucursal(req.user, ubicacion.sucursal)) {
        res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
        return;
      }
      if (req.body.tipo !== undefined && !UBICACION_TIPOS.includes(req.body.tipo)) {
        res.status(400).json({ message: 'Tipo inválido.' });
        return;
      }
      for (const k of ['nombre', 'tipo', 'descripcion']) {
        if (req.body[k] !== undefined) (ubicacion as unknown as Record<string, unknown>)[k] = req.body[k];
      }
      await ubicacion.save();
      res.json(ubicacion);
    } catch (error) {
      console.error('Update ubicacion error:', error);
      res.status(500).json({ message: 'Error al actualizar ubicación.' });
    }
  }
);

// PATCH /api/ubicaciones/:id/toggle-active
router.patch(
  '/:id/toggle-active',
  authenticate,
  authorize('admin'),
  auditLog('toggle_activo', 'ubicacion'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const ubicacion = await Ubicacion.findById(req.params.id);
      if (!ubicacion) {
        res.status(404).json({ message: 'Ubicación no encontrada.' });
        return;
      }
      if (ubicacion.activo) {
        const conStock = await SucursalStock.exists({
          ubicacion: ubicacion._id,
          $or: [{ cantidadDisponible: { $gt: 0 } }, { cantidadReservada: { $gt: 0 } }],
        });
        const conEspacios = await EspacioCultivo.exists({ ubicacion: ubicacion._id, estado: 'activo' });
        if (conStock || conEspacios) {
          res.status(400).json({ message: 'No se puede desactivar: tiene stock o espacios de cultivo activos.' });
          return;
        }
      }
      ubicacion.activo = !ubicacion.activo;
      await ubicacion.save();
      res.json(ubicacion);
    } catch (error) {
      console.error('Toggle ubicacion error:', error);
      res.status(500).json({ message: 'Error al cambiar estado de la ubicación.' });
    }
  }
);

export default router;
