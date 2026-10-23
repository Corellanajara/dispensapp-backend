import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { Production } from '../models/Production';
import { Product } from '../models/Product';
import { Types } from 'mongoose';
import { Cosecha } from '../models/Cultivo';
import { Ubicacion } from '../models/Ubicacion';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { resolveSucursal, getSucursalFilter, canAccessSucursal } from '../middleware/sucursal';
import { ingresarStock, registrarMovimiento } from '../services/stock';
import { auditLog } from '../middleware/audit';
import { generateProductionCode, generateLotCode } from '../utils/helpers';

const router = Router();

// GET /api/production
router.get(
  '/',
  authenticate,
  authorize('admin', 'operador', 'produccion'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const {
        page = '1',
        limit = '20',
        estado,
      } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = { ...getSucursalFilter(req) };
      if (estado) filter.estado = estado;

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      const [productions, total] = await Promise.all([
        Production.find(filter)
          .populate('productoFinal', 'nombre tipo')
          .populate('responsable', 'nombre apellido')
          .populate('sucursal', 'nombre codigo')
          .populate('cosecha', 'lote fecha')
          .populate('ubicacionDestino', 'nombre codigo')
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        Production.countDocuments(filter),
      ]);

      res.json({
        data: productions,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      console.error('Get productions error:', error);
      res.status(500).json({ message: 'Error al obtener producciones.' });
    }
  }
);

// GET /api/production/:id
router.get(
  '/:id',
  authenticate,
  authorize('admin', 'operador', 'produccion'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const production = await Production.findById(req.params.id)
        .populate('productoFinal', 'nombre tipo concentracion')
        .populate('responsable', 'nombre apellido')
        .populate('sucursal', 'nombre codigo')
        .populate('cosecha', 'lote fecha paciente espacio')
        .populate('ubicacionDestino', 'nombre codigo');

      if (!production) {
        res.status(404).json({ message: 'Producción no encontrada.' });
        return;
      }
      const sucursalId = (production.sucursal as unknown as { _id: Types.ObjectId })?._id;
      if (!canAccessSucursal(req.user, sucursalId)) {
        res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
        return;
      }
      res.json(production);
    } catch (error) {
      console.error('Get production error:', error);
      res.status(500).json({ message: 'Error al obtener producción.' });
    }
  }
);

// POST /api/production
router.post(
  '/',
  authenticate,
  authorize('admin', 'produccion'),
  resolveSucursal(),
  auditLog('crear', 'produccion'),
  [
    body('productoFinal').isMongoId().withMessage('Producto final inválido'),
    body('materiasPrimas').isArray({ min: 1 }).withMessage('Debe incluir materias primas'),
    body('cantidadInicial').isNumeric().withMessage('Cantidad inicial debe ser numérica'),
    body('fechaInicio').isISO8601().withMessage('Fecha de inicio inválida'),
    body('cosecha').optional({ values: 'falsy' }).isMongoId().withMessage('Cosecha inválida'),
    body('ubicacionDestino').optional({ values: 'falsy' }).isMongoId().withMessage('Ubicación inválida'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const product = await Product.findById(req.body.productoFinal);
      if (!product) {
        res.status(404).json({ message: 'Producto final no encontrado.' });
        return;
      }

      if (!req.sucursalId) {
        res.status(400).json({ message: 'Selecciona la sucursal.' });
        return;
      }
      if (req.body.cosecha && !(await Cosecha.exists({ _id: req.body.cosecha, sucursal: req.sucursalId }))) {
        res.status(400).json({ message: 'La cosecha no pertenece a esta sucursal.' });
        return;
      }
      if (
        req.body.ubicacionDestino &&
        !(await Ubicacion.exists({ _id: req.body.ubicacionDestino, sucursal: req.sucursalId, activo: true }))
      ) {
        res.status(400).json({ message: 'La ubicación de destino no pertenece a esta sucursal.' });
        return;
      }

      const production = new Production({
        sucursal: req.sucursalId,
        codigoProduccion: generateProductionCode(),
        productoFinal: req.body.productoFinal,
        lote: req.body.lote || generateLotCode(),
        cosecha: req.body.cosecha || undefined,
        ubicacionDestino: req.body.ubicacionDestino || undefined,
        materiasPrimas: req.body.materiasPrimas,
        cantidadInicial: req.body.cantidadInicial,
        fechaInicio: req.body.fechaInicio,
        responsable: req.user!._id,
        observaciones: req.body.observaciones,
      });

      await production.save();
      res.status(201).json(production);
    } catch (error) {
      console.error('Create production error:', error);
      res.status(500).json({ message: 'Error al crear producción.' });
    }
  }
);

// PATCH /api/production/:id/complete
router.patch(
  '/:id/complete',
  authenticate,
  authorize('admin', 'produccion'),
  auditLog('completar', 'produccion'),
  [body('cantidadProducida').isNumeric().withMessage('Cantidad producida debe ser numérica')],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const production = await Production.findById(req.params.id);
      if (!production) {
        res.status(404).json({ message: 'Producción no encontrada.' });
        return;
      }

      if (!canAccessSucursal(req.user, production.sucursal)) {
        res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
        return;
      }

      if (production.estado !== 'en_proceso') {
        res.status(400).json({ message: 'Solo se pueden completar producciones en proceso.' });
        return;
      }

      production.cantidadProducida = req.body.cantidadProducida;
      production.totalMermas = production.cantidadInicial - req.body.cantidadProducida;
      production.estado = 'completado';
      production.fechaFin = new Date();
      await production.save();

      const { fila, anterior } = await ingresarStock({
        sucursal: production.sucursal,
        producto: production.productoFinal,
        lote: production.lote,
        ubicacion: production.ubicacionDestino || null,
        cosecha: production.cosecha || null,
        cantidad: Number(req.body.cantidadProducida),
        fechaProduccion: production.fechaFin,
      });

      await registrarMovimiento({
        sucursal: production.sucursal,
        producto: production.productoFinal,
        tipo: 'produccion',
        cantidad: Number(req.body.cantidadProducida),
        cantidadAnterior: anterior,
        cantidadNueva: fila.cantidadDisponible,
        lote: production.lote,
        ubicacion: production.ubicacionDestino,
        stock: fila._id as Types.ObjectId,
        motivo: `Producción completada - ${production.codigoProduccion}`,
        referencia: { tipo: 'produccion', id: production._id as Types.ObjectId },
        usuario: req.user!._id as Types.ObjectId,
      });

      res.json(production);
    } catch (error) {
      console.error('Complete production error:', error);
      res.status(500).json({ message: 'Error al completar producción.' });
    }
  }
);

// POST /api/production/:id/waste
router.post(
  '/:id/waste',
  authenticate,
  authorize('admin', 'produccion'),
  auditLog('registrar_merma', 'produccion'),
  [
    body('tipo').isIn(['proceso', 'calidad', 'almacenamiento', 'otro']).withMessage('Tipo de merma inválido'),
    body('cantidad').isNumeric().withMessage('Cantidad debe ser numérica'),
    body('motivo').notEmpty().withMessage('Motivo es requerido'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const production = await Production.findById(req.params.id);
      if (!production) {
        res.status(404).json({ message: 'Producción no encontrada.' });
        return;
      }

      if (!canAccessSucursal(req.user, production.sucursal)) {
        res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
        return;
      }

      production.mermas.push({
        tipo: req.body.tipo,
        cantidad: req.body.cantidad,
        motivo: req.body.motivo,
        fecha: new Date(),
      });

      production.totalMermas = production.mermas.reduce((sum, m) => sum + m.cantidad, 0);
      await production.save();

      res.json(production);
    } catch (error) {
      console.error('Add waste error:', error);
      res.status(500).json({ message: 'Error al registrar merma.' });
    }
  }
);

export default router;
