import { Router, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { Product } from '../models/Product';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { upload } from '../middleware/upload';
import { uploadFile, deleteFile } from '../services/storage';

const router = Router();

// GET /api/products
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

// GET /api/products/catalog
router.get(
  '/catalog',
  authenticate,
  authorize('paciente'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const {
        page = '1',
        limit = '20',
        tipo,
      } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = {
        activo: true,
        estado: 'disponible',
        cantidadDisponible: { $gt: 0 },
      };
      if (tipo) filter.tipo = tipo;

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      const [products, total] = await Promise.all([
        Product.find(filter)
          .select('nombre tipo descripcion concentracion presentacion usoTerapeutico precio imagen cantidadDisponible')
          .sort({ nombre: 1 })
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
    body('precio').isNumeric().withMessage('Precio debe ser numérico'),
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
