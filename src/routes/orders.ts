import { Router, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { Order, OrderStatus } from '../models/Order';
import { Patient } from '../models/Patient';
import { ensurePatientProfileForUser } from '../services/ensurePatientProfile';
import { Product } from '../models/Product';
import { InventoryMovement } from '../models/Inventory';
import { FinanceTransaction } from '../models/Finance';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { generateOrderNumber } from '../utils/helpers';

const router = Router();

// GET /api/orders
router.get(
  '/',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const {
        page = '1',
        limit = '20',
        estado,
        paciente,
      } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = {};
      if (estado) filter.estado = estado;
      if (paciente) filter.paciente = paciente;

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      const [orders, total] = await Promise.all([
        Order.find(filter)
          .populate('paciente', 'nombre apellido rut')
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        Order.countDocuments(filter),
      ]);

      res.json({
        data: orders,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      console.error('Get orders error:', error);
      res.status(500).json({ message: 'Error al obtener pedidos.' });
    }
  }
);

// GET /api/orders/patient
router.get(
  '/patient',
  authenticate,
  authorize('paciente'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const patient = await ensurePatientProfileForUser(req.user!);
      if (!patient) {
        res.status(409).json({
          message:
            'No se pudo vincular tu cuenta con un perfil de paciente. Si ya existe una ficha con tu RUT en el sistema, contacta al dispensario.',
        });
        return;
      }

      const {
        page = '1',
        limit = '20',
        estado,
      } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = { paciente: patient._id };
      if (estado) filter.estado = estado;

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      const [orders, total] = await Promise.all([
        Order.find(filter)
          .populate('items.producto', 'nombre tipo precio')
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        Order.countDocuments(filter),
      ]);

      res.json({
        data: orders,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      console.error('Get patient orders error:', error);
      res.status(500).json({ message: 'Error al obtener pedidos del paciente.' });
    }
  }
);

// POST /api/orders/patient
router.post(
  '/patient',
  authenticate,
  authorize('paciente'),
  auditLog('crear', 'pedido'),
  [
    body('items').isArray({ min: 1 }).withMessage('Debe incluir al menos un producto'),
    body('tipoEntrega').isIn(['retiro', 'despacho']).withMessage('Tipo de entrega inválido'),
    body('recetaMedica').notEmpty().withMessage('Receta médica es requerida'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      // Auto-resolve patient from authenticated user
      const patient = await ensurePatientProfileForUser(req.user!);
      if (!patient) {
        res.status(409).json({
          message:
            'No se pudo vincular tu cuenta con un perfil de paciente. Si ya existe una ficha con tu RUT en el sistema, contacta al dispensario.',
        });
        return;
      }

      if (patient.estado !== 'aprobado') {
        res.status(400).json({ message: 'El paciente no está aprobado.' });
        return;
      }

      // Validate and calculate items
      let total = 0;
      const orderItems = [];

      for (const item of req.body.items) {
        const product = await Product.findById(item.producto);
        if (!product) {
          res.status(400).json({ message: `Producto ${item.producto} no encontrado.` });
          return;
        }
        if (product.cantidadDisponible < item.cantidad) {
          res.status(400).json({
            message: `Stock insuficiente para ${product.nombre}. Disponible: ${product.cantidadDisponible}`,
          });
          return;
        }

        const subtotal = product.precio * item.cantidad;
        total += subtotal;

        orderItems.push({
          producto: product._id,
          nombre: product.nombre,
          cantidad: item.cantidad,
          precioUnitario: product.precio,
          subtotal,
        });
      }

      // Check purchase limit
      if (patient.limiteCompra > 0 && total > patient.limiteCompra) {
        res.status(400).json({ message: 'El monto excede el límite de compra del paciente.' });
        return;
      }

      const order = new Order({
        numeroPedido: generateOrderNumber(),
        paciente: patient._id,
        items: orderItems,
        total,
        tipoEntrega: req.body.tipoEntrega,
        recetaMedica: req.body.recetaMedica,
        direccionEntrega: req.body.direccionEntrega,
        fechaRetiroProgramado: req.body.fechaRetiroProgramado,
        observaciones: req.body.observaciones,
        historialEstados: [
          {
            estado: 'pendiente_revision',
            fecha: new Date(),
            usuario: req.user!._id,
          },
        ],
      });

      await order.save();
      res.status(201).json(order);
    } catch (error) {
      console.error('Create patient order error:', error);
      res.status(500).json({ message: 'Error al crear pedido.' });
    }
  }
);

// GET /api/orders/patient/:id
router.get(
  '/patient/:id',
  authenticate,
  authorize('paciente'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const patient = await ensurePatientProfileForUser(req.user!);
      if (!patient) {
        res.status(409).json({
          message:
            'No se pudo vincular tu cuenta con un perfil de paciente. Si ya existe una ficha con tu RUT en el sistema, contacta al dispensario.',
        });
        return;
      }

      const order = await Order.findById(req.params.id)
        .populate('items.producto', 'nombre tipo precio')
        .populate('paciente', 'nombre apellido rut email telefono');

      if (!order) {
        res.status(404).json({ message: 'Pedido no encontrado.' });
        return;
      }

      if (String(order.paciente._id || order.paciente) !== String(patient._id)) {
        res.status(403).json({ message: 'No tiene permisos para ver este pedido.' });
        return;
      }

      res.json(order);
    } catch (error) {
      console.error('Get patient order error:', error);
      res.status(500).json({ message: 'Error al obtener pedido.' });
    }
  }
);

// PATCH /api/orders/patient/:id/cancel
router.patch(
  '/patient/:id/cancel',
  authenticate,
  authorize('paciente'),
  auditLog('cancelar', 'pedido'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const patient = await ensurePatientProfileForUser(req.user!);
      if (!patient) {
        res.status(409).json({
          message:
            'No se pudo vincular tu cuenta con un perfil de paciente. Si ya existe una ficha con tu RUT en el sistema, contacta al dispensario.',
        });
        return;
      }

      const order = await Order.findById(req.params.id);
      if (!order) {
        res.status(404).json({ message: 'Pedido no encontrado.' });
        return;
      }

      if (String(order.paciente) !== String(patient._id)) {
        res.status(403).json({ message: 'No tiene permisos para cancelar este pedido.' });
        return;
      }

      if (order.estado !== 'pendiente_revision') {
        res.status(400).json({ message: 'Solo se pueden cancelar pedidos en estado pendiente de revisión.' });
        return;
      }

      order.estado = 'cancelado';
      order.historialEstados.push({
        estado: 'cancelado',
        fecha: new Date(),
        usuario: req.user!._id,
        observacion: 'Cancelado por el paciente',
      });

      await order.save();
      res.json(order);
    } catch (error) {
      console.error('Cancel patient order error:', error);
      res.status(500).json({ message: 'Error al cancelar pedido.' });
    }
  }
);

// POST /api/orders/flow-webhook — Flow.cl payment webhook (server-to-server, no auth)
router.post(
  '/flow-webhook',
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { paymentData, paymentStatus, cartId } = req.body;

      if (!cartId) {
        res.status(400).json({ message: 'cartId es requerido.' });
        return;
      }

      const order = await Order.findById(cartId);
      if (!order) {
        res.status(404).json({ message: 'Pedido no encontrado.' });
        return;
      }

      // Map Flow.cl integer status to PaymentStatus string
      const flowStatusMap: Record<number, 'pendiente' | 'aprobado' | 'rechazado' | 'cancelado'> = {
        1: 'pendiente',
        2: 'aprobado',
        3: 'rechazado',
        4: 'cancelado',
      };
      const mappedStatus = flowStatusMap[paymentStatus] || 'error';

      // Initialize pago if not exists
      if (!order.pago) {
        order.pago = {
          estado: mappedStatus,
          montoTotal: order.total,
          montoPagado: 0,
          intentos: [],
        };
      }

      // Find existing flow attempt or update the last one
      const existingAttempt = order.pago.intentos.find(
        (a) => a.provider === 'flow' && a.flowToken === paymentData?.token
      );

      if (existingAttempt) {
        existingAttempt.estado = mappedStatus;
        existingAttempt.raw = paymentData;
        if (paymentData?.paymentData) {
          existingAttempt.mensaje = `${paymentData.paymentData.media || 'Flow.cl'} - ${paymentData.statusStr || mappedStatus}`;
        }
      } else {
        // Create new attempt from webhook data
        order.pago.intentos.push({
          transactionId: paymentData?.flowOrder?.toString() || paymentData?.token || `flow_${Date.now()}`,
          provider: 'flow',
          monto: paymentData?.amount || order.total,
          metodo: 'flow',
          estado: mappedStatus,
          mensaje: paymentData?.statusStr || mappedStatus,
          fecha: new Date(),
          raw: paymentData,
          flowToken: paymentData?.token,
          flowOrderNumber: paymentData?.flowOrder,
        });
      }

      // Update overall payment status
      order.pago.estado = mappedStatus;

      if (mappedStatus === 'aprobado') {
        order.pago.montoPagado = paymentData?.amount || order.total;

        order.historialEstados.push({
          estado: 'pago_aprobado',
          fecha: new Date(),
          observacion: `Pago aprobado vía Flow.cl - ${paymentData?.paymentData?.media || 'Pago electrónico'} - Orden Flow #${paymentData?.flowOrder || ''}`,
        });

        // Create finance transaction
        await FinanceTransaction.create({
          tipo: 'ingreso',
          monto: paymentData?.amount || order.total,
          descripcion: `Pago Flow.cl - Pedido ${order.numeroPedido}`,
          categoria: 'pago_pedido',
          fecha: new Date(),
          referencia: { tipo: 'orden', id: order._id },
          comprobante: `flow:${paymentData?.flowOrder || paymentData?.token || ''}`,
          usuario: order.aprobadoPor || order.paciente,
        });
      } else if (mappedStatus === 'rechazado') {
        order.historialEstados.push({
          estado: 'pago_rechazado',
          fecha: new Date(),
          observacion: `Pago rechazado vía Flow.cl - ${paymentData?.statusStr || 'Rechazado'}`,
        });
      } else if (mappedStatus === 'cancelado') {
        order.historialEstados.push({
          estado: 'pago_cancelado',
          fecha: new Date(),
          observacion: `Pago cancelado/anulado vía Flow.cl`,
        });
      }

      await order.save();
      res.json({ received: true, orderId: order._id, status: mappedStatus });
    } catch (error) {
      console.error('Flow webhook error:', error);
      res.status(500).json({ message: 'Error procesando webhook de Flow.' });
    }
  }
);

// GET /api/orders/:id
router.get(
  '/:id',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const order = await Order.findById(req.params.id)
        .populate('paciente', 'nombre apellido rut email telefono')
        .populate('items.producto', 'nombre tipo concentracion')
        .populate('aprobadoPor', 'nombre apellido')
        .populate('preparadoPor', 'nombre apellido');

      if (!order) {
        res.status(404).json({ message: 'Pedido no encontrado.' });
        return;
      }
      res.json(order);
    } catch (error) {
      console.error('Get order error:', error);
      res.status(500).json({ message: 'Error al obtener pedido.' });
    }
  }
);

// POST /api/orders
router.post(
  '/',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('crear', 'pedido'),
  [
    body('paciente').isMongoId().withMessage('Paciente inválido'),
    body('items').isArray({ min: 1 }).withMessage('Debe incluir al menos un producto'),
    body('tipoEntrega').isIn(['retiro', 'despacho']).withMessage('Tipo de entrega inválido'),
    body('recetaMedica').notEmpty().withMessage('Receta médica es requerida'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      // Validate patient
      const patient = await Patient.findById(req.body.paciente);
      if (!patient) {
        res.status(400).json({ message: 'Paciente no encontrado.' });
        return;
      }
      if (patient.estado !== 'aprobado') {
        res.status(400).json({ message: 'El paciente no está aprobado.' });
        return;
      }

      // Validate and calculate items
      let total = 0;
      const orderItems = [];

      for (const item of req.body.items) {
        const product = await Product.findById(item.producto);
        if (!product) {
          res.status(400).json({ message: `Producto ${item.producto} no encontrado.` });
          return;
        }
        if (product.cantidadDisponible < item.cantidad) {
          res.status(400).json({
            message: `Stock insuficiente para ${product.nombre}. Disponible: ${product.cantidadDisponible}`,
          });
          return;
        }

        const subtotal = product.precio * item.cantidad;
        total += subtotal;

        orderItems.push({
          producto: product._id,
          nombre: product.nombre,
          cantidad: item.cantidad,
          precioUnitario: product.precio,
          subtotal,
        });
      }

      // Check purchase limit
      if (patient.limiteCompra > 0 && total > patient.limiteCompra) {
        res.status(400).json({ message: 'El monto excede el límite de compra del paciente.' });
        return;
      }

      const order = new Order({
        numeroPedido: generateOrderNumber(),
        paciente: req.body.paciente,
        items: orderItems,
        total,
        tipoEntrega: req.body.tipoEntrega,
        recetaMedica: req.body.recetaMedica,
        direccionEntrega: req.body.direccionEntrega,
        fechaRetiroProgramado: req.body.fechaRetiroProgramado,
        observaciones: req.body.observaciones,
        historialEstados: [
          {
            estado: 'pendiente_revision',
            fecha: new Date(),
            usuario: req.user!._id,
          },
        ],
      });

      await order.save();
      res.status(201).json(order);
    } catch (error) {
      console.error('Create order error:', error);
      res.status(500).json({ message: 'Error al crear pedido.' });
    }
  }
);

// PATCH /api/orders/:id/status
router.patch(
  '/:id/status',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('cambiar_estado', 'pedido'),
  [body('estado').notEmpty().withMessage('Estado es requerido')],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const order = await Order.findById(req.params.id);
      if (!order) {
        res.status(404).json({ message: 'Pedido no encontrado.' });
        return;
      }

      const newStatus = req.body.estado as OrderStatus;
      const validTransitions: Record<string, string[]> = {
        pendiente_revision: ['aprobado', 'cancelado'],
        aprobado: ['en_preparacion', 'cancelado'],
        en_preparacion: ['listo_retiro', 'en_despacho', 'cancelado'],
        listo_retiro: ['entregado', 'cancelado'],
        en_despacho: ['entregado', 'cancelado'],
      };

      const allowed = validTransitions[order.estado];
      if (!allowed || !allowed.includes(newStatus)) {
        res.status(400).json({
          message: `No se puede cambiar de '${order.estado}' a '${newStatus}'.`,
        });
        return;
      }

      // If approved, reserve inventory
      if (newStatus === 'aprobado') {
        for (const item of order.items) {
          const product = await Product.findById(item.producto);
          if (!product || product.cantidadDisponible < item.cantidad) {
            res.status(400).json({
              message: `Stock insuficiente para ${item.nombre}.`,
            });
            return;
          }
          product.cantidadDisponible -= item.cantidad;
          product.cantidadReservada += item.cantidad;
          if (product.cantidadDisponible === 0) product.estado = 'agotado';
          await product.save();
        }
        order.aprobadoPor = req.user!._id;
      }

      // If delivered, create inventory movements and finance record
      if (newStatus === 'entregado') {
        for (const item of order.items) {
          const product = await Product.findById(item.producto);
          if (product) {
            await InventoryMovement.create({
              producto: item.producto,
              tipo: 'venta',
              cantidad: -item.cantidad,
              cantidadAnterior: product.cantidadReservada + item.cantidad,
              cantidadNueva: product.cantidadReservada,
              lote: product.lote,
              motivo: `Venta - Pedido ${order.numeroPedido}`,
              referencia: { tipo: 'orden', id: order._id },
              usuario: req.user!._id,
            });

            product.cantidadReservada -= item.cantidad;
            await product.save();
          }
        }

        // Create income record
        await FinanceTransaction.create({
          tipo: 'ingreso',
          monto: order.total,
          descripcion: `Venta - Pedido ${order.numeroPedido}`,
          categoria: 'venta_productos',
          fecha: new Date(),
          referencia: { tipo: 'orden', id: order._id },
          usuario: req.user!._id,
        });

        order.fechaEntrega = new Date();
      }

      // If cancelled, return reserved stock
      if (newStatus === 'cancelado' && order.estado !== 'pendiente_revision') {
        for (const item of order.items) {
          const product = await Product.findById(item.producto);
          if (product) {
            product.cantidadDisponible += item.cantidad;
            product.cantidadReservada -= item.cantidad;
            if (product.cantidadDisponible > 0) product.estado = 'disponible';
            await product.save();
          }
        }
      }

      order.estado = newStatus;
      order.historialEstados.push({
        estado: newStatus,
        fecha: new Date(),
        usuario: req.user!._id,
        observacion: req.body.observacion,
      });

      await order.save();
      const populatedOrder = await Order.findById(order._id)
        .populate('paciente', 'nombre apellido rut')
        .populate('items.producto', 'nombre tipo');
      res.json(populatedOrder);
    } catch (error) {
      console.error('Update order status error:', error);
      res.status(500).json({ message: 'Error al actualizar estado del pedido.' });
    }
  }
);

export default router;
