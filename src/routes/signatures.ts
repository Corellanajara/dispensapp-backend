import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { Order, IOrderDocument } from '../models/Order';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { upload } from '../middleware/upload';
import { uploadFile } from '../services/storage';
import { getProvider, listProviders } from '../services/signature';

const router = Router();

// GET /api/signatures/providers — lista proveedores registrados
router.get(
  '/providers',
  authenticate,
  (_req: AuthRequest, res: Response): void => {
    res.json({ providers: listProviders() });
  }
);

// POST /api/signatures/orders/:orderId/documents — subir documento al pedido
router.post(
  '/orders/:orderId/documents',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('subir_documento', 'pedido'),
  upload.single('archivo'),
  [
    body('tipo').notEmpty().withMessage('Tipo de documento es requerido'),
    body('nombre').notEmpty().withMessage('Nombre del documento es requerido'),
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

      if (!req.file) {
        res.status(400).json({ message: 'Archivo es requerido.' });
        return;
      }

      const fileUrl = await uploadFile(req.file);

      order.documentos.push({
        tipo: req.body.tipo,
        nombre: req.body.nombre,
        archivo: fileUrl,
        fechaSubida: new Date(),
        subidoPor: req.user!._id,
      });

      order.historialEstados.push({
        estado: 'documento_subido',
        fecha: new Date(),
        usuario: req.user!._id,
        observacion: `Documento "${req.body.nombre}" (${req.body.tipo}) subido`,
      });

      await order.save();

      const populatedOrder = await Order.findById(order._id)
        .populate('paciente', 'nombre apellido rut email');

      res.status(201).json(populatedOrder);
    } catch (error) {
      console.error('Upload order document error:', error);
      res.status(500).json({ message: 'Error al subir documento.' });
    }
  }
);

// GET /api/signatures/orders/:orderId/documents — listar documentos del pedido
router.get(
  '/orders/:orderId/documents',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const order = await Order.findById(req.params.orderId)
        .select('documentos numeroPedido');
      if (!order) {
        res.status(404).json({ message: 'Pedido no encontrado.' });
        return;
      }
      res.json({ documentos: order.documentos, numeroPedido: order.numeroPedido });
    } catch (error) {
      console.error('Get order documents error:', error);
      res.status(500).json({ message: 'Error al obtener documentos.' });
    }
  }
);

// POST /api/signatures/orders/:orderId/documents/:docId/sign — solicitar firma
router.post(
  '/orders/:orderId/documents/:docId/sign',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('solicitar_firma', 'pedido'),
  [
    body('signerName').notEmpty().withMessage('Nombre del firmante es requerido'),
    body('signerEmail').isEmail().withMessage('Email del firmante inválido'),
    body('signerRut').optional().isString(),
    body('message').optional().isString(),
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

      const doc = (order.documentos as unknown as mongoose.Types.DocumentArray<IOrderDocument>).id(req.params.docId as string);
      if (!doc) {
        res.status(404).json({ message: 'Documento no encontrado.' });
        return;
      }

      // Verificar que no tenga firma activa
      if (doc.firma && ['enviado', 'firmado'].includes(doc.firma.estado)) {
        res.status(400).json({
          message: `El documento ya tiene una firma en estado "${doc.firma.estado}".`,
        });
        return;
      }

      const provider = getProvider();
      const result = await provider.requestSignature({
        documentId: doc._id.toString(),
        documentName: doc.nombre,
        documentPath: doc.archivo,
        signer: {
          name: req.body.signerName,
          email: req.body.signerEmail,
          rut: req.body.signerRut,
        },
        reference: order.numeroPedido,
        message: req.body.message,
      });

      doc.firma = {
        signatureId: result.signatureId,
        provider: provider.name,
        estado: result.status,
        signingUrl: result.signingUrl,
      };

      order.historialEstados.push({
        estado: 'firma_solicitada',
        fecha: new Date(),
        usuario: req.user!._id,
        observacion: `Firma solicitada para "${doc.nombre}" a ${req.body.signerEmail} vía ${provider.name}`,
      });

      await order.save();
      res.json({ order, signature: result });
    } catch (error) {
      console.error('Request signature error:', error);
      res.status(500).json({ message: 'Error al solicitar firma.' });
    }
  }
);

// GET /api/signatures/orders/:orderId/documents/:docId/status — estado de firma
router.get(
  '/orders/:orderId/documents/:docId/status',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const order = await Order.findById(req.params.orderId);
      if (!order) {
        res.status(404).json({ message: 'Pedido no encontrado.' });
        return;
      }

      const doc = (order.documentos as unknown as mongoose.Types.DocumentArray<IOrderDocument>).id(req.params.docId as string);
      if (!doc) {
        res.status(404).json({ message: 'Documento no encontrado.' });
        return;
      }

      if (!doc.firma) {
        res.json({ status: 'sin_firma', message: 'Este documento no tiene solicitud de firma.' });
        return;
      }

      // Si está en progreso, consultar al proveedor
      if (doc.firma.estado === 'enviado') {
        const provider = getProvider(doc.firma.provider);
        const providerStatus = await provider.getSignatureStatus(doc.firma.signatureId);

        if (providerStatus.status !== doc.firma.estado) {
          doc.firma.estado = providerStatus.status;

          if (providerStatus.status === 'firmado') {
            doc.firma.firmadoPor = providerStatus.signedBy;
            doc.firma.rutFirmante = providerStatus.signerRut;
            doc.firma.fechaFirma = providerStatus.signedAt;
            doc.firma.archivoFirmado = providerStatus.signedDocumentUrl;

            order.historialEstados.push({
              estado: 'documento_firmado',
              fecha: new Date(),
              observacion: `"${doc.nombre}" firmado por ${providerStatus.signedBy || 'firmante'}`,
            });
          } else if (['rechazado', 'expirado', 'error'].includes(providerStatus.status)) {
            order.historialEstados.push({
              estado: `firma_${providerStatus.status}`,
              fecha: new Date(),
              observacion: `Firma de "${doc.nombre}": ${providerStatus.message}`,
            });
          }

          await order.save();
        }

        res.json({ documento: doc, providerStatus });
      } else {
        res.json({ documento: doc });
      }
    } catch (error) {
      console.error('Get signature status error:', error);
      res.status(500).json({ message: 'Error al consultar estado de firma.' });
    }
  }
);

// POST /api/signatures/callback — webhook del proveedor de firma
router.post(
  '/callback',
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const provider = getProvider();
      const result = await provider.handleCallback(req.body);

      // Buscar la orden que contiene este documento
      const order = await Order.findOne({
        'documentos.firma.signatureId': result.signatureId,
      });

      if (order) {
        const doc = order.documentos.find(
          (d) => d.firma?.signatureId === result.signatureId
        );

        if (doc && doc.firma) {
          doc.firma.estado = result.status;
          if (result.status === 'firmado') {
            doc.firma.firmadoPor = result.signedBy;
            doc.firma.rutFirmante = result.signerRut;
            doc.firma.fechaFirma = result.signedAt;
            doc.firma.archivoFirmado = result.signedDocumentUrl;
          }

          order.historialEstados.push({
            estado: `firma_${result.status}`,
            fecha: new Date(),
            observacion: `Callback: "${doc.nombre}" - ${result.message}`,
          });

          await order.save();
        }
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Signature callback error:', error);
      res.status(500).json({ message: 'Error procesando callback de firma.' });
    }
  }
);

export default router;
