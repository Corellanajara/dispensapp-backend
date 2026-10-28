import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mongoose, { Types } from 'mongoose';
import { Order, IOrderDocument } from '../models/Order';
import { Patient, IDocument } from '../models/Patient';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { canAccessSucursal } from '../middleware/sucursal';
import { auditLog } from '../middleware/audit';
import { upload } from '../middleware/upload';
import { uploadFile, getDownloadUrl, estadoAlmacenamiento } from '../services/storage';
import { registrarAuditoria } from '../services/audit';
import { getProvider, listProviders } from '../services/signature';
import {
  solicitarFirmaDocumento,
  actualizarEstadoFirma,
  cancelarFirma,
  consultarCertificado,
  solicitarCertificado,
  procesarNotificacion,
  responderErrorFirma,
  retornoFirma,
} from '../services/firmas';
import { configFirma, actualizarConfigFirma } from '../services/configuracion';
import { COMUNAS_SIGNAPIS } from '../config/comunas';
import { DOCUMENT_TYPES } from '../config/documentos';
import { env } from '../config/env';

/**
 * Firma electrónica: configuración (administrador), firma de documentos del paciente,
 * certificado del firmante, adjuntos de las notas de dispensación y webhook del proveedor.
 */
const router = Router();

function baseUrl(req: AuthRequest): string {
  return `${req.protocol}://${req.get('host')}`;
}

function urlWebhook(req: AuthRequest): string {
  return `${env.BACKEND_PUBLIC_URL || baseUrl(req)}/api/signatures/callback`;
}

function validar(req: AuthRequest, res: Response): boolean {
  const errors = validationResult(req);
  if (errors.isEmpty()) return true;
  res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
  return false;
}

// GET /api/signatures/providers — lista proveedores registrados
router.get('/providers', authenticate, authorize('admin', 'operador'), (_req: AuthRequest, res: Response): void => {
  res.json({ providers: listProviders(), activo: env.SIGNATURE_PROVIDER });
});

// GET /api/signatures/comunas — comunas aceptadas por el proveedor (para el enrolamiento)
router.get('/comunas', authenticate, (_req: AuthRequest, res: Response): void => {
  res.json({ comunas: COMUNAS_SIGNAPIS });
});

// ─── Configuración (administrador) ─────────────────────────

function estadoConfig(req: AuthRequest) {
  return {
    firma: configFirma(),
    proveedor: getProvider().info(),
    webhookUrl: urlWebhook(req),
    produccion: env.NODE_ENV === 'production',
    almacenamiento: estadoAlmacenamiento(),
  };
}

// GET /api/signatures/config — configuración de firma y estado del proveedor
router.get('/config', authenticate, authorize('admin'), (req: AuthRequest, res: Response): void => {
  res.json(estadoConfig(req));
});

// PUT /api/signatures/config — el administrador decide si se firma y qué documentos
router.put(
  '/config',
  authenticate,
  authorize('admin'),
  [
    body('habilitada').optional().isBoolean().withMessage('habilitada debe ser verdadero o falso'),
    body('tiposConFirma').optional().isArray().withMessage('tiposConFirma debe ser una lista'),
    body('tiposConFirma.*').optional().isIn(DOCUMENT_TYPES).withMessage('Tipo de documento inválido'),
    body('tipoEstampa').optional().isIn([1, 2, 5]).withMessage('Tipo de estampa inválido'),
    body('textoEstampa').optional().isString().isLength({ max: 120 }).withMessage('El texto admite hasta 120 caracteres'),
    body('conQR').optional().isBoolean(),
    body('vigenciaCertificadoAnios').optional().isIn([1, 2, 3]).withMessage('La vigencia debe ser 1, 2 o 3 años'),
    body('posicion').optional({ values: 'null' }).isObject(),
    body('posicion.pagina').optional().isInt({ min: 1 }).withMessage('Página inválida'),
    body('posicion.x').optional().isInt({ min: 0 }).withMessage('Posición X inválida'),
    body('posicion.y').optional().isInt({ min: 0 }).withMessage('Posición Y inválida'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!validar(req, res)) return;
    try {
      const b = req.body;
      if (b.tipoEstampa === 2 && !String(b.textoEstampa ?? configFirma().textoEstampa ?? '').trim()) {
        res.status(400).json({ message: 'Escribe el texto de la estampa personalizada.' });
        return;
      }
      const antes = configFirma();
      const cambios: Record<string, unknown> = {};
      for (const k of ['habilitada', 'tiposConFirma', 'tipoEstampa', 'textoEstampa', 'conQR', 'vigenciaCertificadoAnios']) {
        if (b[k] !== undefined) cambios[k] = b[k];
      }
      if (b.posicion !== undefined) {
        cambios.posicion = b.posicion
          ? { pagina: Number(b.posicion.pagina), x: Number(b.posicion.x), y: Number(b.posicion.y) }
          : null;
      }
      const firma = await actualizarConfigFirma(cambios, req.user!._id as Types.ObjectId);

      void registrarAuditoria({
        req,
        usuario: req.user!._id as Types.ObjectId,
        accion: 'configurar_firma',
        entidad: 'configuracion',
        detalles: { antes, despues: firma },
      });
      res.json({ ...estadoConfig(req), firma });
    } catch (error) {
      console.error('Update signature config error:', error);
      res.status(500).json({ message: 'Error al guardar la configuración de firma.' });
    }
  }
);

// POST /api/signatures/proveedor/probar — prueba las credenciales del proveedor
router.post('/proveedor/probar', authenticate, authorize('admin'), async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const provider = getProvider();
    if (!provider.testConnection) {
      res.json({ ok: true, message: `El proveedor "${provider.name}" no necesita conexión externa.` });
      return;
    }
    res.json(await provider.testConnection());
  } catch (error) {
    responderErrorFirma(res, error, 'No se pudo probar la conexión con el proveedor');
  }
});

// GET /api/signatures/proveedor/webhook — webhook registrado hoy en el proveedor
router.get('/proveedor/webhook', authenticate, authorize('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const provider = getProvider();
    const actual = provider.getWebhook ? await provider.getWebhook() : null;
    res.json({ actual, esperado: urlWebhook(req), coincide: actual?.url === urlWebhook(req) });
  } catch (error) {
    responderErrorFirma(res, error, 'No se pudo consultar el webhook');
  }
});

// POST /api/signatures/proveedor/webhook — registra en el proveedor la URL de notificaciones de este backend
router.post('/proveedor/webhook', authenticate, authorize('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const provider = getProvider();
    if (!provider.configureWebhook) {
      res.status(400).json({ message: `El proveedor "${provider.name}" no usa webhook.` });
      return;
    }
    if (!env.SIGNATURE_CALLBACK_SECRET) {
      res.status(400).json({ message: 'Define SIGNATURE_CALLBACK_SECRET en las variables de entorno antes de registrar el webhook.' });
      return;
    }
    const url = urlWebhook(req);
    if (!url.startsWith('https://') && env.NODE_ENV === 'production') {
      res.status(400).json({ message: `La URL del webhook debe ser https (actual: ${url}). Revisa BACKEND_PUBLIC_URL.` });
      return;
    }
    const result = await provider.configureWebhook(url, env.SIGNATURE_CALLBACK_SECRET);
    void registrarAuditoria({
      req,
      usuario: req.user!._id as Types.ObjectId,
      accion: 'configurar_webhook_firma',
      entidad: 'configuracion',
      detalles: { url, proveedor: provider.name },
    });
    res.json({ ...result, url });
  } catch (error) {
    responderErrorFirma(res, error, 'No se pudo registrar el webhook');
  }
});

// POST /api/signatures/proveedor/webhook/probar — pide al proveedor enviar una notificación de prueba
router.post('/proveedor/webhook/probar', authenticate, authorize('admin'), async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const provider = getProvider();
    if (!provider.testWebhook) {
      res.status(400).json({ message: `El proveedor "${provider.name}" no usa webhook.` });
      return;
    }
    res.json(await provider.testWebhook());
  } catch (error) {
    responderErrorFirma(res, error, 'No se pudo probar el webhook');
  }
});

// ─── Documentos del paciente ───────────────────────────────

async function cargarPaciente(req: AuthRequest, res: Response) {
  const { patientId } = req.params as Record<string, string>;
  if (!mongoose.Types.ObjectId.isValid(patientId)) {
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
  return patient;
}

async function cargarDocumentoPaciente(req: AuthRequest, res: Response) {
  const patient = await cargarPaciente(req, res);
  if (!patient) return null;
  const { docId } = req.params as Record<string, string>;
  const doc = mongoose.Types.ObjectId.isValid(docId) ? (patient.documentos.id(docId) as IDocument | null) : null;
  if (!doc) {
    res.status(404).json({ message: 'Documento no encontrado.' });
    return null;
  }
  return { patient, doc };
}

// GET /api/signatures/patients/:patientId/certificado — estado del certificado de firma del paciente
router.get(
  '/patients/:patientId/certificado',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const patient = await cargarPaciente(req, res);
      if (!patient) return;
      const estado = await consultarCertificado(patient);
      if (patient.isModified()) await patient.save();
      res.json(estado);
    } catch (error) {
      responderErrorFirma(res, error, 'Error al consultar el certificado de firma');
    }
  }
);

const validarEnrolamiento = [
  body('serieCedula').isString().notEmpty().withMessage('Indica el número de documento de la cédula'),
  body('telefono').optional({ values: 'falsy' }).isString(),
  body('comuna').optional({ values: 'falsy' }).isString(),
];

// POST /api/signatures/patients/:patientId/certificado — pide el certificado de firma del paciente
router.post(
  '/patients/:patientId/certificado',
  authenticate,
  authorize('admin', 'operador'),
  validarEnrolamiento,
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!validar(req, res)) return;
    try {
      const patient = await cargarPaciente(req, res);
      if (!patient) return;
      const result = await solicitarCertificado(patient, req.body, retornoFirma.personalCertificado());
      await patient.save();
      void registrarAuditoria({
        req,
        usuario: req.user!._id as Types.ObjectId,
        accion: 'solicitar_certificado_firma',
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
      });
      res.json(result);
    } catch (error) {
      responderErrorFirma(res, error, 'Error al solicitar el certificado de firma');
    }
  }
);

// POST /api/signatures/patients/:patientId/documents/:docId/sign — enviar documento a firma del paciente
router.post(
  '/patients/:patientId/documents/:docId/sign',
  authenticate,
  authorize('admin', 'operador'),
  [body('reiniciar').optional().isBoolean()],
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!validar(req, res)) return;
    let found: Awaited<ReturnType<typeof cargarDocumentoPaciente>> = null;
    try {
      found = await cargarDocumentoPaciente(req, res);
      if (!found) return;
      const { patient, doc } = found;

      const result = await solicitarFirmaDocumento(patient, doc, req.user!._id as Types.ObjectId, {
        redirectUrl: retornoFirma.personal(),
        reiniciar: req.body.reiniciar === true,
      });
      await patient.save();

      void registrarAuditoria({
        req,
        usuario: req.user!._id as Types.ObjectId,
        accion: 'solicitar_firma',
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
        detalles: { documento: doc._id, tipo: doc.tipo, proveedor: doc.firma?.provider, reiniciar: !!req.body.reiniciar },
      });

      res.json({ documento: doc, firma: result });
    } catch (error) {
      // Guardar lo que haya cambiado (ej. estado del certificado) aunque la firma falle.
      if (found?.patient.isModified()) await found.patient.save().catch(() => undefined);
      responderErrorFirma(res, error, 'Error al solicitar firma');
    }
  }
);

// POST /api/signatures/patients/:patientId/documents/:docId/cancel — cancelar una firma en curso
router.post(
  '/patients/:patientId/documents/:docId/cancel',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const found = await cargarDocumentoPaciente(req, res);
      if (!found) return;
      const { patient, doc } = found;
      await cancelarFirma(doc);
      await patient.save();
      void registrarAuditoria({
        req,
        usuario: req.user!._id as Types.ObjectId,
        accion: 'cancelar_firma',
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
        detalles: { documento: doc._id, tipo: doc.tipo },
      });
      res.json({ documento: doc });
    } catch (error) {
      responderErrorFirma(res, error, 'Error al cancelar la firma');
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
      responderErrorFirma(res, error, 'Error al consultar estado de firma');
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

// POST /api/signatures/callback — exige el header X-Callback-Secret = SIGNATURE_CALLBACK_SECRET.
// Signapis lo envía porque el webhook se registra con authType WEBHOOK_API_KEY (ver /proveedor/webhook).
router.post('/callback', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!env.SIGNATURE_CALLBACK_SECRET || req.header('X-Callback-Secret') !== env.SIGNATURE_CALLBACK_SECRET) {
    void registrarAuditoria({
      req,
      accion: 'callback_firma_rechazado',
      entidad: 'firma',
      resultado: 'fallo',
      detalles: { code: typeof req.body?.code === 'string' ? req.body.code : undefined },
    });
    res.status(401).json({ message: 'Callback no autorizado.' });
    return;
  }

  try {
    const evento = await getProvider().handleCallback(req.body ?? {});
    const resumen = await procesarNotificacion(evento);
    console.log(`[firma] Webhook ${String(req.body?.code ?? '')}: ${resumen}`);
    res.json({ received: true });
  } catch (error) {
    // 500 = el proveedor reintenta durante 24 horas.
    console.error('Signature callback error:', error);
    res.status(500).json({ message: 'Error procesando callback de firma.' });
  }
});

export default router;
