import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mongoose, { Types } from 'mongoose';
import { Patient, IPatient, IDocument } from '../models/Patient';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { resolveSucursal, getSucursalFilter, canAccessSucursal } from '../middleware/sucursal';
import { getDownloadUrl } from '../services/storage';
import { registrarAuditoria } from '../services/audit';
import { configFirma, tipoRequiereFirma } from '../services/configuracion';
import { DOCUMENT_TYPE_LABELS, DocumentType } from '../config/documentos';
import {
  etapaValidacion,
  EtapaValidacion,
  consultarCertificado,
  solicitarCertificado,
  solicitarContrafirma,
  actualizarContrafirma,
  actualizarEstadoFirma,
  rechazarValidacion,
  exigirResponsable,
  responderErrorFirma,
  retornoFirma,
} from '../services/firmas';

/**
 * Validación del dispensario: lo que firma el paciente queda en esta bandeja hasta que un
 * responsable de firma lo revise y lo contrafirme con su propio certificado, o lo rechace
 * (el paciente sube una nueva versión y vuelve a firmar). Se repite hasta que cumple.
 */
const router = Router();

const ETAPAS_PENDIENTES: EtapaValidacion[] = ['por_validar', 'contrafirma_en_curso'];

function validar(req: AuthRequest, res: Response): boolean {
  const errors = validationResult(req);
  if (errors.isEmpty()) return true;
  res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
  return false;
}

function baseUrl(req: AuthRequest): string {
  return `${req.protocol}://${req.get('host')}`;
}

/** Último documento de cada tipo: las versiones antiguas no se validan. */
function ultimosPorTipo(patient: IPatient): IDocument[] {
  const porTipo = new Map<string, IDocument>();
  for (const d of patient.documentos) {
    const actual = porTipo.get(d.tipo);
    if (!actual || new Date(d.fechaSubida).getTime() >= new Date(actual.fechaSubida).getTime()) porTipo.set(d.tipo, d);
  }
  return [...porTipo.values()];
}

function nombreDe(ref: unknown): string | undefined {
  if (ref && typeof ref === 'object' && 'nombre' in ref) {
    const u = ref as { nombre?: string; apellido?: string };
    return `${u.nombre ?? ''} ${u.apellido ?? ''}`.trim() || undefined;
  }
  return undefined;
}

function itemBandeja(patient: IPatient, doc: IDocument, etapa: EtapaValidacion) {
  const sucursal = patient.sucursal as unknown as { _id?: Types.ObjectId; nombre?: string; codigo?: string } | undefined;
  return {
    paciente: {
      _id: patient._id,
      nombre: `${patient.nombre} ${patient.apellido}`.trim(),
      rut: patient.rut,
      sucursal: sucursal?.nombre ? { _id: sucursal._id, nombre: sucursal.nombre, codigo: sucursal.codigo } : null,
    },
    documento: {
      _id: doc._id,
      tipo: doc.tipo,
      etiqueta: DOCUMENT_TYPE_LABELS[doc.tipo as DocumentType] ?? doc.tipo,
      nombre: doc.nombre,
      fechaSubida: doc.fechaSubida,
      estado: doc.estado,
      observaciones: doc.observaciones,
    },
    etapa,
    firmaPaciente: doc.firma
      ? {
          firmadoPor: doc.firma.firmadoPor,
          rutFirmante: doc.firma.rutFirmante,
          fechaFirma: doc.firma.fechaFirma,
          tieneArchivo: !!doc.firma.archivoFirmado,
        }
      : null,
    contrafirma: doc.contrafirma
      ? {
          estado: doc.contrafirma.estado,
          responsable: nombreDe(doc.contrafirma.solicitadoPor),
          responsableId: (doc.contrafirma.solicitadoPor as { _id?: Types.ObjectId } | undefined)?._id ?? doc.contrafirma.solicitadoPor,
          firmadoPor: doc.contrafirma.firmadoPor,
          fechaFirma: doc.contrafirma.fechaFirma,
          signingUrl: doc.contrafirma.estado === 'enviado' ? doc.contrafirma.signingUrl : undefined,
          mensaje: doc.contrafirma.mensaje,
          tieneArchivo: !!doc.contrafirma.archivoFirmado,
        }
      : null,
  };
}

async function pacientesConFirmas(req: AuthRequest) {
  return Patient.find({ ...getSucursalFilter(req), 'documentos.firma.estado': 'firmado' })
    .select('nombre apellido rut sucursal documentos')
    .populate('sucursal', 'nombre codigo')
    .populate('documentos.contrafirma.solicitadoPor', 'nombre apellido');
}

// GET /api/validacion-firmas/resumen — cuántos documentos esperan validación (para el menú)
router.get(
  '/resumen',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const cfg = configFirma();
      if (!cfg.habilitada || !cfg.contrafirma) {
        res.json({ activa: false, pendientes: 0, responsable: !!req.user!.responsableFirma });
        return;
      }
      let pendientes = 0;
      for (const p of await pacientesConFirmas(req)) {
        for (const d of ultimosPorTipo(p)) if (ETAPAS_PENDIENTES.includes(etapaValidacion(d))) pendientes++;
      }
      res.json({ activa: true, pendientes, responsable: !!req.user!.responsableFirma });
    } catch (error) {
      responderErrorFirma(res, error, 'Error al contar documentos por validar');
    }
  }
);

// GET /api/validacion-firmas — bandeja: documentos firmados por pacientes que esperan al dispensario
router.get(
  '/',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const cfg = configFirma();
      const pendientes: ReturnType<typeof itemBandeja>[] = [];
      const validados: ReturnType<typeof itemBandeja>[] = [];
      for (const p of await pacientesConFirmas(req)) {
        for (const d of ultimosPorTipo(p)) {
          if (!tipoRequiereFirma(d.tipo)) continue;
          const etapa = etapaValidacion(d);
          if (ETAPAS_PENDIENTES.includes(etapa)) pendientes.push(itemBandeja(p, d, etapa));
          else if (etapa === 'completo' && d.contrafirma?.estado === 'firmado') validados.push(itemBandeja(p, d, etapa));
        }
      }
      // Lo que lleva más tiempo esperando, primero.
      const fechaPaciente = (i: ReturnType<typeof itemBandeja>) => new Date(i.firmaPaciente?.fechaFirma ?? 0).getTime();
      pendientes.sort((a, b) => fechaPaciente(a) - fechaPaciente(b));
      const fechaValidacion = (i: ReturnType<typeof itemBandeja>) => new Date(i.contrafirma?.fechaFirma ?? 0).getTime();
      validados.sort((a, b) => fechaValidacion(b) - fechaValidacion(a));

      res.json({
        activa: cfg.habilitada && cfg.contrafirma,
        responsable: !!req.user!.responsableFirma && ['admin', 'operador'].includes(req.user!.role),
        pendientes,
        validados: validados.slice(0, 20),
      });
    } catch (error) {
      responderErrorFirma(res, error, 'Error al cargar la bandeja de validación');
    }
  }
);

// ─── Certificado del responsable ───────────────────────────

// GET /api/validacion-firmas/certificado — estado de mi certificado de firma
router.get(
  '/certificado',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const user = req.user!;
      exigirResponsable(user);
      const estado = await consultarCertificado(user);
      if (user.isModified()) await user.save();
      res.json(estado);
    } catch (error) {
      responderErrorFirma(res, error, 'Error al consultar tu certificado de firma');
    }
  }
);

// POST /api/validacion-firmas/certificado — pido mi certificado de firma (una sola vez)
router.post(
  '/certificado',
  authenticate,
  authorize('admin', 'operador'),
  [
    body('serieCedula').isString().notEmpty().withMessage('Indica el número de documento de la cédula'),
    body('telefono').optional({ values: 'falsy' }).isString(),
    body('comuna').isString().notEmpty().withMessage('Selecciona tu comuna de residencia'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!validar(req, res)) return;
    try {
      const user = req.user!;
      exigirResponsable(user);
      const result = await solicitarCertificado(user, req.body, retornoFirma.responsableCertificado());
      user.markModified('certificadoFirma');
      await user.save();
      void registrarAuditoria({
        req,
        usuario: user._id as Types.ObjectId,
        accion: 'solicitar_certificado_firma',
        entidad: 'usuario',
        entidadId: user._id as Types.ObjectId,
      });
      res.json(result);
    } catch (error) {
      responderErrorFirma(res, error, 'Error al solicitar tu certificado de firma');
    }
  }
);

// ─── Acciones sobre un documento ───────────────────────────

async function cargar(req: AuthRequest, res: Response): Promise<{ patient: IPatient; doc: IDocument } | null> {
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
  if (!canAccessSucursal(req.user, patient.sucursal)) {
    res.status(403).json({ message: 'No tiene acceso a este dispensario.' });
    return null;
  }
  const doc = patient.documentos.id(docId) as IDocument | null;
  if (!doc) {
    res.status(404).json({ message: 'Documento no encontrado.' });
    return null;
  }
  return { patient, doc };
}

async function responderItem(res: Response, patient: IPatient, doc: IDocument, extra: Record<string, unknown> = {}) {
  await patient.populate([
    { path: 'sucursal', select: 'nombre codigo' },
    { path: 'documentos.contrafirma.solicitadoPor', select: 'nombre apellido' },
  ]);
  const actualizado = patient.documentos.id(doc._id) as IDocument;
  res.json({ ...extra, item: itemBandeja(patient, actualizado, etapaValidacion(actualizado)) });
}

// POST /api/validacion-firmas/:patientId/:docId/firmar — el responsable contrafirma
router.post(
  '/:patientId/:docId/firmar',
  authenticate,
  authorize('admin', 'operador'),
  [body('reiniciar').optional().isBoolean()],
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!validar(req, res)) return;
    let found: Awaited<ReturnType<typeof cargar>> = null;
    try {
      found = await cargar(req, res);
      if (!found) return;
      const { patient, doc } = found;
      const user = req.user!;

      // Si aún no tenemos el PDF firmado del paciente (webhook perdido), se intenta traer ahora.
      if (doc.firma?.estado === 'firmado' && !doc.firma.archivoFirmado) {
        await actualizarEstadoFirma(doc).catch(() => false);
      }

      const firma = await solicitarContrafirma(patient, doc, user, {
        redirectUrl: retornoFirma.contrafirma(),
        reiniciar: req.body.reiniciar === true,
      });
      await patient.save();
      if (user.isModified()) await user.save();

      void registrarAuditoria({
        req,
        usuario: user._id as Types.ObjectId,
        accion: 'solicitar_contrafirma',
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
        detalles: { documento: doc._id, tipo: doc.tipo, reiniciar: !!req.body.reiniciar },
      });
      await responderItem(res, patient, doc, { firma });
    } catch (error) {
      if (found?.patient.isModified()) await found.patient.save().catch(() => undefined);
      if (req.user?.isModified()) await req.user.save().catch(() => undefined);
      responderErrorFirma(res, error, 'Error al solicitar la contrafirma');
    }
  }
);

// POST /api/validacion-firmas/:patientId/:docId/rechazar — devuelve el documento al paciente con el motivo
router.post(
  '/:patientId/:docId/rechazar',
  authenticate,
  authorize('admin', 'operador'),
  [body('motivo').isString().trim().isLength({ min: 3, max: 500 }).withMessage('Escribe el motivo del rechazo')],
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!validar(req, res)) return;
    try {
      const found = await cargar(req, res);
      if (!found) return;
      const { patient, doc } = found;
      await rechazarValidacion(doc, req.user!, String(req.body.motivo));
      await patient.save();
      void registrarAuditoria({
        req,
        usuario: req.user!._id as Types.ObjectId,
        accion: 'rechazar_validacion_firma',
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
        detalles: { documento: doc._id, tipo: doc.tipo, motivo: req.body.motivo },
      });
      await responderItem(res, patient, doc);
    } catch (error) {
      responderErrorFirma(res, error, 'Error al rechazar el documento');
    }
  }
);

// GET /api/validacion-firmas/:patientId/:docId/estado — consulta la contrafirma en Signapis
router.get(
  '/:patientId/:docId/estado',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const found = await cargar(req, res);
      if (!found) return;
      const { patient, doc } = found;
      if (await actualizarContrafirma(patient, doc)) await patient.save();
      await responderItem(res, patient, doc);
    } catch (error) {
      responderErrorFirma(res, error, 'Error al consultar la contrafirma');
    }
  }
);

// GET /api/validacion-firmas/:patientId/:docId/archivo?version=paciente|final — enlace temporal al PDF
router.get(
  '/:patientId/:docId/archivo',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const found = await cargar(req, res);
      if (!found) return;
      const { patient, doc } = found;
      const final = req.query.version === 'final';
      const ref = final ? doc.contrafirma?.archivoFirmado : doc.firma?.archivoFirmado ?? doc.archivo;
      const url = ref ? await getDownloadUrl(ref, baseUrl(req)) : null;
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
        detalles: { documento: doc._id, version: final ? 'contrafirmado' : 'firmado_paciente' },
      });
      res.json({ url });
    } catch (error) {
      responderErrorFirma(res, error, 'Error al abrir el documento');
    }
  }
);

export default router;
