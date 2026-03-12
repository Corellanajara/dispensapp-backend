import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { InventoryMovement } from '../models/Inventory';
import { Product } from '../models/Product';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';

const router = Router();

// GET /api/inventory/movements
router.get(
  '/movements',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const {
        page = '1',
        limit = '20',
        tipo,
        producto,
        lote,
        desde,
        hasta,
      } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = {};
      if (tipo) filter.tipo = tipo;
      if (producto) filter.producto = producto;
      if (lote) filter.lote = lote;
      if (desde || hasta) {
        filter.createdAt = {};
        if (desde) (filter.createdAt as Record<string, unknown>).$gte = new Date(desde);
        if (hasta) (filter.createdAt as Record<string, unknown>).$lte = new Date(hasta);
      }

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      const [movements, total] = await Promise.all([
        InventoryMovement.find(filter)
          .populate('producto', 'nombre tipo lote')
          .populate('usuario', 'nombre apellido')
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        InventoryMovement.countDocuments(filter),
      ]);

      res.json({
        data: movements,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      console.error('Get inventory movements error:', error);
      res.status(500).json({ message: 'Error al obtener movimientos.' });
    }
  }
);

// POST /api/inventory/movements
router.post(
  '/movements',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('crear', 'movimiento_inventario'),
  [
    body('producto').isMongoId().withMessage('Producto inválido'),
    body('tipo').isIn(['produccion', 'ingreso', 'ajuste', 'merma', 'transferencia']).withMessage('Tipo inválido'),
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
      const product = await Product.findById(req.body.producto);
      if (!product) {
        res.status(404).json({ message: 'Producto no encontrado.' });
        return;
      }

      const cantidad = parseFloat(req.body.cantidad);
      const cantidadAnterior = product.cantidadDisponible;
      let cantidadNueva: number;

      if (['produccion', 'ingreso'].includes(req.body.tipo)) {
        cantidadNueva = cantidadAnterior + Math.abs(cantidad);
      } else if (['merma'].includes(req.body.tipo)) {
        cantidadNueva = cantidadAnterior - Math.abs(cantidad);
        if (cantidadNueva < 0) {
          res.status(400).json({ message: 'Stock insuficiente para esta merma.' });
          return;
        }
      } else {
        cantidadNueva = cantidadAnterior + cantidad;
      }

      if (cantidadNueva < 0) {
        res.status(400).json({ message: 'El movimiento resultaría en stock negativo.' });
        return;
      }

      const movement = await InventoryMovement.create({
        producto: req.body.producto,
        tipo: req.body.tipo,
        cantidad,
        cantidadAnterior,
        cantidadNueva,
        lote: req.body.lote || product.lote,
        motivo: req.body.motivo,
        referencia: req.body.referencia,
        usuario: req.user!._id,
      });

      product.cantidadDisponible = cantidadNueva;
      product.estado = cantidadNueva > 0 ? 'disponible' : 'agotado';
      await product.save();

      res.status(201).json(movement);
    } catch (error) {
      console.error('Create inventory movement error:', error);
      res.status(500).json({ message: 'Error al crear movimiento.' });
    }
  }
);

// GET /api/inventory/traceability/:lote
router.get(
  '/traceability/:lote',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { lote } = req.params;

      const movements = await InventoryMovement.find({ lote })
        .populate('producto', 'nombre tipo')
        .populate('usuario', 'nombre apellido')
        .sort({ createdAt: 1 });

      const product = await Product.findOne({ lote });

      res.json({
        lote,
        producto: product,
        movimientos: movements,
        totalMovimientos: movements.length,
      });
    } catch (error) {
      console.error('Get traceability error:', error);
      res.status(500).json({ message: 'Error al obtener trazabilidad.' });
    }
  }
);

// GET /api/inventory/stock
router.get(
  '/stock',
  authenticate,
  authorize('admin', 'operador'),
  async (_req: AuthRequest, res: Response): Promise<void> => {
    try {
      const stock = await Product.find({ activo: true })
        .select('nombre tipo lote cantidadDisponible cantidadReservada estado precio')
        .sort({ nombre: 1 });

      res.json(stock);
    } catch (error) {
      console.error('Get stock error:', error);
      res.status(500).json({ message: 'Error al obtener stock.' });
    }
  }
);

export default router;
