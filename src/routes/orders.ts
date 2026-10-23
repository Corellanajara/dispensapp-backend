import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mongoose, { Types } from 'mongoose';
import { Order, OrderStatus, IOrder, IOrderItem } from '../models/Order';
import { Patient, IPatient } from '../models/Patient';
import { ensurePatientProfileForUser } from '../services/ensurePatientProfile';
import { Product } from '../models/Product';
import { SucursalStock } from '../models/SucursalStock';
import { FinanceTransaction } from '../models/Finance';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { resolveSucursal, getSucursalFilter, canAccessSucursal } from '../middleware/sucursal';
import { auditLog } from '../middleware/audit';
import { generateOrderNumber } from '../utils/helpers';
import { env } from '../config/env';
import { recetaVigente } from '../services/vigencia';
import { registrarAuditoria } from '../services/audit';
import {
  disponibleParaDispensar,
  reservarParaNota,
  liberarReservaDeNota,
  consumirReservaDeNota,
  StockError,
} from '../services/stock';

/**
 * Notas de dispensación (el modelo se sigue llamando Order para no migrar datos).
 * No es una nota de venta: sin PAGOS_HABILITADOS no se calculan precios ni se registran ingresos.
 */
const router = Router();

const SIN_PERFIL =
  'No se pudo vincular tu cuenta con un perfil de paciente. Si ya existe una ficha con tu RUT en el sistema, contacta al dispensario.';

class NotaError extends Error {
  status = 400;
}

function formatoFecha(d: Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Valida que el paciente pueda recibir una dispensación en esa sucursal.
 * Devuelve la receta vigente.
 */
function validarPaciente(patient: IPatient, sucursal: Types.ObjectId | undefined) {
  if (patient.estado !== 'aprobado') {
    const motivo =
      patient.estado === 'suspendido' && patient.motivoSuspension === 'receta_vencida'
        ? 'está suspendido porque su receta venció. Debe presentar una receta nueva'
        : `no está activo (estado: ${patient.estado})`;
    throw new NotaError(`El paciente ${motivo}.`);
  }
  const receta = recetaVigente(patient);
  if (!receta) {
    throw new NotaError(
      'El paciente no tiene una receta aprobada y vigente. Sube y aprueba una receta con fecha de vencimiento.'
    );
  }
  if (!patient.sucursal) {
    throw new NotaError('El paciente no tiene dispensario asignado. Un administrador debe asignarlo en su ficha.');
  }
  if (sucursal && String(patient.sucursal) !== String(sucursal)) {
    throw new NotaError('El paciente pertenece a otro dispensario.');
  }
  return receta;
}

/** Revisa el límite mensual de unidades del paciente (últimos 30 días, sin contar anuladas). */
async function validarLimiteMensual(patient: IPatient, unidadesNuevas: number, excluir?: Types.ObjectId) {
  if (!patient.limiteMensualUnidades || patient.limiteMensualUnidades <= 0) return;

  const desde = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const filtro: Record<string, unknown> = {
    paciente: patient._id,
    estado: { $ne: 'cancelado' },
    createdAt: { $gte: desde },
  };
  if (excluir) filtro._id = { $ne: excluir };

  const [agg] = await Order.aggregate([
    { $match: filtro },
    { $unwind: '$items' },
    { $group: { _id: null, total: { $sum: '$items.cantidad' } } },
  ]);
  const usadas = agg?.total || 0;

  if (usadas + unidadesNuevas > patient.limiteMensualUnidades) {
    throw new NotaError(
      `Supera el límite mensual del paciente: ${patient.limiteMensualUnidades} unidades en 30 días ` +
        `(ya tiene ${usadas}, se piden ${unidadesNuevas}).`
    );
  }
}

/** Arma los ítems de la nota y valida que haya stock dispensable. */
async function prepararItems(
  rawItems: { producto: string; cantidad: number }[],
  sucursal: Types.ObjectId
): Promise<{ items: IOrderItem[]; total: number }> {
  // Agrupa por producto para validar stock una sola vez por producto
  const porProducto = new Map<string, number>();
  for (const it of rawItems) {
    const cantidad = Number(it.cantidad);
    if (!mongoose.Types.ObjectId.isValid(it.producto) || !Number.isInteger(cantidad) || cantidad < 1) {
      throw new NotaError('Cada ítem necesita un producto válido y una cantidad entera mayor a 0.');
    }
    porProducto.set(it.producto, (porProducto.get(it.producto) || 0) + cantidad);
  }

  const items: IOrderItem[] = [];
  let total = 0;

  for (const [productoId, cantidad] of porProducto) {
    const product = await Product.findOne({ _id: productoId, activo: true });
    if (!product) throw new NotaError(`Producto ${productoId} no encontrado.`);

    const disponible = await disponibleParaDispensar(sucursal, productoId);
    if (disponible < cantidad) {
      throw new NotaError(`Stock insuficiente para ${product.nombre}. Disponible para dispensar: ${disponible}.`);
    }

    let precio = 0;
    if (env.PAGOS_HABILITADOS) {
      const stockConPrecio = await SucursalStock.findOne({ sucursal, producto: productoId, precioLocal: { $gt: 0 } });
      precio = stockConPrecio?.precioLocal || product.precio || 0;
    }
    const subtotal = precio * cantidad;
    total += subtotal;

    items.push({
      producto: product._id as Types.ObjectId,
      nombre: product.nombre,
      cantidad,
      precioUnitario: precio,
      subtotal,
      lotes: [],
    });
  }

  return { items, total };
}

function responderError(res: Response, error: unknown, fallback: string, log: string) {
  if (error instanceof NotaError || error instanceof StockError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  console.error(log, error);
  res.status(500).json({ message: fallback });
}

async function crearNota(
  req: AuthRequest,
  patient: IPatient,
  sucursal: Types.ObjectId
): Promise<IOrder> {
  const receta = validarPaciente(patient, sucursal);
  const { items, total } = await prepararItems(req.body.items, sucursal);
  await validarLimiteMensual(
    patient,
    items.reduce((s, i) => s + i.cantidad, 0)
  );

  const order = new Order({
    numeroPedido: generateOrderNumber(),
    sucursal,
    paciente: patient._id,
    items,
    total,
    tipoEntrega: req.body.tipoEntrega,
    recetaMedica: `${receta.nombre} (vence ${formatoFecha(receta.fechaVencimiento!)})`,
    receta: receta._id,
    direccionEntrega: req.body.direccionEntrega,
    fechaRetiroProgramado: req.body.fechaRetiroProgramado,
    observaciones: req.body.observaciones,
    historialEstados: [{ estado: 'pendiente_revision', fecha: new Date(), usuario: req.user!._id }],
  });

  await order.save();
  return order;
}

const validarNota = [
  body('items').isArray({ min: 1 }).withMessage('Debe incluir al menos un producto'),
  body('tipoEntrega').isIn(['retiro', 'despacho']).withMessage('Tipo de entrega inválido'),
];

// ─── Personal ──────────────────────────────────────────────

// GET /api/orders
router.get(
  '/',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { page = '1', limit = '20', estado, paciente } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = { ...getSucursalFilter(req) };
      if (estado) filter.estado = estado;
      if (paciente) filter.paciente = paciente;

      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

      const [orders, total] = await Promise.all([
        Order.find(filter)
          .populate('paciente', 'nombre apellido rut')
          .populate('sucursal', 'nombre codigo')
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        Order.countDocuments(filter),
      ]);

      res.json({
        data: orders,
        pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
      });
    } catch (error) {
      console.error('Get orders error:', error);
      res.status(500).json({ message: 'Error al obtener notas de dispensación.' });
    }
  }
);

// ─── Portal del paciente ───────────────────────────────────

// GET /api/orders/patient
router.get('/patient', authenticate, authorize('paciente'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const patient = await ensurePatientProfileForUser(req.user!);
    if (!patient) {
      res.status(409).json({ message: SIN_PERFIL });
      return;
    }

    const { page = '1', limit = '20', estado } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { paciente: patient._id };
    if (estado) filter.estado = estado;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('items.producto', 'nombre tipo')
        .populate('sucursal', 'nombre codigo')
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
      Order.countDocuments(filter),
    ]);

    res.json({
      data: orders,
      pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    console.error('Get patient orders error:', error);
    res.status(500).json({ message: 'Error al obtener tus solicitudes.' });
  }
});

// POST /api/orders/patient — el paciente solicita una dispensación en su dispensario
router.post(
  '/patient',
  authenticate,
  authorize('paciente'),
  resolveSucursal({ required: false }),
  auditLog('crear', 'pedido'),
  validarNota,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const patient = await ensurePatientProfileForUser(req.user!);
      if (!patient) {
        res.status(409).json({ message: SIN_PERFIL });
        return;
      }
      const sucursal = patient.sucursal as Types.ObjectId | undefined;
      if (!sucursal) {
        res.status(400).json({ message: 'Tu ficha no tiene dispensario asignado. Contacta al dispensario.' });
        return;
      }
      const order = await crearNota(req, patient, sucursal);
      res.status(201).json(order);
    } catch (error) {
      responderError(res, error, 'Error al crear la solicitud.', 'Create patient order error:');
    }
  }
);

// GET /api/orders/patient/:id
router.get('/patient/:id', authenticate, authorize('paciente'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const patient = await ensurePatientProfileForUser(req.user!);
    if (!patient) {
      res.status(409).json({ message: SIN_PERFIL });
      return;
    }
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      res.status(400).json({ message: 'ID inválido.' });
      return;
    }

    const order = await Order.findOne({ _id: req.params.id, paciente: patient._id })
      .select('-pago.intentos.raw')
      .populate('items.producto', 'nombre tipo')
      .populate('paciente', 'nombre apellido rut email telefono')
      .populate('sucursal', 'nombre codigo');

    if (!order) {
      res.status(404).json({ message: 'Solicitud no encontrada.' });
      return;
    }
    res.json(order);
  } catch (error) {
    console.error('Get patient order error:', error);
    res.status(500).json({ message: 'Error al obtener la solicitud.' });
  }
});

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
        res.status(409).json({ message: SIN_PERFIL });
        return;
      }
      if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
        res.status(400).json({ message: 'ID inválido.' });
        return;
      }

      const order = await Order.findOne({ _id: req.params.id, paciente: patient._id });
      if (!order) {
        res.status(404).json({ message: 'Solicitud no encontrada.' });
        return;
      }
      if (order.estado !== 'pendiente_revision') {
        res.status(400).json({ message: 'Solo se pueden anular solicitudes pendientes de revisión.' });
        return;
      }

      order.estado = 'cancelado';
      order.historialEstados.push({
        estado: 'cancelado',
        fecha: new Date(),
        usuario: req.user!._id as Types.ObjectId,
        observacion: 'Anulada por el paciente',
      });

      await order.save();
      res.json(order);
    } catch (error) {
      console.error('Cancel patient order error:', error);
      res.status(500).json({ message: 'Error al anular la solicitud.' });
    }
  }
);

// ─── Webhook de Flow (solo con pagos habilitados) ──────────

// POST /api/orders/flow-webhook — exige el header X-Webhook-Secret = FLOW_WEBHOOK_SECRET
router.post('/flow-webhook', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!env.PAGOS_HABILITADOS) {
      res.status(403).json({ message: 'Los pagos están deshabilitados.' });
      return;
    }
    if (!env.FLOW_WEBHOOK_SECRET || req.header('X-Webhook-Secret') !== env.FLOW_WEBHOOK_SECRET) {
      void registrarAuditoria({ req, accion: 'webhook_flow_rechazado', entidad: 'pago', resultado: 'fallo' });
      res.status(401).json({ message: 'Webhook no autorizado.' });
      return;
    }

    const { paymentData, paymentStatus, cartId } = req.body;
    if (!cartId || !mongoose.Types.ObjectId.isValid(cartId)) {
      res.status(400).json({ message: 'cartId es requerido.' });
      return;
    }

    const order = await Order.findById(cartId);
    if (!order) {
      res.status(404).json({ message: 'Nota no encontrada.' });
      return;
    }

    const flowStatusMap: Record<number, 'pendiente' | 'aprobado' | 'rechazado' | 'cancelado'> = {
      1: 'pendiente',
      2: 'aprobado',
      3: 'rechazado',
      4: 'cancelado',
    };
    const mappedStatus = flowStatusMap[paymentStatus] || 'error';

    if (!order.pago) {
      order.pago = { estado: mappedStatus, montoTotal: order.total, montoPagado: 0, intentos: [] };
    }

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

    order.pago.estado = mappedStatus;

    if (mappedStatus === 'aprobado') {
      order.pago.montoPagado = paymentData?.amount || order.total;
      order.historialEstados.push({
        estado: 'pago_aprobado',
        fecha: new Date(),
        observacion: `Pago aprobado vía Flow.cl - Orden Flow #${paymentData?.flowOrder || ''}`,
      });
      await FinanceTransaction.create({
        sucursal: order.sucursal,
        tipo: 'ingreso',
        monto: paymentData?.amount || order.total,
        descripcion: `Pago Flow.cl - Nota ${order.numeroPedido}`,
        categoria: 'pago_pedido',
        fecha: new Date(),
        referencia: { tipo: 'orden', id: order._id },
        comprobante: `flow:${paymentData?.flowOrder || paymentData?.token || ''}`,
        usuario: order.aprobadoPor || order.paciente,
      });
    } else if (mappedStatus === 'rechazado' || mappedStatus === 'cancelado') {
      order.historialEstados.push({
        estado: `pago_${mappedStatus}`,
        fecha: new Date(),
        observacion: `Pago ${mappedStatus} vía Flow.cl`,
      });
    }

    await order.save();
    res.json({ received: true, orderId: order._id, status: mappedStatus });
  } catch (error) {
    console.error('Flow webhook error:', error);
    res.status(500).json({ message: 'Error procesando webhook de Flow.' });
  }
});

// ─── Detalle, creación y estados (personal) ────────────────

// GET /api/orders/:id
router.get(
  '/:id',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
        res.status(400).json({ message: 'ID inválido.' });
        return;
      }
      const order = await Order.findById(req.params.id)
        .populate('paciente', 'nombre apellido rut email telefono estado')
        .populate('items.producto', 'nombre tipo concentracion')
        .populate('items.lotes.ubicacion', 'nombre codigo tipo')
        .populate('aprobadoPor', 'nombre apellido')
        .populate('preparadoPor', 'nombre apellido')
        .populate('historialEstados.usuario', 'nombre apellido')
        .populate('sucursal', 'nombre codigo');

      if (!order) {
        res.status(404).json({ message: 'Nota no encontrada.' });
        return;
      }
      const sucursalId = (order.sucursal as unknown as { _id: Types.ObjectId })?._id || order.sucursal;
      if (!canAccessSucursal(req.user, sucursalId)) {
        res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
        return;
      }
      res.json(order);
    } catch (error) {
      console.error('Get order error:', error);
      res.status(500).json({ message: 'Error al obtener la nota.' });
    }
  }
);

// POST /api/orders
router.post(
  '/',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal(),
  auditLog('crear', 'pedido'),
  [body('paciente').isMongoId().withMessage('Paciente inválido'), ...validarNota],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      if (!req.sucursalId) {
        res.status(400).json({ message: 'Selecciona la sucursal donde se dispensa.' });
        return;
      }
      const patient = await Patient.findById(req.body.paciente);
      if (!patient) {
        res.status(400).json({ message: 'Paciente no encontrado.' });
        return;
      }
      const order = await crearNota(req, patient, req.sucursalId);
      res.status(201).json(order);
    } catch (error) {
      responderError(res, error, 'Error al crear la nota.', 'Create order error:');
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
      if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
        res.status(400).json({ message: 'ID inválido.' });
        return;
      }
      const order = await Order.findById(req.params.id);
      if (!order) {
        res.status(404).json({ message: 'Nota no encontrada.' });
        return;
      }
      if (!canAccessSucursal(req.user, order.sucursal)) {
        res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
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
        res.status(400).json({ message: `No se puede cambiar de '${order.estado}' a '${newStatus}'.` });
        return;
      }

      // Al aprobar y al entregar se vuelve a revisar al paciente: la receta pudo vencer entre medio.
      if (newStatus === 'aprobado' || newStatus === 'entregado') {
        const patient = await Patient.findById(order.paciente);
        if (!patient) throw new NotaError('Paciente no encontrado.');
        validarPaciente(patient, order.sucursal);
        if (newStatus === 'aprobado') {
          await validarLimiteMensual(
            patient,
            order.items.reduce((s, i) => s + i.cantidad, 0),
            order._id as Types.ObjectId
          );
        }
      }

      // Toma la nota de forma atómica: si otra persona la cambió recién, no se repite la reserva o el descuento.
      const estadoAnterior = order.estado;
      const tomada = await Order.updateOne({ _id: order._id, estado: estadoAnterior }, { $set: { estado: newStatus } });
      if (tomada.modifiedCount === 0) {
        res.status(409).json({ message: 'La nota cambió de estado recién. Recarga e intenta de nuevo.' });
        return;
      }

      try {
        await aplicarEfectosDeEstado(order, newStatus, req);
      } catch (err) {
        await Order.updateOne({ _id: order._id }, { $set: { estado: estadoAnterior } });
        throw err;
      }

      order.estado = newStatus;
      order.historialEstados.push({
        estado: newStatus,
        fecha: new Date(),
        usuario: req.user!._id as Types.ObjectId,
        observacion: req.body.observacion,
      });

      await order.save();
      const populatedOrder = await Order.findById(order._id)
        .populate('paciente', 'nombre apellido rut')
        .populate('items.producto', 'nombre tipo')
        .populate('items.lotes.ubicacion', 'nombre codigo tipo')
        .populate('sucursal', 'nombre codigo');
      res.json(populatedOrder);
    } catch (error) {
      responderError(res, error, 'Error al actualizar el estado de la nota.', 'Update order status error:');
    }
  }
);

/** Reserva, descuenta o libera stock según el nuevo estado de la nota. */
async function aplicarEfectosDeEstado(order: IOrder, newStatus: OrderStatus, req: AuthRequest): Promise<void> {
  if (newStatus === 'aprobado') {
    await reservarParaNota(order);
    order.aprobadoPor = req.user!._id as Types.ObjectId;
  }

  if (newStatus === 'en_preparacion') {
    order.preparadoPor = req.user!._id as Types.ObjectId;
  }

  if (newStatus === 'entregado') {
    await consumirReservaDeNota(order, req.user!._id as Types.ObjectId);

    if (env.PAGOS_HABILITADOS && order.total > 0) {
      await FinanceTransaction.create({
        sucursal: order.sucursal,
        tipo: 'ingreso',
        monto: order.total,
        descripcion: `Nota ${order.numeroPedido}`,
        categoria: 'venta_productos',
        fecha: new Date(),
        referencia: { tipo: 'orden', id: order._id },
        usuario: req.user!._id,
      });
    }

    order.fechaEntrega = new Date();
  }

  if (newStatus === 'cancelado' && order.estado !== 'pendiente_revision') {
    await liberarReservaDeNota(order);
  }
}

export default router;
