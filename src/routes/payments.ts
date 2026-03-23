import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import axios from 'axios';
import { Order } from '../models/Order';
import { FinanceTransaction } from '../models/Finance';
import { Patient } from '../models/Patient';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { getProvider, listProviders } from '../services/payment';
import { env } from '../config/env';

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

// POST /api/payments/orders/:orderId/create-flow
router.post(
  '/orders/:orderId/create-flow',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('crear_pago_flow', 'pedido'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const order = await Order.findById(req.params.orderId).populate('paciente', 'nombre apellido rut email');
      if (!order) {
        res.status(404).json({ message: 'Pedido no encontrado.' });
        return;
      }

      if (!['aprobado', 'en_preparacion', 'listo_retiro'].includes(order.estado)) {
        res.status(400).json({
          message: `No se puede crear pago para un pedido en estado "${order.estado}".`,
        });
        return;
      }

      if (order.pago?.estado === 'aprobado') {
        res.status(400).json({ message: 'Este pedido ya tiene un pago aprobado.' });
        return;
      }

      const patient = order.paciente as any;
      const paymentMethod = req.body.paymentMethod || 9;

      const flowResponse = await axios.post(`${env.FLOW_SERVICE_URL}/apiFlow/create_order`, {
        orderId: order._id.toString(),
        subject: `Pago Pedido #${order.numeroPedido} - Dispensario`,
        currency: 'CLP',
        amount: order.total,
        email: patient.email,
        paymentMethod,
        rut: patient.rut,
        serviceId: order._id.toString(),
      });
      console.log('flowResponse', flowResponse.data);
      const { redirect } = flowResponse.data;
      if (!redirect) {
        res.status(502).json({ message: 'Error al crear pago en Flow.cl', detail: flowResponse.data });
        return;
      }

      const urlObj = new URL(redirect);
      const flowToken = urlObj.searchParams.get('token') || '';

      if (!order.pago) {
        order.pago = {
          estado: 'pendiente',
          montoTotal: order.total,
          montoPagado: 0,
          intentos: [],
        };
      } else {
        order.pago.estado = 'pendiente';
      }

      order.pago.intentos.push({
        transactionId: `flow_${Date.now()}`,
        provider: 'flow',
        monto: order.total,
        metodo: 'flow',
        estado: 'pendiente',
        mensaje: 'Link de pago generado vía Flow.cl',
        fecha: new Date(),
        flowToken,
        redirectUrl: redirect,
      });

      order.historialEstados.push({
        estado: 'pago_pendiente',
        fecha: new Date(),
        usuario: req.user!._id,
        observacion: `Pago Flow.cl creado por ${req.user!.nombre || 'operador'}`,
      });

      await order.save();
      res.json({ order, redirectUrl: redirect, flowToken });
    } catch (error) {
      console.error('Create flow payment error:', error);
      res.status(500).json({ message: 'Error al crear pago Flow.cl.' });
    }
  }
);

// POST /api/payments/orders/:orderId/send-payment-email
router.post(
  '/orders/:orderId/send-payment-email',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('enviar_pago_email', 'pedido'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const order = await Order.findById(req.params.orderId).populate('paciente', 'nombre apellido rut email');
      if (!order) {
        res.status(404).json({ message: 'Pedido no encontrado.' });
        return;
      }

      if (!['aprobado', 'en_preparacion', 'listo_retiro'].includes(order.estado)) {
        res.status(400).json({
          message: `No se puede enviar pago para un pedido en estado "${order.estado}".`,
        });
        return;
      }

      if (order.pago?.estado === 'aprobado') {
        res.status(400).json({ message: 'Este pedido ya tiene un pago aprobado.' });
        return;
      }

      const patient = order.paciente as any;
      const email = req.body.email || patient.email;
      const subject = req.body.subject || `Pago Pedido #${order.numeroPedido} - Dispensario`;

      if (!email) {
        res.status(400).json({ message: 'Email del paciente es requerido.' });
        return;
      }

      const flowResponse = await axios.post(`${env.FLOW_SERVICE_URL}/apiFlow/create_email`, {
        email,
        subject,
        amount: order.total,
        orderId: order._id.toString(),
      });

      const flowData = flowResponse.data?.response || flowResponse.data;

      if (!order.pago) {
        order.pago = {
          estado: 'pendiente',
          montoTotal: order.total,
          montoPagado: 0,
          intentos: [],
        };
      } else {
        order.pago.estado = 'pendiente';
      }

      order.pago.intentos.push({
        transactionId: `flow_email_${Date.now()}`,
        provider: 'flow',
        monto: order.total,
        metodo: 'flow',
        estado: 'pendiente',
        mensaje: `Link de pago enviado por email a ${email}`,
        fecha: new Date(),
        flowToken: flowData?.token,
        flowOrderNumber: flowData?.flowOrder,
        raw: flowData,
      });

      order.historialEstados.push({
        estado: 'pago_pendiente',
        fecha: new Date(),
        usuario: req.user!._id,
        observacion: `Link de pago enviado por email a ${email} vía Flow.cl`,
      });

      await order.save();
      res.json({ order, emailSent: true, email, flowResponse: flowData });
    } catch (error) {
      console.error('Send payment email error:', error);
      res.status(500).json({ message: 'Error al enviar pago por email.' });
    }
  }
);

// GET /api/payments/orders/:orderId/flow-status
router.get(
  '/orders/:orderId/flow-status',
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

      const flowAttempts = order.pago.intentos.filter((a) => a.provider === 'flow');
      const lastFlowAttempt = flowAttempts[flowAttempts.length - 1];

      if (!lastFlowAttempt) {
        res.json({ status: 'sin_pago_flow', message: 'No hay pagos Flow.cl registrados.' });
        return;
      }

      if (['aprobado', 'rechazado', 'cancelado'].includes(lastFlowAttempt.estado)) {
        res.json({ pago: order.pago, ultimoIntento: lastFlowAttempt });
        return;
      }

      if (lastFlowAttempt.flowToken) {
        try {
          const flowResponse = await axios.post(
            `${env.FLOW_SERVICE_URL}/getPayment?token=${lastFlowAttempt.flowToken}`
          );
          const flowData = flowResponse.data;

          const flowStatusMap: Record<number, 'pendiente' | 'aprobado' | 'rechazado' | 'cancelado'> = {
            1: 'pendiente',
            2: 'aprobado',
            3: 'rechazado',
            4: 'cancelado',
          };
          const newStatus = flowStatusMap[flowData?.status] || lastFlowAttempt.estado;

          if (newStatus !== lastFlowAttempt.estado) {
            lastFlowAttempt.estado = newStatus;
            lastFlowAttempt.raw = flowData;
            order.pago.estado = newStatus;

            if (newStatus === 'aprobado') {
              order.pago.montoPagado = flowData?.amount || lastFlowAttempt.monto;
              order.historialEstados.push({
                estado: 'pago_aprobado',
                fecha: new Date(),
                observacion: `Pago aprobado vía Flow.cl (consulta manual)`,
              });

              await FinanceTransaction.create({
                tipo: 'ingreso',
                monto: flowData?.amount || order.total,
                descripcion: `Pago Flow.cl - Pedido ${order.numeroPedido}`,
                categoria: 'pago_pedido',
                fecha: new Date(),
                referencia: { tipo: 'orden', id: order._id },
                comprobante: `flow:${flowData?.flowOrder || lastFlowAttempt.flowToken}`,
                usuario: order.aprobadoPor || order.paciente,
              });
            } else if (newStatus === 'rechazado') {
              order.historialEstados.push({
                estado: 'pago_rechazado',
                fecha: new Date(),
                observacion: `Pago rechazado vía Flow.cl`,
              });
            } else if (newStatus === 'cancelado') {
              order.historialEstados.push({
                estado: 'pago_cancelado',
                fecha: new Date(),
                observacion: `Pago cancelado vía Flow.cl`,
              });
            }

            await order.save();
          }

          res.json({ pago: order.pago, ultimoIntento: lastFlowAttempt, flowStatus: flowData });
        } catch (flowError) {
          console.error('Flow status query error:', flowError);
          res.json({
            pago: order.pago,
            ultimoIntento: lastFlowAttempt,
            flowError: 'No se pudo consultar el estado en Flow.cl',
          });
        }
      } else {
        res.json({ pago: order.pago, ultimoIntento: lastFlowAttempt });
      }
    } catch (error) {
      console.error('Get flow status error:', error);
      res.status(500).json({ message: 'Error al consultar estado del pago.' });
    }
  }
);

// POST /api/payments/orders/:orderId/patient-pay — Patient self-initiates Flow.cl payment
router.post(
  '/orders/:orderId/patient-pay',
  authenticate,
  authorize('paciente'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const order = await Order.findById(req.params.orderId).populate('paciente', 'nombre apellido rut email usuario');
      if (!order) {
        res.status(404).json({ message: 'Pedido no encontrado.' });
        return;
      }

      const patient = order.paciente as any;
      if (!patient || patient.usuario?.toString() !== req.user!._id.toString()) {
        res.status(403).json({ message: 'No tienes permiso para pagar este pedido.' });
        return;
      }

      if (['cancelado', 'entregado'].includes(order.estado)) {
        res.status(400).json({ message: `No se puede pagar un pedido en estado "${order.estado}".` });
        return;
      }

      if (order.pago?.estado === 'aprobado') {
        res.status(400).json({ message: 'Este pedido ya fue pagado.' });
        return;
      }

      // If there's already a pending flow attempt with redirectUrl, return it
      const existingFlowAttempt = order.pago?.intentos
        ?.filter((a) => a.provider === 'flow' && a.estado === 'pendiente' && a.redirectUrl)
        .slice(-1)[0];

      if (existingFlowAttempt?.redirectUrl) {
        res.json({ order, redirectUrl: existingFlowAttempt.redirectUrl, flowToken: existingFlowAttempt.flowToken });
        return;
      }

      const flowResponse = await axios.post(`${env.FLOW_SERVICE_URL}/apiFlow/create_order`, {
        orderId: order._id.toString(),
        subject: `Pago Pedido #${order.numeroPedido} - Dispensario`,
        currency: 'CLP',
        amount: order.total,
        email: 'corellanajara@hotmail.com',//patient.email,
        paymentMethod: 9,
        rut: patient.rut,
        serviceId: order._id.toString(),
      });

      const { redirect } = flowResponse.data;
      if (!redirect) {
        res.status(502).json({ message: 'Error al crear pago en Flow.cl' , reason: flowResponse.data?.error});
        return;
      }

      const urlObj = new URL(redirect);
      const flowToken = urlObj.searchParams.get('token') || '';

      if (!order.pago) {
        order.pago = {
          estado: 'pendiente',
          montoTotal: order.total,
          montoPagado: 0,
          intentos: [],
        };
      } else {
        order.pago.estado = 'pendiente';
      }

      order.pago.intentos.push({
        transactionId: `flow_patient_${Date.now()}`,
        provider: 'flow',
        monto: order.total,
        metodo: 'flow',
        estado: 'pendiente',
        mensaje: 'Pago iniciado por paciente',
        fecha: new Date(),
        flowToken,
        redirectUrl: redirect,
      });

      order.historialEstados.push({
        estado: 'pago_pendiente',
        fecha: new Date(),
        usuario: req.user!._id,
        observacion: 'Pago Flow.cl iniciado por paciente',
      });

      await order.save();
      res.json({ order, redirectUrl: redirect, flowToken });
    } catch (error) {
      console.error('Patient pay error:', error);
      res.status(500).json({ message: 'Error al iniciar pago.' });
    }
  }
);

export default router;
