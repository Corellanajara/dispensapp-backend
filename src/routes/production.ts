import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { Production } from '../models/Production';
import { Product } from '../models/Product';
import { InventoryMovement } from '../models/Inventory';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { generateProductionCode, generateLotCode } from '../utils/helpers';

const router = Router();

// GET /api/production
router.get(
  '/',
  authenticate,
  authorize('admin', 'operador', 'produccion'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const {
        page = '1',
        limit = '20',
        estado,
      } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = {};
      if (estado) filter.estado = estado;

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      const [productions, total] = await Promise.all([
        Production.find(filter)
          .populate('productoFinal', 'nombre tipo')
          .populate('responsable', 'nombre apellido')
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
        .populate('responsable', 'nombre apellido');

      if (!production) {
        res.status(404).json({ message: 'Producción no encontrada.' });
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
  auditLog('crear', 'produccion'),
  [
    body('productoFinal').isMongoId().withMessage('Producto final inválido'),
    body('materiasPrimas').isArray({ min: 1 }).withMessage('Debe incluir materias primas'),
    body('cantidadInicial').isNumeric().withMessage('Cantidad inicial debe ser numérica'),
    body('fechaInicio').isISO8601().withMessage('Fecha de inicio inválida'),
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

      const production = new Production({
        codigoProduccion: generateProductionCode(),
        productoFinal: req.body.productoFinal,
        lote: req.body.lote || generateLotCode(),
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

      if (production.estado !== 'en_proceso') {
        res.status(400).json({ message: 'Solo se pueden completar producciones en proceso.' });
        return;
      }

      production.cantidadProducida = req.body.cantidadProducida;
      production.totalMermas = production.cantidadInicial - req.body.cantidadProducida;
      production.estado = 'completado';
      production.fechaFin = new Date();
      await production.save();

      // Update product inventory
      const product = await Product.findById(production.productoFinal);
      if (product) {
        const cantidadAnterior = product.cantidadDisponible;
        product.cantidadDisponible += req.body.cantidadProducida;
        product.lote = production.lote;
        product.estado = 'disponible';
        await product.save();

        // Create inventory movement
        await InventoryMovement.create({
          producto: product._id,
          tipo: 'produccion',
          cantidad: req.body.cantidadProducida,
          cantidadAnterior,
          cantidadNueva: product.cantidadDisponible,
          lote: production.lote,
          motivo: `Producción completada - ${production.codigoProduccion}`,
          referencia: { tipo: 'produccion', id: production._id },
          usuario: req.user!._id,
        });
      }

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
