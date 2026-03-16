import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { Order } from '../models/Order';
import { FinanceTransaction } from '../models/Finance';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { getProvider, listProviders } from '../services/payment';

const router = Router();

// GET /api/payments/providers — lista proveedores registrados
router.get(
  '/providers',
  authenticate,
  (_req: AuthRequest, res: Response): void => {
    res.json({ providers: listProviders() });
  }
);

// POST /api/payments/orders/:orderId/initiate — iniciar cobro en terminal POS
router.post(
  '/orders/:orderId/initiate',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('iniciar_pago', 'pedido'),
  [
    body('method').isIn(['debito', 'credito']).withMessage('Método debe ser debito o credito'),
    body('installments').optional().isInt({ min: 0 }).withMessage('Cuotas debe ser entero >= 0'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const order = await Order.findById(req.params.orderId);
      if (!order) {
        res.status(404).json({ message: 'Pedido no encontrado.' });
        return;
      }

      // Solo se puede pagar pedidos aprobados o en preparación
      if (!['aprobado', 'en_preparacion', 'listo_retiro'].includes(order.estado)) {
        res.status(400).json({
          message: `No se puede cobrar un pedido en estado "${order.estado}".`,
        });
        return;
      }

      // Verificar que no haya un pago ya aprobado
      if (order.pago?.estado === 'aprobado') {
        res.status(400).json({ message: 'Este pedido ya tiene un pago aprobado.' });
        return;
      }

      const provider = getProvider();
      const result = await provider.initiatePayment({
        orderId: order._id.toString(),
        amount: order.total,
        method: req.body.method,
        installments: req.body.installments,
        reference: order.numeroPedido,
        metadata: { operador: req.user!._id },
      });

      // Inicializar subdocumento de pago si no existe
      if (!order.pago) {
        order.pago = {
          estado: 'procesando',
          montoTotal: order.total,
          montoPagado: 0,
          intentos: [],
        };
      } else {
        order.pago.estado = 'procesando';
      }

      // Registrar intento
      order.pago.intentos.push({
        transactionId: result.transactionId,
        provider: provider.name,
        monto: order.total,
        metodo: req.body.method,
        cuotas: req.body.installments,
        estado: result.status,
        mensaje: result.message,
        fecha: new Date(),
        raw: result.raw,
      });

      // Registrar en historial
      order.historialEstados.push({
        estado: `pago_${result.status}`,
        fecha: new Date(),
        usuario: req.user!._id,
        observacion: `Pago iniciado vía ${provider.name} (${req.body.method}) - ${result.transactionId}`,
      });

      await order.save();
      res.json({ order, payment: result });
    } catch (error) {
      console.error('Initiate payment error:', error);
      res.status(500).json({ message: 'Error al iniciar pago.' });
    }
  }
);

// GET /api/payments/orders/:orderId/status — consultar estado del pago
router.get(
  '/orders/:orderId/status',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const order = await Order.findById(req.params.orderId);
      if (!order) {
        res.status(404).json({ message: 'Pedido no encontrado.' });
        return;
      }

      if (!order.pago || order.pago.intentos.length === 0) {
        res.json({ status: 'sin_pago', message: 'No hay pagos registrados para este pedido.' });
        return;
      }

      // Consultar último intento activo
      const lastAttempt = order.pago.intentos[order.pago.intentos.length - 1];

      if (lastAttempt.estado === 'procesando') {
        const provider = getProvider(lastAttempt.provider);
        const providerStatus = await provider.getPaymentStatus(lastAttempt.transactionId);

        // Actualizar si cambió
        if (providerStatus.status !== lastAttempt.estado) {
          lastAttempt.estado = providerStatus.status;
          lastAttempt.ultimosDigitos = providerStatus.lastFourDigits;
          lastAttempt.codigoAutorizacion = providerStatus.authorizationCode;
          lastAttempt.mensaje = providerStatus.message;

          if (providerStatus.status === 'aprobado') {
            order.pago.estado = 'aprobado';
            order.pago.montoPagado = providerStatus.amount || lastAttempt.monto;

            order.historialEstados.push({
              estado: 'pago_aprobado',
              fecha: new Date(),
              observacion: `Pago aprobado - ${lastAttempt.provider} ****${providerStatus.lastFourDigits || ''} Auth:${providerStatus.authorizationCode || ''}`,
            });

            // Crear registro financiero automático
            await FinanceTransaction.create({
              tipo: 'ingreso',
              monto: order.pago.montoPagado,
              descripcion: `Pago POS - Pedido ${order.numeroPedido}`,
              categoria: 'pago_pedido',
              fecha: new Date(),
              referencia: { tipo: 'orden', id: order._id },
              comprobante: `${lastAttempt.provider}:${lastAttempt.codigoAutorizacion}`,
              usuario: order.aprobadoPor || order.paciente,
            });
          } else if (['rechazado', 'cancelado', 'error'].includes(providerStatus.status)) {
            order.pago.estado = providerStatus.status as typeof order.pago.estado;
            order.historialEstados.push({
              estado: `pago_${providerStatus.status}`,
              fecha: new Date(),
              observacion: providerStatus.message,
            });
          }

          await order.save();
        }

        res.json({
          pago: order.pago,
          ultimoIntento: lastAttempt,
          providerStatus,
        });
      } else {
        res.json({
          pago: order.pago,
          ultimoIntento: lastAttempt,
        });
      }
    } catch (error) {
      console.error('Get payment status error:', error);
      res.status(500).json({ message: 'Error al consultar estado del pago.' });
    }
  }
);

// POST /api/payments/orders/:orderId/cancel — cancelar pago en curso
router.post(
  '/orders/:orderId/cancel',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('cancelar_pago', 'pedido'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const order = await Order.findById(req.params.orderId);
      if (!order) {
        res.status(404).json({ message: 'Pedido no encontrado.' });
        return;
      }

      if (!order.pago || order.pago.intentos.length === 0) {
        res.status(400).json({ message: 'No hay pagos registrados.' });
        return;
      }

      const lastAttempt = order.pago.intentos[order.pago.intentos.length - 1];
      if (!['procesando', 'pendiente'].includes(lastAttempt.estado)) {
        res.status(400).json({ message: `No se puede cancelar un pago en estado "${lastAttempt.estado}".` });
        return;
      }

      const provider = getProvider(lastAttempt.provider);
      const result = await provider.cancelPayment(lastAttempt.transactionId);

      if (result.success) {
        lastAttempt.estado = 'cancelado';
        lastAttempt.mensaje = result.message;
        order.pago.estado = 'cancelado';

        order.historialEstados.push({
          estado: 'pago_cancelado',
          fecha: new Date(),
          usuario: req.user!._id,
          observacion: result.message,
        });

        await order.save();
      }

      res.json({ success: result.success, message: result.message, pago: order.pago });
    } catch (error) {
      console.error('Cancel payment error:', error);
      res.status(500).json({ message: 'Error al cancelar pago.' });
    }
  }
);

// POST /api/payments/callback — webhook del proveedor POS
router.post(
  '/callback',
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const provider = getProvider();
      const result = await provider.handleCallback(req.body);

      // Buscar la orden por transactionId
      const order = await Order.findOne({
        'pago.intentos.transactionId': result.transactionId,
      });

      if (order && order.pago) {
        const attempt = order.pago.intentos.find(
          (a) => a.transactionId === result.transactionId
        );

        if (attempt) {
          attempt.estado = result.status;
          attempt.ultimosDigitos = result.lastFourDigits;
          attempt.codigoAutorizacion = result.authorizationCode;
          attempt.mensaje = result.message;

          if (result.status === 'aprobado') {
            order.pago.estado = 'aprobado';
            order.pago.montoPagado = result.amount || attempt.monto;
          }

          order.historialEstados.push({
            estado: `pago_${result.status}`,
            fecha: new Date(),
            observacion: `Callback: ${result.message}`,
          });

          await order.save();
        }
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Payment callback error:', error);
      res.status(500).json({ message: 'Error procesando callback.' });
    }
  }
);

export default router;
