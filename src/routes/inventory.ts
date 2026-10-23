import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mongoose, { Types } from 'mongoose';
import { InventoryMovement } from '../models/Inventory';
import { Product } from '../models/Product';
import { SucursalStock } from '../models/SucursalStock';
import { Ubicacion } from '../models/Ubicacion';
import { Cosecha } from '../models/Cultivo';
import { Transferencia } from '../models/Transferencia';
import { Order } from '../models/Order';
import { Production } from '../models/Production';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { resolveSucursal, getSucursalFilter, canAccessSucursal } from '../middleware/sucursal';
import { auditLog } from '../middleware/audit';
import { registrarMovimiento, ingresarStock, egresarStock, StockError } from '../services/stock';

const router = Router();

function fechaFiltro(desde?: string, hasta?: string) {
  if (!desde && !hasta) return undefined;
  const f: Record<string, Date> = {};
  if (desde) f.$gte = new Date(desde);
  if (hasta) {
    const h = new Date(hasta);
    h.setUTCHours(23, 59, 59, 999);
    f.$lte = h;
  }
  return f;
}

// GET /api/inventory/movements
router.get(
  '/movements',
  authenticate,
  authorize('admin', 'operador', 'cultivo', 'produccion'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { page = '1', limit = '20', tipo, producto, lote, ubicacion, desde, hasta } = req.query as Record<
        string,
        string
      >;

      const filter: Record<string, unknown> = { ...getSucursalFilter(req) };
      if (tipo) filter.tipo = tipo;
      if (producto) filter.producto = producto;
      if (lote) filter.lote = lote;
      if (ubicacion) filter.ubicacion = ubicacion;
      const fechas = fechaFiltro(desde, hasta);
      if (fechas) filter.createdAt = fechas;

      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);

      const [movements, total] = await Promise.all([
        InventoryMovement.find(filter)
          .populate('producto', 'nombre tipo lote')
          .populate('usuario', 'nombre apellido')
          .populate('sucursal', 'nombre codigo')
          .populate('ubicacion', 'nombre codigo tipo')
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        InventoryMovement.countDocuments(filter),
      ]);

      res.json({
        data: movements,
        pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
      });
    } catch (error) {
      console.error('Get inventory movements error:', error);
      res.status(500).json({ message: 'Error al obtener movimientos.' });
    }
  }
);

/**
 * POST /api/inventory/movements — ingreso, ajuste o merma manual.
 * Se indica la fila de stock (`stock`) o, para un ingreso, producto + lote + ubicación.
 * Los traslados se hacen con /api/transferencias.
 */
router.post(
  '/movements',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal(),
  auditLog('crear', 'movimiento_inventario'),
  [
    body('tipo').isIn(['ingreso', 'ajuste', 'merma']).withMessage('Tipo inválido (ingreso, ajuste o merma)'),
    body('cantidad').isNumeric().withMessage('Cantidad debe ser numérica'),
    body('motivo').notEmpty().withMessage('Motivo es requerido'),
    body('stock').optional().isMongoId(),
    body('producto').optional().isMongoId(),
    body('ubicacion').optional({ values: 'falsy' }).isMongoId(),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const tipo = req.body.tipo as 'ingreso' | 'ajuste' | 'merma';
      const cantidad = parseFloat(req.body.cantidad);
      if (!cantidad) {
        res.status(400).json({ message: 'La cantidad no puede ser 0.' });
        return;
      }

      // Fila de stock afectada
      let fila = null;
      if (req.body.stock) {
        fila = await SucursalStock.findById(req.body.stock);
      } else if (req.body.producto) {
        if (!req.sucursalId) {
          res.status(400).json({ message: 'Selecciona una sucursal.' });
          return;
        }
        const filtro: Record<string, unknown> = {
          sucursal: req.sucursalId,
          producto: req.body.producto,
          ubicacion: req.body.ubicacion || null,
        };
        if (req.body.lote) filtro.lote = req.body.lote;
        fila = await SucursalStock.findOne(filtro).sort({ createdAt: -1 });
      }

      // Ingreso a un lote nuevo: se crea la fila
      if (!fila && tipo === 'ingreso' && req.body.producto && req.body.lote) {
        if (!(await Product.exists({ _id: req.body.producto }))) {
          res.status(404).json({ message: 'Producto no encontrado.' });
          return;
        }
        if (req.body.ubicacion) {
          const u = await Ubicacion.findOne({ _id: req.body.ubicacion, sucursal: req.sucursalId });
          if (!u) {
            res.status(400).json({ message: 'La ubicación no pertenece a esta sucursal.' });
            return;
          }
        }
        const { fila: nueva, anterior } = await ingresarStock({
          sucursal: req.sucursalId!,
          producto: req.body.producto,
          lote: req.body.lote,
          ubicacion: req.body.ubicacion || null,
          cantidad: Math.abs(cantidad),
          fechaVencimiento: req.body.fechaVencimiento ? new Date(req.body.fechaVencimiento) : undefined,
        });
        const movement = await registrarMovimiento({
          sucursal: req.sucursalId!,
          producto: req.body.producto,
          tipo,
          cantidad: Math.abs(cantidad),
          cantidadAnterior: anterior,
          cantidadNueva: nueva.cantidadDisponible,
          lote: nueva.lote,
          ubicacion: nueva.ubicacion,
          stock: nueva._id as Types.ObjectId,
          motivo: req.body.motivo,
          usuario: req.user!._id as Types.ObjectId,
        });
        res.status(201).json(movement);
        return;
      }

      if (!fila) {
        res.status(404).json({ message: 'No se encontró el stock indicado.' });
        return;
      }
      if (!canAccessSucursal(req.user, fila.sucursal)) {
        res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
        return;
      }

      let resultado;
      if (tipo === 'ingreso' || (tipo === 'ajuste' && cantidad > 0)) {
        resultado = await ingresarStock({
          sucursal: fila.sucursal,
          producto: fila.producto,
          lote: fila.lote,
          ubicacion: fila.ubicacion || null,
          cantidad: Math.abs(cantidad),
        });
      } else {
        resultado = await egresarStock(fila._id as Types.ObjectId, Math.abs(cantidad));
      }

      const signo = tipo === 'merma' || (tipo === 'ajuste' && cantidad < 0) ? -1 : 1;
      const movement = await registrarMovimiento({
        sucursal: fila.sucursal,
        producto: fila.producto,
        tipo,
        cantidad: signo * Math.abs(cantidad),
        cantidadAnterior: resultado.anterior,
        cantidadNueva: resultado.fila.cantidadDisponible,
        lote: fila.lote,
        ubicacion: fila.ubicacion,
        stock: fila._id as Types.ObjectId,
        motivo: req.body.motivo,
        referencia: req.body.referencia,
        usuario: req.user!._id as Types.ObjectId,
      });

      res.status(201).json(movement);
    } catch (error) {
      if (error instanceof StockError) {
        res.status(error.status).json({ message: error.message });
        return;
      }
      console.error('Create inventory movement error:', error);
      res.status(500).json({ message: 'Error al crear movimiento.' });
    }
  }
);

/**
 * GET /api/inventory/traceability/:lote — historia completa de un lote:
 * cultivo (paciente, espacio, cosecha) → producción → transferencias → stock actual → dispensaciones.
 */
router.get(
  '/traceability/:lote',
  authenticate,
  authorize('admin', 'operador', 'cultivo', 'produccion'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const lote = String(req.params.lote);
      const filtroSucursal = getSucursalFilter(req);

      const [movimientos, producto, cosecha, producciones, transferencias, stock, dispensaciones] = await Promise.all([
        InventoryMovement.find({ lote, ...filtroSucursal })
          .populate('producto', 'nombre tipo')
          .populate('usuario', 'nombre apellido')
          .populate('ubicacion', 'nombre codigo tipo')
          .populate('sucursal', 'nombre codigo')
          .sort({ createdAt: 1 }),
        Product.findOne({ lote }),
        Cosecha.findOne({ lote })
          .populate('paciente', 'nombre apellido rut')
          .populate({ path: 'espacio', select: 'codigo flor metrosCuadrados ubicacion', populate: { path: 'ubicacion', select: 'nombre codigo' } })
          .populate('responsable', 'nombre apellido')
          .populate('sucursal', 'nombre codigo'),
        Production.find({ lote })
          .populate('productoFinal', 'nombre tipo')
          .populate('responsable', 'nombre apellido'),
        Transferencia.find({ 'items.lote': lote })
          .populate('sucursalOrigen', 'nombre codigo')
          .populate('sucursalDestino', 'nombre codigo')
          .populate('ubicacionOrigen', 'nombre codigo')
          .populate('ubicacionDestino', 'nombre codigo')
          .populate('enviadoPor', 'nombre apellido')
          .populate('recibidoPor', 'nombre apellido')
          .sort({ createdAt: 1 }),
        SucursalStock.find({ lote, ...filtroSucursal })
          .populate('producto', 'nombre tipo')
          .populate('ubicacion', 'nombre codigo tipo')
          .populate('sucursal', 'nombre codigo'),
        Order.find({ 'items.lotes.lote': lote, ...filtroSucursal })
          .select('numeroPedido paciente estado fechaEntrega items sucursal createdAt')
          .populate('paciente', 'nombre apellido rut')
          .populate('sucursal', 'nombre codigo')
          .sort({ createdAt: 1 }),
      ]);

      // El rol cultivo no ve a qué pacientes se dispensó
      const verDispensaciones = req.user!.role !== 'cultivo';

      res.json({
        lote,
        producto,
        cosecha,
        producciones,
        transferencias,
        stock,
        dispensaciones: verDispensaciones
          ? dispensaciones.map((o) => ({
              _id: o._id,
              numeroPedido: o.numeroPedido,
              paciente: o.paciente,
              estado: o.estado,
              fechaEntrega: o.fechaEntrega,
              sucursal: o.sucursal,
              createdAt: o.createdAt,
              cantidad: o.items
                .flatMap((i) => i.lotes || [])
                .filter((l) => l.lote === lote)
                .reduce((s, l) => s + l.cantidad, 0),
            }))
          : [],
        movimientos,
        totalMovimientos: movimientos.length,
      });
    } catch (error) {
      console.error('Get traceability error:', error);
      res.status(500).json({ message: 'Error al obtener trazabilidad.' });
    }
  }
);

// GET /api/inventory/stock — existencias por lote y ubicación
router.get(
  '/stock',
  authenticate,
  authorize('admin', 'operador', 'cultivo', 'produccion'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { ubicacion, producto, conStock } = req.query as Record<string, string>;
      const filter: Record<string, unknown> = { activo: true, ...getSucursalFilter(req) };
      if (ubicacion === 'ninguna') filter.ubicacion = null;
      else if (ubicacion && mongoose.Types.ObjectId.isValid(ubicacion)) filter.ubicacion = ubicacion;
      if (producto) filter.producto = producto;
      if (conStock === 'true') filter.$or = [{ cantidadDisponible: { $gt: 0 } }, { cantidadReservada: { $gt: 0 } }];

      const stock = await SucursalStock.find(filter)
        .populate('producto', 'nombre tipo precio imagen')
        .populate('sucursal', 'nombre codigo')
        .populate('ubicacion', 'nombre codigo tipo')
        .populate('cosecha', 'lote fecha')
        .sort({ createdAt: -1 });

      res.json(stock);
    } catch (error) {
      console.error('Get stock error:', error);
      res.status(500).json({ message: 'Error al obtener stock.' });
    }
  }
);

// GET /api/inventory/stock/por-ubicacion — totales agrupados por ubicación
router.get(
  '/stock/por-ubicacion',
  authenticate,
  authorize('admin', 'operador', 'cultivo', 'produccion'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const match: Record<string, unknown> = { activo: true, ...getSucursalFilter(req) };
      const grupos = await SucursalStock.aggregate([
        { $match: match },
        {
          $group: {
            _id: { sucursal: '$sucursal', ubicacion: '$ubicacion' },
            disponible: { $sum: '$cantidadDisponible' },
            reservado: { $sum: '$cantidadReservada' },
            lotes: { $addToSet: '$lote' },
            productos: { $addToSet: '$producto' },
          },
        },
      ]);

      const ubicIds = grupos.map((g) => g._id.ubicacion).filter(Boolean);
      const ubicaciones = await Ubicacion.find({ _id: { $in: ubicIds } }).select('nombre codigo tipo');
      const porId = new Map(ubicaciones.map((u) => [String(u._id), u]));

      res.json(
        grupos.map((g) => ({
          sucursal: g._id.sucursal,
          ubicacion: g._id.ubicacion ? porId.get(String(g._id.ubicacion)) || null : null,
          disponible: g.disponible,
          reservado: g.reservado,
          cantidadLotes: g.lotes.length,
          cantidadProductos: g.productos.length,
        }))
      );
    } catch (error) {
      console.error('Get stock by location error:', error);
      res.status(500).json({ message: 'Error al obtener stock por ubicación.' });
    }
  }
);

export default router;
