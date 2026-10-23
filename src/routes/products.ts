import { Router, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { Product } from '../models/Product';
import { SucursalStock } from '../models/SucursalStock';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { resolveSucursal, getSucursalFilter } from '../middleware/sucursal';
import { auditLog } from '../middleware/audit';
import { upload } from '../middleware/upload';
import { uploadFile, deleteFile } from '../services/storage';
import { Types } from 'mongoose';
import { Ubicacion } from '../models/Ubicacion';
import { env } from '../config/env';
import { ensurePatientProfileForUser } from '../services/ensurePatientProfile';
import { filtroDispensable, ingresarStock, registrarMovimiento } from '../services/stock';

const router = Router();

// GET /api/products (catálogo global)
router.get(
  '/',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const {
        page = '1',
        limit = '20',
        tipo,
        estado,
        search,
      } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = { activo: true };
      if (tipo) filter.tipo = tipo;
      if (estado) filter.estado = estado;
      if (search) {
        filter.$text = { $search: search };
      }

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      const [products, total] = await Promise.all([
        Product.find(filter)
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        Product.countDocuments(filter),
      ]);

      res.json({
        data: products,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      console.error('Get products error:', error);
      res.status(500).json({ message: 'Error al obtener productos.' });
    }
  }
);

// GET /api/products/stock — stock por sucursal (incluye datos del producto)
router.get(
  '/stock',
  authenticate,
  authorize('admin', 'operador', 'produccion', 'cultivo'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const {
        page = '1',
        limit = '20',
        estado,
      } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = {
        ...getSucursalFilter(req),
        activo: true,
      };
      if (estado) filter.estado = estado;

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      const [stocks, total] = await Promise.all([
        SucursalStock.find(filter)
          .populate('producto', 'nombre tipo descripcion concentracion presentacion usoTerapeutico precio imagen')
          .populate('sucursal', 'nombre codigo')
          .populate('ubicacion', 'nombre codigo tipo')
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        SucursalStock.countDocuments(filter),
      ]);

      res.json({
        data: stocks,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      console.error('Get product stock error:', error);
      res.status(500).json({ message: 'Error al obtener stock de productos.' });
    }
  }
);

// POST /api/products/stock — ingresar stock de un producto a la sucursal (queda como movimiento de ingreso)
router.post(
  '/stock',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal(),
  auditLog('crear', 'sucursal_stock'),
  [
    body('producto').isMongoId().withMessage('Producto inválido'),
    body('cantidadDisponible').isFloat({ min: 0 }).withMessage('Cantidad debe ser numérica'),
    body('lote').notEmpty().withMessage('Lote es requerido'),
    body('ubicacion').optional({ values: 'falsy' }).isMongoId().withMessage('Ubicación inválida'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      if (!req.sucursalId) {
        res.status(400).json({ message: 'Selecciona la sucursal.' });
        return;
      }
      const product = await Product.findById(req.body.producto);
      if (!product) {
        res.status(404).json({ message: 'Producto no encontrado.' });
        return;
      }
      if (
        req.body.ubicacion &&
        !(await Ubicacion.exists({ _id: req.body.ubicacion, sucursal: req.sucursalId, activo: true }))
      ) {
        res.status(400).json({ message: 'La ubicación no pertenece a esta sucursal.' });
        return;
      }

      const cantidad = Number(req.body.cantidadDisponible);
      const { fila, anterior } = await ingresarStock({
        sucursal: req.sucursalId,
        producto: product._id as Types.ObjectId,
        lote: req.body.lote,
        ubicacion: req.body.ubicacion || null,
        cantidad,
        fechaProduccion: req.body.fechaProduccion ? new Date(req.body.fechaProduccion) : undefined,
        fechaVencimiento: req.body.fechaVencimiento ? new Date(req.body.fechaVencimiento) : undefined,
      });
      if (req.body.precioLocal !== undefined && req.body.precioLocal !== '') {
        fila.precioLocal = Number(req.body.precioLocal);
        await fila.save();
      }

      if (cantidad > 0) {
        await registrarMovimiento({
          sucursal: req.sucursalId,
          producto: product._id as Types.ObjectId,
          tipo: 'ingreso',
          cantidad,
          cantidadAnterior: anterior,
          cantidadNueva: fila.cantidadDisponible,
          lote: fila.lote,
          ubicacion: fila.ubicacion,
          stock: fila._id as Types.ObjectId,
          motivo: req.body.motivo || 'Ingreso de stock',
          usuario: req.user!._id as Types.ObjectId,
        });
      }

      const populated = await SucursalStock.findById(fila._id)
        .populate('producto', 'nombre tipo descripcion precio')
        .populate('sucursal', 'nombre codigo')
        .populate('ubicacion', 'nombre codigo tipo');
      res.status(201).json(populated);
    } catch (error) {
      console.error('Create product stock error:', error);
      res.status(500).json({ message: 'Error al crear stock de producto.' });
    }
  }
);

// PUT /api/products/stock/:id — actualizar stock de sucursal
router.put(
  '/stock/:id',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal(),
  auditLog('actualizar', 'sucursal_stock'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      // Las cantidades solo cambian con movimientos (POST /api/inventory/movements), para no perder trazabilidad.
      const update: Record<string, unknown> = {};
      for (const k of ['precioLocal', 'fechaProduccion', 'fechaVencimiento', 'activo']) {
        if (req.body[k] !== undefined) update[k] = req.body[k];
      }
      if (req.body.cantidadDisponible !== undefined || req.body.cantidadReservada !== undefined) {
        res.status(400).json({
          message: 'Las cantidades se cambian con un movimiento de inventario (ingreso, ajuste o merma).',
        });
        return;
      }

      const stock = await SucursalStock.findOneAndUpdate(
        { _id: req.params.id, ...getSucursalFilter(req) },
        update,
        { new: true, runValidators: true }
      )
        .populate('producto', 'nombre tipo descripcion precio')
        .populate('sucursal', 'nombre codigo');

      if (!stock) {
        res.status(404).json({ message: 'Stock no encontrado.' });
        return;
      }
      res.json(stock);
    } catch (error) {
      console.error('Update product stock error:', error);
      res.status(500).json({ message: 'Error al actualizar stock.' });
    }
  }
);

// GET /api/products/catalog — productos que el paciente puede solicitar en su dispensario
router.get(
  '/catalog',
  authenticate,
  authorize('paciente'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { page = '1', limit = '20', tipo } = req.query as Record<string, string>;

      const patient = await ensurePatientProfileForUser(req.user!);
      const sucursal = patient?.sucursal || req.sucursalId;
      if (!sucursal) {
        res.json({ data: [], pagination: { total: 0, page: 1, limit: 20, pages: 0 } });
        return;
      }

      const filtro = await filtroDispensable(sucursal);
      const filas = await SucursalStock.find({ ...filtro, cantidadDisponible: { $gt: 0 } })
        .populate({
          path: 'producto',
          match: { activo: true, ...(tipo ? { tipo } : {}) },
          select: 'nombre tipo descripcion concentracion presentacion usoTerapeutico precio imagen',
        })
        .populate('sucursal', 'nombre codigo');

      // Una entrada por producto, sumando sus lotes
      const porProducto = new Map<string, Record<string, unknown>>();
      for (const f of filas) {
        if (!f.producto) continue;
        const prod = f.producto as unknown as { _id: Types.ObjectId; precio?: number; toJSON(): Record<string, unknown> };
        const key = String(prod._id);
        const actual = porProducto.get(key);
        if (actual) {
          actual.cantidadDisponible = (actual.cantidadDisponible as number) + f.cantidadDisponible;
        } else {
          const producto = prod.toJSON();
          if (!env.PAGOS_HABILITADOS) delete producto.precio;
          porProducto.set(key, {
            _id: f._id,
            producto,
            sucursal: f.sucursal,
            cantidadDisponible: f.cantidadDisponible,
            cantidadReservada: 0,
            estado: 'disponible',
            lote: f.lote,
            activo: true,
            ...(env.PAGOS_HABILITADOS && f.precioLocal ? { precioLocal: f.precioLocal } : {}),
          });
        }
      }

      const todos = [...porProducto.values()];
      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

      res.json({
        data: todos.slice((pageNum - 1) * limitNum, pageNum * limitNum),
        pagination: {
          total: todos.length,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(todos.length / limitNum),
        },
      });
    } catch (error) {
      console.error('Get product catalog error:', error);
      res.status(500).json({ message: 'Error al obtener catálogo de productos.' });
    }
  }
);

// GET /api/products/:id
router.get(
  '/:id',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) {
        res.status(404).json({ message: 'Producto no encontrado.' });
        return;
      }
      res.json(product);
    } catch (error) {
      console.error('Get product error:', error);
      res.status(500).json({ message: 'Error al obtener producto.' });
    }
  }
);

// POST /api/products
router.post(
  '/',
  authenticate,
  authorize('admin', 'operador', 'produccion'),
  auditLog('crear', 'producto'),
  [
    body('nombre').notEmpty().withMessage('Nombre es requerido'),
    body('tipo').isIn(['flor', 'aceite', 'crema', 'capsula', 'tintura', 'comestible', 'otro']).withMessage('Tipo inválido'),
    body('precio').optional({ values: 'falsy' }).isNumeric().withMessage('Precio debe ser numérico'),
    body('lote').notEmpty().withMessage('Lote es requerido'),
    body('fechaProduccion').isISO8601().withMessage('Fecha de producción inválida'),
    body('fechaVencimiento').isISO8601().withMessage('Fecha de vencimiento inválida'),
    body('cantidadDisponible').isNumeric().withMessage('Cantidad debe ser numérica'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const product = new Product(req.body);
      await product.save();
      res.status(201).json(product);
    } catch (error) {
      console.error('Create product error:', error);
      res.status(500).json({ message: 'Error al crear producto.' });
    }
  }
);

// PUT /api/products/:id
router.put(
  '/:id',
  authenticate,
  authorize('admin', 'operador', 'produccion'),
  auditLog('actualizar', 'producto'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
      });
      if (!product) {
        res.status(404).json({ message: 'Producto no encontrado.' });
        return;
      }
      res.json(product);
    } catch (error) {
      console.error('Update product error:', error);
      res.status(500).json({ message: 'Error al actualizar producto.' });
    }
  }
);

// DELETE /api/products/:id (soft delete)
router.delete(
  '/:id',
  authenticate,
  authorize('admin'),
  auditLog('eliminar', 'producto'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const product = await Product.findByIdAndUpdate(
        req.params.id,
        { activo: false },
        { new: true }
      );
      if (!product) {
        res.status(404).json({ message: 'Producto no encontrado.' });
        return;
      }
      res.json({ message: 'Producto eliminado.' });
    } catch (error) {
      console.error('Delete product error:', error);
      res.status(500).json({ message: 'Error al eliminar producto.' });
    }
  }
);


// POST /api/products/:id/image
router.post(
  '/:id/image',
  authenticate,
  authorize('admin', 'operador', 'produccion'),
  upload.single('imagen'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) {
        res.status(404).json({ message: 'Producto no encontrado.' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ message: 'No se proporcionó imagen.' });
        return;
      }

      // Eliminar imagen anterior si existe
      if (product.imagen) {
        await deleteFile(product.imagen);
      }

      const imageUrl = await uploadFile(req.file);
      product.imagen = imageUrl;
      await product.save();

      res.json(product);
    } catch (error) {
      console.error('Upload product image error:', error);
      res.status(500).json({ message: 'Error al subir imagen del producto.' });
    }
  }
);

export default router;
