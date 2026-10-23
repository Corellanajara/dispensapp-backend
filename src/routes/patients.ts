import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mongoose, { Types } from 'mongoose';
import { Patient, IPatient, IDocument } from '../models/Patient';
import { Sucursal } from '../models/Sucursal';
import { Order } from '../models/Order';
import { AuditLog } from '../models/AuditLog';
import { EspacioCultivo, Cosecha } from '../models/Cultivo';
import { DOCUMENT_TYPES, requirementFor } from '../config/documentos';
import { ensurePatientProfileForUser } from '../services/ensurePatientProfile';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { resolveSucursal, canAccessSucursal } from '../middleware/sucursal';
import { auditLog } from '../middleware/audit';
import { upload } from '../middleware/upload';
import { uploadFile, getDownloadUrl } from '../services/storage';
import { registrarAuditoria } from '../services/audit';
import {
  recetaVigente,
  verificarRequisitosActivacion,
  reactivarSiCorresponde,
  alertasVigencia,
} from '../services/vigencia';
import { solicitarFirmaDocumento, actualizarEstadoFirma, FirmaError } from '../services/firmas';

const router = Router();

const SIN_PERFIL =
  'No se pudo vincular tu cuenta con un perfil de paciente. Si ya existe una ficha con tu RUT en el sistema, contacta al dispensario.';

/** Campos que el personal puede editar con PUT. Estado, documentos y dispensario tienen rutas propias. */
const CAMPOS_EDITABLES = [
  'nombre',
  'apellido',
  'fechaNacimiento',
  'direccion',
  'telefono',
  'email',
  'medicoTratante',
  'limiteMensualUnidades',
  'observaciones',
];

function baseUrl(req: AuthRequest): string {
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * El personal ve los pacientes de sus sucursales.
 * Las fichas antiguas sin sucursal quedan visibles para poder asignarlas.
 */
function puedeVerPaciente(req: AuthRequest, patient: IPatient): boolean {
  if (!patient.sucursal) return true;
  return canAccessSucursal(req.user, patient.sucursal);
}

function filtroPacientes(req: AuthRequest): Record<string, unknown> {
  if (req.sucursalId) {
    return { $or: [{ sucursal: req.sucursalId }, { sucursal: null }] };
  }
  if (req.user!.role !== 'admin') {
    return { $or: [{ sucursal: { $in: req.user!.sucursales || [] } }, { sucursal: null }] };
  }
  return {};
}

async function cargarPacienteConAcceso(req: AuthRequest, res: Response): Promise<IPatient | null> {
  if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
    res.status(400).json({ message: 'ID de paciente inválido.' });
    return null;
  }
  const patient = await Patient.findById(req.params.id);
  if (!patient) {
    res.status(404).json({ message: 'Paciente no encontrado.' });
    return null;
  }
  if (!puedeVerPaciente(req, patient)) {
    res.status(403).json({ message: 'No tiene acceso a pacientes de esta sucursal.' });
    return null;
  }
  return patient;
}

function buscarDocumento(patient: IPatient, docId: string): IDocument | null {
  if (!mongoose.Types.ObjectId.isValid(docId)) return null;
  return patient.documentos.id(docId) as IDocument | null;
}

/** Valida y crea un documento a partir del archivo subido. */
async function crearDocumento(req: AuthRequest, res: Response): Promise<IDocument | null> {
  if (!req.file) {
    res.status(400).json({ message: 'Archivo es requerido.' });
    return null;
  }
  const requisito = requirementFor(req.body.tipo);
  if (requisito?.requiereVencimiento && !req.body.fechaVencimiento) {
    res.status(400).json({ message: `${requisito.label}: la fecha de vencimiento es obligatoria.` });
    return null;
  }

  const archivo = await uploadFile(req.file, { privado: true });

  return {
    tipo: req.body.tipo,
    nombre: req.body.nombre,
    archivo,
    fechaSubida: new Date(),
    subidoPor: req.user!._id as Types.ObjectId,
    fechaVencimiento: req.body.fechaVencimiento ? new Date(req.body.fechaVencimiento) : undefined,
    estado: 'pendiente',
    observaciones: req.body.observaciones,
  } as IDocument;
}

const validarDocumento = [
  body('tipo').isIn(DOCUMENT_TYPES).withMessage('Tipo de documento inválido'),
  body('nombre').notEmpty().withMessage('Nombre del documento es requerido'),
  body('fechaVencimiento').optional({ values: 'falsy' }).isISO8601().withMessage('Fecha de vencimiento inválida'),
];

function conVigencia(patient: IPatient) {
  const json = patient.toJSON() as Record<string, unknown>;
  const receta = recetaVigente(patient);
  json.recetaVigente = receta ? { _id: receta._id, fechaVencimiento: receta.fechaVencimiento } : null;
  json.requisitosActivacion = verificarRequisitosActivacion(patient);
  return json;
}

// ─── Listado y alertas ─────────────────────────────────────

// GET /api/patients
router.get(
  '/',
  authenticate,
  authorize('admin', 'operador', 'cultivo'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { page = '1', limit = '20', estado, search, sinSucursal } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = { ...filtroPacientes(req) };
      if (estado) filter.estado = estado;
      if (sinSucursal === 'true') filter.sucursal = null;
      if (search) {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$and = [
          {
            $or: [
              { nombre: { $regex: escaped, $options: 'i' } },
              { apellido: { $regex: escaped, $options: 'i' } },
              { rut: { $regex: escaped, $options: 'i' } },
            ],
          },
        ];
      }

      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

      // El rol cultivo solo necesita datos básicos para asignar espacios.
      const select = req.user!.role === 'cultivo' ? 'nombre apellido rut estado sucursal' : undefined;

      const [patients, total] = await Promise.all([
        Patient.find(filter)
          .select(select || '')
          .populate('sucursal', 'nombre codigo')
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        Patient.countDocuments(filter),
      ]);

      res.json({
        data: req.user!.role === 'cultivo' ? patients : patients.map(conVigencia),
        pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
      });
    } catch (error) {
      console.error('Get patients error:', error);
      res.status(500).json({ message: 'Error al obtener pacientes.' });
    }
  }
);

// GET /api/patients/alertas/vigencia — recetas por vencer, vencidas y pacientes sin receta vigente
router.get(
  '/alertas/vigencia',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      res.json(await alertasVigencia(filtroPacientes(req)));
    } catch (error) {
      console.error('Get vigencia alerts error:', error);
      res.status(500).json({ message: 'Error al obtener alertas de vigencia.' });
    }
  }
);

// ─── Portal del paciente ───────────────────────────────────

// GET /api/patients/me
router.get('/me', authenticate, authorize('paciente'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const patient = await ensurePatientProfileForUser(req.user!);
    if (!patient) {
      res.status(409).json({ message: SIN_PERFIL });
      return;
    }
    await patient.populate('sucursal', 'nombre codigo direccion telefono horarioAtencion');
    res.json(conVigencia(patient));
  } catch (error) {
    console.error('Get patient profile error:', error);
    res.status(500).json({ message: 'Error al obtener perfil de paciente.' });
  }
});

// PUT /api/patients/me
router.put(
  '/me',
  authenticate,
  authorize('paciente'),
  auditLog('actualizar', 'paciente'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const update: Record<string, unknown> = {};
      if (req.body.telefono !== undefined) update.telefono = req.body.telefono;
      if (req.body.direccion !== undefined) update.direccion = req.body.direccion;
      if (req.body.medicoTratante !== undefined) update.medicoTratante = req.body.medicoTratante;

      const existing = await ensurePatientProfileForUser(req.user!);
      if (!existing) {
        res.status(409).json({ message: SIN_PERFIL });
        return;
      }
      const patient = await Patient.findByIdAndUpdate(existing._id, update, { new: true, runValidators: true });
      if (!patient) {
        res.status(404).json({ message: 'Perfil de paciente no encontrado.' });
        return;
      }
      res.json(conVigencia(patient));
    } catch (error) {
      console.error('Update patient profile error:', error);
      res.status(500).json({ message: 'Error al actualizar perfil de paciente.' });
    }
  }
);

// POST /api/patients/me/documents
router.post(
  '/me/documents',
  authenticate,
  authorize('paciente'),
  upload.single('archivo'),
  auditLog('subir_documento', 'paciente'),
  validarDocumento,
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
      const doc = await crearDocumento(req, res);
      if (!doc) return;

      patient.documentos.push(doc);
      await patient.save();
      res.status(201).json(conVigencia(patient));
    } catch (error) {
      console.error('Upload patient document error:', error);
      res.status(500).json({ message: 'Error al subir documento.' });
    }
  }
);

// GET /api/patients/me/documents/:docId/archivo — enlace temporal de descarga
router.get(
  '/me/documents/:docId/archivo',
  authenticate,
  authorize('paciente'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const patient = await ensurePatientProfileForUser(req.user!);
      const doc = patient && buscarDocumento(patient, String(req.params.docId));
      if (!patient || !doc) {
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
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
        detalles: { documento: doc._id, tipo: doc.tipo },
      });
      res.json({ url });
    } catch (error) {
      console.error('Get own document error:', error);
      res.status(500).json({ message: 'Error al obtener documento.' });
    }
  }
);

// POST /api/patients/me/documents/:docId/firmar — el paciente pide firmar su documento
router.post(
  '/me/documents/:docId/firmar',
  authenticate,
  authorize('paciente'),
  auditLog('solicitar_firma', 'paciente'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const patient = await ensurePatientProfileForUser(req.user!);
      const doc = patient && buscarDocumento(patient, String(req.params.docId));
      if (!patient || !doc) {
        res.status(404).json({ message: 'Documento no encontrado.' });
        return;
      }
      const result = await solicitarFirmaDocumento(
        patient,
        doc,
        { name: `${patient.nombre} ${patient.apellido}`, email: patient.email, rut: patient.rut },
        req.user!._id as Types.ObjectId
      );
      await patient.save();
      res.json({ paciente: conVigencia(patient), firma: result });
    } catch (error) {
      if (error instanceof FirmaError) {
        res.status(error.status).json({ message: error.message });
        return;
      }
      console.error('Request own signature error:', error);
      res.status(500).json({ message: 'Error al solicitar firma.' });
    }
  }
);

// GET /api/patients/me/documents/:docId/firma — consulta el estado de la firma
router.get(
  '/me/documents/:docId/firma',
  authenticate,
  authorize('paciente'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const patient = await ensurePatientProfileForUser(req.user!);
      const doc = patient && buscarDocumento(patient, String(req.params.docId));
      if (!patient || !doc) {
        res.status(404).json({ message: 'Documento no encontrado.' });
        return;
      }
      if (await actualizarEstadoFirma(doc)) await patient.save();
      res.json({ documento: doc });
    } catch (error) {
      console.error('Get own signature status error:', error);
      res.status(500).json({ message: 'Error al consultar firma.' });
    }
  }
);

// ─── Ficha (personal) ──────────────────────────────────────

// GET /api/patients/:id
router.get(
  '/:id',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const patient = await cargarPacienteConAcceso(req, res);
      if (!patient) return;
      await patient.populate([
        { path: 'usuario', select: 'email nombre apellido' },
        { path: 'sucursal', select: 'nombre codigo' },
        { path: 'activadoPor', select: 'nombre apellido email' },
        { path: 'historialEstados.usuario', select: 'nombre apellido' },
        { path: 'documentos.revisadoPor', select: 'nombre apellido' },
        { path: 'documentos.subidoPor', select: 'nombre apellido role' },
      ]);
      res.json(conVigencia(patient));
    } catch (error) {
      console.error('Get patient error:', error);
      res.status(500).json({ message: 'Error al obtener paciente.' });
    }
  }
);

// POST /api/patients — el paciente queda en la sucursal seleccionada
router.post(
  '/',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal(),
  auditLog('crear', 'paciente'),
  [
    body('rut').notEmpty().withMessage('RUT es requerido'),
    body('nombre').notEmpty().withMessage('Nombre es requerido'),
    body('apellido').notEmpty().withMessage('Apellido es requerido'),
    body('fechaNacimiento').isISO8601().withMessage('Fecha de nacimiento inválida'),
    body('telefono').notEmpty().withMessage('Teléfono es requerido'),
    body('email').isEmail().withMessage('Email inválido'),
    body('medicoTratante.nombre').notEmpty().withMessage('Nombre del médico es requerido'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const sucursal = req.sucursalId || req.body.sucursal;
      if (!sucursal || !(await Sucursal.exists({ _id: sucursal, activo: true }))) {
        res.status(400).json({ message: 'Selecciona el dispensario al que pertenece el paciente.' });
        return;
      }

      const existing = await Patient.findOne({ rut: req.body.rut });
      if (existing) {
        res.status(400).json({ message: 'Ya existe un paciente con este RUT.' });
        return;
      }

      const data: Record<string, unknown> = {};
      for (const k of [...CAMPOS_EDITABLES, 'rut']) if (req.body[k] !== undefined) data[k] = req.body[k];

      const patient = new Patient({
        ...data,
        sucursal,
        estado: 'pendiente',
        historialEstados: [{ estado: 'pendiente', fecha: new Date(), usuario: req.user!._id, motivo: 'Ficha creada' }],
      });
      await patient.save();
      res.status(201).json(conVigencia(patient));
    } catch (error) {
      console.error('Create patient error:', error);
      res.status(500).json({ message: 'Error al crear paciente.' });
    }
  }
);

// PUT /api/patients/:id
router.put(
  '/:id',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('actualizar', 'paciente'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const existing = await cargarPacienteConAcceso(req, res);
      if (!existing) return;

      const update: Record<string, unknown> = {};
      for (const k of CAMPOS_EDITABLES) if (req.body[k] !== undefined) update[k] = req.body[k];

      const patient = await Patient.findByIdAndUpdate(existing._id, update, { new: true, runValidators: true });
      res.json(conVigencia(patient!));
    } catch (error) {
      console.error('Update patient error:', error);
      res.status(500).json({ message: 'Error al actualizar paciente.' });
    }
  }
);

// PATCH /api/patients/:id/sucursal — asignar o cambiar el dispensario (solo admin)
router.patch(
  '/:id/sucursal',
  authenticate,
  authorize('admin'),
  auditLog('cambiar_sucursal', 'paciente'),
  [body('sucursal').isMongoId().withMessage('Sucursal inválida')],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }
    try {
      if (!(await Sucursal.exists({ _id: req.body.sucursal, activo: true }))) {
        res.status(404).json({ message: 'Sucursal no encontrada o inactiva.' });
        return;
      }
      const patient = await Patient.findByIdAndUpdate(
        req.params.id,
        { sucursal: req.body.sucursal },
        { new: true }
      ).populate('sucursal', 'nombre codigo');
      if (!patient) {
        res.status(404).json({ message: 'Paciente no encontrado.' });
        return;
      }
      res.json(conVigencia(patient));
    } catch (error) {
      console.error('Assign patient sucursal error:', error);
      res.status(500).json({ message: 'Error al asignar sucursal.' });
    }
  }
);

// PATCH /api/patients/:id/status — activar, rechazar o suspender. Deja quién y cuándo.
router.patch(
  '/:id/status',
  authenticate,
  authorize('admin'),
  auditLog('cambiar_estado', 'paciente'),
  [
    body('estado').isIn(['pendiente', 'aprobado', 'rechazado', 'suspendido']).withMessage('Estado inválido'),
    body('motivo').optional().isString(),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const patient = await cargarPacienteConAcceso(req, res);
      if (!patient) return;

      const estado = req.body.estado as IPatient['estado'];
      const motivo: string | undefined = req.body.motivo || req.body.observaciones;

      if (estado === 'aprobado') {
        if (!patient.sucursal) {
          res.status(400).json({ message: 'Asigna un dispensario al paciente antes de activarlo.' });
          return;
        }
        const requisitos = verificarRequisitosActivacion(patient);
        if (requisitos.bloqueantes.length > 0) {
          res.status(400).json({
            message: `No se puede activar. Falta: ${requisitos.bloqueantes.join(', ')}.`,
            requisitos,
          });
          return;
        }
        patient.activadoPor = req.user!._id as Types.ObjectId;
        patient.fechaActivacion = new Date();
        patient.motivoSuspension = undefined;
      }

      if (estado === 'suspendido') {
        patient.motivoSuspension = 'manual';
      }

      patient.estado = estado;
      if (req.body.observaciones !== undefined) patient.observaciones = req.body.observaciones;
      patient.historialEstados.push({
        estado,
        fecha: new Date(),
        usuario: req.user!._id as Types.ObjectId,
        motivo,
      });
      await patient.save();

      await patient.populate([
        { path: 'sucursal', select: 'nombre codigo' },
        { path: 'activadoPor', select: 'nombre apellido email' },
        { path: 'historialEstados.usuario', select: 'nombre apellido' },
        { path: 'documentos.revisadoPor', select: 'nombre apellido' },
      ]);
      res.json(conVigencia(patient));
    } catch (error) {
      console.error('Update patient status error:', error);
      res.status(500).json({ message: 'Error al actualizar estado.' });
    }
  }
);

// POST /api/patients/:id/documents
router.post(
  '/:id/documents',
  authenticate,
  authorize('admin', 'operador'),
  upload.single('archivo'),
  auditLog('subir_documento', 'paciente'),
  validarDocumento,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const patient = await cargarPacienteConAcceso(req, res);
      if (!patient) return;
      const doc = await crearDocumento(req, res);
      if (!doc) return;

      patient.documentos.push(doc);
      await patient.save();
      res.status(201).json(conVigencia(patient));
    } catch (error) {
      console.error('Upload document error:', error);
      res.status(500).json({ message: 'Error al subir documento.' });
    }
  }
);

// PATCH /api/patients/:id/documents/:docId/review — el administrador aprueba o rechaza un documento
router.patch(
  '/:id/documents/:docId/review',
  authenticate,
  authorize('admin'),
  auditLog('revisar_documento', 'paciente'),
  [
    body('estado').isIn(['aprobado', 'rechazado']).withMessage('Estado inválido'),
    body('observaciones').optional().isString(),
    body('fechaVencimiento').optional({ values: 'falsy' }).isISO8601().withMessage('Fecha de vencimiento inválida'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const patient = await cargarPacienteConAcceso(req, res);
      if (!patient) return;
      const doc = buscarDocumento(patient, String(req.params.docId));
      if (!doc) {
        res.status(404).json({ message: 'Documento no encontrado.' });
        return;
      }

      if (req.body.fechaVencimiento) doc.fechaVencimiento = new Date(req.body.fechaVencimiento);

      const requisito = requirementFor(doc.tipo);
      if (req.body.estado === 'aprobado' && requisito?.requiereVencimiento && !doc.fechaVencimiento) {
        res.status(400).json({ message: `Indica la fecha de vencimiento de la ${requisito.label.toLowerCase()}.` });
        return;
      }

      doc.estado = req.body.estado;
      doc.observaciones = req.body.observaciones ?? doc.observaciones;
      doc.revisadoPor = req.user!._id as Types.ObjectId;
      doc.fechaRevision = new Date();

      const reactivado = reactivarSiCorresponde(patient, req.user!._id as Types.ObjectId);
      await patient.save();

      await patient.populate([
        { path: 'sucursal', select: 'nombre codigo' },
        { path: 'activadoPor', select: 'nombre apellido email' },
        { path: 'historialEstados.usuario', select: 'nombre apellido' },
        { path: 'documentos.revisadoPor', select: 'nombre apellido' },
      ]);
      res.json({ ...conVigencia(patient), reactivado });
    } catch (error) {
      console.error('Review document error:', error);
      res.status(500).json({ message: 'Error al revisar documento.' });
    }
  }
);

// GET /api/patients/:id/documents/:docId/archivo — enlace temporal de descarga (queda auditado)
router.get(
  '/:id/documents/:docId/archivo',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const patient = await cargarPacienteConAcceso(req, res);
      if (!patient) return;
      const doc = buscarDocumento(patient, String(req.params.docId));
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
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
        detalles: { documento: doc._id, tipo: doc.tipo },
      });
      res.json({ url });
    } catch (error) {
      console.error('Get document file error:', error);
      res.status(500).json({ message: 'Error al obtener documento.' });
    }
  }
);

// GET /api/patients/:id/expediente — todo lo del paciente en un solo lugar, para revisión o fiscalización
router.get(
  '/:id/expediente',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const patient = await cargarPacienteConAcceso(req, res);
      if (!patient) return;

      await patient.populate([
        { path: 'usuario', select: 'email nombre apellido' },
        { path: 'sucursal', select: 'nombre codigo direccion' },
        { path: 'activadoPor', select: 'nombre apellido email' },
        { path: 'historialEstados.usuario', select: 'nombre apellido email' },
        { path: 'documentos.revisadoPor', select: 'nombre apellido email' },
        { path: 'documentos.subidoPor', select: 'nombre apellido role' },
      ]);

      const [espacios, cosechas, dispensaciones, auditoria] = await Promise.all([
        EspacioCultivo.find({ paciente: patient._id })
          .populate('ubicacion', 'nombre codigo tipo')
          .populate('creadoPor', 'nombre apellido')
          .sort({ fechaInicio: -1 }),
        Cosecha.find({ paciente: patient._id })
          .populate('espacio', 'codigo flor')
          .populate('producto', 'nombre tipo')
          .populate('ubicacionDestino', 'nombre codigo')
          .populate('responsable', 'nombre apellido')
          .sort({ fecha: -1 }),
        Order.find({ paciente: patient._id })
          .select('-pago.intentos.raw')
          .populate('sucursal', 'nombre codigo')
          .populate('aprobadoPor', 'nombre apellido')
          .populate('preparadoPor', 'nombre apellido')
          .populate('historialEstados.usuario', 'nombre apellido')
          .populate('items.lotes.ubicacion', 'nombre codigo tipo')
          .sort({ createdAt: -1 }),
        AuditLog.find({ entidadId: patient._id })
          .populate('usuario', 'nombre apellido email role')
          .sort({ createdAt: -1 })
          .limit(500),
      ]);

      void registrarAuditoria({
        req,
        usuario: req.user!._id as Types.ObjectId,
        accion: 'exportar_expediente',
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
      });

      res.json({
        generadoEn: new Date(),
        generadoPor: {
          nombre: `${req.user!.nombre} ${req.user!.apellido}`,
          email: req.user!.email,
        },
        paciente: conVigencia(patient),
        espacios,
        cosechas,
        dispensaciones,
        auditoria,
      });
    } catch (error) {
      console.error('Get expediente error:', error);
      res.status(500).json({ message: 'Error al generar expediente.' });
    }
  }
);

export default router;
