import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mongoose, { Types } from 'mongoose';
import { Order, IOrderDocument } from '../models/Order';
import { Patient, IDocument } from '../models/Patient';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { canAccessSucursal } from '../middleware/sucursal';
import { auditLog } from '../middleware/audit';
import { upload } from '../middleware/upload';
import { uploadFile, getDownloadUrl } from '../services/storage';
import { registrarAuditoria } from '../services/audit';
import { getProvider, listProviders } from '../services/signature';
import { solicitarFirmaDocumento, actualizarEstadoFirma, FirmaError } from '../services/firmas';
import { env } from '../config/env';

/**
 * Firma electrónica de documentos del paciente (reglamento interno y mandato o contrato)
 * y adjuntos de las notas de dispensación.
 */
const router = Router();

function baseUrl(req: AuthRequest): string {
  return `${req.protocol}://${req.get('host')}`;
}

// GET /api/signatures/providers — lista proveedores registrados
router.get('/providers', authenticate, authorize('admin', 'operador'), (_req: AuthRequest, res: Response): void => {
  res.json({ providers: listProviders(), activo: env.SIGNATURE_PROVIDER });
});

// ─── Documentos del paciente ───────────────────────────────

async function cargarDocumentoPaciente(req: AuthRequest, res: Response) {
  const { patientId, docId } = req.params as Record<string, string>;
  if (!mongoose.Types.ObjectId.isValid(patientId) || !mongoose.Types.ObjectId.isValid(docId)) {
    res.status(400).json({ message: 'ID inválido.' });
    return null;
  }
  const patient = await Patient.findById(patientId);
  if (!patient) {
    res.status(404).json({ message: 'Paciente no encontrado.' });
    return null;
  }
  if (patient.sucursal && !canAccessSucursal(req.user, patient.sucursal)) {
    res.status(403).json({ message: 'No tiene acceso a pacientes de esta sucursal.' });
    return null;
  }
  const doc = patient.documentos.id(docId) as IDocument | null;
  if (!doc) {
    res.status(404).json({ message: 'Documento no encontrado.' });
    return null;
  }
  return { patient, doc };
}

// POST /api/signatures/patients/:patientId/documents/:docId/sign — enviar documento a firma del paciente
router.post(
  '/patients/:patientId/documents/:docId/sign',
  authenticate,
  authorize('admin', 'operador'),
  [
    body('signerName').optional().isString(),
    body('signerEmail').optional().isEmail().withMessage('Email del firmante inválido'),
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
      const found = await cargarDocumentoPaciente(req, res);
      if (!found) return;
      const { patient, doc } = found;

      // Por defecto firma el propio paciente.
      const result = await solicitarFirmaDocumento(
        patient,
        doc,
        {
          name: req.body.signerName || `${patient.nombre} ${patient.apellido}`,
          email: req.body.signerEmail || patient.email,
          rut: req.body.signerRut || patient.rut,
        },
        req.user!._id as Types.ObjectId,
        req.body.message
      );
      await patient.save();

      void registrarAuditoria({
        req,
        usuario: req.user!._id as Types.ObjectId,
        accion: 'solicitar_firma',
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
        detalles: { documento: doc._id, tipo: doc.tipo, proveedor: doc.firma?.provider },
      });

      res.json({ documento: doc, firma: result });
    } catch (error) {
      if (error instanceof FirmaError) {
        res.status(error.status).json({ message: error.message });
        return;
      }
      console.error('Request patient signature error:', error);
      res.status(500).json({ message: 'Error al solicitar firma.' });
    }
  }
);

// GET /api/signatures/patients/:patientId/documents/:docId/status — estado de la firma
router.get(
  '/patients/:patientId/documents/:docId/status',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const found = await cargarDocumentoPaciente(req, res);
      if (!found) return;
      const { patient, doc } = found;
      if (await actualizarEstadoFirma(doc)) await patient.save();
      res.json({ documento: doc });
    } catch (error) {
      console.error('Get patient signature status error:', error);
      res.status(500).json({ message: 'Error al consultar estado de firma.' });
    }
  }
);

// ─── Adjuntos de notas de dispensación ─────────────────────

async function cargarNota(req: AuthRequest, res: Response) {
  if (!mongoose.Types.ObjectId.isValid(String(req.params.orderId))) {
    res.status(400).json({ message: 'ID inválido.' });
    return null;
  }
  const order = await Order.findById(req.params.orderId);
  if (!order) {
    res.status(404).json({ message: 'Nota no encontrada.' });
    return null;
  }
  if (!canAccessSucursal(req.user, order.sucursal)) {
    res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
    return null;
  }
  return order;
}

// POST /api/signatures/orders/:orderId/documents — adjuntar documento a la nota
router.post(
  '/orders/:orderId/documents',
  authenticate,
  authorize('admin', 'operador'),
  upload.single('archivo'),
  auditLog('subir_documento', 'pedido'),
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
      const order = await cargarNota(req, res);
      if (!order) return;

      if (!req.file) {
        res.status(400).json({ message: 'Archivo es requerido.' });
        return;
      }

      const fileRef = await uploadFile(req.file, { privado: true });

      order.documentos.push({
        tipo: req.body.tipo,
        nombre: req.body.nombre,
        archivo: fileRef,
        fechaSubida: new Date(),
        subidoPor: req.user!._id as Types.ObjectId,
      });

      order.historialEstados.push({
        estado: 'documento_subido',
        fecha: new Date(),
        usuario: req.user!._id as Types.ObjectId,
        observacion: `Documento "${req.body.nombre}" (${req.body.tipo}) subido`,
      });

      await order.save();

      const populatedOrder = await Order.findById(order._id).populate('paciente', 'nombre apellido rut email');
      res.status(201).json(populatedOrder);
    } catch (error) {
      console.error('Upload order document error:', error);
      res.status(500).json({ message: 'Error al subir documento.' });
    }
  }
);

// GET /api/signatures/orders/:orderId/documents — listar adjuntos de la nota
router.get(
  '/orders/:orderId/documents',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const order = await cargarNota(req, res);
      if (!order) return;
      res.json({ documentos: order.documentos, numeroPedido: order.numeroPedido });
    } catch (error) {
      console.error('Get order documents error:', error);
      res.status(500).json({ message: 'Error al obtener documentos.' });
    }
  }
);

// GET /api/signatures/orders/:orderId/documents/:docId/archivo — enlace temporal de descarga
router.get(
  '/orders/:orderId/documents/:docId/archivo',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const order = await cargarNota(req, res);
      if (!order) return;
      const doc = (order.documentos as unknown as mongoose.Types.DocumentArray<IOrderDocument>).id(
        String(req.params.docId)
      );
      if (!doc) {
        res.status(404).json({ message: 'Documento no encontrado.' });
        return;
      }
      const ref = req.query.firmado === 'true' && doc.firma?.archivoFirmado ? doc.firma.archivoFirmado : doc.archivo;
      const url = await getDownloadUrl(ref, baseUrl(req));
      if (!url) {
        res.status(404).json({ message: 'El archivo no está disponible.' });
        return;
      }
      void registrarAuditoria({
        req,
        usuario: req.user!._id as Types.ObjectId,
        accion: 'ver_documento',
        entidad: 'pedido',
        entidadId: order._id as Types.ObjectId,
        sucursal: order.sucursal,
        detalles: { documento: doc._id },
      });
      res.json({ url });
    } catch (error) {
      console.error('Get order document file error:', error);
      res.status(500).json({ message: 'Error al obtener documento.' });
    }
  }
);

// ─── Webhook del proveedor ─────────────────────────────────

// POST /api/signatures/callback — exige el header X-Callback-Secret = SIGNATURE_CALLBACK_SECRET
router.post('/callback', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!env.SIGNATURE_CALLBACK_SECRET || req.header('X-Callback-Secret') !== env.SIGNATURE_CALLBACK_SECRET) {
      void registrarAuditoria({
        req,
        accion: 'callback_firma_rechazado',
        entidad: 'firma',
        resultado: 'fallo',
      });
      res.status(401).json({ message: 'Callback no autorizado.' });
      return;
    }

    const provider = getProvider();
    const result = await provider.handleCallback(req.body);

    const patient = await Patient.findOne({ 'documentos.firma.signatureId': result.signatureId });
    if (patient) {
      const doc = patient.documentos.find((d) => d.firma?.signatureId === result.signatureId);
      if (doc?.firma) {
        doc.firma.estado = result.status;
        if (result.status === 'firmado') {
          doc.firma.firmadoPor = result.signedBy;
          doc.firma.rutFirmante = result.signerRut;
          doc.firma.fechaFirma = result.signedAt;
          doc.firma.archivoFirmado = result.signedDocumentUrl;
        }
        await patient.save();
        void registrarAuditoria({
          req,
          accion: `firma_${result.status}`,
          entidad: 'paciente',
          entidadId: patient._id as Types.ObjectId,
          sucursal: patient.sucursal,
          detalles: { documento: doc._id, signatureId: result.signatureId },
        });
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Signature callback error:', error);
    res.status(500).json({ message: 'Error procesando callback de firma.' });
  }
});

export default router;
